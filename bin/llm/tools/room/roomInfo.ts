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

export const roomInfoTool: Tool = {
    name: "roomInfo",
    category: "room",
    definition: def(
        "roomInfo",
        "Get the current room's settings and member list: name, description, space, game, access/visibility, admins, banned/whitelisted members, and all characters present.",
        {},
    ),
    handler: (args, ctx) => {
        const room = ctx.conn.chatRoom;
        if (!room) return "Error: not in a room.";

        const info = room.ToInfo();
        const chars = room.characters
            .map((c) => `${c.Name} (${c.MemberNumber})`)
            .join(", ");
        const lines = [
            `Name: ${room.Name}`,
            `Description: ${info.Description}`,
            `Space: ${info.Space}`,
            `Game: ${info.Game || "(none)"}`,
            `Language: ${info.Language}`,
            `Access: ${room.Access.join(", ")}`,
            `Visibility: ${room.Visibility.join(", ")}`,
            `Limit: ${room.Limit}`,
            `Admins: ${room.Admin.join(", ")}`,
            `Whitelist: ${room.Whitelist.join(", ") || "(none)"}`,
            `Ban: ${room.Ban.join(", ") || "(none)"}`,
            `Characters (${room.charactersCount}): ${chars}`,
        ];
        return lines.join("\n");
    },
};
