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

export const setExpressionTool: Tool = {
    name: "setExpression",
    definition: def(
        "setExpression",
        "Set a facial expression on a character (requires the character to have an item in the given group, e.g. 'Face').",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            group: {
                type: "string",
                description: "Expression group, usually 'Face'",
            },
            expression: {
                type: "string",
                description:
                    "Expression name, e.g. 'Happy', 'Sad', 'Angry', 'Surprised', 'Neutral'",
            },
        },
        ["memberNumber", "group", "expression"],
    ),
    handler: (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const group = args.group as string;
        const expression = args.expression as string;
        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;
        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;
        target.SetExpression(group as never, expression as never);
        return `Set expression of ${target.Name} to ${expression}.`;
    },
};
