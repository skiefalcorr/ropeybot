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

import { Tool, def } from "../shared";
import type { RiddleState } from "../../../games/riddles/riddleState";
import { PLAYER_PARAMS, resolvePlayer, type RiddleToolOptions } from "./shared";

/**
 * `getRiddleStatus` — one player's detail, or the full leaderboard.
 *
 * Used by the model before asking a riddle (to avoid a riddle the player
 * already solved) and when a player asks how they are doing. Whether the
 * answer is included follows `options.revealAnswers`.
 */
export function createGetRiddleStatusTool(
    state: RiddleState,
    options: RiddleToolOptions,
): Tool {
    return {
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
                memberNumber: PLAYER_PARAMS.memberNumber,
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

            const goal = state.getGoal();
            const board = state.leaderboard(10);
            lines.push(`Riddle leaderboard (goal ${goal}):`);
            if (board.length === 0) {
                lines.push("Nobody has played yet.");
            } else {
                board.forEach((entry, i) => {
                    lines.push(
                        `${i + 1}. ${entry.name} — ${entry.solved}/${goal} solved` +
                            (entry.failed > 0
                                ? `, ${entry.failed} given up`
                                : ""),
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
}
