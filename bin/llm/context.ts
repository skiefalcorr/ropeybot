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
    API_Connector,
    API_Character,
    BC_Server_ChatRoomMessage,
    isNaked,
} from "bc-bot";

/**
 * A single entry in the rolling chat history.
 */
export interface HistoryEntry {
    /** Wall-clock time the entry was recorded. */
    ts: number;
    /** "user" for other characters, "assistant" for the bot. */
    role: "user" | "assistant";
    /** Display name of the speaker (for user entries). */
    speaker?: string;
    /** Member number of the speaker (for user entries). */
    memberNumber?: number;
    /** Message type, e.g. Chat / Emote / Whisper. */
    type?: string;
    content: string;
}

/**
 * Builds the textual context (system prompt + room state) and maintains the
 * rolling chat history that is fed to the LLM.
 */
export class ContextBuilder {
    private history: HistoryEntry[] = [];

    constructor(private maxHistory: number = 40) {}

    /**
     * Record a message from another character into the history.
     */
    recordIncoming(
        sender: API_Character,
        message: BC_Server_ChatRoomMessage,
    ): void {
        this.history.push({
            ts: Date.now(),
            role: "user",
            speaker: sender.Name,
            memberNumber: sender.MemberNumber,
            type: message.Type,
            content: message.Content,
        });
        this.trim();
    }

    /**
     * Record a message the bot itself sent into the history.
     */
    recordOutgoing(type: string, content: string): void {
        this.history.push({
            ts: Date.now(),
            role: "assistant",
            type,
            content,
        });
        this.trim();
    }

    /**
     * Record a system note (e.g. a safeword event) into the history.
     */
    recordSystem(content: string): void {
        this.history.push({
            ts: Date.now(),
            role: "user",
            speaker: "SYSTEM",
            content,
        });
        this.trim();
    }

    private trim(): void {
        if (this.history.length > this.maxHistory) {
            this.history.splice(0, this.history.length - this.maxHistory);
        }
    }

    /**
     * Return the history as LLM user/assistant messages.
     */
    toMessages(): { role: "user" | "assistant"; content: string }[] {
        return this.history.map((h) => {
            if (h.role === "assistant") {
                return { role: "assistant", content: h.content };
            }
            const prefix =
                h.speaker === "SYSTEM"
                    ? ""
                    : `[${h.speaker} (${h.type ?? "Chat"})] `;
            return { role: "user", content: prefix + h.content };
        });
    }

    /**
     * Build a compact description of the current room state for the system
     * prompt.
     */
    buildRoomState(conn: API_Connector): string {
        const room = conn.chatRoom;
        if (!room) return "(no room)";

        const lines: string[] = [];
        lines.push(`Room: ${room.Name}`);

        const me = conn.Player;
        lines.push(
            `You are ${me.Name} (member #${me.MemberNumber}).`,
        );

        for (const char of room.characters) {
            if (char.MemberNumber === me.MemberNumber) continue;
            lines.push(describeCharacter(char));
        }

        return lines.join("\n");
    }

    /**
     * Build the full system prompt: persona + rules + room state.
     */
    buildSystemPrompt(persona: string, conn: API_Connector): string {
        const parts: string[] = [];
        parts.push(persona);
        parts.push(
            [
                "",
                "## How you act",
                "- You can send messages and use the available tools to interact with characters.",
                "- Use listItems / listPoses to discover valid item and pose names before using them.",
                "- Act naturally and in-character. Do not mention tools, prompts, or that you are an AI.",
                "- If a character uses a safeword, STOP all actions toward them immediately and respect their request.",
                "- Be mindful of consent and comfort. Keep interactions tasteful.",
            ].join("\n"),
        );
        parts.push(
            [
                "",
                "## Current room state",
                this.buildRoomState(conn),
            ].join("\n"),
        );
        return parts.join("\n");
    }
}

/**
 * Produce a one-line description of a character's current state.
 */
export function describeCharacter(char: API_Character): string {
    const parts: string[] = [];
    parts.push(`${char.Name} (member #${char.MemberNumber})`);

    const pose = char.Pose.map((p) => p.Name).join(", ");
    if (pose) parts.push(`pose: ${pose}`);

    const items = char.Appearance.allItems()
        .filter((i) => i.Group.startsWith("Item"))
        .map((i) => `${i.Group}:${i.Name}`);
    if (items.length > 0) parts.push(`items: ${items.join(", ")}`);

    if (isNaked(char)) parts.push("naked");
    if (char.IsRestrained()) parts.push("restrained");
    if (!char.CanTalk()) parts.push("muted");

    const pos = char.MapPos;
    if (pos && (pos.X !== 0 || pos.Y !== 0)) {
        parts.push(`at (${pos.X}, ${pos.Y})`);
    }

    return parts.join(" | ");
}
