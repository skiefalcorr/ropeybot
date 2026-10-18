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

import type { Tool } from "../shared";
import type { RiddleState } from "../../../games/riddles/riddleState";
import { createGetRiddlesTool } from "./getRiddles";
import { createGetSingleRiddleTool } from "./getSingleRiddle";
import { createAssignRiddleTool } from "./assignRiddle";
import { createMarkRiddleResultTool } from "./markRiddleResult";
import { createGetRiddleStatusTool } from "./getRiddleStatus";
import { createClearRiddleTool } from "./clearRiddle";
import type { RiddleToolOptions } from "./shared";

export type { RiddleToolOptions } from "./shared";
export {
    PLAYER_PARAMS,
    formatRiddle,
    resolvePlayer,
    type ResolvedPlayer,
} from "./shared";

/**
 * Build the riddle tool set.
 *
 * Deliberately a factory rather than a static array: every handler closes over
 * this activity's {@link RiddleState} and riddle pool, so `ToolContext` needs
 * no riddle-specific fields and a second activity can never collide with
 * these tools.
 *
 * Each tool lives in its own file, mirroring the one-tool-per-file layout of
 * the base tool folders. Adding a tool means: write `createXTool`, then add
 * it to the array below.
 */
export function createRiddleTools(
    state: RiddleState,
    options: RiddleToolOptions,
): Tool[] {
    return [
        createGetRiddlesTool(state, options),
        createGetSingleRiddleTool(state, options),
        createAssignRiddleTool(state, options),
        createMarkRiddleResultTool(state, options),
        createGetRiddleStatusTool(state, options),
        createClearRiddleTool(state, options),
    ];
}
