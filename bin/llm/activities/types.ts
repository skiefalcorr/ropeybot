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
    API_Character,
    API_Connector,
    BC_Server_ChatRoomMessage,
} from "bc-bot";
import { LLMConfig } from "../../config";
import { CommandHub } from "../commands/hub";
import { Tool, ToolContext } from "../tools/shared";

/**
 * What an activity is given when it is initialised.
 *
 * Everything an activity needs to act on the bot goes through here, so an
 * activity never has to import or reach into `LLMGame` itself.
 */
export interface ActivityContext {
    conn: API_Connector;
    /** The full LLM config (the activity reads its own sub-section). */
    llmConfig: LLMConfig;
    /**
     * The live tool context. Activities can read `participants` from it, but
     * should NOT store tools in it — tools are returned via `getTools()`
     * with their own state closed over.
     */
    toolContext: ToolContext;
    /** Command hub for registering `/bot ...` commands, including overrides. */
    commands: CommandHub;
    /**
     * Participation gate. Calling this opts a character into the roleplay
     * (the equivalent of them running `/bot start`). Used by activities that
     * want a single command to both start their mode and enable RP.
     */
    requestParticipant(memberNumber: number): void;
    /** Whether a character is currently participating in roleplay. */
    isParticipant(memberNumber: number): boolean;
    /** Whether a character is a superuser (allowed to run admin commands). */
    isSuperuser(memberNumber: number): boolean;
    /** Member numbers of all current participants. */
    participants(): number[];
    /**
     * Send a private whisper to a character. Unlike `conn.SendMessage`, this
     * is safe to call with a member number that may have left the room.
     */
    whisper(memberNumber: number, text: string): void;
    /**
     * Append a free-form line to the bot's rolling chat history as a SYSTEM
     * note, so the model sees that something happened between turns.
     */
    note(content: string): void;
    /**
     * Nudge the agent to consider a turn. Used after an activity changes
     * state that the model should react to (e.g. a riddle was assigned).
     */
    pushEvent(content: string): void;
    /** Prefix log lines with the activity id. */
    log(message: string): void;
    warn(message: string): void;
}

/**
 * An optional, self-contained mode layered on top of the base roleplay bot.
 *
 * Activities are the extension point for "riddle mode", and later for things
 * like pony-play tracking or a casino croupier mode. The base bot owns the
 * connection, the turn loop and the chat history; an activity contributes:
 *
 *  - tools the LLM can call (`getTools`),
 *  - prompt material (`systemSections`, `roomStateSections`,
 *    `characterAnnotations`),
 *  - chat commands via the hub (`registerCommands`),
 *  - reactions to room events (`onMessage`, `onCharacterEntered`, ...),
 *  - a bio addendum advertising the mode (`bioAddendum`).
 *
 * Every hook is optional except `id`, `getTools`, `init` and `stop`, so a
 * minimal activity can be a few lines long.
 */
export interface LLMActivity {
    /** Stable id, also the key used in `llm.activities`. */
    readonly id: string;
    /** Human-readable name, used in `/bot status`. */
    readonly title: string;

    /** Load persisted state, build tools, register commands. */
    init(ctx: ActivityContext): Promise<void>;
    /** Flush state and release anything held. Must be safe to call twice. */
    stop(): Promise<void>;

    /**
     * Tools this activity contributes. Called once during agent construction,
     * after `init()`, so the activity's state is already loaded.
     */
    getTools(): Tool[];

    /**
     * Static prompt sections. Must not contain volatile per-turn data — this
     * text is part of the cacheable system prompt.
     */
    systemSections?(): string[];

    /**
     * Volatile per-turn sections appended to the "Current room state"
     * snapshot. Rebuilt on every turn, so this is the right place for
     * progress summaries and leaderboards.
     */
    roomStateSections?(ctx: ActivityContext): string[];

    /**
     * Extra lines attached directly under a character's description line in
     * the room snapshot, keyed by member number. This is where an activity
     * says "this character is currently solving riddle X".
     */
    characterAnnotations?(
        ctx: ActivityContext,
    ): Map<number, string[]>;

    /** An extra line appended to the bot's bio while the activity is on. */
    bioAddendum?(): string | undefined;

    /** Register `/bot ...` commands, including overrides of core commands. */
    registerCommands?(ctx: ActivityContext): void;

    onCharacterEntered?(ctx: ActivityContext, character: API_Character): void;
    onCharacterLeft?(ctx: ActivityContext, character: API_Character): void;
    onMessage?(
        ctx: ActivityContext,
        sender: API_Character,
        message: BC_Server_ChatRoomMessage,
    ): void;
    onParticipantChanged?(ctx: ActivityContext, memberNumber: number): void;

    /** Snapshot for the debug server's `/activities` endpoint. */
    debugSnapshot?(): unknown;

    /** Reset runtime state (superuser action on the debug server). */
    reset?(): void;
}
