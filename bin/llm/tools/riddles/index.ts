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

import type { API_Character } from "bc-bot";
import { Tool, ToolContext, def, displayName } from "../shared";
import {
    pickRandomRiddles,
    type Riddle,
} from "../../../games/riddles/riddleStore";
import type { RiddleState } from "../../../games/riddles/riddleState";

/**
 * Options the activity passes when building the tool set.
 */
export interface RiddleToolOptions {
    /** Path-independent pool of all riddles. */
    pool: Riddle[];
    /** How many riddles `getRiddles` returns when `count` is omitted. */
    defaultBatchSize: number;
    /**
     * Whether to reveal the answer of the current riddle to the model when
     * reporting status. The answer is normally already in the room snapshot;
     * this only affects the tool result text.
     */
    revealAnswers: boolean;
    /**
     * Push a system note into the model's history (used when a verdict is
     * recorded so the next turn remembers it).
     */
    note(content: string): void;
}

/**
 * Resolve a player from tool arguments. Accepts `memberNumber` (preferred,
 * unambiguous) or `player` (a name/nickname, case-insensitive).
 */
function resolvePlayer(
    ctx: ToolContext,
    args: Record<string, unknown>,
): { character: API_Character; memberNumber: number; name: string } | undefined {
    const room = ctx.conn.chatRoom;
    if (!room) return undefined;

    const memberNumber = args.memberNumber;
    if (typeof memberNumber === "number") {
        const character = room.characters.find(
            (c) => c.MemberNumber === memberNumber,
        );
        if (character) {
            return {
                character,
                memberNumber,
                name: displayName(character),
            };
        }
        // Allow acting on someone who just left the room: the number is still
        // authoritative, we just cannot read a live nickname.
        return { character: undefined as never, memberNumber, name: String(memberNumber) };
    }

    const name = args.player ?? args.name;
    if (typeof name === "string" && name.trim().length > 0) {
        const lower = name.trim().toLowerCase();
        const character = room.characters.find(
            (c) =>
                c.Name.toLowerCase() === lower ||
                c.NickName.toLowerCase() === lower,
        );
        if (character) {
            return {
                character,
                memberNumber: character.MemberNumber,
                name: displayName(character),
            };
        }
    }
    return undefined;
}

function formatRiddle(riddle: Riddle): string {
    return `[${riddle.id}] ${riddle.question} (answer: ${riddle.answer})`;
}

/**
 * Build the riddle tool set.
 *
 * Deliberately a factory rather than a static array: every handler closes over
 * this activity's {@link RiddleState} and pool, so `ToolContext` needs no
 * riddle-specific fields and a second activity can never collide with these.
 */
export function createRiddleTools(
    state: RiddleState,
    options: RiddleToolOptions,
): Tool[] {
    const getRiddles: Tool = {
        name: "getRiddles",
        category: "riddles",
        definition: def(
            "getRiddles",
            "Get N random riddles from the table to choose from. Each result has an id, the question, and the canonical answer. Use the id when calling assignRiddle. Optionally pass a player to exclude riddles they already solved.",
            {
                count: {
                    type: "number",
                    description: `How many riddles to return (default ${options.defaultBatchSize}).`,
                },
                player: {
                    type: "string",
                    description:
                        "Optional player name. When given, riddles they already solved are avoided.",
                },
                memberNumber: {
                    type: "number",
                    description:
                        "Optional player member number. Preferred over 'player' when available.",
                },
            },
        ),
        handler: (args, ctx) => {
            const count =
                typeof args.count === "number" && args.count > 0
                    ? Math.floor(args.count)
                    : options.defaultBatchSize;

            let exclude: string[] = [];
            const target = resolvePlayer(ctx, args);
            if (target) {
                exclude = state.solvedIds(target.memberNumber);
            }

            const picked = pickRandomRiddles(options.pool, count, exclude);
            if (picked.length === 0) {
                return "No riddles available. The riddle table appears to be empty.";
            }
            const note = target
                ? ` (avoiding ${exclude.length} riddle(s) ${target.name} already solved)`
                : "";
            return [
                `Got ${picked.length} riddle(s)${note}:`,
                ...picked.map(formatRiddle),
                "",
                "Ask one of these to a player, then call assignRiddle so their progress tracks it.",
            ].join("\n");
        },
    };

    const getSingleRiddle: Tool = {
        name: "getSingleRiddle",
        category: "riddles",
        definition: def(
            "getSingleRiddle",
            "Get one random riddle and (by default) assign it to a player in one step. Use this when you want a simple flow: one riddle, already tracked for that player, so you can just ask it.",
            {
                player: {
                    type: "string",
                    description:
                        "Player name to assign the riddle to. Omit to just get a riddle without assigning.",
                },
                memberNumber: {
                    type: "number",
                    description:
                        "Player member number. Preferred over 'player' when available.",
                },
                assign: {
                    type: "boolean",
                    description:
                        "Assign the riddle to the player and reset their attempts. Default true when a player is given.",
                },
            },
        ),
        handler: (args, ctx) => {
            const target = resolvePlayer(ctx, args);
            const exclude = target ? state.solvedIds(target.memberNumber) : [];
            const [picked] = pickRandomRiddles(options.pool, 1, exclude);
            if (!picked) return "No riddles available.";

            const shouldAssign =
                args.assign === undefined ? !!target : args.assign === true;

            if (!target || !shouldAssign) {
                return [
                    `Riddle: ${picked.question}`,
                    `Answer: ${picked.answer}`,
                    `Id: ${picked.id}`,
                    "",
                    "Not assigned to anyone yet. Use assignRiddle when you give it to a player.",
                ].join("\n");
            }

            state.assign(target.memberNumber, target.name, picked);
            options.note(
                `Riddle assigned to ${target.name}: "${picked.question}" (answer: ${picked.answer}).`,
            );
            return [
                `Riddle assigned to ${target.name} (${state.progressText(target.memberNumber)}):`,
                `"${picked.question}"`,
                `Answer: ${picked.answer}`,
                `Id: ${picked.id}`,
                "",
                "Ask it in character. When they guess, call markRiddleResult.",
            ].join("\n");
        },
    };

    const assignRiddle: Tool = {
        name: "assignRiddle",
        category: "riddles",
        definition: def(
            "assignRiddle",
            "Record which riddle a player has been given. Pass riddleId from getRiddles, or raw question+answer if you invented your own riddle. This starts tracking their progress on it.",
            {
                player: {
                    type: "string",
                    description: "Player name.",
                },
                memberNumber: {
                    type: "number",
                    description:
                        "Player member number. Preferred over 'player' when available.",
                },
                riddleId: {
                    type: "string",
                    description:
                        "Id of a riddle returned by getRiddles/getSingleRiddle.",
                },
                question: {
                    type: "string",
                    description:
                        "Question text. Use instead of riddleId if you made up the riddle.",
                },
                answer: {
                    type: "string",
                    description:
                        "Canonical answer. Required when using 'question' instead of 'riddleId'.",
                },
            },
            [],
        ),
        handler: (args, ctx) => {
            const target = resolvePlayer(ctx, args);
            if (!target) {
                return "Error: could not find that player in the room. Pass memberNumber or their exact name.";
            }

            const riddleId =
                typeof args.riddleId === "string" ? args.riddleId.trim() : "";
            if (riddleId) {
                const riddle = options.pool.find((r) => r.id === riddleId);
                if (!riddle) {
                    return `Error: no riddle with id '${riddleId}'. Call getRiddles to see valid ids.`;
                }
                state.assign(target.memberNumber, target.name, riddle);
                options.note(
                    `Riddle assigned to ${target.name}: "${riddle.question}" (answer: ${riddle.answer}).`,
                );
                return [
                    `Recorded: ${target.name} is now solving "${riddle.question}" (answer: ${riddle.answer}).`,
                    `Progress: ${state.progressText(target.memberNumber)}.`,
                ].join("\n");
            }

            const question =
                typeof args.question === "string" ? args.question.trim() : "";
            const answer =
                typeof args.answer === "string" ? args.answer.trim() : "";
            if (!question || !answer) {
                return "Error: pass riddleId, or both question and answer.";
            }

            // A custom riddle gets a deterministic id so it survives restarts.
            const customId = `custom:${Buffer.from(question)
                .toString("base64url")
                .slice(0, 24)}`;
            state.assign(target.memberNumber, target.name, {
                id: customId,
                question,
                answer,
            });
            options.note(
                `Riddle assigned to ${target.name}: "${question}" (answer: ${answer}).`,
            );
            return [
                `Recorded: ${target.name} is now solving "${question}" (answer: ${answer}).`,
                `Progress: ${state.progressText(target.memberNumber)}.`,
            ].join("\n");
        },
    };

    const markRiddleResult: Tool = {
        name: "markRiddleResult",
        category: "riddles",
        definition: def(
            "markRiddleResult",
            "Record your verdict on a player's guess for their current riddle. You decide whether it is correct — the canonical answer is shown in the room state. Set giveUp when the player gives up or you reveal the answer.",
            {
                player: {
                    type: "string",
                    description: "Player name.",
                },
                memberNumber: {
                    type: "number",
                    description:
                        "Player member number. Preferred over 'player' when available.",
                },
                correct: {
                    type: "boolean",
                    description:
                        "True if the player solved it, false otherwise.",
                },
                guessedAnswer: {
                    type: "string",
                    description:
                        "What the player actually guessed, for the record.",
                },
                giveUp: {
                    type: "boolean",
                    description:
                        "True when the player gives up or the answer is revealed. Marks the riddle as failed instead of counting another wrong attempt.",
                },
                reason: {
                    type: "string",
                    description: "Short note on why you judged it that way.",
                },
            },
            ["correct"],
        ),
        handler: (args, ctx) => {
            const target = resolvePlayer(ctx, args);
            if (!target) {
                return "Error: could not find that player. Pass memberNumber or their exact name.";
            }
            if (typeof args.correct !== "boolean") {
                return "Error: 'correct' must be true or false.";
            }

            const result = state.markResult(target.memberNumber, args.correct, {
                giveUp: args.giveUp === true,
            });
            if (!result) {
                return `${target.name} has no riddle in progress. Assign one first with assignRiddle or getSingleRiddle.`;
            }

            const guess =
                typeof args.guessedAnswer === "string" &&
                args.guessedAnswer.trim()
                    ? ` They guessed "${args.guessedAnswer.trim()}".`
                    : "";
            const reason =
                typeof args.reason === "string" && args.reason.trim()
                    ? ` Reason: ${args.reason.trim()}`
                    : "";

            if (result.outcome === "solved") {
                options.note(
                    `${target.name} solved their riddle (${result.solved}/${result.goal} solved).${guess}${reason}`,
                );
                const lines = [
                    `${target.name} SOLVED it.${guess}`,
                    `Progress: ${result.solved}/${result.goal} solved.`,
                ];
                if (result.goalReached) {
                    lines.push(
                        `They reached the goal of ${result.goal}! Congratulate them and offer a fresh challenge or a reward.`,
                    );
                } else {
                    lines.push(
                        "Clear the riddle with clearRiddle or assign the next one.",
                    );
                }
                return lines.join("\n");
            }

            if (result.outcome === "failed") {
                options.note(
                    `${target.name} gave up on their riddle (${result.record.failedCount} given up total).${reason}`,
                );
                return [
                    `Marked as failed for ${target.name}.`,
                    `Progress: ${result.solved}/${result.goal} solved, ${result.record.failedCount} given up.`,
                    "Reveal the answer in character if you have not already, then offer a new riddle.",
                ].join("\n");
            }

            options.note(
                `${target.name} guessed wrong (attempt ${result.record.attempts}).${guess}${reason}`,
            );
            return [
                `Recorded a wrong guess from ${target.name}.${guess}`,
                `Attempt ${result.record.attempts} on this riddle. Progress: ${result.solved}/${result.goal} solved.`,
                "You may hint or let them keep trying.",
            ].join("\n");
        },
    };

    const getRiddleStatus: Tool = {
        name: "getRiddleStatus",
        category: "riddles",
        definition: def(
            "getRiddleStatus",
            "Check riddle progress: for one player (with their current riddle and answer) or for everyone (leaderboard). Use it before asking a riddle, or when a player asks how they are doing.",
            {
                player: {
                    type: "string",
                    description: "Player name. Omit for the full leaderboard.",
                },
                memberNumber: {
                    type: "number",
                    description: "Player member number. Preferred over 'player'.",
                },
            },
        ),
        handler: (args, ctx) => {
            const target = resolvePlayer(ctx, args);
            const lines: string[] = [];

            if (target) {
                const record = state.peek(target.memberNumber);
                lines.push(
                    `${target.name}: ${state.progressText(target.memberNumber)} (goal ${state.getGoal()}).`,
                );
                if (!record) {
                    lines.push("They have not been asked a riddle yet.");
                } else if (record.state === "asked" && record.question) {
                    lines.push(`Current riddle: "${record.question}"`);
                    if (options.revealAnswers && record.answer) {
                        lines.push(`Answer: ${record.answer}`);
                    }
                    lines.push(`Wrong attempts so far: ${record.attempts}.`);
                } else if (record.state === "solved") {
                    lines.push("Their last riddle was solved.");
                } else if (record.state === "failed") {
                    lines.push("Their last riddle was given up on.");
                } else {
                    lines.push("They are idle, ready for a new riddle.");
                }
                return lines.join("\n");
            }

            const board = state.leaderboard(10);
            lines.push(`Riddle leaderboard (goal ${state.getGoal()}):`);
            if (board.length === 0) {
                lines.push("Nobody has played yet.");
            } else {
                board.forEach((entry, i) => {
                    lines.push(
                        `${i + 1}. ${entry.name} — ${entry.solved}/${state.getGoal()} solved` +
                            (entry.failed > 0 ? `, ${entry.failed} given up` : ""),
                    );
                });
            }

            const active = state
                .all()
                .filter((p) => p.record.state === "asked");
            if (active.length > 0) {
                lines.push("", "Currently working on a riddle:");
                for (const { record } of active) {
                    lines.push(
                        `- ${record.name}: "${record.question}"` +
                            (options.revealAnswers && record.answer
                                ? ` (answer: ${record.answer})`
                                : ""),
                    );
                }
            }
            return lines.join("\n");
        },
    };

    const clearRiddle: Tool = {
        name: "clearRiddle",
        category: "riddles",
        definition: def(
            "clearRiddle",
            "Clear a finished riddle so the player is ready for the next one. Optional — assigning a new riddle clears the old one automatically.",
            {
                player: { type: "string", description: "Player name." },
                memberNumber: {
                    type: "number",
                    description: "Player member number. Preferred over 'player'.",
                },
            },
        ),
        handler: (args, ctx) => {
            const target = resolvePlayer(ctx, args);
            if (!target) return "Error: could not find that player.";
            state.clearRiddle(target.memberNumber);
            return `${target.name} is ready for a new riddle. Progress: ${state.progressText(target.memberNumber)}.`;
        },
    };

    return [
        getRiddles,
        getSingleRiddle,
        assignRiddle,
        markRiddleResult,
        getRiddleStatus,
        clearRiddle,
    ];
}
