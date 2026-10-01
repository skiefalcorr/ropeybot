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

import { Tool, def, checkRateLimit, requireRoomAdmin } from "../shared";

const ROLES = ["All", "Admin", "Whitelist"] as const;
const GAMES = [
    "",
    "ClubCard",
    "LARP",
    "MagicBattle",
    "GGTS",
    "Prison",
] as const;
const LANGUAGES = ["EN", "DE", "FR", "ES", "CN", "RU", "UA"] as const;

export const updateRoomTool: Tool = {
    name: "updateRoom",
    category: "room",
    definition: def(
        "updateRoom",
        "Update settings of the current room. Requires the bot to be an admin of the room. The update is based on the room's current settings, so only the provided fields are changed; all others keep their current values.",
        {
            description: {
                type: "string",
                description: "New room description.",
            },
            background: {
                type: "string",
                description: "New background asset name.",
            },
            access: {
                type: "string",
                description:
                    "Who may enter and leave: 'All', 'Admin' or 'Whitelist', comma-separated. 'Admin' or 'Whitelist' to lock a room.",
            },
            visibility: {
                type: "string",
                description:
                    "Who can see the room in search: 'All', 'Admin' or 'Whitelist', comma-separated.",
            },
            limit: {
                type: "number",
                description: "New maximum member count.",
            },
            // game: {
            //     type: "string",
            //     enum: [...GAMES],
            //     description: "New room game mode. '' = no game.",
            // },
            // language: {
            //     type: "string",
            //     enum: [...LANGUAGES],
            //     description: "New room language code.",
            // },
            blockCategory: {
                type: "string",
                description:
                    "Comma-separated list of blocked content categories, e.g. 'Medical,Extreme,Pony,SciFi,ABDL,Fantasy,Smoking,Leashing,Photos,Arousal,Location'. Empty string clears the list.",
            },
        },
    ),
    handler: async (args, ctx) => {
        const room = ctx.conn.chatRoom;
        if (!room) return "Error: not in a room.";
        const adminErr = requireRoomAdmin(ctx);
        if (adminErr) return adminErr;
        const limited = checkRateLimit(ctx);
        if (limited) return limited;

        // Send the full current room data as a base, then apply overrides.
        const base = room.ToInfo();
        const update: Record<string, unknown> = {
            Description: base.Description,
            Background: base.Background,
            Access: [...base.Access],
            Visibility: [...base.Visibility],
            Limit: base.Limit,
            Game: base.Game,
            Language: base.Language,
            BlockCategory: [...base.BlockCategory],
            Space: base.Space,
            Whitelist: [...base.Whitelist],
            Ban: [...base.Ban],
            Admin: [...base.Admin],
        };

        const parseRoles = (value: string): string[] =>
            value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => (ROLES as readonly string[]).includes(s));

        const changed: string[] = [];
        if (typeof args.description === "string") {
            update.Description = args.description;
            changed.push("Description");
        }
        if (typeof args.background === "string") {
            update.Background = args.background;
            changed.push("Background");
        }
        if (typeof args.limit === "number") {
            update.Limit = args.limit;
            changed.push("Limit");
        }
        if (typeof args.game === "string") {
            update.Game = args.game;
            changed.push("Game");
        }
        if (typeof args.language === "string") {
            update.Language = args.language;
            changed.push("Language");
        }
        if (typeof args.access === "string") {
            update.Access = parseRoles(args.access);
            changed.push("Access");
        }
        if (typeof args.visibility === "string") {
            update.Visibility = parseRoles(args.visibility);
            changed.push("Visibility");
        }
        if (typeof args.blockCategory === "string") {
            update.BlockCategory = args.blockCategory
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            changed.push("BlockCategory");
        }

        if (changed.length === 0) {
            return "Error: no fields provided to update.";
        }

        const result = await ctx.conn.ChatRoomUpdate(update as never);
        if (result === "Updated") {
            return `Updated room '${room.Name}': ${changed.join(", ")}.`;
        }
        return `Error: server rejected the room update (${result}).`;
    },
};
