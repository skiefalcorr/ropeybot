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

import { Tool, def, checkRateLimit } from "../shared";

export const leaveRoomTool: Tool = {
    name: "leaveRoom",
    category: "room",
    definition: def(
        "leaveRoom",
        "Leave the current room. The bot will be outside any room afterwards and can join another with joinRoom or create one with createRoom.",
        {},
    ),
    handler: (args, ctx) => {
        const room = ctx.conn.chatRoom;
        if (!room) return "Error: not in a room.";
        const limited = checkRateLimit(ctx);
        if (limited) return limited;

        ctx.conn.ChatRoomLeave();
        return `Left room '${room.Name}'.`;
    },
};
