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

import {
    Tool,
    def,
    displayName,
    findCharacter,
    isProtected,
    requireParticipant,
    requireUnrestrained,
    checkRateLimit,
} from "../shared";
import { applyTypedOption, getExtendedEntry } from "./shared";

/**
 * Change the variant of a `typed` extended item that a character is wearing.
 *
 * No chat Action message is emitted: the queued appearance update already
 * reaches the room, and a synthetic ActionUse would read back as "the item was
 * applied again" and pollute the bot's own action parsing. The returned string
 * is recorded in history instead.
 */
export const setExtendedTypeTool: Tool = {
    name: "setExtendedType",
    history: "action",
    definition: def(
        "setExtendedType",
        "Change the variant/option of an extended item a character is already wearing — items with several configurations such as 'ItemTorso:HempRopeHarness' (Crotch, Waist, Harness, Star, Diamond, Hishi, Unity) or chastity belts. The item must already be equipped; use listExtendedOptions to see the valid option names for it.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            group: {
                type: "string",
                description:
                    "Asset group of the worn item, e.g. 'ItemTorso', 'ItemPelvis'",
            },
            option: {
                type: "string",
                description:
                    "Exact option name to select, as reported by listExtendedOptions",
            },
        },
        ["memberNumber", "group", "option"],
    ),
    handler: (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const group = args.group as string;
        const option = args.option as string;

        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;
        const restrained = requireUnrestrained(ctx);
        if (restrained) return restrained;

        const item = target.Appearance.InventoryGet(group as never);
        if (!item)
            return `Character has no item in group '${group}'. Add one first with addItem.`;

        const entry = getExtendedEntry(group, item.Name);
        if (!entry)
            return `${group}:${item.Name} is a plain item with no configurable options — nothing to change.`;
        if (entry.archetype !== "typed")
            return `${group}:${item.Name} is a ${entry.archetype} extended item; only typed items can be configured. Use listExtendedOptions to inspect it.`;

        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;

        const result = applyTypedOption(item, option);
        if (!result.ok) {
            // applyTypedOption already names the valid options when there are
            // any to name, so the model can retry in the same turn.
            return `Error: ${result.error}`;
        }

        return `Set ${group}:${item.Name} on ${displayName(target)}: ${result.before ?? "default"} → ${result.after}.`;
    },
};
