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
} from "bc-bot";
import { LLMClient, LLMMessage } from "./llmClient";
import { buildTools, resolveTools, Tool, ToolContext } from "./tools";
import { ContextBuilder } from "./context";
import { LLMConfig } from "../config";

/**
 * The LLM agent. It ingests room events, coalesces them with a debounce
 * window, and runs a single-flight "turn" loop: ask the LLM, execute any
 * tool calls it requests, feed results back, repeat until it produces plain
 * text (or hits the iteration cap).
 *
 * Safety features:
 *  - Single-flight: only one turn runs at a time; new events during a turn
 *    are coalesced into the next turn.
 *  - Safeword detection: if a character says a safeword, the agent strips
 *    their items, suspends actions toward them, and tells them they are free.
 *  - Rate limiting: global actions-per-minute + per-target cooldown,
 *    enforced inside the tool handlers.
 */
export class LLMAgent {
    private client: LLMClient;
    private tools: Tool[];
    private toolMap: Map<string, Tool>;
    private ctx: ToolContext;
    private contextBuilder: ContextBuilder;

    private pendingEvents: string[] = [];
    private debounceTimer: NodeJS.Timeout | undefined;
    private running = false;
    private stopped = false;

    constructor(
        private conn: API_Connector,
        private config: LLMConfig,
        private superusers: number[],
    ) {
        this.client = new LLMClient(
            config.url,
            config.apiKey,
            config.timeoutMs ?? 120_000,
        );

        const allTools = buildTools();
        this.tools = resolveTools(allTools, config);
        this.toolMap = new Map(this.tools.map((t) => [t.name, t]));

        this.ctx = {
            conn,
            config,
            protectedMembers: [
                ...superusers,
                ...(config.protectedMembers ?? []),
            ],
            suspended: new Map(),
            actionTimestamps: [],
            lastActionByTarget: new Map(),
        };

        this.contextBuilder = new ContextBuilder(
            config.historyLength ?? 40,
            config.bioLength ?? 200,
        );
    }

    /**
     * Feed an event into the agent. Events are coalesced; a turn is triggered
     * after the debounce window elapses with no new events.
     */
    onEvent(description: string): void {
        if (this.stopped) return;
        this.pendingEvents.push(description);
        this.scheduleTurn();
    }

    /**
     * Record an incoming chat message into the rolling history and feed it
     * to the agent as an event.
     */
    onIncomingMessage(
        sender: API_Character,
        message: BC_Server_ChatRoomMessage,
    ): void {
        this.contextBuilder.recordIncoming(sender, message);
        this.onEvent(
            `[${sender.Name} ${message.Type}] ${message.Content}`,
        );
    }

    private scheduleTurn(): void {
        if (this.debounceTimer) return;
        const delay = this.config.debounceMs ?? 1500;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            void this.runTurn();
        }, delay);
    }

    /**
     * Run a single agent turn. Single-flight guarded.
     */
    private async runTurn(): Promise<void> {
        if (this.running || this.stopped) return;
        this.running = true;

        const events = this.pendingEvents;
        this.pendingEvents = [];

        try {
            await this.executeTurn(events);
        } catch (e) {
            console.error("LLM agent turn failed:", e);
        } finally {
            this.running = false;
            // If new events arrived while we were running, run another turn.
            if (this.pendingEvents.length > 0 && !this.stopped) {
                this.scheduleTurn();
            }
        }
    }

    private async executeTurn(events: string[]): Promise<void> {
        const me = this.conn.Player;
        const room = this.conn.chatRoom;
        if (!room) return;

        // Build the conversation: static system prompt + history + a FRESH
        // room-state snapshot at the end + new events. The snapshot is
        // rebuilt on every turn so the model always sees the current state.
        const systemPrompt = this.contextBuilder.buildSystemPrompt(
            this.config.persona,
        );

        const messages: LLMMessage[] = [
            { role: "system", content: systemPrompt },
            ...this.contextBuilder.toMessages(),
            {
                role: "user",
                content: this.contextBuilder.buildRoomStateMessage(this.conn),
            },
        ];

        if (events.length > 0) {
            messages.push({
                role: "user",
                content:
                    "New events in the room:\n" +
                    events.join("\n") +
                    "\n\nRespond in character. You may use tools if appropriate, or simply reply with a message.",
            });
        } else {
            messages.push({
                role: "user",
                content:
                    "Continue the roleplay. Act if something feels appropriate, or stay silent.",
            });
        }

        const maxIterations = this.config.maxToolIterations ?? 5;
        const toolDefs = this.tools.map((t) => t.definition);

        for (let i = 0; i < maxIterations; i++) {
            let result;
            try {
                result = await this.client.chat(messages, {
                    model: this.config.model,
                    temperature: this.config.temperature ?? 0.8,
                    max_tokens: this.config.maxTokens ?? 512,
                    tools: toolDefs.length > 0 ? toolDefs : undefined,
                });
            } catch (e) {
                console.error("LLM chat error:", e);
                return;
            }

            // Plain text response: send it to the room and finish.
            if (result.content && result.content.trim()) {
                const text = result.content.trim();
                this.conn.SendMessage("Chat", text);
                this.contextBuilder.recordOutgoing("Chat", text);
                return;
            }

            // No content and no tool calls: nothing to do.
            if (result.toolCalls.length === 0) {
                return;
            }

            // Append the assistant message with tool calls.
            messages.push({
                role: "assistant",
                content: null,
                tool_calls: result.toolCalls,
            });

            // Execute each tool call and append the results.
            for (const call of result.toolCalls) {
                const name = call.function.name;
                const tool = this.toolMap.get(name);
                const args = LLMClient.parseToolArgs(call.function.arguments);
                let resultText: string;

                if (!tool) {
                    resultText = `Error: unknown tool '${name}'.`;
                } else {
                    console.log(
                        `LLM tool call: ${name}(${JSON.stringify(args)})`,
                    );
                    try {
                        resultText = await tool.handler(args, this.ctx);
                    } catch (e) {
                        resultText = `Error executing ${name}: ${String(e)}`;
                    }
                }

                console.log(`  -> ${resultText.slice(0, 200)}`);

                // Record outgoing messages so the LLM knows what it said.
                if (name === "sendMessage" && args.content) {
                    this.contextBuilder.recordOutgoing(
                        String(args.type ?? "Chat"),
                        String(args.content),
                    );
                }

                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    name,
                    content: resultText,
                });
            }
        }

        console.warn(
            `LLM agent hit max tool iterations (${maxIterations}) without a final message.`,
        );
    }

    /**
     * Check a message for safewords. If found, strip the character's items,
     * suspend actions toward them, and notify them.
     * Returns true if a safeword was handled.
     */
    handleSafeword(
        sender: API_Character,
        content: string,
    ): boolean {
        const safewords = this.config.safewords ?? ["red"];
        if (safewords.length === 0) return false;

        const lower = content.toLowerCase();
        const hit = safewords.find((w) =>
            lower.includes(w.toLowerCase()),
        );
        if (!hit) return false;

        console.log(`Safeword '${hit}' used by ${sender.Name}`);

        const suspendMs = this.config.safewordSuspendMs ?? 600_000;
        this.ctx.suspended.set(sender.MemberNumber, Date.now() + suspendMs);

        // Strip all items from the character (paced).
        void sender.Appearance.slowlyStripBulk({
            appearance: false,
            bodyCosplay: false,
            clothing: false,
            item: true,
        });

        sender.Tell(
            "Whisper",
            "(You used a safeword. All items have been removed and I will not touch you for a while. You are free to go.)",
        );

        this.contextBuilder.recordSystem(
            `${sender.Name} used a safeword. All items were removed and actions toward them are suspended.`,
        );
        return true;
    }

    /**
     * Stop the agent (clear timers, mark stopped).
     */
    stop(): void {
        this.stopped = true;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
    }
}
