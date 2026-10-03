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
    checkRateLimit,
} from "../shared";
import { PoseFemale3DCGNames } from "../catalog";

export const setPoseTool: Tool = {
    name: "setPose",
    definition: def(
        "setPose",
        "Set a character's active pose. Provide a list of pose names (usually one). Use listPoses to find valid names. The bot can also set its own pose by passing its own member number.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            poses: {
                type: "array",
                description: 'List of pose names, e.g. ["Kneel"]',
            },
        },
        ["memberNumber", "poses"],
    ),
    handler: (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const poses = (args.poses as string[]) ?? [];
        if (poses.length === 0) return "Error: no poses provided.";
        const invalid = poses.filter(
            (p) => !PoseFemale3DCGNames.includes(p as never),
        );
        if (invalid.length > 0)
            return `Error: invalid pose(s) ${invalid.join(", ")}. Use listPoses.`;
        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;
        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;
        target.SetActivePose(poses as never);
        return `Set pose of ${displayName(target)} to ${poses.join(", ")}.`;
    },
};
