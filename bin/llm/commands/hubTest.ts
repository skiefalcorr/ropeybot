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
 * Offline tests for the command hub. No BC connection and no LLM are used.
 *
 *   npx tsx bin/llm/commands/hubTest.ts
 *
 * Covers the parts that are easy to get wrong: help visibility for superusers,
 * de-duplication of multiple contributions to one command, section grouping
 * and ordering, and the replace/append dispatch rules.
 */

import { CommandHub, CORE_OWNER, DEFAULT_SECTION } from "./hub";
import type { CommandContribution } from "./types";

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

/**
 * A CommandHub with a stub connection. `replies` collects whatever the hub
 * would have sent, so dispatch behaviour can be asserted directly.
 */
function makeHub() {
    const replies: string[] = [];
    const whispers: string[] = [];
    const registered = new Map<string, unknown>();

    const conn = {
        reply: (_msg: unknown, text: string) => replies.push(text),
        SendMessage: (_type: string, text: string) => whispers.push(text),
    };
    const parser = {
        register: (name: string, handler: unknown) =>
            registered.set(name, handler),
    };

    const hub = new CommandHub(conn as never, parser as never);

    /** Invoke a registered command the way CommandParser would. */
    const invoke = async (name: string, args: string[] = []): Promise<void> => {
        const handler = registered.get(name) as
            | ((
                  sender: unknown,
                  message: unknown,
                  args: string[],
              ) => Promise<void>)
            | undefined;
        if (!handler) return;
        await handler({ MemberNumber: 7 }, { Type: "Chat" }, args);
    };

    return { hub, replies, whispers, registered, invoke };
}

function testHelpVisibility(): void {
    console.log("\nHelp visibility");

    const { hub } = makeHub();

    hub.register({
        name: "start",
        owner: CORE_OWNER,
        help: "Start roleplaying.",
        handler: () => "started",
    });
    hub.register({
        name: "help",
        owner: CORE_OWNER,
        help: "Show this list.",
        private: true,
        handler: () => "help",
    });
    hub.register({
        name: "tool",
        owner: CORE_OWNER,
        help: "Invoke a tool.",
        superuserOnly: true,
        usage: "<name>",
        handler: () => "tool",
    });

    const playerLines = hub.helpText({ isSuperuser: false });
    const playerText = playerLines.join("\n");
    check(
        "regular players see public commands",
        playerText.includes("/bot start"),
    );
    check("regular players see help itself", playerText.includes("/bot help"));
    check(
        "regular players do NOT see superuser commands",
        !playerText.includes("/bot tool"),
    );

    const suLines = hub.helpText({ isSuperuser: true });
    const suText = suLines.join("\n");
    check("superusers see superuser commands", suText.includes("/bot tool"));
    check(
        "superuser usage is rendered after the name",
        suText.includes("/bot tool <name>"),
    );
    check(
        "superusers still see public commands",
        suText.includes("/bot start"),
    );
}

function testDedupAndOrdering(): void {
    console.log("\nDe-duplication and ordering");

    const { hub } = makeHub();

    // Several contributions to the same command must collapse to one line.
    hub.register({
        name: "status",
        owner: CORE_OWNER,
        help: "Participants.",
        handler: () => "base",
    });
    hub.register({
        name: "status",
        owner: "riddles",
        mode: "append",
        help: "Riddle lines.",
        handler: () => "appended",
    });
    // An alias with no help must not be advertised at all.
    hub.register({
        name: "st",
        owner: CORE_OWNER,
        handler: () => "alias",
    });

    const text = hub.helpText({ isSuperuser: false }).join("\n");
    const statusLines = text
        .split("\n")
        .filter((l) => l.includes("/bot status"));
    equal("status appears exactly once", statusLines.length, 1);
    check(
        "the base definition wins the listing",
        statusLines[0]?.includes("Participants."),
    );
    check("commands without help are hidden", !text.includes("/bot st "));

    // Section grouping: General first, then alphabetical.
    const { hub: hub2 } = makeHub();
    hub2.register({
        name: "zzz",
        owner: CORE_OWNER,
        help: "General command.",
        handler: () => "",
    });
    hub2.register({
        name: "ponies",
        owner: "pony",
        section: "Pony Play",
        help: "Pony things.",
        handler: () => "",
    });
    hub2.register({
        name: "riddles",
        owner: "riddles",
        section: "Riddles",
        help: "Riddle things.",
        handler: () => "",
    });

    const lines = hub2.helpText({ isSuperuser: false });
    const text2 = lines.join("\n");
    equal(
        "General is listed first",
        lines.filter((l) => l.startsWith("[")).map((l) => l.slice(1, -1)),
        [DEFAULT_SECTION, "Pony Play", "Riddles"],
    );
    check(
        "the General command sits under its section",
        text2.indexOf("/bot zzz") < text2.indexOf("[Pony Play]"),
    );

    // Alphabetical within a section.
    const { hub: hub3 } = makeHub();
    for (const name of ["zebra", "alpha", "mike"]) {
        hub3.register({
            name,
            owner: CORE_OWNER,
            help: `The ${name} command.`,
            handler: () => "",
        });
    }
    const order = hub3
        .helpText({ isSuperuser: false })
        .filter((l) => l.startsWith("/bot "))
        .map((l) => l.split(" ")[1]);
    equal("commands are alphabetical within a section", order, [
        "alpha",
        "mike",
        "zebra",
    ]);
}

function testEmptyHelp(): void {
    console.log("\nEmpty listing");

    const { hub } = makeHub();
    hub.register({
        name: "hidden",
        owner: CORE_OWNER,
        superuserOnly: true,
        help: "Superuser only.",
        handler: () => "",
    });
    const text = hub.helpText({ isSuperuser: false }).join("\n");
    check(
        "a player with nothing visible gets a clear message",
        text.includes("No commands are available"),
    );
    check("and no superuser command leaks", !text.includes("/bot hidden"));
}

async function testDispatch(): Promise<void> {
    console.log("\nDispatch");

    const { hub, replies, whispers, invoke } = makeHub();

    hub.register({
        name: "status",
        owner: CORE_OWNER,
        priority: 0,
        handler: () => "base line",
    });
    hub.register({
        name: "status",
        owner: "riddles",
        mode: "append",
        priority: 5,
        handler: () => "riddle line",
    });
    await invoke("status", []);
    equal(
        "append output is stacked after the base in one reply",
        replies.at(-1),
        "base line\nriddle line",
    );

    // A higher-priority replace wins the base slot.
    hub.register({
        name: "status",
        owner: "pony",
        priority: 100,
        handler: () => "pony base",
    });
    await invoke("status", []);
    equal(
        "highest-priority replace wins the base slot",
        replies.at(-1),
        "pony base\nriddle line",
    );

    // Private contributions are whispered, not replied.
    const before = replies.length;
    hub.register({
        name: "riddles",
        owner: "riddles",
        private: true,
        handler: () => "your progress",
    });
    await invoke("riddles", []);
    equal("private command does not reply publicly", replies.length, before);
    equal("private command whispers instead", whispers.at(-1), "your progress");

    // unregisterOwner detaches an activity's commands.
    hub.unregisterOwner("pony");
    await invoke("status", []);
    equal(
        "unregistering an owner restores the previous base",
        replies.at(-1),
        "base line\nriddle line",
    );

    // After dispose the hub is inert.
    hub.dispose();
    const settled = replies.length;
    await invoke("status", []);
    equal("disposed hub stays silent", replies.length, settled);
}

async function main(): Promise<void> {
    testHelpVisibility();
    testDedupAndOrdering();
    testEmptyHelp();
    await testDispatch();

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

void main();
