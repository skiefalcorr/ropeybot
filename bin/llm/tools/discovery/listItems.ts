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
import { CATALOG, ITEM_GROUPS, FETISH_NAMES } from "../catalog";

export const listItemsTool: Tool = {
    name: "listItems",
    definition: def(
        "listItems",
        "List available items (restraints and BDSM gear: gags, cuffs, vibrators, shock devices, etc.) as 'group:asset' names so you can use valid names with addItem/removeItem. Optionally filter by group, gender, fetish tag, or a search term.",
        {
            group: {
                type: "string",
                enum: ITEM_GROUPS,
                description:
                    "Filter by asset group, e.g. 'ItemMouth', 'ItemNeck', 'ItemArms'",
            },
            gender: {
                type: "string",
                enum: ["F", "M"],
                description:
                    "Only show items this gender can wear: 'F' for female, 'M' for male. Unisex items (no gender) are always included.",
            },
            fetish: {
                type: "string",
                enum: FETISH_NAMES,
                description:
                    "Only show assets tagged with this fetish, e.g. 'Latex', 'Rope', 'Pet'",
            },
            search: {
                type: "string",
                description:
                    "Case-insensitive substring to match against group or asset names",
            },
            limit: {
                type: "number",
                description: "Max results to return (default 100)",
            },
        },
    ),
    handler: (args) => {
        const group = args.group as string | undefined;
        const gender = args.gender as "F" | "M" | undefined;
        const fetish = args.fetish as string | undefined;
        const search = (args.search as string | undefined)?.toLowerCase();
        const limit = Math.min(Number(args.limit ?? 100), 200);
        const out: string[] = [];
        for (const grp of CATALOG) {
            if (grp.Category !== "Item") continue;
            if (group && grp.Group !== group) continue;
            for (const a of grp.Asset ?? []) {
                const name = typeof a === "string" ? a : a.Name;
                const tags = typeof a === "string" ? undefined : a.Fetish;
                const assetGender = typeof a === "string" ? undefined : a.Gender;
                if (gender && assetGender !== undefined && assetGender !== gender)
                    continue;
                if (fetish && !tags?.includes(fetish)) continue;
                if (
                    search &&
                    !grp.Group.toLowerCase().includes(search) &&
                    !name.toLowerCase().includes(search)
                )
                    continue;
                out.push(
                    tags?.length
                        ? `${grp.Group}:${name} [${tags.join(", ")}]`
                        : `${grp.Group}:${name}`,
                );
                if (out.length >= limit) break;
            }
            if (out.length >= limit) break;
        }
        if (out.length === 0)
            return "No items matched. Try a different group, fetish, or search term.";
        return `${out.length} items:\n${out.join("\n")}`;
    },
};
