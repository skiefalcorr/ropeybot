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

import type { API_Character, BC_Server_ChatRoomMessage } from "bc-bot";
import type { RiddlesConfig } from "../../config";
import type { ActivityContext, LLMActivity } from "../../llm/activities/types";
import type { Tool } from "../../llm/tools/shared";
import { displayName } from "../../llm/tools/shared";
import { createRiddleTools } from "../../llm/tools/riddles";
import { JsonStore } from "../../llm/support/jsonStore";
import { loadRiddles, type Riddle } from "./riddleStore";
import { RiddleState, type RiddleStateData } from "./riddleState";

const DEFAULT_COMMAND = "riddles";

/**
 * Riddle mode as an {@link LLMActivity}.
 *
 * The base bot stays a roleplay bot; this activity adds:
 *
 *  - six tools the LLM uses to hand out riddles and record verdicts,
 *  - a per-player "current riddle + answer" block in the room snapshot,
 *  - a one-time entry whisper inviting the player,
 *  - a private `/bot riddles` command,
 *  - a line in the bot's bio advertising the mode.
 *
 * The LLM is the sole judge of a guess. This class never tries to match text
 * itself; it only applies whatever `markRiddleResult` says.
 */
export class RiddlesActivity implements LLMActivity {
    readonly id = "riddles";
    readonly title = "Riddles";

    private state: RiddleState;
    private pool: Riddle[] = [];
    private store: JsonStore<RiddleStateData> | undefined;
    private ctx: ActivityContext | undefined;
    private tools: Tool[] = [];
    private initialized = false;

    constructor(private config: RiddlesConfig) {
        this.state = new RiddleState(config.goal ?? 10);
    }

    /** The state machine, exposed for the debug endpoint and tests. */
    getState(): RiddleState {
        return this.state;
    }

    getRiddlePoolSize(): number {
        return this.pool.length;
    }

    async init(ctx: ActivityContext): Promise<void> {
        if (this.initialized) return;
        this.ctx = ctx;

        const csvPath = this.config.csvPath ?? "bin/games/riddles/riddles.csv";
        const loaded = await loadRiddles(csvPath);
        this.pool = loaded.riddles;
        ctx.log(
            `loaded ${this.pool.length} riddles from ${csvPath}` +
                (loaded.duplicates > 0
                    ? ` (dropped ${loaded.duplicates} duplicate question(s))`
                    : "") +
                (loaded.skipped > 0
                    ? ` (skipped ${loaded.skipped} malformed row(s))`
                    : ""),
        );
        if (this.pool.length === 0) {
            ctx.warn("no riddles loaded — the mode will do nothing useful");
        }

        const stateFile = this.config.stateFile ?? "riddles.state.json";
        this.store = new JsonStore<RiddleStateData>(stateFile, 1000);
        this.state.load(await this.store.load());
        this.state.setOnChange(() => {
            this.store?.save(this.state.toJSON());
        });

        const revealAnswers = this.config.answersInContext !== false;
        this.tools = createRiddleTools(this.state, {
            pool: this.pool,
            defaultBatchSize: this.config.defaultBatchSize ?? 5,
            revealAnswers,
            note: (content) => this.ctx?.note(content),
        });

        this.registerCommands(ctx);
        this.initialized = true;
        ctx.log(
            `ready: goal ${this.state.getGoal()}, ${this.state.all().length} known player(s), state file ${stateFile}`,
        );
    }

    async stop(): Promise<void> {
        await this.store?.close();
        this.store = undefined;
        this.initialized = false;
    }

    getTools(): Tool[] {
        return this.tools;
    }

    // ---------------------------------------------------------------------
    // Prompt material
    // ---------------------------------------------------------------------

    systemSections(): string[] {
        return [
            "## Riddle side-game",
            "- Some characters here play riddles with you. This is a side-game inside the roleplay, not a separate mode: stay in character.",
            "- Characters marked 'RIDDLE PLAYER' are your priority for roleplay. Engage them first.",
            "- Never reveal a riddle's answer unless the player solved it, gave up, or explicitly asked you to reveal it.",
            "- When you decide to give a player a riddle: call getRiddles (or getSingleRiddle) to pick one, tell them the riddle in character, then call assignRiddle with its id.",
            "- When a player guesses: you judge it yourself against the answer shown in the room state, then call markRiddleResult with correct true or false. Set giveUp when they give up or you reveal the answer.",
            "- Always call markRiddleResult for every verdict. If you do not, their progress is not recorded.",
            "- After a solve, congratulate them in character and offer the next riddle. Never invent progress numbers — read them from the room state.",
            `- Progress and details are in the 'Riddles' block of the room state. Players can type /bot ${DEFAULT_COMMAND} for their own status.`,
        ];
    }

    roomStateSections(): string[] {
        const goal = this.state.getGoal();
        const board = this.state.leaderboard(5);
        const lines: string[] = [`Riddles (goal ${goal} solved):`];

        const active = this.state
            .all()
            .filter((p) => p.record.state === "asked");
        if (active.length === 0) {
            lines.push("- Nobody is currently working on a riddle.");
        } else {
            for (const { record } of active) {
                lines.push(
                    `- ${record.name}: "${record.question}"` +
                        ` (answer: ${record.answer}) — wrong attempts: ${record.attempts}`,
                );
            }
        }

        if (board.length > 0) {
            lines.push(
                "Leaderboard: " +
                    board
                        .map(
                            (b) =>
                                `${b.name} ${b.solved}/${goal}` +
                                (b.failed > 0 ? ` (${b.failed} given up)` : ""),
                        )
                        .join(", "),
            );
        }
        return lines;
    }

    /**
     * Attach a status line under each character that has ever interacted with
     * the riddle game, and mark active players as priority for roleplay.
     */
    characterAnnotations(ctx: ActivityContext): Map<number, string[]> {
        const map = new Map<number, string[]>();
        const room = ctx.conn.chatRoom;
        if (!room) return map;

        for (const character of room.characters) {
            if (character.MemberNumber === ctx.conn.Player.MemberNumber) {
                continue;
            }
            const record = this.state.peek(character.MemberNumber);
            const greeted = record?.greetedAt !== undefined;
            if (!record && !greeted) continue;

            const solved = record?.solvedIds.length ?? 0;
            const failed = record?.failedCount ?? 0;
            const lines: string[] = [
                `RIDDLE PLAYER (priority for roleplay) — ${solved}/${this.state.getGoal()} solved` +
                    (failed > 0 ? `, ${failed} given up` : ""),
            ];

            if (record?.state === "asked" && record.question) {
                lines.push(
                    `current riddle: "${record.question}"` +
                        (this.config.answersInContext !== false
                            ? ` (answer: ${record.answer})`
                            : ""),
                );
            } else if (record?.state === "solved") {
                lines.push(
                    "just solved their last riddle — ready for the next one",
                );
            } else if (record?.state === "failed") {
                lines.push(
                    "gave up on their last riddle — ready for the next one",
                );
            } else if (record) {
                lines.push("idle — no riddle assigned yet");
            }
            map.set(character.MemberNumber, lines);
        }
        return map;
    }

    bioAddendum(): string | undefined {
        if (this.config.bioLine) {
            return this.config.bioLine.replace(
                /\{cmd\}/g,
                `/bot ${DEFAULT_COMMAND}`,
            );
        }
        return `Riddles: write /bot ${DEFAULT_COMMAND} to play riddles with me.`;
    }

    // ---------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------

    registerCommands(ctx: ActivityContext): void {
        ctx.commands.register({
            name: DEFAULT_COMMAND,
            owner: this.id,
            priority: 10,
            private: true,
            section: this.title,
            usage: "[top|reset]",
            help: "Your riddle progress (also opts you into roleplay).",
            handler: ({ sender, args }) => this.onCommandRiddles(sender, args),
        });
    }

    /**
     * `/bot riddles [status|top|reset]` — always whispered.
     *
     * Running it also opts the player into roleplay: riddle mode is a layer on
     * top of RP, so asking to play riddles implies wanting the bot to talk to
     * you. That is the one command the activity is allowed to use this for.
     */
    private onCommandRiddles(
        sender: API_Character,
        args: string[],
    ): string | string[] {
        const ctx = this.ctx;
        if (!ctx) return "Riddle mode is still starting up, try again shortly.";

        const name = displayName(sender);
        const sub = (args[0] ?? "").toLowerCase();

        // Opt the player into roleplay (idempotent).
        const wasParticipant = ctx.isParticipant(sender.MemberNumber);
        if (!wasParticipant) {
            ctx.requestParticipant(sender.MemberNumber);
            this.state.markGreeted(sender.MemberNumber, name);
        }

        if (sub === "reset") {
            if (!ctx.isSuperuser(sender.MemberNumber)) {
                return "Only the bot's operator can reset the riddle game.";
            }
            this.state.reset();
            return "Riddle progress has been reset for everyone.";
        }

        if (sub === "top" || sub === "leaderboard") {
            const board = this.state.leaderboard(10);
            if (board.length === 0) return "Nobody has played riddles yet.";
            return [
                `Riddle leaderboard (goal ${this.state.getGoal()}):`,
                ...board.map(
                    (b, i) =>
                        `${i + 1}. ${b.name} — ${b.solved}/${this.state.getGoal()}` +
                        (b.failed > 0 ? ` (${b.failed} given up)` : ""),
                ),
            ];
        }

        const record = this.state.peek(sender.MemberNumber);
        const lines: string[] = [
            `Riddles: ${this.state.progressText(sender.MemberNumber)} (goal ${this.state.getGoal()}).`,
        ];
        if (!record || record.state === "idle") {
            lines.push(
                "Ask me for a riddle in chat and I will give you one in character.",
            );
        } else if (record.state === "asked" && record.question) {
            lines.push(`Your current riddle: "${record.question}"`);
            lines.push(
                `Wrong attempts so far: ${record.attempts}. Answer in chat whenever you like.`,
            );
        } else if (record.state === "solved") {
            lines.push(
                "You just solved your last riddle. Ask for the next one!",
            );
        } else if (record.state === "failed") {
            lines.push(
                "You gave up on the last one. Ask for a fresh riddle whenever you want.",
            );
        }
        if (!wasParticipant) {
            lines.push("You are now chatting with me — say hi!");
        }
        return lines;
    }

    // ---------------------------------------------------------------------
    // Room events
    // ---------------------------------------------------------------------

    /**
     * Entry whisper. Once per member, persisted in the state file, so a
     * returning player gets their progress instead of the full intro.
     */
    onCharacterEntered(ctx: ActivityContext, character: API_Character): void {
        const me = ctx.conn.Player;
        const currentNick = me.NickName || me.Name;

        if (this.config.greetOnEnter === false) return;
        if (character.MemberNumber === ctx.conn.Player.MemberNumber) return;

        const name = displayName(character);
        const first = this.state.markGreeted(character.MemberNumber, name);
        const botName = ctx.llmConfig.botName?.trim() || currentNick;

        if (first) {
            ctx.whisper(
                character.MemberNumber,
                `Hi ${name}! I'm ${botName} — I roleplay, and I also set riddles.\n` +
                    `Write /bot ${DEFAULT_COMMAND} to play riddles with me. ` +
                    `Solve ${this.state.getGoal()} and I'll be impressed.\n` +
                    `(That command also starts our roleplay — say or do something after it.)`,
            );
        } else {
            ctx.whisper(
                character.MemberNumber,
                `Welcome back, ${name}! You are at ${this.state.progressText(character.MemberNumber)}.\n` +
                    `Write /bot ${DEFAULT_COMMAND} to continue, or just talk to me.`,
            );
        }

        // Let the model know the player arrived so it can greet them in
        // character on its next turn.
        ctx.pushEvent(
            `${name} entered the room and was greeted with the riddle invite.`,
        );
    }

    /**
     * When a participant starts, make sure the riddle record knows their name
     * (so the leaderboard is readable even if they never entered with riddle
     * mode notice).
     */
    onParticipantChanged(ctx: ActivityContext, memberNumber: number): void {
        const character = ctx.conn.chatRoom?.getCharacter(memberNumber);
        if (!character) return;
        this.state.touch(memberNumber, displayName(character));
    }

    /**
     * Intentionally does nothing: the LLM detects guesses from the chat it
     * already sees and records them via `markRiddleResult`. There is no
     * deterministic answer matching here by design.
     */
    onMessage(
        _ctx: ActivityContext,
        _sender: API_Character,
        _message: BC_Server_ChatRoomMessage,
    ): void {
        // no-op
    }

    // ---------------------------------------------------------------------
    // Debug
    // ---------------------------------------------------------------------

    debugSnapshot(): unknown {
        return {
            id: this.id,
            goal: this.state.getGoal(),
            poolSize: this.pool.length,
            players: this.state.all().map(({ memberNumber, record }) => ({
                memberNumber,
                ...record,
            })),
            leaderboard: this.state.leaderboard(10),
        };
    }

    reset(): void {
        this.state.reset();
    }
}
