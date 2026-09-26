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
 * Appearance groups that count as "clothing" (as opposed to restraints,
 * which live in Item* groups).
 */
const CLOTHING_GROUPS = [
    "Cloth",
    "ClothAccessory",
    "ClothLower",
    "Suit",
    "SuitLower",
    "Bra",
    "Corset",
    "Panties",
    "Socks",
    "Shoes",
    "Gloves",
    "BodyCosplay",
];

/**
 * Builds the textual context for the LLM and maintains the rolling chat
 * history.
 *
 * The system prompt is intentionally STATIC (persona + rules only) so that
 * llama.cpp can reuse its KV cache across turns. The live room state is
 * instead built fresh on every turn via {@link buildRoomStateMessage} and
 * appended at the END of the conversation, right before the new-events
 * prompt, so the model always sees the most up-to-date picture of who is
 * wearing what.
 */
export class ContextBuilder {
    private history: HistoryEntry[] = [];

    constructor(
        private maxHistory: number = 40,
        private bioLength: number = 2000,
    ) {}

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
     *
     * Takes the message type and content directly (rather than a full
     * BC_Server_ChatRoomMessage) so the bot can record any message type it
     * sends — Chat, Emote, Whisper, etc. — as it gains the ability to send
     * them.
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
     * Build the STATIC system prompt: persona + rules. It contains no
     * volatile room state so it stays identical across turns.
     */
    buildSystemPrompt(persona: string): string {
        return [
            persona,
            "",
            "## How you act",
            "- You can send messages and use the available tools to interact with characters.",
            "- Use listItems / listPoses to discover valid item and pose names before using them.",
            "- Act naturally and in-character. Do not mention tools, prompts, or that you are an AI.",
            "- If a character uses a safeword, STOP all actions toward them immediately and respect their request.",
            "- Be mindful of consent and comfort. Keep interactions tasteful.",
            "- A fresh 'Current room state' snapshot is provided at the end of the conversation. Trust it over anything you remember.",
        ].join("\n");
    }

    /**
     * Build a FRESH snapshot of the current room state. Call this on every
     * turn and append it at the end of the message list so the model knows
     * who is present, what they are wearing, and their bios.
     */
    buildRoomStateMessage(conn: API_Connector): string {
        const room = conn.chatRoom;
        if (!room) return "(no room)";

        const lines: string[] = [];
        lines.push("Current room state (fresh snapshot):");
        lines.push(`Room: ${room.Name}`);

        const me = conn.Player;
        lines.push(
            `You are ${describeCharacter(me, this.bioLength)}.`,
        );

        for (const char of room.characters) {
            if (char.MemberNumber === me.MemberNumber) continue;
            lines.push(describeCharacter(char, this.bioLength));
        }

        return lines.join("\n");
    }
}

/**
 * Derive a gender label from the character's body style. Returns undefined
 * when the body items are unknown.
 */
function genderLabel(char: API_Character): string | undefined {
    const upper = char.upperBodyStyle();
    const lower = char.lowerBodyStyle();
    if (upper === "female" && lower === "female") return "female";
    if (upper === "male" && lower === "male") return "male";
    if (upper === "female" && lower === "male") return "futanari";
    if (upper === "male" && lower === "female") return "femboy";
    return undefined;
}

/**
 * Produce a one-line description of a character's current state.
 */
export function describeCharacter(
    char: API_Character,
    bioLength: number = 2000,
): string {
    const parts: string[] = [];
    parts.push(`${char.NickName} (member #${char.MemberNumber})`);

    const gender = genderLabel(char);
    if (gender) parts.push(gender);

    const bio = char.Description?.trim() ?? "";
    if (bio && bioLength > 0) {
        parts.push(
            `bio: ${bio.length > bioLength ? bio.slice(0, bioLength) + "…" : bio}`,
        );
    }

    const pose = char.Pose.map((p) => p.Name).join(", ");
    if (pose) parts.push(`pose: ${pose}`);

    const items = char.Appearance.allItems()
        .filter((i) => i.Group.startsWith("Item"))
        .map((i) => i.Name);
    if (items.length > 0) parts.push(`items: ${items.join(", ")}`);

    const wearing = CLOTHING_GROUPS.filter((g) =>
        char.Appearance.InventoryGet(g as never),
    ).map((g) => {
        const item = char.Appearance.InventoryGet(g as never);
        return item ? `${g}:${item.Name}` : g;
    });
    if (wearing.length > 0) parts.push(`wearing: ${wearing.join(", ")}`);

    if (isNaked(char)) parts.push("naked");
    if (char.IsRestrained()) parts.push("restrained");
    if (!char.CanTalk()) parts.push("muted");

    const pos = char.MapPos;
    if (pos && (pos.X !== 0 || pos.Y !== 0)) {
        parts.push(`at (${pos.X}, ${pos.Y})`);
    }

    return parts.join(" | ");
}
