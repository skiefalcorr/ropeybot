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

import { Tool, def, displayName, findCharacter } from "../shared";
import {
    currentModuleIndex,
    currentTypedIndex,
    describeOption,
    getExtendedEntry,
} from "./shared";

/**
 * Show what can be configured on an extended item the character is already
 * wearing.
 *
 * Deliberately scoped to one worn slot rather than dumping the whole extended
 * config table: that table is ~800 entries and tens of thousands of lines, and
 * the model only ever needs the options for the item in front of it.
 */
export const listExtendedOptionsTool: Tool = {
    name: "listExtendedOptions",
    lookup: true,
    definition: def(
        "listExtendedOptions",
        "Show the configurable options of an extended item a character is already wearing (items with extra variants such as rope harnesses, chastity belts or pet posts). Returns the option names to pass to setExtendedType. Use after addItem to see what you can tune.",
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
        },
        ["memberNumber", "group"],
    ),
    handler: (args, ctx) => {
        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";

        const group = args.group as string;
        const item = target.Appearance.InventoryGet(group as never);
        if (!item)
            return `No item in group '${group}'. Add one first with addItem.`;

        const entry = getExtendedEntry(group, item.Name);
        if (!entry)
            return `${group}:${item.Name} is a plain item with no configurable options.`;
        if (!entry.configurable)
            return `${group}:${item.Name} is an extended item but has only one variant, so there is nothing to choose between.`;

        const prop = item.getData().Property as
            Record<string, unknown> | undefined;
        const lines: string[] = [];
        lines.push(
            `${group}:${item.Name} on ${displayName(target)} — ${entry.archetype} item.`,
        );

        if (entry.archetype === "typed") {
            const currentIdx = currentTypedIndex(entry, prop);
            lines.push(
                `Current option: ${entry.options[currentIdx]?.Name ?? "unknown"}`,
            );
            lines.push(
                "Pass one of these names as 'option' to setExtendedType:",
            );
            for (const [i, option] of entry.options.entries()) {
                const marker = i === currentIdx ? " (current)" : "";
                lines.push(
                    `  ${option.Name}${marker}${describeOption(option)}`,
                );
            }
        } else if (entry.archetype === "modular") {
            lines.push("Module selections (read-only for now):");
            for (const mod of entry.modules) {
                const currentIdx = currentModuleIndex(entry, mod.Key, prop);
                const choices = mod.Options.map((_option, i) =>
                    i === currentIdx
                        ? `${mod.Key}${i} (current)`
                        : `${mod.Key}${i}`,
                ).join(", ");
                lines.push(`  ${mod.Name} [${mod.Key}]: ${choices}`);
            }
            lines.push(
                "Modular items cannot be reconfigured by the bot yet; only typed items can.",
            );
        } else {
            lines.push(
                "This item's extended archetype is not configurable by the bot.",
            );
        }

        if (prop?.LockedBy) {
            lines.push(
                entry.changeWhenLocked
                    ? "The item is locked, but its option can still be changed."
                    : "The item is locked and its option cannot be changed until it is unlocked.",
            );
        }

        return lines.join("\n");
    },
};
