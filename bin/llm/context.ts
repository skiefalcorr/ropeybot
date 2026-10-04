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
import lzString from "lz-string";
import { CLOTHING_GROUPS } from "./tools";
import { ITEM_GROUPS } from "./tools/catalog";
import { vibratorState } from "./tools/modification/setVibrator";
import { displayName } from "./tools/shared";
import { LLMConfig } from "../config";

/**
 * Decodes a character description that may be LZ-compressed.
 *
 * The game compresses long text descriptions with lz-string's
 * `compressToUTF16` and prefixes the result with the sentinel character ╬
 * (\u256C) to mark it as compressed. Short/uncompressed descriptions have no
 * prefix.
 */
export function decodeDescription(raw: string): string {
    if (!raw) return "";

    if (raw.startsWith("╬")) {
        const compressedData = raw.slice(1);

        // Note: LZString.compressToUTF16 appends a trailing space by design.
        // If the transport or an editor trimmed trailing whitespace, try both.
        const decompressed =
            lzString.decompressFromUTF16(compressedData) ||
            lzString.decompressFromUTF16(compressedData + " ");

        return decompressed ?? raw;
    }

    return raw;
}

/**
 * Marker for the AI-bot disclaimer block appended to the bot's bio.
 * A unique sentinel so we can detect and strip it reliably.
 */
export const BOT_DISCLAIMER_MARKER = "AI Bot:";

/**
 * Build the disclaimer block for the bot's bio.
 */
export function botDisclaimer(config: LLMConfig): string {
    return (
        `\n\n${BOT_DISCLAIMER_MARKER} This AI bot is powered by local LLM "${config.model}". \n` +
        `Model doesn't send data to anyone, but runs somewhat slowly. \n` +
        `It should be able to RP, apply and remove restraints, use leash, and create and join rooms. \n` +
        `It shows emotes for current state: code when LLM thinks, wardrobe when it looks up items, and listening when it waits to begin its turn. \n` +
        `To allow the bot to react to you, write /bot start. And say or do something. \n` +
        `Available commands: /bot start, /bot stop, /bot status, /bot feedback. \n` +
        `Safewords are: "${config.safewords.join(',')}" \n\n` +
        `Source code is at https://github.com/skiefalcorr/ropeybot`
    );
}

/**
 * Append the bot disclaimer to a bio if it is not already present.
 */
export function withBotDisclaimer(bio: string, config: LLMConfig): string {
    if (bio.includes(BOT_DISCLAIMER_MARKER)) return bio;
    const trimmed = bio.trimEnd();
    return trimmed
        ? `${trimmed}\n${botDisclaimer(config)}`
        : botDisclaimer(config);
}

/**
 * Remove the bot disclaimer block from a bio, if present.
 */
export function stripBotDisclaimer(bio: string): string {
    const idx = bio.indexOf(BOT_DISCLAIMER_MARKER);
    if (idx === -1) return bio;
    const end = bio.indexOf("]", idx);
    return (
        end === -1 ? bio.slice(0, idx) : bio.slice(0, idx) + bio.slice(end + 1)
    ).trim();
}

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
        private participants?: Set<number>,
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
            speaker: displayName(sender),
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

    /**
     * Record an action the bot itself performed (item applied/removed,
     * shock sent, vibrator adjusted, ...) into the history so the model
     * remembers what it did across turns. Rendered as a plain assistant
     * line, e.g. "Applied ItemNeckAccessories:Collar to Alice."
     */
    recordAction(content: string): void {
        this.history.push({
            ts: Date.now(),
            role: "assistant",
            type: "Action",
            content,
        });
        this.trim();
    }

    /**
     * Record a room change the bot underwent (joined/created/left a room via
     * a tool call, or was leashed into a room by another character) into the
     * history so the model remembers where it went across turns.
     *
     * Recorded as an assistant action (not a SYSTEM note) because some models
     * reject system-role messages in the middle of a conversation. The content
     * is the tool's own result string for tool-driven changes, or a clear
     * sentence for leash-follows.
     */
    recordRoomChange(content: string): void {
        this.history.push({
            ts: Date.now(),
            role: "assistant",
            type: "RoomChange",
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
     * Return a copy of the rolling history (for the debug server).
     */
    getHistory(): HistoryEntry[] {
        return [...this.history];
    }

    /**
     * Return the history as LLM user/assistant messages.
     */
    toMessages(): { role: "user" | "assistant"; content: string }[] {
        return this.history.map((h) => {
            const ts = formatTimestamp(h.ts);
            if (h.role === "assistant") {
                return { role: "assistant", content: `${ts} ${h.content}` };
            }
            const prefix =
                h.speaker === "SYSTEM"
                    ? ""
                    : `[${h.speaker} (${h.type ?? "Chat"})] `;
            return { role: "user", content: `${ts} ${prefix}${h.content}` };
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
            "- You can use the available tools to interact with characters.",
            "- Server closes empty chatrooms, like when you were the only one present and left. In order to go back to it, you'll need to create it again.",
            "- Use listItems (for gear and restraints) / listClothing (for clothing) to discover valid names before using them. Results are looped back into your context for this turn only.",
            "- If a character uses a safeword, or sends OOC message - in parentheses: (like this) - respect their request.",
            //"- Be mindful of consent and comfort. Keep interactions tasteful.",
            "- A fresh 'Current room state' snapshot is provided at the end of the conversation. Trust it over anything you remember.",
            "- Only interact with participating characters. Characters marked 'not participating' are not playing with you — ignore them.",
            "- When you have finished all actions you want to take this turn, call endTurn tool. Results of other toolcalls are looped back to you in this turn. Don't chain endTurn with other tools, end your turn with a separate call to endTurn.",
            "- Act naturally and in-character. Do not mention tools, prompts, or that you are an AI.",
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
        lines.push(`You are ${describeCharacter(me, this.bioLength)}.`);

        for (const char of room.characters) {
            if (char.MemberNumber === me.MemberNumber) continue;
            const participating =
                !this.participants || this.participants.has(char.MemberNumber);
            lines.push("Next character:");
            lines.push(describeCharacter(char, this.bioLength));
            if (!participating) {
                lines.push("(not participating)");
            }
        }

        return lines.join("\n");
    }
}

/**
 * Format a millisecond timestamp as a compact local-time string
 * (e.g. "14:32:07") for use in LLM history messages.
 */
function formatTimestamp(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `[${hh}:${mm}:${ss}]`;
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
    parts.push(`${displayName(char)} (member #${char.MemberNumber})`);

    const gender = genderLabel(char);
    if (gender) parts.push(gender);

    // Strip the AI-bot disclaimer so the LLM never sees the boilerplate.
    const bio = stripBotDisclaimer(
        decodeDescription(char.Description ?? ""),
    ).trim();
    if (bio && bioLength > 0) {
        parts.push(
            `bio: ${bio.length > bioLength ? bio.slice(0, bioLength) + "…" : bio}`,
        );
    }

    const pose = char.Pose.map((p) => p.Name).join(", ");
    if (pose) parts.push(`pose: ${pose}`);

    // const items = char.Appearance.allItems()
    //     .filter((i) => i.Group.startsWith("Item"))
    //     .map((i) => i.Name);
    // if (items.length > 0) parts.push(`items: ${items.join(", ")}`);

    const items = ITEM_GROUPS.filter((i) =>
        char.Appearance.InventoryGet(i as never),
    ).map((i) => {
        const item = char.Appearance.InventoryGet(i as never);
        if (!item) return i;
        const vibe = vibratorState(item);
        return vibe ? `${i}:${item.Name} [vibe:${vibe}]` : `${i}:${item.Name}`;
    });
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
    if (!char.CanTalk()) parts.push("gagged");

    const pos = char.MapPos;
    if (pos && (pos.X !== 0 || pos.Y !== 0)) {
        parts.push(`at (${pos.X}, ${pos.Y})`);
    }

    return parts.join(" | ");
}
