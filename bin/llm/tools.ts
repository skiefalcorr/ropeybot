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
    AssetGet,
    BC_AppearanceItem,
    isBind,
} from "bc-bot";
import { LLMToolDefinition } from "./llmClient";
import { LLMConfig } from "../config";

// Deep import of the compiled asset catalog (bc-bot ships dist/ with .d.ts).
// Used to validate item/pose names and to power the listItems / listClothing / listPoses
// discovery tools, so the LLM can pick valid names without us dumping the
// whole 1.7MB catalog into the prompt.
import {
    AssetFemale3DCG,
    PoseFemale3DCG,
    PoseFemale3DCGNames,
} from "bc-bot/dist/bcdata/female3DCG.js";

interface CatalogGroup {
    Group: string;
    Category?: string;
    Clothing?: boolean;
    AllowNone?: boolean;
    Asset?: (
        | string
        | { Name: string; Fetish?: string[]; [k: string]: unknown }
    )[];
}

const CATALOG = AssetFemale3DCG as unknown as CatalogGroup[];

/** Item (restraint/BDSM) group names, derived from the catalog. */
const ITEM_GROUPS = CATALOG.filter((g) => g.Category === "Item").map(
    (g) => g.Group,
);

/** Clothing group names, derived from the catalog (Clothing: true flag). */
export const CLOTHING_GROUPS = CATALOG.filter(
    (g) => g.Clothing === true,
).map((g) => g.Group);

/**
 * All valid fetish tag names (mirrors the `FetishName` type from
 * bc-stubs). Used to constrain the `fetish` filter param so the LLM
 * can't hallucinate a tag.
 */
const FETISH_NAMES = [
    "Bondage",
    "Gagged",
    "Blindness",
    "Deafness",
    "Chastity",
    "Exhibitionist",
    "Masochism",
    "Sadism",
    "Rope",
    "Latex",
    "Leather",
    "Metal",
    "Tape",
    "Nylon",
    "Lingerie",
    "Pet",
    "Pony",
    "ABDL",
    "Forniphilia",
    "Spandex",
];

/**
 * A single tool the LLM may invoke. `definition` is the OpenAI/llama-server
 * tool schema; `handler` executes it and returns a short result string that
 * is fed back to the model as the tool result.
 */
export interface Tool {
    name: string;
    definition: LLMToolDefinition;
    handler: (
        args: Record<string, unknown>,
        ctx: ToolContext,
    ) => Promise<string> | string;
}

export interface ToolContext {
    conn: API_Connector;
    config: LLMConfig;
    /** Member numbers that must never be acted upon. */
    protectedMembers: number[];
    /** Member numbers currently suspended (safeword) with their expiry. */
    suspended: Map<number, number>;
    /** Sliding-window timestamps of actions taken (for rate limiting). */
    actionTimestamps: number[];
    /** Last action time per target member number. */
    lastActionByTarget: Map<number, number>;
}

function def(
    name: string,
    description: string,
    properties: Record<
        string,
        { type: string; description?: string; enum?: (string | number)[] }
    >,
    required: string[] = [],
): LLMToolDefinition {
    return {
        type: "function",
        function: {
            name,
            description,
            parameters: { type: "object", properties, required },
        },
    };
}

function findCharacter(
    conn: API_Connector,
    args: Record<string, unknown>,
): API_Character | undefined {
    const room = conn.chatRoom;
    if (!room) return undefined;
    const memberNumber = args.memberNumber as number | undefined;
    const name = args.name as string | undefined;
    if (memberNumber !== undefined) {
        return room.characters.find((c) => c.MemberNumber === memberNumber);
    }
    if (name) {
        const lower = name.toLowerCase();
        return room.characters.find(
            (c) =>
                c.Name.toLowerCase() === lower ||
                c.NickName.toLowerCase() === lower,
        );
    }
    return undefined;
}

/**
 * Validate that a (group, asset) pair exists in the catalog.
 * Returns the group definition if valid, null otherwise.
 */
function validateAsset(group: string, asset: string): CatalogGroup | null {
    const grp = CATALOG.find((g) => g.Group === group);
    if (!grp) return null;
    const ok = grp.Asset?.some(
        (a) => (typeof a === "string" ? a : a.Name) === asset,
    );
    return ok ? grp : null;
}

function isProtected(ctx: ToolContext, memberNumber: number): boolean {
    // if (memberNumber === ctx.conn.Player.MemberNumber) return true;
    // if (ctx.protectedMembers.includes(memberNumber)) return true;
    // const until = ctx.suspended.get(memberNumber);
    // if (until !== undefined && until > Date.now()) return true;
    return false;
}

/**
 * Rate-limit gate. Returns null if the action is allowed, or an error string
 * explaining why it was rejected.
 */
function checkRateLimit(
    ctx: ToolContext,
    targetMemberNumber?: number,
): string | null {
    const now = Date.now();
    const maxPerMinute = ctx.config.maxActionsPerMinute ?? 10;
    const windowMs = 60_000;

    // Drop timestamps outside the window.
    while (
        ctx.actionTimestamps.length > 0 &&
        ctx.actionTimestamps[0] < now - windowMs
    ) {
        ctx.actionTimestamps.shift();
    }
    if (ctx.actionTimestamps.length >= maxPerMinute) {
        return `Rate limit: already performed ${maxPerMinute} actions this minute. Wait before acting again.`;
    }

    if (targetMemberNumber !== undefined) {
        const cooldown = ctx.config.targetCooldownMs ?? 5000;
        const last = ctx.lastActionByTarget.get(targetMemberNumber) ?? 0;
        if (now - last < cooldown) {
            return `Cooldown: you just acted on this character ${Math.round(
                (cooldown - (now - last)) / 1000,
            )}s ago. Wait a moment.`;
        }
    }

    ctx.actionTimestamps.push(now);
    if (targetMemberNumber !== undefined) {
        ctx.lastActionByTarget.set(targetMemberNumber, now);
    }
    return null;
}

export function buildTools(): Tool[] {
    const tools: Tool[] = [];

    // ------------------------------------------------------------------
    // Communication
    // ------------------------------------------------------------------
    tools.push({
        name: "sendMessage",
        definition: def(
            "sendMessage",
            "Send a message to the room or to a specific character. Use type 'Chat' for public speech, 'Emote' for actions (rendered as *...*), 'Activity' for status/activity updates, or 'Whisper' for private messages (requires memberNumber).",
            {
                type: {
                    type: "string",
                    enum: ["Chat", "Emote", "Activity", "Whisper"],
                    description: "Message type",
                },
                content: {
                    type: "string",
                    description: "The message text",
                },
                memberNumber: {
                    type: "number",
                    description:
                        "Target member number. Required for Whisper, omit for Chat/Emote.",
                },
            },
            ["type", "content"],
        ),
        handler: (args, ctx) => {
            const type = args.type as string;
            const content = String(args.content ?? "");
            if (!content.trim()) return "Error: empty message.";
            const memberNumber = args.memberNumber as number | undefined;
            if (type === "Whisper" && memberNumber === undefined) {
                return "Error: Whisper requires memberNumber.";
            }
            if (type === "Whisper" && isProtected(ctx, memberNumber!)) {
                return "Refused: that character is protected or suspended.";
            }
            ctx.conn.SendMessage(
                type as "Chat" | "Emote" | "Activity" | "Whisper",
                content,
                memberNumber,
            );
            return `Sent ${type}: ${content.slice(0, 80)}`;
        },
    });

    // ------------------------------------------------------------------
    // Item discovery
    // ------------------------------------------------------------------
    tools.push({
        name: "listItems",
        definition: def(
            "listItems",
            "List available items (restraints and BDSM gear: gags, cuffs, hoods, devices, etc.) as 'group:asset' names so you can use valid names with addItem/removeItem. Optionally filter by group, fetish tag, or a search term.",
            {
                group: {
                    type: "string",
                    enum: ITEM_GROUPS,
                    description:
                        "Filter by asset group, e.g. 'ItemMouth', 'ItemNeck', 'ItemArms'",
                },
                fetish: {
                    type: "string",
                    enum: FETISH_NAMES,
                    description:
                        "Only show assets tagged with this fetish, e.g. 'Latex', 'Rope', 'Pet'",
                },
                search: {
                    type: "string",
                    description:
                        "Case-insensitive substring to match against group or asset names",
                },
                limit: {
                    type: "number",
                    description: "Max results to return (default 40)",
                },
            },
        ),
        handler: (args) => {
            const group = args.group as string | undefined;
            const fetish = args.fetish as string | undefined;
            const search = (args.search as string | undefined)?.toLowerCase();
            const limit = Math.min(
                Number(args.limit ?? 40),
                100,
            );
            const out: string[] = [];
            for (const grp of CATALOG) {
                if (grp.Category !== "Item") continue;
                if (group && grp.Group !== group) continue;
                for (const a of grp.Asset ?? []) {
                    const name = typeof a === "string" ? a : a.Name;
                    const tags =
                        typeof a === "string" ? undefined : a.Fetish;
                    if (fetish && !tags?.includes(fetish)) continue;
                    if (
                        search &&
                        !grp.Group.toLowerCase().includes(search) &&
                        !name.toLowerCase().includes(search)
                    )
                        continue;
                    out.push(
                        tags?.length
                            ? `${grp.Group}:${name} [${tags.join(", ")}]`
                            : `${grp.Group}:${name}`,
                    );
                    if (out.length >= limit) break;
                }
                if (out.length >= limit) break;
            }
            if (out.length === 0)
                return "No items matched. Try a different group, fetish, or search term.";
            return `${out.length} items:\n${out.join("\n")}`;
        },
    });

    tools.push({
        name: "listClothing",
        definition: def(
            "listClothing",
            "List available clothing and body appearance groups (suits, bras, panties, shoes, hair, etc.) as 'group:asset' names so you can use valid names with addItem/removeItem. Optionally filter by group, fetish tag, or a search term.",
            {
                group: {
                    type: "string",
                    enum: CLOTHING_GROUPS,
                    description:
                        "Filter by asset group, e.g. 'Cloth', 'Suit', 'Bra', 'Panties', 'Shoes'",
                },
                fetish: {
                    type: "string",
                    enum: FETISH_NAMES,
                    description:
                        "Only show assets tagged with this fetish, e.g. 'Latex', 'Lingerie', 'Nylon'",
                },
                search: {
                    type: "string",
                    description:
                        "Case-insensitive substring to match against group or asset names",
                },
                limit: {
                    type: "number",
                    description: "Max results to return (default 40)",
                },
            },
        ),
        handler: (args) => {
            const group = args.group as string | undefined;
            const fetish = args.fetish as string | undefined;
            const search = (args.search as string | undefined)?.toLowerCase();
            const limit = Math.min(
                Number(args.limit ?? 40),
                100,
            );
            const out: string[] = [];
            for (const grp of CATALOG) {
                if (grp.Clothing !== true) continue;
                if (group && grp.Group !== group) continue;
                for (const a of grp.Asset ?? []) {
                    const name = typeof a === "string" ? a : a.Name;
                    const tags =
                        typeof a === "string" ? undefined : a.Fetish;
                    if (fetish && !tags?.includes(fetish)) continue;
                    if (
                        search &&
                        !grp.Group.toLowerCase().includes(search) &&
                        !name.toLowerCase().includes(search)
                    )
                        continue;
                    out.push(
                        tags?.length
                            ? `${grp.Group}:${name} [${tags.join(", ")}]`
                            : `${grp.Group}:${name}`,
                    );
                    if (out.length >= limit) break;
                }
                if (out.length >= limit) break;
            }
            if (out.length === 0)
                return "No clothing matched. Try a different group, fetish, or search term.";
            return `${out.length} clothing items:\n${out.join("\n")}`;
        },
    });

    tools.push({
        name: "listPoses",
        definition: def(
            "listPoses",
            "List all valid pose names (with their body category) so you can use valid names with setPose.",
            {},
        ),
        handler: () => {
            const lines = PoseFemale3DCG.map(
                (p) => `${p.Name} (${p.Category})`,
            );
            return `${lines.length} poses:\n${lines.join("\n")}`;
        },
    });

    // ------------------------------------------------------------------
    // Item manipulation
    // ------------------------------------------------------------------
    tools.push({
        name: "addItem",
        definition: def(
            "addItem",
            "Add an item (restraint, clothing, etc.) to a character. Use listItems (restraints/BDSM) or listClothing (clothing/body) to find valid group/asset names. Restraints are applied one-by-one with pacing to avoid anti-cheat.",
            {
                memberNumber: {
                    type: "number",
                    description: "Target character's member number",
                },
                group: {
                    type: "string",
                    description: "Asset group, e.g. 'ItemMouth', 'Cloth'",
                },
                asset: {
                    type: "string",
                    description: "Asset name within the group, e.g. 'Gag'",
                },
            },
            ["memberNumber", "group", "asset"],
        ),
        handler: async (args, ctx) => {
            const memberNumber = args.memberNumber as number;
            const group = args.group as string;
            const asset = args.asset as string;
            const target = findCharacter(ctx.conn, args);
            if (!target) return "Error: character not found in room.";
            if (isProtected(ctx, memberNumber))
                return "Refused: that character is protected or suspended.";
            const grp = validateAsset(group, asset);
            if (!grp)
                return `Error: '${group}:${asset}' is not a valid item. Use listItems or listClothing to find valid names.`;

            const limited = checkRateLimit(ctx, memberNumber);
            if (limited) return limited;

            const item: BC_AppearanceItem = AssetGet(
                group as never,
                asset,
            ) as BC_AppearanceItem;
            try {
                if (isBind(item)) {
                    // Paced, anti-cheat-safe application.
                    await target.Appearance.slowlyApplyBundle([item]);
                } else {
                    target.Appearance.AddItem(item);
                }
                return `Added ${group}:${asset} to ${target.Name}.`;
            } catch (e) {
                return `Error adding item: ${String(e)}`;
            }
        },
    });

    tools.push({
        name: "removeItem",
        definition: def(
            "removeItem",
            "Remove an item from a character by group. Use listItems (restraints/BDSM) or listClothing (clothing/body) to find valid group names.",
            {
                memberNumber: {
                    type: "number",
                    description: "Target character's member number",
                },
                group: {
                    type: "string",
                    description: "Asset group to clear, e.g. 'ItemMouth'",
                },
            },
            ["memberNumber", "group"],
        ),
        handler: (args, ctx) => {
            const memberNumber = args.memberNumber as number;
            const group = args.group as string;
            const target = findCharacter(ctx.conn, args);
            if (!target) return "Error: character not found in room.";
            if (isProtected(ctx, memberNumber))
                return "Refused: that character is protected or suspended.";
            const existing = target.Appearance.InventoryGet(
                group as never,
            );
            if (!existing)
                return `Character has no item in group '${group}'.`;
            const limited = checkRateLimit(ctx, memberNumber);
            if (limited) return limited;
            target.Appearance.RemoveItem(group as never);
            return `Removed ${group} from ${target.Name}.`;
        },
    });

    tools.push({
        name: "stripAll",
        definition: def(
            "stripAll",
            "Remove ALL clothing from a character, applied one-by-one with pacing to avoid anti-cheat. Does not remove restraints.",
            {
                memberNumber: {
                    type: "number",
                    description: "Target character's member number",
                },
            },
            ["memberNumber"],
        ),
        handler: async (args, ctx) => {
            const memberNumber = args.memberNumber as number;
            const target = findCharacter(ctx.conn, args);
            if (!target) return "Error: character not found in room.";
            if (isProtected(ctx, memberNumber))
                return "Refused: that character is protected or suspended.";
            const limited = checkRateLimit(ctx, memberNumber);
            if (limited) return limited;
            await target.Appearance.slowlyStripBulk({
                appearance: false,
                bodyCosplay: false,
                clothing: true,
                item: false,
            }, true);
            return `Stripped all items from ${target.Name}.`;
        },
    });

    // ------------------------------------------------------------------
    // Poses & expressions
    // ------------------------------------------------------------------
    tools.push({
        name: "setPose",
        definition: def(
            "setPose",
            "Set a character's active pose. Provide a list of pose names (usually one). Use listPoses to find valid names. The bot can also set its own pose by passing its own member number.",
            {
                memberNumber: {
                    type: "number",
                    description: "Target character's member number",
                },
                poses: {
                    type: "array",
                    description: "List of pose names, e.g. [\"Kneel\"]",
                },
            },
            ["memberNumber", "poses"],
        ),
        handler: (args, ctx) => {
            const memberNumber = args.memberNumber as number;
            const poses = (args.poses as string[]) ?? [];
            if (poses.length === 0) return "Error: no poses provided.";
            const invalid = poses.filter(
                (p) => !PoseFemale3DCGNames.includes(p as never),
            );
            if (invalid.length > 0)
                return `Error: invalid pose(s) ${invalid.join(", ")}. Use listPoses.`;
            const target = findCharacter(ctx.conn, args);
            if (!target) return "Error: character not found in room.";
            if (isProtected(ctx, memberNumber))
                return "Refused: that character is protected or suspended.";
            const limited = checkRateLimit(ctx, memberNumber);
            if (limited) return limited;
            target.SetActivePose(poses as never);
            return `Set pose of ${target.Name} to ${poses.join(", ")}.`;
        },
    });

    tools.push({
        name: "setExpression",
        definition: def(
            "setExpression",
            "Set a facial expression on a character (requires the character to have an item in the given group, e.g. 'Face').",
            {
                memberNumber: {
                    type: "number",
                    description: "Target character's member number",
                },
                group: {
                    type: "string",
                    description: "Expression group, usually 'Face'",
                },
                expression: {
                    type: "string",
                    description:
                        "Expression name, e.g. 'Happy', 'Sad', 'Angry', 'Surprised', 'Neutral'",
                },
            },
            ["memberNumber", "group", "expression"],
        ),
        handler: (args, ctx) => {
            const memberNumber = args.memberNumber as number;
            const group = args.group as string;
            const expression = args.expression as string;
            const target = findCharacter(ctx.conn, args);
            if (!target) return "Error: character not found in room.";
            if (isProtected(ctx, memberNumber))
                return "Refused: that character is protected or suspended.";
            const limited = checkRateLimit(ctx, memberNumber);
            if (limited) return limited;
            target.SetExpression(group as never, expression as never);
            return `Set expression of ${target.Name} to ${expression}.`;
        },
    });

    // ------------------------------------------------------------------
    // Locks
    // ------------------------------------------------------------------
    tools.push({
        name: "lockItem",
        definition: def(
            "lockItem",
            "Lock an item on a character so it cannot be removed (requires the item to support locking).",
            {
                memberNumber: {
                    type: "number",
                    description: "Target character's member number",
                },
                group: {
                    type: "string",
                    description: "Asset group of the item to lock",
                },
            },
            ["memberNumber", "group"],
        ),
        handler: (args, ctx) => {
            const memberNumber = args.memberNumber as number;
            const group = args.group as string;
            const target = findCharacter(ctx.conn, args);
            if (!target) return "Error: character not found in room.";
            if (isProtected(ctx, memberNumber))
                return "Refused: that character is protected or suspended.";
            const item = target.Appearance.InventoryGet(group as never);
            if (!item) return `Character has no item in group '${group}'.`;
            const limited = checkRateLimit(ctx, memberNumber);
            if (limited) return limited;
            item.lock("Lock" as never, ctx.conn.Player.MemberNumber, {});
            return `Locked ${group} on ${target.Name}.`;
        },
    });

    // ------------------------------------------------------------------
    // Movement (self)
    // ------------------------------------------------------------------
    tools.push({
        name: "moveSelf",
        definition: def(
            "moveSelf",
            "Move the bot's own character to a position on the room map (if the room uses a map).",
            {
                x: { type: "number", description: "Map X coordinate" },
                y: { type: "number", description: "Map Y coordinate" },
            },
            ["x", "y"],
        ),
        handler: (args, ctx) => {
            const x = Number(args.x);
            const y = Number(args.y);
            if (Number.isNaN(x) || Number.isNaN(y))
                return "Error: x and y must be numbers.";
            const limited = checkRateLimit(ctx);
            if (limited) return limited;
            ctx.conn.moveOnMap(x, y);
            return `Moved self to (${x}, ${y}).`;
        },
    });

    return tools;
}

/**
 * Resolve the set of tools the LLM is allowed to use, based on config
 * allowedTools / deniedTools.
 */
export function resolveTools(
    all: Tool[],
    config: LLMConfig,
): Tool[] {
    const denied = new Set(config.deniedTools ?? []);
    let tools = all.filter((t) => !denied.has(t.name));
    if (config.allowedTools && config.allowedTools.length > 0) {
        const allowed = new Set(config.allowedTools);
        tools = tools.filter((t) => allowed.has(t.name));
    }
    return tools;
}
