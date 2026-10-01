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
    AnyCharacterEvent,
    BC_Server_ChatRoomMessage,
    CommandParser,
    LogicBase,
} from "bc-bot";
import { LLMConfig, ConfigFile } from "../config";
import { LLMAgent } from "../llm/agent";
import { DebugServer } from "../llm/debugServer";
import { decodeDescription, withBotDisclaimer } from "../llm/context";
import { parseToolArgs } from "../llm/tools/toolCommand";

/**
 * The LLM-powered roleplay game. It wires room events into an {@link LLMAgent}
 * which decides how the bot should react (chat, apply/remove items, change
 * poses, etc.) using a locally-served LLM with native tool calling.
 *
 * The bot self-configures on start: it sets its nickname and description from
 * the config, and optionally a starting pose.
 */
export class LLMGame extends LogicBase {
    public static description = [
        "An LLM-powered roleplay bot.",
        "It chats and interacts with characters in the room, using a local LLM to decide its actions.",
        "Use !start to join, !stop to leave, !status to list participants.",
        "Say a safeword to make it stop and remove any items it placed on you.",
        "Superusers can test tools without the LLM: !tools, !tool <name> [args], !toolstatus.",
        "Code at https://github.com/FriendsOfBC/ropeybot",
    ].join("\n");

    private agent: LLMAgent;
    private commandParser: CommandParser;
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

    constructor(
        private conn: API_Connector,
        private config: ConfigFile,
        private llmConfig: LLMConfig,
        private superusers: number[],
    ) {
        super();
        this.agent = new LLMAgent(conn, llmConfig, superusers, config.room);
        this.commandParser = new CommandParser(conn);
        this.commandParser.register("start", this.onCommandStart);
        this.commandParser.register("stop", this.onCommandStop);
        this.commandParser.register("status", this.onCommandStatus);
        this.commandParser.register("tools", this.onCommandTools);
        this.commandParser.register("tool", this.onCommandTool);
        this.commandParser.register("toolstatus", this.onCommandToolStatus);
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
    ): void => {
        if (!this.isSuperuser(sender)) {
            this.conn.reply(msg, "Not authorized.");
            return;
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
        this.conn.reply(
            msg,
            `Available tools (${tools.length}):\n${lines.join("\n")}\n\nUsage: !tool <name> [key=value ...] or !tool <name> {"key":value}`,
        );
    };

    private onCommandTool = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): Promise<void> => {
        if (!this.isSuperuser(sender)) {
            this.conn.reply(msg, "Not authorized.");
            return;
        }
        const raw = this.extractRawToolArgs(msg);
        const spaceIdx = raw.indexOf(" ");
        const name = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).trim();
        const argsRaw = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1);
        if (!name) {
            this.conn.reply(msg, "Usage: !tool <name> [key=value ...]");
            return;
        }
        const [args, error] = parseToolArgs(argsRaw);
        if (error) {
            this.conn.reply(msg, error);
            return;
        }
        const result = await this.agent.runTool(name, args);
        this.conn.reply(msg, result);
    };

    private onCommandToolStatus = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): void => {
        if (!this.isSuperuser(sender)) {
            this.conn.reply(msg, "Not authorized.");
            return;
        }
        this.conn.reply(msg, this.agent.getToolStatus());
    };

    private onCommandStart = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): void => {
        this.agent.setParticipant(sender.MemberNumber, true);
        this.conn.reply(
            msg,
            `Welcome, ${sender.Name}! You are now a participant.`,
        );
    };

    private onCommandStop = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): void => {
        this.agent.setParticipant(sender.MemberNumber, false);
        this.conn.reply(
            msg,
            `You are no longer a participant. I will ignore you from now on.`,
        );
    };

    private onCommandStatus = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
    ): void => {
        const room = this.conn.chatRoom;
        const names = this.agent
            .getParticipants()
            .map(
                (n) =>
                    room?.characters.find((c) => c.MemberNumber === n)?.Name ??
                    String(n),
            );
        this.conn.reply(
            msg,
            names.length > 0
                ? `Participants: ${names.join(", ")}`
                : "No participants yet. Use !start to join.",
        );
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

        // Append the AI disclaimer to the bio (idempotent). The original bio
        // is preserved; describeCharacter strips the disclaimer before it
        // reaches the LLM.
        const bio = decodeDescription(me.Description ?? "");
        this.originalBio = bio;
        const newBio = withBotDisclaimer(bio, this.llmConfig.model);
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

        console.log("LLM bot ready. Persona loaded, agent running.");
    }

    protected onMessage(
        connection: API_Connector,
        message: BC_Server_ChatRoomMessage,
        sender: API_Character,
    ): void {
        const me = connection.Player;

        // Ignore our own messages (the server echoes them back).
        if (sender.MemberNumber === me.MemberNumber) return;

        // Ignore non-text message types.
        if (
            message.Type !== "Chat" &&
            message.Type !== "Emote" &&
            message.Type !== "Whisper" &&
            message.Type !== "Activity"
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
            const text = extractActivityText(message, connection);
            if (text) {
                this.agent.onIncomingMessage(sender, {
                    ...message,
                    Content: text,
                });
            }
            return;
        }

        this.agent.onIncomingMessage(sender, message);
    }

    protected onCharacterEntered(
        connection: API_Connector,
        character: API_Character,
    ): Promise<void> {
        if (character.MemberNumber === connection.Player.MemberNumber) {
            return Promise.resolve();
        }
        if (!this.agent.isParticipant(character.MemberNumber)) {
            return Promise.resolve();
        }
        this.agent.onEvent(`${character.Name} entered the room.`);
        return Promise.resolve();
    }

    protected onCharacterLeft(
        connection: API_Connector,
        character: API_Character,
        intentional: boolean,
    ): void {
        if (character.MemberNumber === connection.Player.MemberNumber) return;
        // Was this character a participant? If so, tell the agent they left
        // and remove them from the participant set (which also releases
        // their leash if held).
        const wasParticipant = this.agent.isParticipant(character.MemberNumber);
        this.agent.setParticipant(character.MemberNumber, false);
        if (!wasParticipant) return;
        this.agent.onEvent(
            `${character.Name} left the room${intentional ? "" : " (kicked)"}.`,
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

        const who = event.character.Name;
        const by = event.source ? ` by ${event.source.Name}` : "";

        switch (event.name) {
            case "ItemAdd":
                if (event.item) {
                    this.agent.onEvent(
                        `${who} had ${event.item.Group}:${event.item.Name} applied${by}.`,
                    );
                }
                break;
            case "ItemRemove":
                if (event.item) {
                    this.agent.onEvent(
                        `${who} had ${event.item.Group}:${event.item.Name} removed${by}.`,
                    );
                }
                break;
            case "PoseChanged":
                this.agent.onEvent(
                    `${who}'s pose changed to: ${event.character.Pose.map((P) => P.Name)}${by}.`,
                );
                break;
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
        this.agent.stop();

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
 * The most reliable source is the dictionary entry whose `Tag` contains
 * "MISSING TEXT" — its `Text` field holds the fully rendered sentence
 * (e.g. "Mosven nuzzles underneath Captain Amelia's hand."). When that is
 * absent, we fall back to reconstructing a simple sentence from the
 * ActivityName and the source/target character names.
 */
function extractActivityText(
    message: BC_Server_ChatRoomMessage,
    conn: API_Connector,
): string | undefined {
    const dict = (message.Dictionary ??
        []) as unknown as ActivityDictionaryEntry[];

    // Preferred: the rendered sentence from the "MISSING TEXT" entry.
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

    // Fallback: reconstruct from ActivityName + character names.
    const activityName = dict.find((e) => typeof e.ActivityName === "string")
        ?.ActivityName as string | undefined;
    if (!activityName) return undefined;

    const source = dict.find((e) => e.SourceCharacter !== undefined)
        ?.SourceCharacter as number | undefined;
    const target = dict.find((e) => e.TargetCharacter !== undefined)
        ?.TargetCharacter as number | undefined;

    const nameOf = (memberNumber?: number): string | undefined => {
        if (memberNumber === undefined) return undefined;
        return conn.chatRoom?.getCharacter(memberNumber)?.Name;
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
