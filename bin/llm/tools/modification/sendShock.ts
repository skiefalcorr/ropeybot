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
    API_AppearanceItem,
    AssetGet,
    getExtendedAssetDef,
} from "bc-bot";
import {
    Tool,
    def,
    findCharacter,
    isProtected,
    requireParticipant,
    checkRateLimit,
} from "../shared";

/**
 * Debug switch for the two sendShock code paths:
 *  - true  (PATH 1): send the "Set{Low|Medium|High}" level message first,
 *    then the "TriggerShock{level}" message. Mirrors the full example
 *    sequence captured from the client.
 *  - false (PATH 2): only send the "TriggerShock{level}" message. Assumes
 *    the collar's level is already set; matches the note that extended
 *    shock items likely only react to TriggerShock.
 */
const SEND_SET_LEVEL_MESSAGE = true;

/**
 * Human-readable level names used in the "Set{...}" message content.
 * Index = shock level (0/1/2).
 */
const LEVEL_NAMES = ["Low", "Medium", "High"] as const;

/**
 * Shock intensity value sent in the TriggerShock dictionary per level.
 * Level 0 omits the field entirely (matches the example).
 */
const SHOCK_INTENSITY: Record<number, number | undefined> = {
    0: undefined,
    1: 1.5,
    2: 3,
};

/**
 * Detect whether an item can administer shocks.
 *
 * Shock items are extended items whose config (typed `Options` or modular
 * `Modules`) carries a `ShockLevel` property. We read the extended asset
 * definition at runtime rather than loading the large catalog files.
 */
export function isShockItem(item: API_AppearanceItem): boolean {
    const config = getExtendedAssetDef(
        AssetGet(item.Group as never, item.Name),
    );
    if (!config) return false;

    const hasShockLevel = (prop: unknown): boolean =>
        !!prop &&
        typeof prop === "object" &&
        "ShockLevel" in (prop as Record<string, unknown>);

    // Typed items: Options[].Property
    const options = (config as { Options?: { Property?: unknown }[] }).Options;
    if (options?.some((o) => hasShockLevel(o.Property))) return true;

    // Modular items: Modules[].Options[].Property
    const modules = (config as { Modules?: { Options?: { Property?: unknown }[] }[] })
        .Modules;
    if (modules?.some((m) => m.Options?.some((o) => hasShockLevel(o.Property))))
        return true;

    return false;
}

export const sendShockTool: Tool = {
    name: "sendShock",
    definition: def(
        "sendShock",
        "Send an electric shock to a character wearing a shock item (shock collar, shock plug, shock clamps, etc.). The character must already have the item in the given group. Level: 0 low, 1 medium, 2 high.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            group: {
                type: "string",
                description:
                    "Asset group of the shock item, e.g. 'ItemNeck', 'ItemButt', 'ItemNipples'",
            },
            level: {
                type: "number",
                enum: [0, 1, 2],
                description: "Shock level: 0 low, 1 medium, 2 high",
            },
        },
        ["memberNumber", "group", "level"],
    ),
    handler: (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const group = args.group as string;
        const level = args.level as number;

        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;

        const item = target.Appearance.InventoryGet(group as never);
        if (!item)
            return `Character has no item in group '${group}'. Add one first with addItem.`;

        if (!isShockItem(item))
            return `Item '${group}:${item.Name}' does not appear to be a shock item.`;

        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;

        const botMember = ctx.conn.Player.MemberNumber;
        const assetEntry: Record<string, unknown> = {
            Tag: "AssetName",
            AssetName: item.Name,
            GroupName: group,
        };

        // PATH 1: set the level first (mirrors the client's Set{...} message).
        if (SEND_SET_LEVEL_MESSAGE) {
            const destinationEntry = {
                Tag: "DestinationCharacter",
                MemberNumber: memberNumber,
                Text: target.Name,
            };
            ctx.conn.SendMessage(
                "Action" as never,
                `${group}AccessoriesCollarShockUnitSet${LEVEL_NAMES[level]}`,
                undefined,
                [
                    assetEntry,
                    { SourceCharacter: botMember },
                    destinationEntry,
                ],
            );
        }

        // Trigger the shock (both paths).
        const triggerDict: Record<string, unknown>[] = [
            {
                Tag: "DestinationCharacterName",
                MemberNumber: memberNumber,
                Text: target.Name,
            },
            assetEntry,
        ];
        const intensity = SHOCK_INTENSITY[level];
        if (intensity !== undefined) triggerDict.push({ ShockIntensity: intensity });
        triggerDict.push({
            Tag: "FocusAssetGroup",
            FocusGroupName: group,
        });

        ctx.conn.SendMessage(
            "Action" as never,
            `TriggerShock${level}`,
            undefined,
            triggerDict,
        );

        return `Sent a ${LEVEL_NAMES[level].toLowerCase()} shock to ${target.Name} via ${group}:${item.Name}.`;
    },
};
