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
 * `markRiddleResult` — the LLM's verdict on a guess.
 *
 * The model is the sole judge: it reads the canonical answer out of the room
 * snapshot and decides. This tool performs no matching of its own, it only
 * applies the consequence and reports back progress the model can narrate.
 *
 * Three outcomes:
 *  - correct        -> solved (deduped against the player's solved set)
 *  - wrong          -> stays asked, attempts += 1
 *  - wrong + giveUp -> failed, failedCount += 1
 */
export function createMarkRiddleResultTool(
    state: RiddleState,
    options: RiddleToolOptions,
): Tool {
    return {
        name: "markRiddleResult",
        category: "riddles",
        history: "action",
        definition: def(
            "markRiddleResult",
            "Record your verdict on a player's guess for their current riddle. You decide whether it is correct — the canonical answer is shown in the room state. Set giveUp when the player gives up or you reveal the answer.",
            {
                ...PLAYER_PARAMS,
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
                const lines = [
                    `${target.name} SOLVED their riddle.${guess}${reason}`,
                    `Progress: ${result.solved}/${result.goal} solved.`,
                ];
                if (result.goalReached) {
                    lines.push(`Goal of ${result.goal} reached.`);
                }
                return lines.join("\n");
            }

            if (result.outcome === "failed") {
                return [
                    `Marked as failed for ${target.name}.${reason}`,
                    `Progress: ${result.solved}/${result.goal} solved, ${result.record.failedCount} given up.`,
                ].join("\n");
            }

            return [
                `Recorded a wrong guess from ${target.name}.${guess}${reason}`,
                `Attempt ${result.record.attempts} on this riddle. Progress: ${result.solved}/${result.goal} solved.`,
            ].join("\n");
        },
    };
}
