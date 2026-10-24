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

import { appendFileSync } from "node:fs";
import {
    API_Connector,
    API_Character,
    AnyCharacterEvent,
    AnyLogicEvent,
    BC_Server_ChatRoomMessage,
    CommandParser,
    LogicBase,
} from "bc-bot";
import { LLMConfig, ConfigFile } from "../config";
import { LLMAgent } from "../llm/agent";
import { DebugServer } from "../llm/debugServer";
import {
    decodeDescription,
    messageContent,
    stripBotDisclaimer,
    withBotDisclaimer,
} from "../llm/context";
import { parseToolArgs } from "../llm/tools/toolCommand";
import { displayName } from "../llm/tools/shared";
import {
    loadActivityDictionary,
    renderActivityText,
    type ActivityDictionary,
} from "../llm/activityDictionary";
import { CommandHub, CORE_OWNER } from "../llm/commands/hub";
import type { CommandContribution } from "../llm/commands/types";
import {
    buildActivities,
    enabledActivityIds,
    type LLMActivity,
} from "../llm/activities/registry";

/**
 * The LLM-powered roleplay game. It wires room events into an {@link LLMAgent}
 * which decides how the bot should react (chat, apply/remove items, change
 * poses, etc.) using a locally-served LLM with native tool calling.
 *
 * The bot self-configures on start: it sets its nickname and description from
 * the config, and optionally a starting pose.
 */
export class LLMGame extends LogicBase {
    private agent: LLMAgent;
    private commandParser: CommandParser;
    private commandHub: CommandHub;
    /** Optional activities layered on top of the base roleplay bot. */
    private activities: LLMActivity[] = [];
    /** Nickname as it was before init() modified it, restored on stop(). */
    private originalNickname: string | undefined;
    /**
     * Decoded bio as it was before init() appended the disclaimer.
     * accountUpdate() does not update local state, so we can't rely on
     * me.Description in stop() — restore from this snapshot instead.
     */
    private originalBio: string | undefined;
    /** Whether init() actually appended the disclaimer (so stop() knows to remove it). */
    private disclaimerAdded = false;
    /** Local HTTP debug server, present only when llm.debugPort is set. */
    private debugServer: DebugServer | undefined;
    /** ActivityName -> text template, loaded from ActivityDictionary.csv. */
    private activityDictionary: ActivityDictionary = new Map();

    constructor(
        private conn: API_Connector,
        private config: ConfigFile,
        private llmConfig: LLMConfig,
        private superusers: number[],
    ) {
        super();
        this.agent = new LLMAgent(conn, llmConfig, superusers, config.room);
        this.commandParser = new CommandParser(conn);
        this.commandHub = new CommandHub(conn, this.commandParser);
        this.agent.setCommandHub(this.commandHub);
        this.registerCoreCommands();
    }

    /**
     * Register the base bot's own commands through the hub, so activities can
     * add to them (`append`) or deliberately override them (`replace`) without
     * fighting over the CommandParser's single-handler-per-name map.
     *
     * Every handler returns its reply text rather than sending it; the hub
     * joins all contributions into one message.
     */
    private registerCoreCommands(): void {
        const reg = (
            name: string,
            help: string,
            handler: Parameters<CommandHub["register"]>[0]["handler"],
            extra: Partial<CommandContribution> = {},
        ) =>
            this.commandHub.register({
                name,
                owner: CORE_OWNER,
                priority: 0,
                help,
                handler,
                ...extra,
            });

        // `/bot help` lists every command that declares help, filtered for the
        // sender. Always whispered: a wall of command text does not belong in
        // public chat.
        reg(
            "help",
            "Show this list of commands.",
            (c) =>
                this.commandHub.helpText({
                    isSuperuser: this.isSuperuser(c.sender),
                }),
            { private: true },
        );

        reg(
            "start",
            "Start roleplaying with the bot — I will reply to you.",
            (c) => this.onCommandStart(c.sender, c.message),
        );
        reg("stop", "Stop roleplaying with the bot.", (c) =>
            this.onCommandStop(c.sender, c.message),
        );
        reg("status", "List current participants and enabled activities.", () =>
            this.onCommandStatus(),
        );
        reg(
            "feedback",
            "Send a note to the bot's operator.",
            (c) => this.onCommandFeedback(c.sender, c.message),
            { usage: "<text>" },
        );

        // Operator commands: hidden from the listing for everyone else.
        reg(
            "tools",
            "List the LLM's available tools.",
            (c) => this.onCommandTools(c.sender, c.message),
            { superuserOnly: true },
        );
        reg(
            "tool",
            "Invoke a tool directly, bypassing the LLM.",
            (c) => this.onCommandTool(c.sender, c.message),
            { superuserOnly: true, usage: "<name> [key=value ...]" },
        );
        reg(
            "toolstatus",
            "Rate-limit and leash state.",
            (c) => this.onCommandToolStatus(c.sender, c.message),
            { superuserOnly: true },
        );
    }

    /**
     * Enabled activities, for `/bot status`.
     *
     * Prefers the actually-attached activities (they may have failed to
     * initialise) and falls back to the configured ids if `/bot status` runs
     * before `init()` finished attaching them.
     */
    private enabledActivityLabels(): string[] {
        if (this.activities.length > 0) {
            return this.activities.map((a) => a.title);
        }
        return enabledActivityIds(this.llmConfig);
    }

    /**
     * Whether the sender is a superuser (allowed to use the tool test commands).
     */
    private isSuperuser(sender: API_Character): boolean {
        return this.superusers.includes(sender.MemberNumber);
    }

    /**
     * The CommandParser lowercases the whole command string before splitting,
     * which would mangle case-sensitive tool names and args (e.g. 'ItemMouth').
     * Re-extract the raw substring after the 'tool ' prefix from the original
     * message content so case is preserved.
     */
    private extractRawToolArgs(msg: BC_Server_ChatRoomMessage): string {
        const content = msg.Content.replace(/^\(+/, "").replace(/\)+$/, "");
        const lower = content.toLowerCase();
        const idx = lower.indexOf("tool ");
        if (idx === -1) return "";
        return content.slice(idx + "tool ".length).trim();
    }

    private onCommandTools = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): string => {
        if (!this.isSuperuser(sender)) {
            return "Not authorized.";
        }
        const tools = this.agent.getTools();
        const lines = tools.map((t) => {
            const props = t.definition.function.parameters.properties;
            const required = t.definition.function.parameters.required ?? [];
            const params = Object.entries(props)
                .map(([k, p]) => {
                    const req = required.includes(k) ? "" : "?";
                    const enumStr = p.enum ? ` (${p.enum.join("|")})` : "";
                    return `${k}${req}:${p.type}${enumStr}`;
                })
                .join(", ");
            return `!tool ${t.name} ${params}`;
        });
        return `Available tools (${tools.length}):\n${lines.join("\n")}\n\nUsage: !tool <name> [key=value ...] or !tool <name> {"key":value}`;
    };

    private onCommandTool = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): Promise<string> => {
        if (!this.isSuperuser(sender)) {
            return "Not authorized.";
        }
        const raw = this.extractRawToolArgs(msg);
        const spaceIdx = raw.indexOf(" ");
        const name = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).trim();
        const argsRaw = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1);
        if (!name) {
            return "Usage: !tool <name> [key=value ...]";
        }
        const [args, error] = parseToolArgs(argsRaw);
        if (error) {
            return error;
        }
        return this.agent.runTool(name, args);
    };

    private onCommandToolStatus = (
        sender: API_Character,
        _msg: BC_Server_ChatRoomMessage,
    ): string => {
        if (!this.isSuperuser(sender)) {
            return "Not authorized.";
        }
        return this.agent.getToolStatus();
    };

    /**
     * The CommandParser lowercases the whole command string before splitting,
     * which would mangle the feedback text. Re-extract the raw substring after
     * the 'feedback ' prefix from the original message content so case and
     * punctuation are preserved.
     */
    private extractRawFeedback(msg: BC_Server_ChatRoomMessage): string {
        const content = msg.Content.replace(/^\(+/, "").replace(/\)+$/, "");
        const lower = content.toLowerCase();
        const idx = lower.indexOf("feedback ");
        if (idx === -1) return "";
        return content.slice(idx + "feedback ".length).trim();
    }

    /**
     * `!feedback <text>` — append the sender's feedback to the feedback log
     * file. Available to any character (it is a feedback channel, not a
     * superuser tool).
     */
    private onCommandFeedback = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): string => {
        const text = this.extractRawFeedback(msg);
        if (!text) {
            return "Usage: !feedback <your feedback>";
        }
        const file = this.llmConfig.feedbackFile ?? "feedback.log";
        const line = `[${new Date().toISOString()}] ${displayName(
            sender,
        )} (${sender.MemberNumber}): ${text}\n`;
        try {
            appendFileSync(file, line);
            return "Thanks for the feedback!";
        } catch (e) {
            console.error("Failed to write feedback:", e);
            return "Sorry, I couldn't record that.";
        }
    };

    private onCommandStart = (
        sender: API_Character,
        _msg: BC_Server_ChatRoomMessage,
    ): string => {
        this.agent.setParticipant(sender.MemberNumber, true);
        const safewords = this.llmConfig.safewords.join(", ");
        return (
            `Welcome, ${displayName(sender)}! You can now RP with me — say something or poke/pet me.\n` +
            `It takes me around 1 minute to reply. \n` +
            `Commands: /bot start, /bot stop, /bot status, /bot feedback. Safewords: ${safewords}.`
        );
    };

    private onCommandStop = (
        sender: API_Character,
        _msg: BC_Server_ChatRoomMessage,
    ): string => {
        this.agent.setParticipant(sender.MemberNumber, false);
        return `You are no longer a participant. I will ignore you from now on.`;
    };

    /**
     * Participant list plus the enabled activity names. No activity detail
     * here — anything private lives behind the activity's own command.
     */
    private onCommandStatus = (): string => {
        const room = this.conn.chatRoom;
        const names = this.agent.getParticipants().map((n) => {
            const c = room?.characters.find((c) => c.MemberNumber === n);
            return c ? displayName(c) : String(n);
        });
        const activities = this.enabledActivityLabels();
        return [
            names.length > 0
                ? `Participants: ${names.join(", ")}`
                : "No participants yet. Use !start to join.",
            activities.length > 0
                ? `Activities: ${activities.join(", ")}`
                : "Activities: (none)",
        ].join("\n");
    };

    /**
     * Self-setup: nickname, bio disclaimer, and optional starting pose.
     */
    public async init(): Promise<void> {
        const me = this.conn.Player;

        // Mark the nickname so players can tell it's a bot.
        this.originalNickname = me.NickName;
        const currentNick = me.NickName || me.Name;
        if (!currentNick.endsWith(" BOT")) {
            this.conn.accountUpdate({ Nickname: `${currentNick} BOT` });
        }

        // Build and start the optional activities BEFORE the bio is written,
        // so their bio addenda (e.g. the riddle invite) are included.
        this.activities = buildActivities(this.llmConfig);
        if (this.activities.length > 0) {
            const context = this.agent.createActivityContext();
            for (const activity of this.activities) {
                try {
                    await activity.init(context);
                } catch (e) {
                    console.error(
                        `[activities] Failed to initialise '${activity.id}':`,
                        e,
                    );
                }
            }
            this.agent.attachActivities(this.activities);
        }

        // Append the AI disclaimer to the bio (idempotent). The original bio
        // is preserved; describeCharacter strips the disclaimer before it
        // reaches the LLM.
        const bio = decodeDescription(me.Description ?? "");
        this.originalBio = bio;
        var newBio = stripBotDisclaimer(bio);
        newBio = withBotDisclaimer(newBio, this.llmConfig);
        newBio = this.withActivityBioLines(newBio);
        if (newBio !== bio) {
            this.disclaimerAdded = true;
            this.conn.setBotDescription(newBio);
        }

        // Allow other players to leash the bot (required for the leash tool).
        if (!me.OnlineSharedSettings.AllowPlayerLeashing) {
            me.allowPlayerLeashing = true;
        }

        // Optional starting pose for the bot itself.
        const startPose = this.llmConfig.startPose;
        if (startPose && startPose.length > 0) {
            try {
                me.SetActivePose(startPose as never);
            } catch (e) {
                console.warn("Could not set starting pose:", e);
            }
        }

        // Optional local debug server for programmatic tool testing.
        const debugPort = this.llmConfig.debugPort;
        if (debugPort) {
            this.debugServer = new DebugServer(
                debugPort,
                this.agent,
                this.llmConfig.llmLog,
                () => {
                    void this.stop().then(() => process.exit(0));
                },
            );
            this.debugServer.start();
        }

        this.activityDictionary = await loadActivityDictionary();

        console.log("LLM bot ready. Persona loaded, agent running.");
    }

    /**
     * Append each activity's bio addendum (if any) to the disclaimer text, so
     * the bio advertises the enabled modes.
     */
    private withActivityBioLines(bio: string): string {
        const lines: string[] = [];
        for (const activity of this.activities) {
            const line = activity.bioAddendum?.();
            if (line && line.trim()) lines.push(line.trim());
        }
        if (lines.length === 0) return bio;
        return `${bio.trimEnd()}\n${lines.join("\n")}\n`;
    }

    /**
     * Handle incoming logic events. We only care about Leash beeps: when a
     * character leashes the bot and then changes rooms, the server sends a
     * "Leash" beep carrying the character's new room. The bot follows by
     * joining that room (mirroring the game client's ServerHandleLeashBeep).
     */
    public onEvent(ev: AnyLogicEvent): void {
        if (ev.name !== "Beep") return;
        const beep = ev.beep;
        if (beep.BeepType !== "Leash") return;
        // Ignore beeps from the bot itself.
        if (beep.MemberNumber === this.conn.Player.MemberNumber) return;
        const roomName = beep.ChatRoomName;
        if (!roomName) return;
        const current = this.conn.chatRoom;
        if (current && current.Name === roomName) return;
        console.log(
            `Leash beep from ${beep.MemberName} (${beep.MemberNumber}): following to room '${roomName}'`,
        );
        this.conn.ChatRoomLeave();
        void this.conn.ChatRoomJoin(roomName);
        // Record the room change in the rolling history so the model
        // remembers it was leashed into the new room across turns.
        this.agent.recordRoomChange(
            `You were leashed into room '${roomName}' by ${beep.MemberName}.`,
        );
    }

    protected onMessage(
        connection: API_Connector,
        message: BC_Server_ChatRoomMessage,
        sender: API_Character,
    ): void {
        const me = connection.Player;

        // Ignore our own messages (the server echoes them back).
        if (sender.MemberNumber === me.MemberNumber) return;

        // If a character removes the leash they were holding on the bot,
        // drop them from the leashed map so we stop pinging them.
        if (message.Type === "Hidden" && message.Content === "RemoveLeash") {
            this.agent.dropLeash(sender.MemberNumber);
            return;
        }

        // Status messages carry typing indicators ("Talk" / "null").
        // Route them to the agent so it can track who is still typing and
        // hold the debounce window until everyone is done.
        if (message.Type === "Status") {
            if (this.agent.isParticipant(sender.MemberNumber)) {
                this.agent.onTypingStatus(
                    sender.MemberNumber,
                    message.Content === "Talk",
                );
            }
            return;
        }

        // Give activities a look at the raw message before the base bot
        // decides anything. They must not block the stream: the base bot
        // still forwards the message to the agent afterwards.
        this.forwardToActivities((ctx, activity) =>
            activity.onMessage?.(ctx, sender, message),
        );

        // Ignore non-text message types. "Action" is allowed through so the
        // item add/remove events it carries (ActionUse/ActionRemove) can be
        // parsed below.
        if (
            message.Type !== "Chat" &&
            message.Type !== "Emote" &&
            message.Type !== "Whisper" &&
            message.Type !== "Activity" &&
            message.Type !== "Action"
        )
            return;

        // Safeword check first: if the sender used a safeword, handle it and
        // do NOT feed the raw message to the agent as a normal prompt.
        if (this.agent.handleSafeword(sender, message.Content)) {
            return;
        }

        // Only participants' messages are fed to the agent.
        if (!this.agent.isParticipant(sender.MemberNumber)) return;

        // Activities are physical actions, not speech: extract a readable
        // sentence from the message dictionary and feed it in as a regular
        // message. They never trigger safeword handling.
        if (message.Type === "Activity") {
            const text = extractActivityText(
                message,
                connection,
                this.activityDictionary,
            );
            if (text) {
                this.agent.onIncomingMessage(sender, {
                    ...message,
                    Content: text,
                });
            }
            return;
        }

        // Action messages (ActionUse / ActionRemove) carry item add/remove
        // events in their dictionary. The server's ItemAdd/ItemRemove
        // character events don't always reach us, so parse these directly.
        // The bot's own actions are already filtered out above (sender === me)
        // and are recorded from the tool results instead.
        if ((message.Type as string) === "Action") {
            const text = extractActionText(message, sender, connection);
            if (text) {
                this.agent.onIncomingMessage(sender, {
                    ...message,
                    Content: text,
                });
            } else {
                // Other Action messages (e.g. item-triggered "Beep" when a
                // nose plug releases) carry their descriptive text in the
                // dictionary under the "msg" tag rather than in Content.
                const msgText = messageContent(message);
                if (msgText && msgText !== message.Content) {
                    this.agent.onIncomingMessage(sender, {
                        ...message,
                        Content: msgText,
                    });
                }
            }
            return;
        }

        this.agent.onIncomingMessage(sender, message);
    }

    /**
     * Run a hook for every enabled activity, isolating failures so one broken
     * activity cannot break chat handling.
     */
    private forwardToActivities(
        hook: (
            ctx: import("../llm/activities/types").ActivityContext,
            activity: LLMActivity,
        ) => void,
    ): void {
        const ctx = this.agent.getActivityContext();
        if (!ctx || this.activities.length === 0) return;
        for (const activity of this.activities) {
            try {
                hook(ctx, activity);
            } catch (e) {
                console.error(
                    `[activities] ${activity.id} event hook failed:`,
                    e,
                );
            }
        }
    }

    protected onCharacterEntered(
        connection: API_Connector,
        character: API_Character,
    ): Promise<void> {
        if (character.MemberNumber === connection.Player.MemberNumber) {
            return Promise.resolve();
        }

        // Activities see every arrival (riddle mode whispers an invite to
        // newcomers whether or not they are already participating).
        this.forwardToActivities((ctx, activity) =>
            activity.onCharacterEntered?.(ctx, character),
        );

        if (!this.agent.isParticipant(character.MemberNumber)) {
            return Promise.resolve();
        }
        this.agent.onEvent(`${displayName(character)} entered the room.`);
        return Promise.resolve();
    }

    protected onCharacterLeft(
        connection: API_Connector,
        character: API_Character,
        intentional: boolean,
    ): void {
        if (character.MemberNumber === connection.Player.MemberNumber) return;

        this.forwardToActivities((ctx, activity) =>
            activity.onCharacterLeft?.(ctx, character),
        );

        // Was this character a participant? If so, tell the agent they left
        // and remove them from the participant set (which also releases
        // their leash if held).
        const wasParticipant = this.agent.isParticipant(character.MemberNumber);
        this.agent.setParticipant(character.MemberNumber, false);
        if (!wasParticipant) return;
        this.agent.onEvent(
            `${displayName(character)} left the room${intentional ? "" : " (kicked)"}.`,
        );
    }

    protected onCharacterEvent(
        connection: API_Connector,
        event: AnyCharacterEvent,
    ): void {
        const me = connection.Player;
        // Ignore events about the bot itself (we already know what we did).
        if (event.character.MemberNumber === me.MemberNumber) return;
        // Ignore events the bot itself caused (e.g. an item it applied on
        // another character): the server syncs the target's appearance back
        // with source = bot, and reacting to our own action would trigger an
        // extra turn.
        if (event.source?.MemberNumber === me.MemberNumber) return;
        // Only react to events about participating characters.
        if (!this.agent.isParticipant(event.character.MemberNumber)) return;

        const who = displayName(event.character);
        const by = event.source ? ` by ${displayName(event.source)}` : "";

        switch (event.name) {
            case "ItemAdd":
                if (event.item) {
                    const text = `${who} had ${event.item.Group}:${event.item.Name} applied${by}.`;
                    this.agent.onEvent(text);
                }
                break;
            case "ItemRemove":
                if (event.item) {
                    const text = `${who} had ${event.item.Group}:${event.item.Name} removed${by}.`;
                    this.agent.onEvent(text);
                }
                break;
            // case "PoseChanged":
            //     this.agent.onEvent(
            //         `${who}'s pose changed to: ${event.character.Pose.map((P) => P.Name)}${by}.`,
            //     );
            //     break;
            default:
                break;
        }
    }

    /**
     * Stop the agent and undo the self-setup changes (called on shutdown).
     */
    public async stop(): Promise<void> {
        this.debugServer?.close();
        this.debugServer = undefined;

        // Detach activity commands before stopping, then let each activity
        // flush its persisted state.
        for (const activity of this.activities) {
            this.commandHub.unregisterOwner(activity.id);
        }
        await this.agent.stopWithActivities();
        this.commandHub.dispose();
        this.activities = [];

        // Restore the original nickname.
        if (this.originalNickname !== undefined) {
            this.conn.accountUpdate({ Nickname: this.originalNickname });
            this.originalNickname = undefined;
        }

        // Remove the AI disclaimer from the bio, if we added it. We restore
        // from the snapshot taken in init() because accountUpdate() does not
        // update local state, so me.Description may still be stale.
        if (this.disclaimerAdded && this.originalBio !== undefined) {
            this.conn.setBotDescription(this.originalBio);
            this.disclaimerAdded = false;
            this.originalBio = undefined;
        }
    }
}

/**
 * A single entry in an Activity message's dictionary. The server sends a
 * heterogeneous array of small objects (character references, asset groups,
 * the activity name, and text substitutions).
 */
type ActivityDictionaryEntry = Record<string, unknown>;

/**
 * Extract a human-readable sentence from an Activity chat message.
 *
 * The preferred source is the activity dictionary (ActivityDictionary.csv):
 * the message Content (e.g. "ChatSelf-ItemArms-Wiggle") is looked up and its
 * template is rendered with the source/target character names and pronouns
 * substituted in. When the content is not in the dictionary, we fall back to
 * the "MISSING TEXT" dictionary entry (its `Text` holds a fully rendered
 * sentence), and finally to reconstructing a simple sentence from the
 * ActivityName and character names.
 */
function extractActivityText(
    message: BC_Server_ChatRoomMessage,
    conn: API_Connector,
    dictionary: ActivityDictionary,
): string | undefined {
    const dict = (message.Dictionary ??
        []) as unknown as ActivityDictionaryEntry[];

    const activityName = dict.find((e) => typeof e.ActivityName === "string")
        ?.ActivityName as string | undefined;
    const source = dict.find((e) => e.SourceCharacter !== undefined)
        ?.SourceCharacter as number | undefined;
    const target = dict.find((e) => e.TargetCharacter !== undefined)
        ?.TargetCharacter as number | undefined;
    const assetEntry = dict.find((e) => e.Tag === "ActivityAsset");
    const assetName =
        typeof assetEntry?.AssetName === "string"
            ? (assetEntry.AssetName as string)
            : undefined;

    const sourceChar =
        source !== undefined ? conn.chatRoom?.getCharacter(source) : undefined;
    const targetChar =
        target !== undefined ? conn.chatRoom?.getCharacter(target) : undefined;

    // Preferred: render the template from ActivityDictionary.csv. The CSV is
    // keyed by the message Content (e.g. "ChatSelf-ItemArms-Wiggle"), not by
    // the short ActivityName.
    if (typeof message.Content === "string" && message.Content) {
        const rendered = renderActivityText(message.Content, dictionary, {
            source: sourceChar,
            target: targetChar,
            assetName,
        });
        if (rendered) return rendered;
    }

    // Fallback 1: the rendered sentence from the "MISSING TEXT" entry.
    for (const entry of dict) {
        const tag = entry.Tag;
        if (
            typeof tag === "string" &&
            tag.includes("MISSING TEXT") &&
            typeof entry.Text === "string" &&
            entry.Text.trim()
        ) {
            return entry.Text.trim();
        }
    }

    // Fallback 2: reconstruct from ActivityName + character names.
    if (!activityName) return undefined;

    const nameOf = (memberNumber?: number): string | undefined => {
        if (memberNumber === undefined) return undefined;
        const c = conn.chatRoom?.getCharacter(memberNumber);
        return c ? displayName(c) : undefined;
    };

    const sourceName = nameOf(source);
    const targetName = nameOf(target);

    if (sourceName && targetName) {
        return `${sourceName} performs ${activityName} on ${targetName}.`;
    }
    if (sourceName) {
        return `${sourceName} performs ${activityName}.`;
    }
    return `${activityName}.`;
}

/**
 * Extract a readable sentence from an Action message (ActionUse /
 * ActionRemove) describing an item being applied or removed. Returns
 * undefined for action types we don't care about (vibe/shock/etc. are
 * recorded from the bot's own tool results when the bot is the source).
 */
function extractActionText(
    message: BC_Server_ChatRoomMessage,
    sender: API_Character,
    conn: API_Connector,
): string | undefined {
    if (message.Content !== "ActionUse" && message.Content !== "ActionRemove")
        return undefined;

    // Each dictionary entry is self-named via a `Tag` field, with the data
    // in sibling fields, e.g. { Tag: 'NextAsset', AssetName, GroupName } or
    // { Tag: 'DestinationCharacter', MemberNumber, Text }.
    const dict = (message.Dictionary ?? []) as unknown as Record<
        string,
        unknown
    >[];
    const byTag = (tag: string) => dict.find((e) => e.Tag === tag);

    const assetTag =
        message.Content === "ActionUse" ? "NextAsset" : "PrevAsset";
    const assetEntry = byTag(assetTag);
    const assetName = assetEntry?.AssetName;
    const groupName = assetEntry?.GroupName;
    if (typeof assetName !== "string" || typeof groupName !== "string")
        return undefined;

    const destEntry = byTag("DestinationCharacter");
    const targetChar =
        typeof destEntry?.MemberNumber === "number"
            ? conn.chatRoom?.getCharacter(destEntry.MemberNumber)
            : undefined;
    const targetName = targetChar ? displayName(targetChar) : destEntry?.Text;
    if (!targetName) return undefined;

    const verb = message.Content === "ActionUse" ? "applied" : "removed";
    return `${targetName} had ${groupName}:${assetName} ${verb} by ${displayName(
        sender,
    )}.`;
}
