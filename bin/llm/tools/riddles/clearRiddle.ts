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
 * `clearRiddle` — return a player to idle after a finished riddle.
 *
 * Optional: assigning a new riddle already clears the previous one. This
 * exists so the model can explicitly say "we are done with that one" without
 * having to produce a replacement immediately.
 */
export function createClearRiddleTool(
    state: RiddleState,
    _options: RiddleToolOptions,
): Tool {
    return {
        name: "clearRiddle",
        category: "riddles",
        history: "action",
        definition: def(
            "clearRiddle",
            "Clear a finished riddle so the player is ready for the next one. Optional — assigning a new riddle clears the old one automatically.",
            PLAYER_PARAMS,
        ),
        handler: (args, ctx) => {
            const target = resolvePlayer(ctx, args);
            if (!target) return "Error: could not find that player.";
            state.clearRiddle(target.memberNumber);
            return `${target.name} is ready for a new riddle. Progress: ${state.progressText(target.memberNumber)}.`;
        },
    };
}
