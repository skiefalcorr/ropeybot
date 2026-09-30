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

const SPACES = ["X", "M", "Asylum", ""] as const;

export const searchRoomsTool: Tool = {
    name: "searchRooms",
    category: "room",
    definition: def(
        "searchRooms",
        "Search for public chat rooms on the server by name/description. Returns a list of rooms with their name, description, member count, and whether the bot can join. Use joinRoom to enter one.",
        {
            query: {
                type: "string",
                description:
                    "Search term to match against room names/descriptions. Empty string lists all rooms.",
            },
            space: {
                type: "string",
                enum: [...SPACES],
                description:
                    "Room space to search in. 'X' = main space, 'M' = map rooms, 'Asylum' = asylum, '' = default. Default: 'X'.",
            },
            limit: {
                type: "number",
                description: "Max results to return (default 20)",
            },
        },
        ["query"],
    ),
    handler: async (args, ctx) => {
        const query = String(args.query ?? "");
        const space = (args.space as string) ?? "X";
        const limit = Math.min(Number(args.limit ?? 20), 50);

        let results;
        try {
            results = await ctx.conn.searchRooms(query, space as never);
        } catch (e) {
            return `Error searching rooms: ${String(e)}`;
        }

        if (results.length === 0) {
            return `No rooms found for query '${query}' in space '${space}'.`;
        }

        const lines = results.slice(0, limit).map((r) => {
            const joinable = r.CanJoin ? "" : " [cannot join]";
            return `- ${r.Name} (${r.MemberCount}/${r.MemberLimit})${joinable}: ${r.Description.slice(0, 100)}`;
        });
        return `${results.length} rooms found (showing ${Math.min(results.length, limit)}):\n${lines.join("\n")}`;
    },
};
