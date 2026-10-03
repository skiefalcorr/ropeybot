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

import { API_Connector, API_Character, type RoomDefinition } from "bc-bot";
import { LLMToolDefinition } from "../llmClient";
import { LLMConfig } from "../../config";

/**
 * A single tool the LLM may invoke. `definition` is the OpenAI/llama-server
 * tool schema; `handler` executes it and returns a short result string that
 * is fed back to the model as the tool result.
 */
export interface Tool {
    name: string;
    /**
     * Optional category tag used to enable/disable groups of tools via
     * config (e.g. the "room" category is gated by `llm.roomTools`).
     */
    category?: string;
    definition: LLMToolDefinition;
    handler: (
        args: Record<string, unknown>,
        ctx: ToolContext,
    ) => Promise<string> | string;
}

export interface ToolContext {
    conn: API_Connector;
    config: LLMConfig;
    /** The bot's configured room definition, used as defaults for room tools. */
    room: RoomDefinition;
    /** Member numbers that must never be acted upon. */
    protectedMembers: number[];
    /** Member numbers currently suspended (safeword) with their expiry. */
    suspended: Map<number, number>;
    /** Sliding-window timestamps of actions taken (for rate limiting). */
    actionTimestamps: number[];
    /** Last action time per target member number. */
    lastActionByTarget: Map<number, number>;
    /** Member numbers the bot is currently holding on a leash. */
    leashed: Map<number, number>;
    /** Member numbers that are active participants (opted in via /bot start). */
    participants: Set<number>;
}

export function def(
    name: string,
    description: string,
    properties: Record<
        string,
        { type: string; description?: string; enum?: (string | number)[] }
    >,
    required: string[] = [],
): LLMToolDefinition {
    return {
        type: "function",
        function: {
            name,
            description,
            parameters: { type: "object", properties, required },
        },
    };
}

/**
 * Human-readable display name for a character: the nickname if set,
 * otherwise the account name. Use this in any user-facing string (tool
 * results, history entries, event descriptions) so the model and the
 * room see the same name the character chose.
 */
export function displayName(char: API_Character): string {
    return char.NickName.length > 0 ? char.NickName : char.Name;
}

export function findCharacter(
    conn: API_Connector,
    args: Record<string, unknown>,
): API_Character | undefined {
    const room = conn.chatRoom;
    if (!room) return undefined;
    const memberNumber = args.memberNumber as number | undefined;
    const name = args.name as string | undefined;
    if (memberNumber !== undefined) {
        return room.characters.find((c) => c.MemberNumber === memberNumber);
    }
    if (name) {
        const lower = name.toLowerCase();
        return room.characters.find(
            (c) =>
                c.Name.toLowerCase() === lower ||
                c.NickName.toLowerCase() === lower,
        );
    }
    return undefined;
}

export function isProtected(ctx: ToolContext, memberNumber: number): boolean {
    // if (memberNumber === ctx.conn.Player.MemberNumber) return true;
    // if (ctx.protectedMembers.includes(memberNumber)) return true;
    // const until = ctx.suspended.get(memberNumber);
    // if (until !== undefined && until > Date.now()) return true;
    return false;
}

/**
 * Participation gate. Returns null if the target is an active participant
 * (or is the bot itself), or an error string explaining the refusal.
 */
export function requireParticipant(
    ctx: ToolContext,
    memberNumber: number,
): string | null {
    if (memberNumber === ctx.conn.Player.MemberNumber) return null;
    if (!ctx.participants.has(memberNumber)) {
        return "Refused: that character is not participating. They must use /bot start first.";
    }
    return null;
}

/**
 * Room-admin gate. Returns null if the bot is an admin of the current room,
 * or an error string explaining the refusal.
 */
export function requireRoomAdmin(ctx: ToolContext): string | null {
    const room = ctx.conn.chatRoom;
    if (!room) return "Error: not in a room.";
    const me = ctx.conn.Player.MemberNumber;
    if (!room.Admin.includes(me)) {
        return "Refused: the bot is not an admin of this room.";
    }
    return null;
}

/**
 * Rate-limit gate. Returns null if the action is allowed, or an error string
 * explaining why it was rejected.
 */
export function checkRateLimit(
    ctx: ToolContext,
    targetMemberNumber?: number,
): string | null {
    const now = Date.now();
    const maxPerMinute = ctx.config.maxActionsPerMinute ?? 10;
    const windowMs = 60_000;

    // Drop timestamps outside the window.
    while (
        ctx.actionTimestamps.length > 0 &&
        ctx.actionTimestamps[0] < now - windowMs
    ) {
        ctx.actionTimestamps.shift();
    }
    if (ctx.actionTimestamps.length >= maxPerMinute) {
        return `Rate limit: already performed ${maxPerMinute} actions this minute. Wait before acting again.`;
    }

    // if (targetMemberNumber !== undefined) {
    //     const cooldown = ctx.config.targetCooldownMs ?? 5000;
    //     const last = ctx.lastActionByTarget.get(targetMemberNumber) ?? 0;
    //     if (now - last < cooldown) {
    //         return `Cooldown: you just acted on this character ${Math.round(
    //             (cooldown - (now - last)) / 1000,
    //         )}s ago. Wait a moment.`;
    //     }
    // }

    ctx.actionTimestamps.push(now);
    if (targetMemberNumber !== undefined) {
        ctx.lastActionByTarget.set(targetMemberNumber, now);
    }
    return null;
}

/**
 * Ping all leashed characters so they follow the bot into the current room.
 *
 * The game client does this automatically when a player changes rooms
 * (ChatRoomPingLeashedPlayers). The bot must replicate it: for each member
 * in ctx.leashed, send PingHoldLeash (Hidden) and AccountBeep("Leash").
 * The server fills in the sender's current room in the beep response, so
 * the leashed client joins the bot's new room.
 *
 * Must be called AFTER the bot has successfully joined/created the new room.
 */
export function pingLeashed(ctx: ToolContext): void {
    for (const memberNumber of ctx.leashed.keys()) {
        ctx.conn.SendMessage("Hidden", "PingHoldLeash", memberNumber);
        ctx.conn.AccountBeep(memberNumber, "Leash");
    }
}
