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

/**
 * Minimal OpenAI-compatible chat-completions client, targeted at llama-server.
 *
 * llama-server exposes `/v1/chat/completions` and supports native tool calling
 * (function calling) in the OpenAI wire format. This client is intentionally
 * dependency-free (uses global fetch, available in Node 18+) and non-streaming.
 */

export interface LLMToolParameter {
    type: string;
    description?: string;
    enum?: (string | number)[];
}

export interface LLMToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, LLMToolParameter>;
            required?: string[];
        };
    };
}

export interface LLMMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    /** Present on assistant messages that requested tool calls. */
    tool_calls?: LLMToolCall[];
    /** Present on tool-result messages: the tool_call id being answered. */
    tool_call_id?: string;
    /** Present on tool-result messages: the tool name (for logging). */
    name?: string;
}

export interface LLMToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string; // JSON-encoded
    };
}

export interface LLMChatOptions {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    tools?: LLMToolDefinition[];
    /** Force the model to call a tool (llama-server supports "required"). */
    tool_choice?: "auto" | "none" | "required";
}

export interface LLMChatResult {
    content: string | null;
    toolCalls: LLMToolCall[];
    finishReason: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
    /**
     * Present when the model is a thinking/reasoning model (e.g. Qwen3) and
     * the server returns its chain-of-thought in `reasoning_content`.
     */
    reasoningContent?: string | null;
}

export class LLMClient {
    constructor(
        private baseUrl: string,
        private apiKey?: string,
        private timeoutMs: number = 120_000,
    ) {
        // Normalize: strip trailing slash, ensure we hit the /v1 endpoint.
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        if (!this.baseUrl.includes("/v1")) {
            this.baseUrl += "/v1";
        }
    }

    /**
     * Perform a single (non-streaming) chat completion.
     */
    async chat(
        messages: LLMMessage[],
        options: LLMChatOptions = {},
    ): Promise<LLMChatResult> {
        const body: Record<string, unknown> = {
            model: options.model ?? "local-model",
            messages,
            stream: false,
            temperature: options.temperature ?? 0.8,
            max_tokens: options.max_tokens ?? 512,
        };

        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
            body.tool_choice = options.tool_choice ?? "auto";
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (this.apiKey) {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let resp: Response;
        try {
            resp = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (e) {
            throw new Error(
                `LLM request failed (is llama-server running at ${this.baseUrl}?): ${String(e)}`,
            );
        } finally {
            clearTimeout(timer);
        }

        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(
                `LLM server returned ${resp.status}: ${text.slice(0, 500)}`,
            );
        }

        const data = (await resp.json()) as {
            choices?: {
                message?: {
                    content?: string | null;
                    tool_calls?: LLMToolCall[];
                    reasoning_content?: string | null;
                };
                finish_reason?: string;
            }[];
            usage?: { prompt_tokens: number; completion_tokens: number };
        };

        const choice = data.choices?.[0];
        const message = choice?.message;

        return {
            content: message?.content ?? null,
            toolCalls: message?.tool_calls ?? [],
            finishReason: choice?.finish_reason ?? "stop",
            usage: data.usage,
            reasoningContent: message?.reasoning_content ?? null,
        };
    }

    /**
     * Parse the JSON arguments of a tool call, tolerating minor model errors.
     */
    static parseToolArgs(raw: string): Record<string, unknown> {
        if (!raw || !raw.trim()) return {};
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed === "object" && parsed !== null
                ? parsed
                : {};
        } catch {
            // Models occasionally emit trailing commas or unquoted strings.
            // Best-effort salvage: strip trailing commas.
            try {
                const fixed = raw.replace(/,\s*([}\]])/g, "$1");
                const parsed = JSON.parse(fixed);
                return typeof parsed === "object" && parsed !== null
                    ? parsed
                    : {};
            } catch {
                console.warn("Failed to parse tool arguments:", raw.slice(0, 200));
                return {};
            }
        }
    }
}
