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
    LogicBase,
} from "bc-bot";
import { LLMConfig, ConfigFile } from "../config";
import { LLMAgent } from "../llm/agent";

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
        "Say a safeword to make it stop and remove any items it placed on you.",
        "Code at https://github.com/FriendsOfBC/ropeybot",
    ].join("\n");

    private agent: LLMAgent;

    constructor(
        private conn: API_Connector,
        private config: ConfigFile,
        private llmConfig: LLMConfig,
        superusers: number[],
    ) {
        super();
        this.agent = new LLMAgent(conn, llmConfig, superusers);
    }

    /**
     * Self-setup: nickname, description, and optional starting pose.
     */
    public async init(): Promise<void> {
        const me = this.conn.Player;

        //this.conn.accountUpdate({ Nickname: "Ropey LLM" });
        //this.conn.setBotDescription(LLMGame.description);

        // Optional starting pose for the bot itself.
        const startPose = this.llmConfig.startPose;
        if (startPose && startPose.length > 0) {
            try {
                me.SetActivePose(startPose as never);
            } catch (e) {
                console.warn("Could not set starting pose:", e);
            }
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

        // Ignore non-text message types.
        if (message.Type !== "Chat" && message.Type !== "Emote") return;

        // Safeword check first: if the sender used a safeword, handle it and
        // do NOT feed the raw message to the agent as a normal prompt.
        if (this.agent.handleSafeword(sender, message.Content)) {
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
        this.agent.onEvent(`${character.Name} entered the room.`);
        return Promise.resolve();
    }

    protected onCharacterLeft(
        connection: API_Connector,
        character: API_Character,
        intentional: boolean,
    ): void {
        if (character.MemberNumber === connection.Player.MemberNumber) return;
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
     * Stop the agent (called on shutdown).
     */
    public stop(): void {
        this.agent.stop();
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
    const dict = (message.Dictionary ?? []) as unknown as ActivityDictionaryEntry[];

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
    const activityName = dict.find(
        (e) => typeof e.ActivityName === "string",
    )?.ActivityName as string | undefined;
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
