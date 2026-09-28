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

import { AssetGet, BC_AppearanceItem, isBind } from "bc-bot";
import {
    Tool,
    def,
    findCharacter,
    isProtected,
    requireParticipant,
    checkRateLimit,
} from "../shared";
import { validateAsset } from "../catalog";

export const addItemTool: Tool = {
    name: "addItem",
    definition: def(
        "addItem",
        "Add an item (restraint, clothing, etc.) to a character. Use listItems (restraints/BDSM) or listClothing (clothing/body) to find valid group/asset names. The item is automatically colored; pass color1/color2 to override. Optionally set a craft name/description so the item shows up as a named craft.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            group: {
                type: "string",
                description: "Asset group, e.g. 'ItemMouth', 'Cloth'",
            },
            asset: {
                type: "string",
                description: "Asset name within the group, e.g. 'Gag'",
            },
            color1: {
                type: "string",
                description:
                    "Override for the item's first color (default: the character's hair color). Hex like '#FF0000' or a named color like 'Red'.",
            },
            color2: {
                type: "string",
                description:
                    "Override for the item's second color (default: the character's eye color). Hex like '#00FF00' or a named color like 'Blue'.",
            },
            craftName: {
                type: "string",
                description:
                    "Optional craft name for the item, e.g. 'Silk Gag'.",
            },
            craftDescription: {
                type: "string",
                description: "Optional craft description for the item.",
            },
        },
        ["memberNumber", "group", "asset"],
    ),
    handler: async (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const group = args.group as string;
        const asset = args.asset as string;
        const color1 = args.color1 as string | undefined;
        const color2 = args.color2 as string | undefined;
        const craftName = args.craftName as string | undefined;
        const craftDescription = args.craftDescription as string | undefined;
        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;
        const grp = validateAsset(group, asset);
        if (!grp)
            return `Error: '${group}:${asset}' is not a valid item. Use listItems or listClothing to find valid names.`;

        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;

        const item: BC_AppearanceItem = AssetGet(group as never, asset);
        try {
            if (isBind(item)) {
                // Paced, anti-cheat-safe application.
                await target.Appearance.slowlyApplyBundle([item]);
            } else {
                target.Appearance.AddItem(item);
            }

            // Color the item after the character's hair/eyes (or the
            // explicit overrides), then optionally mark it as a craft.
            const applied = target.Appearance.InventoryGet(group as never);
            if (applied) {
                applied.setColorFromCharacter(color1, color2);
                if (craftName !== undefined || craftDescription !== undefined) {
                    applied.SetCraft({
                        Name: craftName ?? "",
                        Description: craftDescription ?? "",
                    });
                }
            }

            return `Added ${group}:${asset} to ${target.Name}.`;
        } catch (e) {
            return `Error adding item: ${String(e)}`;
        }
    },
};
