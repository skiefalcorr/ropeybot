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

import type { API_Character } from "bc-bot";
import type { ToolContext } from "../shared";
import { displayName } from "../shared";
import type { Riddle } from "../../../games/riddles/riddleStore";
import type { RiddleState } from "../../../games/riddles/riddleState";

/**
 * Build-time dependencies every riddle tool needs.
 *
 * Riddle tools are factories rather than static constants (unlike the base
 * tools) because their handlers close over the activity's live state and
 * riddle pool. This keeps `ToolContext` free of riddle-specific fields and
 * lets a second activity never collide with these tools.
 *
 * Note: there is deliberately no `note()` here. Tool results reach the
 * cross-turn history through the tool's own `history` flag, so history has
 * exactly one source of truth per tool.
 */
export interface RiddleToolOptions {
    /** The full riddle pool, loaded from the CSV. */
    pool: Riddle[];
    /** How many riddles `getRiddles` returns when `count` is omitted. */
    defaultBatchSize: number;
    /**
     * Whether to reveal the answer of the current riddle in status results.
     * The answer is normally already in the room snapshot; this only affects
     * the tool result text.
     */
    revealAnswers: boolean;
}

/**
 * The `player` / `memberNumber` parameter pair, shared by every riddle tool
 * that targets a character. Spread into a tool's `properties`.
 *
 * `memberNumber` is preferred because names are ambiguous and can change;
 * `player` exists so the model can act on what it read in the chat.
 */
export const PLAYER_PARAMS = {
    player: {
        type: "string",
        description: "Player name.",
    },
    memberNumber: {
        type: "number",
        description:
            "Player member number. Preferred over 'player' when available.",
    },
} as const;

/** A character resolved from tool arguments. */
export interface ResolvedPlayer {
    /**
     * The live character, when they are still in the room. Undefined when the
     * caller passed a `memberNumber` for someone who has since left: the
     * number is still authoritative for state tracking, we just have no
     * nickname or appearance to read.
     */
    character?: API_Character;
    memberNumber: number;
    /** Display name, or the member number when the character is gone. */
    name: string;
}

/**
 * Resolve a player from tool arguments.
 *
 * Accepts `memberNumber` (preferred, unambiguous) or `player` (a name or
 * nickname, case-insensitive). Returns `undefined` only when a name was given
 * and no matching character is in the room.
 */
export function resolvePlayer(
    ctx: ToolContext,
    args: Record<string, unknown>,
): ResolvedPlayer | undefined {
    const room = ctx.conn.chatRoom;
    if (!room) return undefined;

    const memberNumber = args.memberNumber;
    if (typeof memberNumber === "number") {
        const character = room.characters.find(
            (c) => c.MemberNumber === memberNumber,
        );
        return {
            character,
            memberNumber,
            name: character ? displayName(character) : String(memberNumber),
        };
    }

    const name = args.player ?? args.name;
    if (typeof name === "string" && name.trim().length > 0) {
        const lower = name.trim().toLowerCase();
        const character = room.characters.find(
            (c) =>
                c.Name.toLowerCase() === lower ||
                c.NickName.toLowerCase() === lower,
        );
        if (character) {
            return {
                character,
                memberNumber: character.MemberNumber,
                name: displayName(character),
            };
        }
    }
    return undefined;
}

/** Render a riddle in the compact form the tools return to the model. */
export function formatRiddle(riddle: Riddle): string {
    return `[${riddle.id}] ${riddle.question} (answer: ${riddle.answer})`;
}

/**
 * Shared shape for the per-tool factories. Each tool file exports a function
 * of this signature so `index.ts` can compose them uniformly.
 */
export type RiddleToolFactory = (
    state: RiddleState,
    options: RiddleToolOptions,
) => import("../shared").Tool;
