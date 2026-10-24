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
 * `assignRiddle` — record which riddle a player is now solving.
 *
 * Two paths on purpose:
 *  - by `riddleId` from `getRiddles` / `getSingleRiddle`, or
 *  - by raw `question` + `answer` when the model made up its own riddle. That
 *    still gets a deterministic id so progress survives a restart.
 *
 * Assignment is allowed from any state: re-assigning implicitly abandons the
 * previous riddle, which is what should happen after an ambiguous guess.
 */
export function createAssignRiddleTool(
    state: RiddleState,
    options: RiddleToolOptions,
): Tool {
    return {
        name: "assignRiddle",
        category: "riddles",
        history: "action",
        definition: def(
            "assignRiddle",
            "Record which riddle a player has been given. Pass riddleId from getRiddles, or raw question+answer if you invented your own riddle. This starts tracking their progress on it.",
            {
                ...PLAYER_PARAMS,
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
            return [
                `Recorded: ${target.name} is now solving "${question}" (answer: ${answer}).`,
                `Progress: ${state.progressText(target.memberNumber)}.`,
            ].join("\n");
        },
    };
}
