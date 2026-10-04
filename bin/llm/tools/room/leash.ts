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

export const leashTool: Tool = {
    name: "leash",
    definition: def(
        "leash",
        "Hold or release a character's leash. Holding the leash prevents the target from leaving the room and forces them to follow you around the map and into other chat rooms. Release the leash when you no longer need to control their movement.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            action: {
                type: "string",
                enum: ["hold", "release"],
                description: "'hold' to take the leash, 'release' to let go",
            },
        },
        ["memberNumber", "action"],
    ),
    handler: (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const action = args.action as string;
        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;
        const restrained = requireUnrestrained(ctx);
        if (restrained) return restrained;
        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;

        // Find a leash item in any slot. The static "Leash" effect lives in
        // the asset definition, not the runtime Property.Effect (which the
        // server does not populate on sync), so check the asset def.
        const leashItem = target.Appearance.allItems().find((item) => {
            const def = item.getAssetDef();
            return def?.Effect?.includes("Leash") ?? false;
        });
        if (!leashItem)
            return `Error: ${displayName(target)} has no leash item in any slot.`;

        if (action === "hold") {
            // Push IsLeashed effect to the server so the client shows the leash; maybe redundant
            const effects = leashItem.getEffects();
            if (!effects.includes("IsLeashed")) {
                leashItem.setProperty("Effect", [...effects, "IsLeashed"]);
            }
            // Msg that leashes
            ctx.conn.SendMessage("Hidden", "HoldLeash", memberNumber);
            ctx.leashed.set(memberNumber, Date.now());
            return `Holding ${displayName(target)}'s leash. They must now follow you.`;
        }
        if (action === "release") {
            // Remove IsLeashed effect
            const effects = leashItem.getEffects();
            if (effects.includes("IsLeashed")) {
                leashItem.setProperty(
                    "Effect",
                    effects.filter((e) => e !== "IsLeashed"),
                );
            }
            ctx.conn.SendMessage("Hidden", "StopHoldLeash", memberNumber);
            ctx.leashed.delete(memberNumber);
            return `Released ${displayName(target)}'s leash.`;
        }
        return "Error: action must be 'hold' or 'release'.";
    },
};
