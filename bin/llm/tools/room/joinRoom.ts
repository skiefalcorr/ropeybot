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

import { Tool, def, checkRateLimit, pingLeashed } from "../shared";

export const joinRoomTool: Tool = {
    name: "joinRoom",
    category: "room",
    definition: def(
        "joinRoom",
        "Leave the current room and join another room by its exact name. Use searchRooms to find valid room names first. The bot will be in the new room afterwards. If you want to take anyone with you, you need to leash them first.",
        {
            name: {
                type: "string",
                description: "Exact name of the room to join",
            },
        },
        ["name"],
    ),
    handler: async (args, ctx) => {
        const name = String(args.name ?? "").trim();
        if (!name) return "Error: room name is required.";
        const limited = checkRateLimit(ctx);
        if (limited) return limited;

        const room = ctx.conn.chatRoom;
        if (room && room.Name === name) {
            return `Already in room '${name}'.`;
        }

        ctx.conn.ChatRoomLeave();
        const ok = await ctx.conn.ChatRoomJoin(name);
        if (!ok) {
            return `Failed to join room '${name}'. It may be locked, full, or not exist.`;
        }
        // Ping leashed characters so they follow the bot into the new room.
        pingLeashed(ctx);
        return `Joined room '${name}'.`;
    },
};
