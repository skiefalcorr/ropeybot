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
import { pickRandomRiddles } from "../../../games/riddles/riddleStore";
import type { RiddleState } from "../../../games/riddles/riddleState";
import { PLAYER_PARAMS, resolvePlayer, type RiddleToolOptions } from "./shared";

/**
 * `getSingleRiddle` — one riddle, optionally assigned in the same call.
 *
 * This is the low-effort path: when the model loses the thread in a busy
 * roleplay it can ask for one riddle and have it recorded for a player
 * without a second tool call. With no player, it just returns a riddle and
 * leaves assignment to `assignRiddle`.
 */
export function createGetSingleRiddleTool(
    state: RiddleState,
    options: RiddleToolOptions,
): Tool {
    return {
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
                memberNumber: PLAYER_PARAMS.memberNumber,
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
}
