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
    /** Max tool-call iterations per agent turn. @default 5 */
    maxToolIterations?: number;
    /** Debounce window (ms) before an LLM turn is triggered after events. @default 1500 */
    debounceMs?: number;
    /** Max chat-history messages kept in context. @default 40 */
    historyLength?: number;
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
