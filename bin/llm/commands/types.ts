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

/**
 * Arguments a chat command handler receives. Kept structurally identical to
 * the existing `CommandParser` callback so handlers can be moved over without
 * changing their bodies.
 */
export interface CommandArgs {
    sender: API_Character;
    message: BC_Server_ChatRoomMessage;
    /** Remaining words after the command name, lowercased by CommandParser. */
    args: string[];
    conn: API_Connector;
}

/**
 * A command handler may return the reply text instead of sending it. The hub
 * assembles every contributing handler's text into ONE reply, so two
 * activities can add lines to `/bot status` without racing each other or
 * spamming the room with multiple messages.
 *
 * Returning `undefined` contributes nothing. Returning an array contributes
 * one line per element.
 */
export type CommandHandler = (
    ctx: CommandArgs,
) => string | string[] | void | Promise<string | string[] | void>;

/**
 * How a contribution interacts with the other contributions to the same
 * command name.
 *
 *  - `replace` (default): competes for the single "base" slot. Highest
 *    priority wins. Used to define a command or deliberately override it.
 *  - `append`: never competes for the base slot; its output is appended after
 *    the base output. Multiple appenders stack in priority order.
 */
export type CommandMode = "replace" | "append";

export interface CommandContribution {
    /** The command name, e.g. "status" or "riddles". Matched case-insensitively. */
    name: string;
    /**
     * Owner tag, used to remove a whole activity's contributions at once.
     * The core bot registers as "core".
     */
    owner: string;
    mode?: CommandMode;
    /** Higher wins the base slot. Ties are broken by registration order. @default 0 */
    priority?: number;
    /**
     * When true the hub will not fall back to a generic "unknown command"
     * reply for this name even if no base handler is present.
     */
    handler: CommandHandler;
    /**
     * Optional one-line help text, used by the generated help listing so
     * activities can document their commands without editing the core help.
     */
    help?: string;
    /**
     * When true the handler's reply is always sent as a private Whisper to the
     * sender, regardless of the message type that triggered it. Used by
     * `/bot riddles`, whose content must never land in public chat.
     */
    private?: boolean;
}
