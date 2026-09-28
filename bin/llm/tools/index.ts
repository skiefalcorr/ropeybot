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

import { LLMConfig } from "../../config";
import { Tool, ToolContext } from "./shared";
import { CLOTHING_GROUPS } from "./catalog";

import { sendMessageTool } from "./communication/sendMessage";
import { endTurnTool } from "./communication/endTurn";
import { listItemsTool } from "./discovery/listItems";
import { listClothingTool } from "./discovery/listClothing";
import { listPosesTool } from "./discovery/listPoses";
import { addItemTool } from "./items/addItem";
import { removeItemTool } from "./items/removeItem";
import { stripAllTool } from "./items/stripAll";
import { lockItemTool } from "./modification/lockItem";
import { setPoseTool } from "./body/setPose";
import { setExpressionTool } from "./body/setExpression";
import { leashTool } from "./room/leash";
import { moveSelfTool } from "./map/moveSelf";

export { Tool, ToolContext } from "./shared";
export { CLOTHING_GROUPS } from "./catalog";

export function buildTools(): Tool[] {
    return [
        // Communication
        sendMessageTool,
        // Item discovery
        listItemsTool,
        listClothingTool,
        listPosesTool,
        // Item manipulation
        addItemTool,
        removeItemTool,
        stripAllTool,
        // Poses & expressions
        setPoseTool,
        setExpressionTool,
        // Locks
        lockItemTool,
        // Movement (self)
        moveSelfTool,
        // Turn control
        endTurnTool,
        // Leash
        leashTool,
    ];
}

/**
 * Resolve the set of tools the LLM is allowed to use, based on config
 * allowedTools / deniedTools.
 */
export function resolveTools(all: Tool[], config: LLMConfig): Tool[] {
    const denied = new Set(config.deniedTools ?? []);
    let tools = all.filter((t) => !denied.has(t.name));
    if (config.allowedTools && config.allowedTools.length > 0) {
        const allowed = new Set(config.allowedTools);
        tools = tools.filter((t) => allowed.has(t.name));
    }
    return tools;
}
