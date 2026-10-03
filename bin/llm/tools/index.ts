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
import { setVibratorTool } from "./modification/setVibrator";
import { sendShockTool } from "./modification/sendShock";
import { setPoseTool } from "./body/setPose";
import { setExpressionTool } from "./body/setExpression";
import { leashTool } from "./room/leash";
import { searchRoomsTool } from "./room/searchRooms";
import { roomInfoTool } from "./room/roomInfo";
import { joinRoomTool } from "./room/joinRoom";
import { leaveRoomTool } from "./room/leaveRoom";
import { createRoomTool } from "./room/createRoom";
import { updateRoomTool } from "./room/updateRoom";
import { roomAdminTool } from "./room/roomAdmin";
import { moveSelfTool } from "./map/moveSelf";

export { Tool, ToolContext, displayName } from "./shared";
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
        // Vibrator control
        setVibratorTool,
        // Shock control
        sendShockTool,
        // Movement (self)
        moveSelfTool,
        // Turn control
        endTurnTool,
        // Leash
        leashTool,
        // Room management
        searchRoomsTool,
        roomInfoTool,
        joinRoomTool,
        leaveRoomTool,
        createRoomTool,
        updateRoomTool,
        roomAdminTool,
    ];
}

/**
 * Resolve the set of tools the LLM is allowed to use, based on config
 * allowedTools / deniedTools. The "room" category (room discovery, join,
 * create, leave, modify, admin) is only included when `roomTools` is not
 * explicitly disabled.
 */
export function resolveTools(all: Tool[], config: LLMConfig): Tool[] {
    const denied = new Set(config.deniedTools ?? []);
    let tools = all.filter(
        (t) =>
            !denied.has(t.name) &&
            (t.category !== "room" || config.roomTools !== false),
    );
    if (config.allowedTools && config.allowedTools.length > 0) {
        const allowed = new Set(config.allowedTools);
        tools = tools.filter((t) => allowed.has(t.name));
    }
    return tools;
}
