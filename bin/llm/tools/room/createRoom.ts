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

import { type RoomDefinition } from "bc-bot";
import { Tool, def, checkRateLimit, pingLeashed } from "../shared";

const SPACES = ["X", "M", "Asylum", ""] as const;
const GAMES = [
    "",
    "ClubCard",
    "LARP",
    "MagicBattle",
    "GGTS",
    "Prison",
] as const;
const LANGUAGES = ["EN", "DE", "FR", "ES", "CN", "RU", "UA"] as const;
const ROLES = ["All", "Admin", "Whitelist"] as const;

export const createRoomTool: Tool = {
    name: "createRoom",
    category: "room",
    definition: def(
        "createRoom",
        "Create a new chat room and enter it. If you want to take anyone with you, you need to leash them first. Unspecified settings are inherited from the bot's configured room. The bot is automatically added as an admin of the new room.",
        {
            name: {
                type: "string",
                description: "Name of the room to create (required; accepts letters, numbers and spaces; no apostrophes)",
            },
            description: {
                type: "string",
                description:
                    "Room description. Defaults to the configured room's description.",
            },
            background: {
                type: "string",
                description:
                    "Background asset name. Defaults to the configured room's background.",
            },
            // space: {
            //     type: "string",
            //     enum: [...SPACES],
            //     description:
            //         "Room space. 'X' = main space, 'M' = map rooms, 'Asylum' = asylum, '' = default.",
            // },
            // game: {
            //     type: "string",
            //     enum: [...GAMES],
            //     description: "Room game mode. '' = no game.",
            // },
            // language: {
            //     type: "string",
            //     enum: [...LANGUAGES],
            //     description: "Room language code.",
            // },
            limit: {
                type: "number",
                description: "Maximum number of members allowed in the room.",
            },
            // access: {
            //     type: "string",
            //     description:
            //         "Who may enter and leave: 'All', 'Admin' or 'Whitelist', comma-separated. 'Admin' or 'Whitelist' to lock a room.",
            // },
            // visibility: {
            //     type: "string",
            //     description:
            //         "Who can see the room in search: 'All', 'Admin' or 'Whitelist', comma-separated.",
            // },
            private: {
                type: "boolean",
                description:
                    "Whether the room is private (hidden from search).",
            },
            locked: {
                type: "boolean",
                description: "Whether the room is locked (no entry or exit except for admins).",
            },
        },
        ["name"],
    ),
    handler: async (args, ctx) => {
        const name = String(args.name ?? "").trim().replace(/'/g, '');
        if (!name) return "Error: room name is required.";
        const limited = checkRateLimit(ctx);
        if (limited) return limited;

        // If the bot is already in a room with this name, there is nothing to
        // do. Without this guard the LLM would retry createRoom forever, since
        // the server rejects creating a room whose name already exists.
        const currentRoom = ctx.conn.chatRoom;
        if (
            currentRoom &&
            currentRoom.Name.trim().toLowerCase() === name.toLowerCase()
        ) {
            return `Already in room '${currentRoom.Name}'. No new room was created; nothing to do.`;
        }

        const base = ctx.room;
        const parseRoles = (
            value: unknown,
            fallback: RoomDefinition["Access"],
        ): RoomDefinition["Access"] => {
            if (typeof value !== "string" || !value.trim()) return fallback;
            return value
                .split(",")
                .map((s) => s.trim())
                .filter((s): s is RoomDefinition["Access"][number] =>
                    (ROLES as readonly string[]).includes(s),
                );
        };

        // The server rejects create requests that include Access/Visibility
        // (InvalidRoomData), so only send them when explicitly requested.
        const roomDef: RoomDefinition = {
            Name: name,
            Description:
                typeof args.description === "string" && args.description
                    ? args.description
                    : base.Description,
            Background:
                typeof args.background === "string" && args.background
                    ? args.background
                    : base.Background,
            Private:
                typeof args.private === "boolean" ? args.private : base.Private,
            Locked:
                typeof args.locked === "boolean" ? args.locked : base.Locked,
            Space:
                typeof args.space === "string"
                    ? (args.space as RoomDefinition["Space"])
                    : base.Space,
            Admin: [...(base.Admin ?? [])],
            Ban: [...(base.Ban ?? [])],
            Limit: typeof args.limit === "number" ? args.limit : base.Limit,
            BlockCategory: [...(base.BlockCategory ?? [])],
            Game:
                typeof args.game === "string"
                    ? (args.game as RoomDefinition["Game"])
                    : base.Game,
            Language:
                typeof args.language === "string"
                    ? (args.language as RoomDefinition["Language"])
                    : base.Language,
        };
        // if (typeof args.access === "string" && args.access.trim()) {
        //     roomDef.Access = parseRoles(args.access, ["All"]);
        // }
        // if (typeof args.visibility === "string" && args.visibility.trim()) {
        //     roomDef.Visibility = parseRoles(args.visibility, ["All"]);
        // }

        // Store the current room's definition so we can return to it if the
        // create fails. Access/Visibility are stripped because the server
        // rejects create requests that include them (InvalidRoomData).
        const oldRoomDef: RoomDefinition | undefined = currentRoom
            ? (() => {
                  const info = currentRoom.ToInfo() as RoomDefinition;
                  delete info.Access;
                  delete info.Visibility;
                  return info;
              })()
            : undefined;

        // // Leave the current room first so leashed characters follow the bot
        // // into the new room.
        // if (currentRoom) {
        //     ctx.conn.ChatRoomLeave();
        // }

        const ok = await ctx.conn.ChatRoomCreate(roomDef);
        if (!ok) {
            // Fall back to the previous room so the bot isn't left stranded.
            // if (oldRoomDef) {
            //     await ctx.conn.joinOrCreateRoom(oldRoomDef);
            //     return `Failed to create room '${name}'. Returned to '${oldRoomDef.Name}'.`;
            // }
            return `Failed to create room '${name}' — a room with that name likely already exists. Use the joinRoom tool to enter it instead of retrying createRoom.`;
        }
        // Ping leashed characters so they follow the bot into the new room.
        pingLeashed(ctx);
        return `Created and joined room '${name}'. The bot is an admin of it.`;
    },
};
