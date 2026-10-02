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

export const stripAllTool: Tool = {
    name: "stripAll",
    definition: def(
        "stripAll",
        "Remove ALL clothing from a character, applied one-by-one with pacing to avoid anti-cheat. Does not remove restraints.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
        },
        ["memberNumber"],
    ),
    handler: async (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;
        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;
        await target.Appearance.slowlyStripBulk(
            {
                appearance: false,
                bodyCosplay: false,
                clothing: true,
                item: false,
            },
            true,
        );
        return `Stripped all clothes from ${target.Name}.`;
    },
};
