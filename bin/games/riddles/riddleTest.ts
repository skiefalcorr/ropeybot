/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Offline tests for riddle mode. No BC connection and no LLM are used.
 *
 *   npx tsx bin/games/riddles/riddleTest.ts
 *
 * Covers the parts that are easy to get subtly wrong: the CSV parser
 * (quotes, embedded commas, CRLF, BOM), stable ids and de-duplication, and
 * every transition of the state machine.
 */

import {
    parseCsv,
    riddleId,
    loadRiddles,
    pickRandomRiddles,
} from "./riddleStore";
import { RiddleState } from "./riddleState";
import { RiddlesActivity } from "./activity";
import type { ActivityContext } from "../../llm/activities/types";
import type { CommandHub } from "../../llm/commands/hub";
import type { Tool } from "../../llm/tools/shared";
import { rm } from "node:fs/promises";
import { buildActivities, enabledActivityIds } from "../../llm/activities/registry";
import { ContextBuilder } from "../../llm/context";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failed += 1;
        console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

function equal<T>(name: string, actual: T, expected: T): void {
    check(
        name,
        JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
}

function testCsvParser(): void {
    console.log("\nCSV parser");

    equal("plain fields", parseCsv("a,b\nc,d\n"), [
        ["a", "b"],
        ["c", "d"],
    ]);

    equal("quoted field with comma", parseCsv('"Hello, world",answer\n'), [
        ["Hello, world", "answer"],
    ]);

    equal("escaped quotes", parseCsv('"He said ""hi""",answer\n'), [
        ['He said "hi"', "answer"],
    ]);

    equal("CRLF line endings", parseCsv("a,b\r\nc,d\r\n"), [
        ["a", "b"],
        ["c", "d"],
    ]);

    equal("BOM stripped", parseCsv("\uFEFFa,b\n"), [["a", "b"]]);

    equal("blank lines dropped", parseCsv("a,b\n\n\nc,d\n"), [
        ["a", "b"],
        ["c", "d"],
    ]);

    equal(
        "quoted field containing newline",
        parseCsv('"line one\nline two",answer\n'),
        [["line one\nline two", "answer"]],
    );

    equal("trailing field without newline", parseCsv("a,b"), [["a", "b"]]);
}

function testIds(): void {
    console.log("\nStable ids");

    const a = riddleId("What gets wetter as it dries?");
    const b = riddleId("what gets wetter as it dries");
    equal("id is case and punctuation insensitive", a, b);

    const c = riddleId("What gets wetter as it dries?");
    equal("id is deterministic", a, c);

    const d = riddleId("What goes up but never comes down?");
    check("different questions get different ids", a !== d);
}

function testPicking(): void {
    console.log("\nRandom picking");

    const pool = [
        { id: "a", question: "A", answer: "a" },
        { id: "b", question: "B", answer: "b" },
        { id: "c", question: "C", answer: "c" },
    ];

    const picked = pickRandomRiddles(pool, 2);
    equal("returns requested count", picked.length, 2);
    check(
        "returns distinct riddles",
        new Set(picked.map((r) => r.id)).size === 2,
    );

    const excluded = pickRandomRiddles(pool, 1, ["a", "b"]);
    equal("excludes solved when enough remain", excluded.map((r) => r.id), [
        "c",
    ]);

    // With only one unsolved riddle left but two requested, the fallback
    // widens the pool rather than returning a short list.
    const widened = pickRandomRiddles(pool, 2, ["a", "b"]);
    equal("widens the pool when too few unsolved remain", widened.length, 2);

    const exhausted = pickRandomRiddles(pool, 2, ["a", "b", "c"]);
    equal(
        "falls back to the full pool when everything is solved",
        exhausted.length,
        2,
    );

    equal("handles an empty pool", pickRandomRiddles([], 3), []);
    equal("handles a zero count", pickRandomRiddles(pool, 0), []);
}

function testStateMachine(): void {
    console.log("\nState machine");

    const state = new RiddleState(3);
    const riddle = {
        id: "r1",
        question: "What gets wetter as it dries?",
        answer: "towel",
    };

    check("starts idle", state.peek(1) === undefined);
    equal("solved count starts at zero", state.solvedCount(1), 0);

    state.assign(1, "Alice", riddle);
    equal("assign -> asked", state.peek(1)?.state, "asked");
    equal("assign records the question", state.peek(1)?.question, riddle.question);

    const wrong = state.markResult(1, false);
    equal("wrong guess keeps it asked", wrong?.outcome, "wrong");
    equal("wrong guess increments attempts", state.peek(1)?.attempts, 1);

    const solved = state.markResult(1, true);
    equal("correct guess -> solved", solved?.outcome, "solved");
    equal("solved count increments", solved?.solved, 1);
    check("goal not reached yet", solved?.goalReached === false);

    state.assign(1, "Alice", { id: "r2", question: "Q2", answer: "a2" });
    state.markResult(1, true);
    state.assign(1, "Alice", { id: "r3", question: "Q3", answer: "a3" });
    const finished = state.markResult(1, true);
    check("goal reached on the third solve", finished?.goalReached === true);

    const duplicate = state.markResult(1, true);
    check("marking when nothing is asked is rejected", duplicate === undefined);

    state.assign(2, "Bob", { id: "r4", question: "Q4", answer: "a4" });
    const gaveUp = state.markResult(2, false, { giveUp: true });
    equal("giveUp -> failed", gaveUp?.outcome, "failed");
    equal("failed count increments", state.peek(2)?.failedCount, 1);
    equal("failed does not count as solved", state.solvedCount(2), 0);

    check(
        "re-solving the same riddle does not double count",
        (() => {
            state.assign(3, "Cara", { id: "r5", question: "Q5", answer: "a5" });
            state.markResult(3, true);
            state.assign(3, "Cara", { id: "r5", question: "Q5", answer: "a5" });
            state.markResult(3, true);
            return state.solvedCount(3) === 1;
        })(),
    );

    equal("board puts the most solves first", state.leaderboard()[0].name, "Alice");
    equal("board entry solved count", state.leaderboard()[0].solved, 3);

    state.clearRiddle(1);
    equal("clearRiddle -> idle", state.peek(1)?.state, "idle");
    equal("clearRiddle keeps progress", state.solvedCount(1), 3);

    check("goalReached lists Alice", state.goalReached().some((g) => g.name === "Alice"));

    check("first greet is reported as such", state.markGreeted(9, "Dan") === true);
    check("second greet is not", state.markGreeted(9, "Dan") === false);
    check("wasGreeted reflects it", state.wasGreeted(9));

    const snapshot = state.toJSON();
    const restored = new RiddleState(3);
    restored.load(snapshot);
    equal("round-trips solved count", restored.solvedCount(1), 3);
    equal("round-trips failed count", restored.peek(2)?.failedCount, 1);
    check("round-trips greeted flag", restored.wasGreeted(9));

    restored.reset();
    equal("reset clears everyone", restored.all().length, 0);

    const empty = new RiddleState(3);
    empty.load(undefined);
    equal("loading undefined data is safe", empty.all().length, 0);
}

async function testRealCsv(): Promise<void> {
    console.log("\nReal riddle table");

    const { riddles, duplicates } = await loadRiddles();
    check("loaded riddles from the real CSV", riddles.length > 300, `got ${riddles.length}`);
    // The CSV contains near-duplicates with different wording, which are
    // legitimately distinct riddles. Only exact repeats are dropped.
    check("duplicate count is reported", duplicates >= 0, `got ${duplicates}`);
    check(
        "every riddle has a question and an answer",
        riddles.every((r) => r.question.length > 0 && r.answer.length > 0),
    );
    check(
        "ids are unique",
        new Set(riddles.map((r) => r.id)).size === riddles.length,
    );
    check(
        "header row was skipped",
        !riddles.some((r) => r.question.toLowerCase() === "questions"),
    );
}

async function testActivityIntegration(): Promise<void> {
    console.log("\nRiddlesActivity integration (stubbed connection)");

    const whispered: string[] = [];
    const pushed: string[] = [];
    const notes: string[] = [];
    const registered: string[] = [];
    const participants = new Set<number>();

    const alice = { MemberNumber: 11, Name: "Alice", NickName: "Alice" };
    const bob = { MemberNumber: 22, Name: "Bob", NickName: "Bob" };
    const me = { MemberNumber: 99, Name: "Bot", NickName: "Bot" };

    const conn = {
        Player: me,
        chatRoom: {
            Name: "Test room",
            characters: [me, alice, bob],
            getCharacter: (n: number) =>
                [me, alice, bob].find((c) => c.MemberNumber === n),
        },
        SendMessage: (_type: string, text: string) => {
            whispered.push(text);
        },
    };

    const commands = {
        register: (c: { name: string }) => registered.push(c.name),
    } as unknown as CommandHub;

    const ctx = {
        conn,
        llmConfig: { url: "http://localhost", persona: "test", botName: "Riddlebot" },
        toolContext: {
            conn,
            participants,
            config: { url: "x", persona: "x" },
        },
        commands,
        requestParticipant: (n: number) => participants.add(n),
        isParticipant: (n: number) => participants.has(n),
        isSuperuser: () => false,
        participants: () => [...participants],
        whisper: (n: number, text: string) => whispered.push(`${n}:${text}`),
        note: (c: string) => notes.push(c),
        pushEvent: (c: string) => pushed.push(c),
        log: () => undefined,
        warn: () => undefined,
    } as unknown as ActivityContext;

    const activity = new RiddlesActivity({
        enabled: true,
        goal: 2,
        stateFile: "riddles.test.state.json",
    });

    await activity.init(ctx);

    check("activity loaded the riddle pool", activity.getRiddlePoolSize() > 300);
    equal("activity registered its command", registered, ["riddles"]);
    equal("activity exposed six tools", activity.getTools().length, 6);
    check(
        "all riddle tools carry the riddles category",
        activity.getTools().every((t) => t.category === "riddles"),
    );

    const section = activity.systemSections().join("\n");
    check("system section mentions markRiddleResult", section.includes("markRiddleResult"));
    check("system section warns against leaking answers", /Never reveal a riddle's answer/.test(section));

    check("bio advertises the command", (activity.bioAddendum() ?? "").includes("/bot riddles"));

    // Entry whisper: first time = intro, second time = welcome back.
    activity.onCharacterEntered(ctx, alice as never);
    check(
        "first entry whispers the invite",
        whispered[0]?.includes("/bot riddles") ?? false,
    );
    equal("first entry pushes an event", pushed.length, 1);

    whispered.length = 0;
    activity.onCharacterEntered(ctx, alice as never);
    check(
        "second entry whispers a progress reminder",
        whispered[0]?.includes("Welcome back") ?? false,
    );

    // Tools end-to-end against the real pool.
    const tools = new Map<string, Tool>(
        activity.getTools().map((t) => [t.name, t]),
    );
    const toolCtx = { conn, participants, config: {} } as never;

    const run = async (
        name: string,
        args: Record<string, unknown>,
    ): Promise<string> => {
        const tool = tools.get(name);
        if (!tool) return `(no such tool: ${name})`;
        return String(await tool.handler(args, toolCtx));
    };

    const got = await run("getRiddles", { count: 3 });
    check(
        "getRiddles returns three riddles",
        (got.match(/^\[\w+\]/gm) ?? []).length === 3,
    );

    const single = await run("getSingleRiddle", {
        player: "Alice",
        memberNumber: 11,
    });
    check("getSingleRiddle assigns a riddle", single.includes("Riddle assigned to Alice"));
    equal("assignment is tracked in the state", activity.getState().peek(11)?.state, "asked");

    const annotations = activity.characterAnnotations(ctx);
    const aliceLines = annotations.get(11) ?? [];
    check("Alice gets a priority annotation", aliceLines[0]?.includes("RIDDLE PLAYER") ?? false);
    check(
        "the annotation includes the current riddle and answer",
        aliceLines.some((l) => l.includes("current riddle:")) &&
            aliceLines.some((l) => l.includes("(answer:")),
    );
    check("Bob has not been annotated yet", !annotations.has(22));

    const wrong = await run("markRiddleResult", {
        memberNumber: 11,
        correct: false,
        guessedAnswer: "nope",
    });
    check("a wrong guess is recorded", wrong.includes("wrong guess"));
    equal("a wrong guess keeps the player asked", activity.getState().peek(11)?.state, "asked");

    const solved = await run("markRiddleResult", {
        memberNumber: 11,
        correct: true,
        reason: "they got it",
    });
    check("a correct guess reports a solve", solved.includes("SOLVED"));
    equal("solving updates progress", activity.getState().solvedCount(11), 1);

    check("verdicts push system notes", notes.length >= 2);

    const status = await run("getRiddleStatus", {});
    check("status lists a leaderboard", status.includes("leaderboard"));

    // Command behaviour: opts the player in, stays private.
    const reply = activity
        .registerCommands
        ? (() => {
              const call = (activity as never as Record<string, unknown>)
                  .onCommandRiddles as (s: unknown, a: string[]) => string | string[];
              return call.call(activity, bob, []);
          })()
        : "";
    const replyText = Array.isArray(reply) ? reply.join("\n") : reply;
    check("command opts the player into roleplay", participants.has(22));
    check("command tells them they can chat", replyText.includes("now chatting with me"));

    // Reset.
    activity.reset();
    equal("reset clears progress", activity.getState().all().length, 0);

    await activity.stop();
    check("stop is safe to call", true);

    // The test writes a throwaway state file; remove it so repeated runs and
    // `git status` stay clean.
    await rm("riddles.test.state.json", { force: true });
}

async function testRegistryAndContext(): Promise<void> {
    console.log("\nRegistry and context injection");

    // Registry: no config => nothing enabled; riddles enabled via the
    // activities map; explicit false disables even the shorthand.
    equal("no config enables nothing", enabledActivityIds({ url: "x", persona: "x" }), []);
    equal(
        "activities map enables riddles",
        enabledActivityIds({
            url: "x",
            persona: "x",
            activities: { riddles: { enabled: true } },
        }),
        ["riddles"],
    );
    equal(
        "explicit false beats the shorthand",
        enabledActivityIds({
            url: "x",
            persona: "x",
            riddles: { enabled: true },
            activities: { riddles: false },
        }),
        [],
    );
    equal(
        "unknown ids are ignored",
        enabledActivityIds({
            url: "x",
            persona: "x",
            activities: { ponyplay: { enabled: true } },
        }),
        [],
    );

    const built = buildActivities({
        url: "x",
        persona: "x",
        activities: { riddles: { enabled: true } },
    });
    equal("registry builds one activity", built.length, 1);
    equal("registry builds the riddle activity", built[0].id, "riddles");

    // Context builder: activity sections land in the system prompt and the
    // room snapshot.
    // Minimum surface `describeCharacter` touches.
    const stubCharacter = (memberNumber: number, name: string) => ({
        MemberNumber: memberNumber,
        Name: name,
        NickName: name,
        Description: "",
        Pose: [] as { Name: string }[],
        MapPos: { X: 0, Y: 0 },
        Appearance: { InventoryGet: () => undefined, allItems: () => [] },
        upperBodyStyle: () => "female" as const,
        lowerBodyStyle: () => "female" as const,
        hasPenis: () => false,
        IsRestrained: () => false,
        CanTalk: () => true,
    });

    const alice = stubCharacter(11, "Alice");
    const me = stubCharacter(99, "Bot");
    const conn = {
        Player: me,
        chatRoom: {
            Name: "Test room",
            characters: [me, alice],
        },
    };
    const participants = new Set<number>([11]);

    const whispers: string[] = [];
    const ctx = {
        conn,
        llmConfig: { url: "x", persona: "x" },
        toolContext: { conn, participants, config: {} },
        commands: { register: () => undefined },
        requestParticipant: () => undefined,
        isParticipant: (n: number) => participants.has(n),
        isSuperuser: () => false,
        participants: () => [...participants],
        whisper: (n: number, text: string) => whispers.push(text),
        note: () => undefined,
        pushEvent: () => undefined,
        log: () => undefined,
        warn: () => undefined,
    } as unknown as ActivityContext;

    const activity = new RiddlesActivity({
        enabled: true,
        goal: 5,
        stateFile: "riddles.test.state.json",
    });
    await activity.init(ctx);
    activity.onCharacterEntered(ctx, alice as never);

    // Give Alice a riddle so the annotation has content.
    const assignTool = activity
        .getTools()
        .find((t) => t.name === "getSingleRiddle");
    await assignTool?.handler({ memberNumber: 11 }, { conn, participants, config: {} } as never);

    const builder = new ContextBuilder(40, 200, participants);
    builder.setActivities([activity], () => ctx);

    const system = builder.buildSystemPrompt("You are a test bot.");
    check("system prompt keeps the persona", system.startsWith("You are a test bot."));
    check("system prompt includes the riddle rules", system.includes("## Riddle side-game"));
    check(
        "system prompt mentions the private command",
        system.includes("/bot riddles"),
    );

    const snapshot = builder.buildRoomStateMessage(conn as never);
    check("snapshot includes the room name", snapshot.includes("Test room"));
    check(
        "snapshot annotates Alice as a riddle player",
        snapshot.includes("RIDDLE PLAYER (priority for roleplay)"),
    );
    check(
        "snapshot shows Alice's current riddle",
        snapshot.includes("current riddle:"),
    );
    check(
        "snapshot includes the riddle leaderboard section",
        snapshot.includes("Riddles (goal 5 solved):"),
    );
    check(
        "annotation sits next to the character, not at the end",
        snapshot.indexOf("RIDDLE PLAYER") <
            snapshot.indexOf("Riddles (goal 5 solved):"),
    );

    await activity.stop();
    await rm("riddles.test.state.json", { force: true });
}

async function main(): Promise<void> {
    testCsvParser();
    testIds();
    testPicking();
    testStateMachine();
    await testRealCsv();
    await testActivityIntegration();
    await testRegistryAndContext();

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

void main();
