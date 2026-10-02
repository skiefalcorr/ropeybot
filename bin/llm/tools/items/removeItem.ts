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
    findCharacter,
    isProtected,
    requireParticipant,
    checkRateLimit,
} from "../shared";

export const removeItemTool: Tool = {
    name: "removeItem",
    definition: def(
        "removeItem",
        "Remove an item from a character by group. Use listItems (restraints/BDSM) or listClothing (clothing/body) to find valid group names.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            group: {
                type: "string",
                description: "Asset group to clear, e.g. 'ItemMouth'",
            },
        },
        ["memberNumber", "group"],
    ),
    handler: (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const group = args.group as string;
        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;
        const existing = target.Appearance.InventoryGet(group as never);
        if (!existing) return `Character has no item in group '${group}'.`;
        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;
        target.Appearance.RemoveItem(group as never);

        //chat msg
        const botMember = ctx.conn.Player.MemberNumber;
        ctx.conn.SendMessage("Action" as never, "ActionRemove", undefined, [
            { SourceCharacter: botMember },
            {
                Tag: "DestinationCharacter",
                MemberNumber: memberNumber,
                Text: target.Name,
            },
            { TargetCharacter: memberNumber },
            {
                Tag: "PrevAsset",
                AssetName: existing.getData().Name,
                GroupName: group,
            },
            { Tag: "FocusAssetGroup", FocusGroupName: group },
        ]);

        return `Removed ${group} from ${target.Name}.`;
    },
};
