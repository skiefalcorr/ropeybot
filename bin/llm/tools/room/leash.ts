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

export const leashTool: Tool = {
    name: "leash",
    definition: def(
        "leash",
        "Hold or release a character's leash (works in map rooms). Holding the leash prevents the target from leaving the room and forces them to follow you around the map and into other chat rooms. Release the leash when you no longer need to control their movement.",
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
        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;

        if (action === "hold") {
            //if (ctx.leashed.has(memberNumber))
            //return `Already holding ${target.Name}'s leash.`;
            ctx.conn.SendMessage("Hidden", "HoldLeash", memberNumber);
            ctx.leashed.set(memberNumber, Date.now());
            return `Holding ${target.Name}'s leash. They must now follow you.`;
        }
        if (action === "release") {
            //if (!ctx.leashed.has(memberNumber))
            //return `Not holding ${target.Name}'s leash.`;
            ctx.conn.SendMessage("Hidden", "StopHoldLeash", memberNumber);
            ctx.leashed.delete(memberNumber);
            return `Released ${target.Name}'s leash.`;
        }
        return "Error: action must be 'hold' or 'release'.";
    },
};
