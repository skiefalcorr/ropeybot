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
    ToolContext,
    def,
    isProtected,
    requireParticipant,
} from "../shared";

export const sendMessageTool: Tool = {
    name: "sendMessage",
    definition: def(
        "sendMessage",
        "Send a message to the room or to a specific character. Use type 'Chat' for public speech, 'Emote' for actions (rendered as *...*), or 'Whisper' for private messages (requires memberNumber). Try to keep them short, up to 15 words each.",
        {
            type: {
                type: "string",
                enum: ["Chat", "Emote", "Whisper"],
                description: "Message type",
            },
            content: {
                type: "string",
                description: "The message text",
            },
            memberNumber: {
                type: "number",
                description:
                    "Target member number. Required for Whisper, omit for Chat/Emote.",
            },
        },
        ["type", "content"],
    ),
    handler: (args, ctx) => {
        const type = args.type as string;
        const content = String(args.content ?? "");
        if (!content.trim()) return "Error: empty message.";
        const memberNumber = args.memberNumber as number | undefined;
        if (type === "Whisper" && memberNumber === undefined) {
            return "Error: Whisper requires memberNumber.";
        }
        if (type === "Whisper" && isProtected(ctx, memberNumber!)) {
            return "Refused: that character is protected or suspended.";
        }
        if (type === "Whisper") {
            const refused = requireParticipant(ctx, memberNumber!);
            if (refused) return refused;
        }
        ctx.conn.SendMessage(
            type as "Chat" | "Emote" | "Activity" | "Whisper",
            content,
            memberNumber,
        );
        return `Sent ${type}: ${content}`;
    },
};
