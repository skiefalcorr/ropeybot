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

import { type RoomDefinition } from "bc-bot";
import { type CasinoConfig } from "./games/casino";

/**
 * Configuration for the LLM-powered roleplay bot.
 *
 * The LLM is expected to be served locally by llama-server, which exposes an
 * OpenAI-compatible `/v1/chat/completions` endpoint with native tool calling.
 */
export interface LLMConfig {
    /** Base URL of llama-server, e.g. "http://localhost:8080". */
    url: string;
    /**
     * Display name of the bot, used in the bio disclaimer so players can
     * tell it's an AI. If omitted, the bot's nickname is used.
     */
    botName?: string;
    /** Model name as served by llama-server. Optional; defaults to the loaded model. */
    model?: string;
    /** API key, if llama-server was started with --api-key. Optional. */
    apiKey?: string;
    /** Persona / system prompt describing who the bot is and how it should behave. */
    persona: string;
    /**
     * Whitelist of tool names the LLM may use. If omitted, all registered tools
     * (minus deniedTools) are available.
     */
    allowedTools?: string[];
    /** Blacklist of tool names the LLM must never use (e.g. destructive admin tools). */
    deniedTools?: string[];
    /**
     * Enable the room-management tools (searchRooms, roomInfo, joinRoom,
     * leaveRoom, createRoom, updateRoom, roomAdmin). @default true
     */
    roomTools?: boolean;
    /** Max tool-call iterations per agent turn. @default 5 */
    maxToolIterations?: number;
    /**
     * Delay (ms) between consecutive tool calls in a batch, so the game
     * server receives the resulting messages in a stable order. @default 150
     */
    toolCallDelayMs?: number;
    /** Debounce window (ms) before an LLM turn is triggered after events. @default 1500 */
    debounceMs?: number;
    /**
     * Max time (ms) to wait for the first pending event before a turn fires,
     * even if events keep arriving. Prevents a continuous event stream from
     * starving the debounce window indefinitely. @default 5000
     */
    debounceMaxWaitMs?: number;
    /**
     * Wait for all participants to stop typing (Status 'Talk' -> 'null')
     * before the debounce window fires a turn. When enabled, a 'Talk' status
     * from a participant restarts the debounce window, and the turn is held
     * (polled every ~500 ms) until no participant is still typing. @default true
     */
    waitForTyping?: boolean;
    /** Max chat-history messages kept in context. @default 40 */
    historyLength?: number;
    /** Max characters of a character's bio (Description) shown in room state. 0 hides bios. @default 200 */
    bioLength?: number;
    /** Sampling temperature. @default 0.8 */
    temperature?: number;
    /** Max tokens per completion. @default 512 */
    maxTokens?: number;
    /** Per-request timeout (ms). @default 120000 */
    timeoutMs?: number;
    /** Safewords that trigger an immediate strip + action suspension. @default ["red"] */
    safewords?: string[];
    /** How long (ms) to suspend LLM actions toward a character after a safeword. @default 600000 */
    safewordSuspendMs?: number;
    /** Max actions the bot may perform per minute. @default 10 */
    maxActionsPerMinute?: number;
    /** Per-target cooldown (ms) between actions on the same character. @default 5000 */
    targetCooldownMs?: number;
    /** Member numbers the bot must never act on (in addition to superusers). */
    protectedMembers?: number[];
    /**
     * Optional file path for full LLM logging. When set, every request
     * (complete prompt) and response (content, tool calls, usage) is appended
     * to this file as JSONL. llama-server's own logging is either an
     * overview or per-token, so this captures the in-between.
     */
    llmLog?: string;
    /**
     * Optional local port for the debug HTTP server. When set, the bot listens
     * on 127.0.0.1:<port> and exposes /status, /tools, /tool, /toollog,
     * /llmlog and /stop so the bot can be driven and inspected programmatically
     * while running against the live server.
     */
    debugPort?: number;
    /** Optional starting pose(s) applied to the bot itself on init. */
    startPose?: string[];
    /**
     * Optional curated item catalog the LLM may use. If omitted, the bot will
     * best-effort enumerate the asset catalog at runtime.
     */
    itemCatalog?: { group: string; name: string; description?: string }[];
}

export interface ConfigFile {
    user: string;
    password: string;
    env: "live" | "test";
    url?: string;
    game: string;
    superusers: number[];
    room: RoomDefinition;
    mongo_uri?: string;
    mongo_db?: string;
    members: number[];

    user2: string;
    password2: string;

    casino?: CasinoConfig;
    llm?: LLMConfig;
}
