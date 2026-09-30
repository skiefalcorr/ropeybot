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
    checkRateLimit,
    requireRoomAdmin,
    findCharacter,
} from "../shared";

const ACTIONS = [
    "Kick",
    "Ban",
    "Unban",
    "Promote",
    "Demote",
    "Whitelist",
    "Unwhitelist",
] as const;

export const roomAdminTool: Tool = {
    name: "roomAdmin",
    category: "room",
    definition: def(
        "roomAdmin",
        "Perform an admin action on a member of the current room: kick, ban, unban, promote to admin, demote, whitelist, or unwhitelist. Requires the bot to be an admin of the room. The target is specified by memberNumber or name (see roomInfo for the member list).",
        {
            action: {
                type: "string",
                enum: [...ACTIONS],
                description: "The admin action to perform.",
            },
            memberNumber: {
                type: "number",
                description: "Member number of the target character.",
            },
            name: {
                type: "string",
                description:
                    "Name or nickname of the target character (alternative to memberNumber).",
            },
            publish: {
                type: "boolean",
                description:
                    "Whether to announce the action in the room chat. Default: true.",
            },
        },
        ["action"],
    ),
    handler: (args, ctx) => {
        const room = ctx.conn.chatRoom;
        if (!room) return "Error: not in a room.";
        const adminErr = requireRoomAdmin(ctx);
        if (adminErr) return adminErr;
        const limited = checkRateLimit(ctx);
        if (limited) return limited;

        const action = args.action as (typeof ACTIONS)[number];
        if (!ACTIONS.includes(action)) {
            return `Error: unknown action '${String(args.action)}'. Valid: ${ACTIONS.join(", ")}.`;
        }

        const target = findCharacter(ctx.conn, args);
        if (!target) {
            return "Error: target character not found in the room. Use roomInfo to see who is present.";
        }
        if (target.MemberNumber === ctx.conn.Player.MemberNumber) {
            return "Refused: the bot cannot perform admin actions on itself.";
        }

        const publish = args.publish !== false;
        ctx.conn.chatRoomAdmin({
            MemberNumber: target.MemberNumber,
            Action: action,
            Publish: publish,
        });
        return `${action} applied to ${target.Name} (${target.MemberNumber}).`;
    },
};
