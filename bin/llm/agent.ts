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
    type RoomDefinition,
} from "bc-bot";
import { LLMClient, LLMChatOptions, LLMMessage } from "./llmClient";
import {
    buildTools,
    resolveTools,
    Tool,
    ToolContext,
    displayName,
} from "./tools";
import { blocksEndTurn } from "./tools/shared";
import { ContextBuilder, messageContent, type HistoryEntry } from "./context";
import { LLMLogger } from "./llmLogger";
import { LLMConfig } from "../config";
import type { ActivityContext, LLMActivity } from "./activities/types";
import { CommandHub } from "./commands/hub";

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
/**
 * A single recorded tool invocation (LLM-driven or manual), kept in a
 * ring buffer for the debug server's /toollog endpoint.
 */
export interface ToolLogEntry {
    ts: string;
    source: "llm" | "manual";
    name: string;
    args: Record<string, unknown>;
    result: string;
}

export class LLMAgent {
    private client: LLMClient;
    private tools: Tool[];
    private toolMap: Map<string, Tool>;
    private ctx: ToolContext;
    private contextBuilder: ContextBuilder;
    private logger: LLMLogger | undefined;
    /** Last 50 tool invocations (LLM or manual), oldest first. */
    private toolLog: ToolLogEntry[] = [];
    /** Optional activities layered on top of the base roleplay bot. */
    private activities: LLMActivity[] = [];
    /** Command hub, set by LLMGame so activities can register commands. */
    private commandHub: CommandHub | undefined;
    /** Built once after activities are attached; passed to activity hooks. */
    private activityContext: ActivityContext | undefined;

    private pendingEvents: string[] = [];
    private debounceTimer: NodeJS.Timeout | undefined;
    /** Wall-clock time the current debounce window started (0 = none). */
    private debounceStartedAt = 0;
    /** Member numbers of participants currently showing a "typing" status. */
    private typingMembers = new Set<number>();
    /** Idle-turn timer, armed after a turn ends to fire a proactive turn. */
    private idleTimer: NodeJS.Timeout | undefined;
    private running = false;
    private stopped = false;
    private emoticonMissingWarned = false;
    /** Last emoticon actually sent to the server (avoids redundant updates). */
    private currentEmoticon: "Hearing" | "Coding" | "Wardrobe" | null = null;

    constructor(
        private conn: API_Connector,
        private config: LLMConfig,
        private superusers: number[],
        private room: RoomDefinition,
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
            room,
            protectedMembers: [
                ...superusers,
                ...(config.protectedMembers ?? []),
            ],
            suspended: new Map(),
            actionTimestamps: [],
            lastActionByTarget: new Map(),
            leashed: new Map(),
            participants: new Set(),
        };

        this.contextBuilder = new ContextBuilder(
            config.historyLength ?? 40,
            config.bioLength ?? 200,
            this.ctx.participants,
        );

        if (config.llmLog) {
            this.logger = new LLMLogger(config.llmLog);
            console.log(`LLM logging enabled -> ${config.llmLog}`);
        }
    }

    /**
     * Give the agent the command hub so activities can register commands
     * during their `init()`. Must be called before {@link attachActivities}.
     */
    setCommandHub(hub: CommandHub): void {
        this.commandHub = hub;
    }

    /**
     * Build the shared {@link ActivityContext}. Must be called (after
     * {@link setCommandHub}) BEFORE any activity's `init()`, because `init()`
     * needs the context to register commands and emit whispers.
     *
     * Idempotent: subsequent calls return the same object.
     */
    createActivityContext(): ActivityContext {
        if (this.activityContext) return this.activityContext;
        if (!this.commandHub) {
            throw new Error(
                "LLMAgent.createActivityContext: command hub is not set.",
            );
        }
        this.activityContext = {
            conn: this.conn,
            llmConfig: this.config,
            toolContext: this.ctx,
            commands: this.commandHub,
            requestParticipant: (memberNumber: number) =>
                this.setParticipant(memberNumber, true),
            isParticipant: (memberNumber: number) =>
                this.ctx.participants.has(memberNumber),
            isSuperuser: (memberNumber: number) =>
                this.superusers.includes(memberNumber),
            participants: () => [...this.ctx.participants],
            whisper: (memberNumber: number, text: string) =>
                this.conn.SendMessage("Whisper", text, memberNumber),
            note: (content: string) =>
                this.contextBuilder.recordSystem(content),
            pushEvent: (content: string) => this.onEvent(content),
            log: (message: string) => console.log(`[activity] ${message}`),
            warn: (message: string) => console.warn(`[activity] ${message}`),
        };
        return this.activityContext;
    }

    /**
     * Attach the enabled activities and merge what they contribute.
     *
     * Called AFTER each activity's `init()` has completed, because the tool
     * set and prompt material depend on the activity state being loaded.
     * Order:
     *
     *  1. ensure the shared activity context exists,
     *  2. merge activity tools into the live tool set (respecting the same
     *     allowedTools/deniedTools filtering as the base tools),
     *  3. hand the activities to the context builder for prompt material,
     *  4. let each activity register its commands.
     */
    attachActivities(activities: LLMActivity[]): void {
        this.activities = activities;
        if (activities.length === 0) return;

        this.createActivityContext();

        // Merge activity tools, applying the same allow/deny filtering the
        // base tools went through.
        const denied = new Set(this.config.deniedTools ?? []);
        const allowed = this.config.allowedTools ?? [];
        for (const activity of activities) {
            for (const tool of activity.getTools()) {
                if (denied.has(tool.name)) continue;
                if (allowed.length > 0 && !allowed.includes(tool.name))
                    continue;
                if (this.toolMap.has(tool.name)) {
                    console.warn(
                        `[activities] Tool '${tool.name}' from '${activity.id}' collides with an existing tool; skipping.`,
                    );
                    continue;
                }
                this.tools.push(tool);
                this.toolMap.set(tool.name, tool);
            }
        }

        this.contextBuilder.setActivities(
            activities,
            () => this.activityContext,
        );

        for (const activity of activities) {
            try {
                activity.registerCommands?.(this.activityContext);
            } catch (e) {
                console.error(
                    `[activities] ${activity.id} failed to register commands:`,
                    e,
                );
            }
        }

        console.log(
            `Activities enabled: ${activities
                .map((a) => `${a.id} (${a.getTools().length} tools)`)
                .join(", ")}`,
        );
    }

    /** Enabled activities, for event forwarding and debug inspection. */
    getActivities(): LLMActivity[] {
        return this.activities;
    }

    /** The shared context handed to activity hooks, once attached. */
    getActivityContext(): ActivityContext | undefined {
        return this.activityContext;
    }

    /**
     * Feed an event into the agent. Events are coalesced; a turn is triggered
     * after the debounce window elapses with no new events, but no later than
     * `debounceMaxWaitMs` after the first pending event (so a continuous
     * stream of events can't starve a turn indefinitely).
     */
    onEvent(description: string): void {
        console.log(description);
        if (this.stopped) return;
        // Any incoming event cancels the idle-turn timer: the normal
        // debounce window takes over from here.
        this.cancelIdleTimer();
        this.pendingEvents.push(description);
        this.scheduleTurn();
    }

    /**
     * Arm the idle-turn timer. After a turn ends, if no incoming events
     * arrive within `idleTurnMs`, a proactive turn is fired. No-op when
     * `idleTurnMs` is unset or non-positive (feature disabled).
     */
    private startIdleTimer(): void {
        this.cancelIdleTimer();
        const idleMs = this.config.idleTurnMs;
        if (!idleMs || idleMs <= 0 || this.stopped) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined;
            if (this.stopped) return;
            console.log(
                `Idle timer fired after ${idleMs} ms with no incoming events; starting proactive turn`,
            );
            // Respect typing state, consistent with the debounce: if a
            // participant is still typing, poll instead of firing.
            if (this.typingMembers.size > 0) {
                this.idleTimer = setTimeout(() => {
                    this.idleTimer = undefined;
                    void this.runTurn();
                }, 500);
                return;
            }
            void this.runTurn();
        }, idleMs);
    }

    /**
     * Cancel the idle-turn timer, if armed.
     */
    private cancelIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    /**
     * Record a typing-status change for a participant.
     *
     * When `isTyping` is true the member is added to the typing set and the
     * debounce window is restarted (same as a normal event) so the bot waits
     * for the participant to finish. When `isTyping` is false the member is
     * simply removed; the existing timer keeps running.
     *
     * No-op when `waitForTyping` is disabled in the config.
     */
    onTypingStatus(memberNumber: number, isTyping: boolean): void {
        if (this.stopped) return;
        if (this.config.waitForTyping === false) return;
        if (isTyping) {
            this.typingMembers.add(memberNumber);
            console.log(
                `Typing status: ${memberNumber} is typing (${this.typingMembers.size} total)`,
            );
            this.scheduleTurn();
        } else {
            this.typingMembers.delete(memberNumber);
            console.log(
                `Typing status: ${memberNumber} stopped typing (${this.typingMembers.size} remaining)`,
            );
        }
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
            `[${displayName(sender)} ${message.Type}] ${messageContent(message)}`,
        );
    }

    private scheduleTurn(): void {
        const now = Date.now();
        if (this.debounceTimer) {
            // True debounce: every new event restarts the quiet window.
            clearTimeout(this.debounceTimer);
        }
        if (this.debounceStartedAt === 0) {
            this.debounceStartedAt = now;
        }
        // Feedback: we are accumulating events, waiting for the room to go
        // quiet. Only shown when idle — a running turn keeps its own
        // "Coding"/"Wardrobe" emoticon.
        if (!this.running) {
            this.setEmoticon("Hearing");
        }

        const debounceMs = this.config.debounceMs ?? 1500;
        const maxWaitMs = this.config.debounceMaxWaitMs ?? 5000;
        const anyoneTyping = this.typingMembers.size > 0;

        // Starvation guard: fire no later than maxWaitMs after the first
        // pending event, even if events keep arriving. Skipped while a
        // participant is still typing — we genuinely want to wait for them.
        let delay: number;
        if (anyoneTyping) {
            delay = debounceMs;
        } else {
            const remainingMaxWait = maxWaitMs - (now - this.debounceStartedAt);
            delay = Math.max(0, Math.min(debounceMs, remainingMaxWait));
        }

        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;

            // If a participant is still typing, don't fire the turn yet.
            // Reschedule with a short poll so we check again soon.
            if (this.typingMembers.size > 0) {
                console.log(
                    `Debounce fired but ${this.typingMembers.size} participant(s) still typing; polling in 500 ms`,
                );
                this.debounceTimer = setTimeout(() => {
                    this.debounceTimer = undefined;
                    void this.runTurn();
                }, 500);
                return;
            }

            this.debounceStartedAt = 0;
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
            //it seems that separately passing events is not really needed
            await this.executeTurn(events);
        } catch (e) {
            console.error("LLM agent turn failed:", e);
        } finally {
            this.running = false;
            // If new events arrived while we were running, run another turn.
            // Drop the timer armed mid-turn and start a FRESH debounce
            // window, so the next turn waits out a full debounce delay
            // instead of firing immediately.
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
                this.debounceTimer = undefined;
            }
            this.debounceStartedAt = 0;
            if (this.pendingEvents.length > 0 && !this.stopped) {
                this.scheduleTurn();
            } else if (!this.stopped) {
                // No pending events: arm the idle-turn timer so the bot
                // proactively continues the roleplay after a quiet period.
                this.startIdleTimer();
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

        // Watermark of how many history entries are already reflected in
        // `messages`. Each iteration appends only the NEW entries (in their
        // original order) plus a fresh room-state snapshot, so the model sees
        // mid-turn events and its own actions' effects without re-sending the
        // whole history.
        let historyWatermark = this.contextBuilder.getHistory().length;

        //it seems that separately passing events is not really needed
        // if (events.length > 0) {
        //     messages.push({
        //         role: "user",
        //         content:
        //             "New events in the room:\n" +
        //             events.join("\n") +
        //             "\n\nRespond in character. Use tools for everything. But you can write OOC messages in parentheses (Like this) if you want.",
        //     });
        // } else {
        //     messages.push({
        //         role: "user",
        //         content:
        //             //"Continue the roleplay. Act if something feels appropriate, or stay silent.",
        //             "Respond in character. Use tools for everything. But you can write OOC messages in parentheses (Like this) if you want."
        //     });
        // }
        messages.push({
            role: "user",
            content:
                //"Continue the roleplay. Act if something feels appropriate, or stay silent.",
                "Respond in character. Use tools for everything. But you can write OOC messages in parentheses (Like this) if you want.",
        });

        const maxIterations = this.config.maxToolIterations ?? 5;
        const toolDefs = this.tools.map((t) => t.definition);
        const chatOptions: LLMChatOptions = {
            model: this.config.model,
            temperature: this.config.temperature ?? 0.8,
            max_tokens: this.config.maxTokens ?? 512,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
        };

        this.logger?.newTurn();

        // Whether the previous tool batch contained a lookup tool; decides
        // which "thinking" emoticon to show before the next LLM call.
        let prevBatchHadLookup = false;

        try {
            for (let i = 0; i < maxIterations; i++) {
                // Feedback: "Wardrobe" while deciding what to do with lookup
                // results, "Coding" while generating normally.
                this.setEmoticon(prevBatchHadLookup ? "Wardrobe" : "Coding");

                let result;
                this.logger?.logRequest(messages, chatOptions);
                const t0 = Date.now();
                try {
                    result = await this.client.chat(messages, chatOptions);
                } catch (e) {
                    console.error("LLM chat error:", e);
                    this.logger?.logError(String(e));
                    return;
                }
                this.logger?.logResponse(result, Date.now() - t0);

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

                // Append the assistant message with tool calls. Echo back
                // the model's reasoning_content so it keeps its
                // chain-of-thought across this turn's iterations. (The
                // messages array is rebuilt on every turn, so reasoning
                // never leaks between turns.)
                messages.push({
                    role: "assistant",
                    content: null,
                    tool_calls: result.toolCalls,
                    ...(result.reasoningContent
                        ? { reasoning_content: result.reasoningContent }
                        : {}),
                });

                // Execute each tool call and append the results.
                // If endTurn is chained with a lookup tool (listItems etc.) in the
                // same batch, ignore it and remind the model to act first.
                const batchNames = new Set<string>(
                    result.toolCalls.map((c) => String(c.function.name)),
                );
                // Which tools in this batch forbid ending the turn, and why.
                // Derived from the tools themselves, so an activity's tools
                // participate without any edit here.
                const blockingLookup = [...batchNames].filter(
                    (n) => this.toolMap.get(n)?.lookup,
                );
                const blockingOther = [...batchNames].filter((n) => {
                    const tool = this.toolMap.get(n);
                    return tool && !tool.lookup && blocksEndTurn(tool);
                });
                const hasLookup = blockingLookup.length > 0;
                const hasBlocking = hasLookup || blockingOther.length > 0;
                let endTurnRequested = false;
                const toolCallDelayMs = this.config.toolCallDelayMs ?? 500;
                for (let i = 0; i < result.toolCalls.length; i++) {
                    // Small pause between tool calls so the game server
                    // receives the resulting messages in a stable order.
                    if (i > 0 && toolCallDelayMs > 0) {
                        await new Promise((r) =>
                            setTimeout(r, toolCallDelayMs * i),
                        );
                    }
                    const call = result.toolCalls[i];
                    const name = call.function.name;
                    const tool = this.toolMap.get(name);
                    const args = LLMClient.parseToolArgs(
                        call.function.arguments,
                    );
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
                    this.recordToolLog("llm", name, args, resultText);

                    // Record outgoing messages so the LLM knows what it said.
                    if (name === "sendMessage" && args.content) {
                        this.contextBuilder.recordOutgoing(
                            String(args.type ?? "Chat"),
                            String(args.content),
                        );
                    }

                    // Persist the result across turns when the tool asks for
                    // it, so the model remembers what it did.
                    this.recordToolHistory(name, resultText);

                    if (name === "endTurn") {
                        if (hasBlocking) {
                            const parts: string[] = [];
                            if (blockingLookup.length > 0) {
                                parts.push(
                                    `lookup tool(s): ${blockingLookup.join(", ")}`,
                                );
                            }
                            if (blockingOther.length > 0) {
                                parts.push(
                                    `tool(s) whose result must be checked: ${blockingOther.join(", ")}`,
                                );
                            }
                            resultText =
                                `endTurn ignored: this batch called ${parts.join(" and ")}. ` +
                                "Inspect the result(s) first, then end the turn with a separate endTurn call.";
                            console.log(`  -> ${resultText}`);
                        } else {
                            endTurnRequested = true;
                        }
                    }

                    messages.push({
                        role: "tool",
                        tool_call_id: call.id,
                        name,
                        content: resultText,
                    });
                }

                // If the model called endTurn, stop the loop.
                if (endTurnRequested) {
                    return;
                }

                prevBatchHadLookup = hasLookup;

                // Refresh context before the next LLM call so the model sees
                // the effects of the actions it just took and any events that
                // arrived mid-turn. Append only NEW user-role history entries
                // (in their original order) plus a fresh room-state snapshot.
                //
                // Only user entries are appended: the bot's own actions are
                // already visible as the `tool` results above, and appending
                // the assistant history entries (recorded via recordOutgoing /
                // recordAction) here would place an assistant message AFTER a
                // tool message, which violates the API rule that a tool message
                // must be immediately followed by the assistant message that
                // made those calls. The fresh snapshot is the authoritative
                // picture of who is wearing what.
                const newEntries = this.contextBuilder.getMessagesSince(
                    historyWatermark,
                    ["user"],
                );
                historyWatermark = this.contextBuilder.getHistory().length;
                for (const entry of newEntries) {
                    messages.push(entry);
                }
                messages.push({
                    role: "user",
                    content: this.contextBuilder.buildRoomStateMessage(
                        this.conn,
                    ),
                });
            }

            console.warn(
                `LLM agent hit max tool iterations (${maxIterations}) without a final message.`,
            );
        } finally {
            // Idle: clear the feedback emoticon on every exit path.
            this.setEmoticon(null);
        }
    }

    /**
     * Set the bot's Emoticon as a working-state indicator
     * (Hearing = accumulating events, Coding = generating,
     * Wardrobe = acting on lookup results, null = idle).
     */
    private setEmoticon(expr: "Hearing" | "Coding" | "Wardrobe" | null): void {
        if (expr === this.currentEmoticon) return;
        this.currentEmoticon = expr;
        const me = this.conn.Player;
        if (!me.Appearance.InventoryGet("Emoticon")) {
            if (!this.emoticonMissingWarned) {
                this.emoticonMissingWarned = true;
                console.warn(
                    "Bot has no Emoticon item; working-state emoticons disabled.",
                );
            }
            return;
        }
        me.SetExpression("Emoticon", expr);
    }

    /**
     * Check a message for safewords. If found, strip the character's items,
     * suspend actions toward them, and notify them.
     * Returns true if a safeword was handled.
     */
    handleSafeword(sender: API_Character, content: string): boolean {
        const safewords = this.config.safewords ?? ["red"];
        if (safewords.length === 0) return false;

        const lower = content.toLowerCase();
        const hit = safewords.find((w) => lower.includes(w.toLowerCase()));
        if (!hit) return false;

        console.log(`Safeword '${hit}' used by ${displayName(sender)}`);

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
            `${displayName(sender)} used a safeword. All items were removed and actions toward them are suspended.`,
        );
        return true;
    }

    /**
     * Stop the agent (clear timers, mark stopped).
     */
    /**
     * Release the leash on a character (e.g. when they leave the room).
     * No-op if the bot is not holding their leash.
     */
    releaseLeash(memberNumber: number): void {
        if (!this.ctx.leashed.has(memberNumber)) return;
        this.conn.SendMessage("Hidden", "StopHoldLeash", memberNumber);
        this.ctx.leashed.delete(memberNumber);
    }

    /**
     * Remove a character from the leashed map without sending StopHoldLeash.
     * Used when the character removes the leash themselves (RemoveLeash
     * Hidden message) — the leash is already gone, we just need to stop
     * tracking them so we don't ping a released character.
     */
    dropLeash(memberNumber: number): void {
        this.ctx.leashed.delete(memberNumber);
    }

    /**
     * Add or remove a character from the participant set. Removing a
     * participant also releases their leash if held.
     */
    setParticipant(memberNumber: number, participating: boolean): void {
        const changed =
            this.ctx.participants.has(memberNumber) !== participating;
        if (participating) {
            this.ctx.participants.add(memberNumber);
        } else {
            this.ctx.participants.delete(memberNumber);
            this.typingMembers.delete(memberNumber);
            this.releaseLeash(memberNumber);
        }
        if (changed) {
            for (const activity of this.activities) {
                try {
                    activity.onParticipantChanged?.(
                        this.activityContext!,
                        memberNumber,
                    );
                } catch (e) {
                    console.error(
                        `[activities] ${activity.id} participant hook failed:`,
                        e,
                    );
                }
            }
        }
    }

    /**
     * Record a message the bot sent into the rolling history, for activities
     * that emit their own messages. Exposed so activities never reach into
     * the context builder directly.
     */
    recordOutgoing(type: string, content: string): void {
        this.contextBuilder.recordOutgoing(type, content);
    }

    /**
     * Record a SYSTEM note into the rolling history. Unlike
     * {@link ActivityContext.note}, which is bound to the shared context, this
     * is available before activities are attached.
     */
    recordSystemNote(content: string): void {
        this.contextBuilder.recordSystem(content);
    }

    /**
     * Whether a character is currently an active participant.
     */
    isParticipant(memberNumber: number): boolean {
        return this.ctx.participants.has(memberNumber);
    }

    /**
     * Return the member numbers of all active participants.
     */
    getParticipants(): number[] {
        return [...this.ctx.participants];
    }

    /**
     * Look up a tool by name (for the in-game `!tool` test command).
     */
    getTool(name: string): Tool | undefined {
        return this.toolMap.get(name);
    }

    /**
     * All tools the LLM is allowed to use (after allowed/denied filtering).
     */
    getTools(): Tool[] {
        return this.tools;
    }

    /**
     * Execute a tool directly, bypassing the LLM. Returns the tool's result
     * string, or an error string if the tool is unknown or throws.
     */
    async runTool(
        name: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        const tool = this.toolMap.get(name);
        if (!tool) return `Error: unknown tool '${name}'.`;
        console.log(`Manual tool call: ${name}(${JSON.stringify(args)})`);
        let result: string;
        try {
            result = await tool.handler(args, this.ctx);
        } catch (e) {
            result = `Error executing ${name}: ${String(e)}`;
        }
        this.recordToolLog("manual", name, args, result);
        // Persist physical actions into the rolling history the same way
        // LLM-driven calls are, so the model remembers them across turns.
        this.recordToolHistory(name, result);
        return result;
    }

    /**
     * Persist a tool result into the rolling history when the tool declares
     * it should survive across turns. Single implementation shared by the
     * LLM-driven loop and manual `!tool` calls, so the two cannot drift.
     */
    private recordToolHistory(name: string, result: string): void {
        const kind = this.toolMap.get(name)?.history;
        if (kind === "action") {
            this.contextBuilder.recordAction(result);
        } else if (kind === "roomChange") {
            this.contextBuilder.recordRoomChange(result);
        }
    }

    /**
     * Record a room change the bot underwent (e.g. being leashed into a room
     * by another character) into the rolling history so the model remembers
     * where it went across turns.
     */
    recordRoomChange(content: string): void {
        this.contextBuilder.recordRoomChange(content);
    }

    /**
     * Return a copy of the rolling chat/action history (for the debug
     * server's /history endpoint).
     */
    getHistory(): HistoryEntry[] {
        return this.contextBuilder.getHistory();
    }

    /**
     * Append an entry to the tool-invocation ring buffer (max 50 entries).
     */
    private recordToolLog(
        source: "llm" | "manual",
        name: string,
        args: Record<string, unknown>,
        result: string,
    ): void {
        this.toolLog.push({
            ts: new Date().toISOString(),
            source,
            name,
            args,
            result,
        });
        if (this.toolLog.length > 50) {
            this.toolLog.shift();
        }
    }

    /**
     * The recent tool-invocation log (LLM and manual calls), oldest first.
     */
    getToolLog(): ToolLogEntry[] {
        return [...this.toolLog];
    }

    /**
     * A short human-readable snapshot of the agent's state, for the
     * `!toolstatus` command.
     */
    getToolStatus(): string {
        const now = Date.now();
        const windowMs = 60_000;
        const recentActions = this.ctx.actionTimestamps.filter(
            (t) => t >= now - windowMs,
        ).length;
        const maxPerMinute = this.config.maxActionsPerMinute ?? 10;
        const suspended = [...this.ctx.suspended.entries()]
            .filter(([, until]) => until > now)
            .map(([n, until]) => `${n} (${Math.ceil((until - now) / 1000)}s)`);
        const leashed = [...this.ctx.leashed.keys()];
        return [
            `Participants: ${this.getParticipants().join(", ") || "(none)"}`,
            `Rate limit: ${recentActions}/${maxPerMinute} actions in the last minute`,
            `Suspended (safeword): ${suspended.join(", ") || "(none)"}`,
            `Leashed: ${leashed.join(", ") || "(none)"}`,
        ].join("\n");
    }

    stop(): void {
        this.stopped = true;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        this.cancelIdleTimer();
        this.debounceStartedAt = 0;
        this.typingMembers.clear();
        this.setEmoticon(null);
        this.logger?.close();
    }

    /**
     * Stop the agent and every activity (flushing persisted state). Separate
     * from {@link stop} so the synchronous shutdown path keeps working while
     * activities get a chance to finish their async cleanup.
     */
    async stopWithActivities(): Promise<void> {
        this.stop();
        for (const activity of this.activities) {
            try {
                await activity.stop();
            } catch (e) {
                console.error(`[activities] ${activity.id} stop failed:`, e);
            }
        }
    }
}
