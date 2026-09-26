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

import { createWriteStream, WriteStream } from "node:fs";
import { LLMChatOptions, LLMChatResult, LLMMessage } from "./llmClient";

/**
 * Full LLM request/response logger.
 *
 * llama-server's own logging is either a high-level overview (no prompt
 * context) or an extremely verbose per-token dump — there is nothing in
 * between. This logger captures the in-between: the complete prompt sent to
 * the model and the complete response received, one JSON object per line
 * (JSONL), so the file can be tailed, grepped, or parsed later.
 *
 * Entries:
 *  - { kind: "request",  messages, options }  — the full conversation sent
 *  - { kind: "response", content, toolCalls, finishReason, usage, elapsedMs,
 *     reasoningContent? }  — reasoningContent only for thinking models
 *  - { kind: "error",    error }              — a failed chat request
 *
 * Every entry carries { ts, turn, iteration } so the multi-step tool loop of
 * a single agent turn can be followed.
 */
export class LLMLogger {
    private stream: WriteStream | undefined;
    private turn = 0;
    private iteration = 0;
    private warned = false;

    constructor(private filePath: string) {
        try {
            this.stream = createWriteStream(filePath, {
                flags: "a",
                encoding: "utf-8",
            });
            this.stream.on("error", (e) =>
                this.fallback(`LLM log file error: ${String(e)}`),
            );
        } catch (e) {
            this.fallback(
                `Could not open LLM log file ${filePath}: ${String(e)}`,
            );
        }
    }

    /**
     * Start a new agent turn. Call once per executeTurn; returns the turn
     * number (1-based).
     */
    newTurn(): number {
        this.turn += 1;
        this.iteration = 0;
        return this.turn;
    }

    /** Log the full prompt about to be sent (one per tool-loop iteration). */
    logRequest(messages: LLMMessage[], options: LLMChatOptions): void {
        this.iteration += 1;
        this.write({
            ts: new Date().toISOString(),
            turn: this.turn,
            iteration: this.iteration,
            kind: "request",
            messages,
            options: {
                model: options.model,
                temperature: options.temperature,
                max_tokens: options.max_tokens,
                tools: options.tools?.map((t) => t.function.name),
            },
        });
    }

    /** Log the response received for the most recent request. */
    logResponse(result: LLMChatResult, elapsedMs: number): void {
        const entry: Record<string, unknown> = {
            ts: new Date().toISOString(),
            turn: this.turn,
            iteration: this.iteration,
            kind: "response",
            elapsedMs,
            content: result.content,
            toolCalls: result.toolCalls,
            finishReason: result.finishReason,
            usage: result.usage,
        };
        if (result.reasoningContent) {
            entry.reasoningContent = result.reasoningContent;
        }
        this.write(entry);
    }

    /** Log a failed chat request. */
    logError(message: string): void {
        this.write({
            ts: new Date().toISOString(),
            turn: this.turn,
            iteration: this.iteration,
            kind: "error",
            error: message,
        });
    }

    /** Flush and close the underlying stream. */
    close(): void {
        this.stream?.end();
        this.stream = undefined;
    }

    private fallback(msg: string): void {
        if (!this.warned) {
            this.warned = true;
            console.warn(`${msg} — falling back to console logging.`);
        }
        this.stream = undefined;
    }

    private write(entry: Record<string, unknown>): void {
        const line = JSON.stringify(entry) + "\n";
        if (this.stream) {
            try {
                this.stream.write(line);
            } catch {
                this.fallback("LLM log file write failed");
            }
        } else {
            console.log("[llm-log]", line.trimEnd());
        }
    }
}
