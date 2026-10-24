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

// Deep import of the compiled extended-item config table, mirroring how
// ../catalog.ts reaches the asset catalog. The configs are plain data, so we
// model only the fields the tools care about instead of pulling in the game's
// full (ambient) extended-item typings.
import type { API_AppearanceItem } from "bc-bot";
import { AssetFemale3DCGExtended } from "bc-bot/dist/bcdata/Female3DCGExtended.js";

/** A single option of a `typed` extended item. */
export interface ExtOption {
    /** Option identifier used by `ExtendedItem.SetType` and shown to the model. */
    Name: string;
    BondageLevel?: number;
    SelfBondageLevel?: number;
    AllowLock?: boolean;
    ChangeWhenLocked?: boolean;
    HasSubscreen?: boolean;
    /** Property object the game applies when this option is selected. */
    Property?: Record<string, unknown>;
}

/** A module of a `modular` extended item (each module is one choice screen). */
export interface ExtModule {
    /** Human-readable module label, e.g. "Leash". */
    Name: string;
    /** TypeRecord key, e.g. "l". Options are named Key + index ("l0", "l1"). */
    Key: string;
    Options: ExtOption[];
}

/** A resolved extended-item configuration for one group/asset pair. */
export interface ExtEntry {
    group: string;
    asset: string;
    /** "typed" | "modular" | "vibrating" | "text" | "noarch" | "variableheight" */
    archetype: string;
    options: ExtOption[];
    modules: ExtModule[];
    /** Whether the item's type may change while it is locked. */
    changeWhenLocked: boolean;
    /**
     * True when there is more than one thing to choose between, i.e. the item
     * is worth offering to the model at all. Single-option extended items exist
     * mostly to declare baseline properties, and have nothing to switch.
     */
    configurable: boolean;
}

interface RawOption {
    Name?: string;
    BondageLevel?: number;
    SelfBondageLevel?: number;
    AllowLock?: boolean;
    ChangeWhenLocked?: boolean;
    HasSubscreen?: boolean;
    Property?: Record<string, unknown>;
}

interface RawConfig {
    Archetype?: string;
    Options?: RawOption[];
    Modules?: {
        Name?: string;
        Key?: string;
        Options?: RawOption[];
        ChangeWhenLocked?: boolean;
    }[];
    ChangeWhenLocked?: boolean;
    CopyConfig?: { GroupName?: string; AssetName: string };
}

const RAW = AssetFemale3DCGExtended as unknown as Record<
    string,
    Record<string, RawConfig>
>;

/**
 * Follow a `CopyConfig` chain to the concrete config, guarding against cycles.
 * Kept local (rather than reusing bc-bot's `resolveExtendedAsset`) because the
 * index is built from the raw table and must not trip that helper's
 * "Invalid item group" warnings for every asset it walks.
 */
function resolveConfig(
    group: string,
    asset: string,
): { cfg: RawConfig; group: string; asset: string } | null {
    let currentGroup = group;
    let currentAsset = asset;
    let cfg = RAW[currentGroup]?.[currentAsset] ?? null;
    const seen = new Set<string>([`${group}:${asset}`]);

    while (cfg?.CopyConfig) {
        const nextGroup = cfg.CopyConfig.GroupName ?? currentGroup;
        const nextAsset = cfg.CopyConfig.AssetName;
        const key = `${nextGroup}:${nextAsset}`;
        if (seen.has(key)) return null;
        seen.add(key);
        currentGroup = nextGroup;
        currentAsset = nextAsset;
        cfg = RAW[currentGroup]?.[currentAsset] ?? null;
    }
    return cfg ? { cfg, group: currentGroup, asset: currentAsset } : null;
}

function toOption(raw: RawOption, index: number): ExtOption {
    return {
        // Modular options carry no Name in the source; the game synthesizes
        // `Key + index`, so we do the same to keep names consistent.
        Name: raw.Name ?? String(index),
        BondageLevel: raw.BondageLevel,
        SelfBondageLevel: raw.SelfBondageLevel,
        AllowLock: raw.AllowLock,
        ChangeWhenLocked: raw.ChangeWhenLocked,
        HasSubscreen: raw.HasSubscreen,
        Property: raw.Property,
    };
}

function buildEntry(
    cfgGroup: string,
    cfgAsset: string,
    cfg: RawConfig,
): ExtEntry | null {
    const archetype = cfg.Archetype ?? "";
    if (!archetype) return null;

    const options = (cfg.Options ?? []).map(toOption);
    const modules: ExtModule[] = (cfg.Modules ?? [])
        .filter((m) => !!m.Key)
        .map((m) => ({
            Name: m.Name ?? String(m.Key),
            Key: String(m.Key),
            Options: (m.Options ?? []).map(toOption),
        }));

    const choices =
        archetype === "typed"
            ? options.length > 1
            : archetype === "modular"
              ? modules.length > 0
              : false;

    return {
        group: cfgGroup,
        asset: cfgAsset,
        archetype,
        options,
        modules,
        changeWhenLocked: cfg.ChangeWhenLocked !== false,
        configurable: choices,
    };
}

/**
 * Every extended-item configuration, keyed by `group:asset`, with `CopyConfig`
 * already flattened.
 *
 * Built once at import: the room-state summary reads this for every worn slot
 * of every character on every turn, so lookups must be O(1) and must not walk
 * config chains at render time.
 */
export const EXTENDED_INDEX: ReadonlyMap<string, ExtEntry> = (() => {
    const map = new Map<string, ExtEntry>();
    for (const [group, assets] of Object.entries(RAW)) {
        for (const asset of Object.keys(assets)) {
            const resolved = resolveConfig(group, asset);
            if (!resolved) continue;
            const entry = buildEntry(
                resolved.group,
                resolved.asset,
                resolved.cfg,
            );
            if (!entry) continue;
            map.set(`${group}:${asset}`, entry);
        }
    }
    return map;
})();

/** Look up the resolved extended config for a worn asset, if any. */
export function getExtendedEntry(
    group: string,
    asset: string,
): ExtEntry | undefined {
    return EXTENDED_INDEX.get(`${group}:${asset}`);
}

/**
 * Read the option index currently selected for a `typed` item.
 *
 * `Property.TypeRecord.typed` is what the game writes and reads; the legacy
 * `Property.Type` string is only present on items saved by older clients, and
 * an absent record means option index 0.
 */
export function currentTypedIndex(
    entry: ExtEntry,
    prop: Record<string, unknown> | undefined,
): number {
    const record = prop?.TypeRecord as Record<string, unknown> | undefined;
    const fromRecord = record?.["typed"];
    if (typeof fromRecord === "number") return fromRecord;
    if (typeof fromRecord === "string") {
        const n = Number.parseInt(fromRecord, 10);
        if (!Number.isNaN(n)) return n;
    }
    if (typeof prop?.Type === "string") {
        const idx = entry.options.findIndex((o) => o.Name === prop.Type);
        if (idx !== -1) return idx;
    }
    return 0;
}

/**
 * Read the option index currently selected for one module of a `modular` item.
 * An absent record means the module's default (index 0).
 */
export function currentModuleIndex(
    entry: ExtEntry,
    moduleKey: string,
    prop: Record<string, unknown> | undefined,
): number {
    const record = prop?.TypeRecord as Record<string, unknown> | undefined;
    const value = record?.[moduleKey];
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) return n;
    }
    return 0;
}

/**
 * Short label describing the item's extended state, for the room-state
 * snapshot: `HempRopeHarness[Star]` for typed items, and the non-default
 * module selections (`l2,s3`) for modular ones.
 *
 * Returns undefined when there is nothing worth reporting: the asset is not an
 * extended item, has only one option, or (for modular items) every module is
 * still on its default. Keeping those unannotated stops the snapshot from
 * filling up with noise the model cannot act on.
 */
export function extendedStateLabel(
    group: string,
    asset: string,
    prop: Record<string, unknown> | undefined,
): string | undefined {
    const entry = getExtendedEntry(group, asset);
    if (!entry || !entry.configurable) return undefined;

    if (entry.archetype === "typed") {
        const idx = currentTypedIndex(entry, prop);
        return entry.options[idx]?.Name;
    }

    if (entry.archetype === "modular") {
        const parts: string[] = [];
        for (const mod of entry.modules) {
            const idx = currentModuleIndex(entry, mod.Key, prop);
            if (idx !== 0) parts.push(`${mod.Key}${idx}`);
        }
        return parts.length > 0 ? parts.join(",") : undefined;
    }

    return undefined;
}

/**
 * Bracketed annotation for the room-state snapshot, e.g. ` [Star]` or
 * ` [l2,s3]`. Returns an empty string when there is nothing to report, so
 * callers can append it unconditionally.
 */
export function extendedAnnotation(item: API_AppearanceItem): string {
    const label = extendedStateLabel(
        item.Group,
        item.Name,
        item.getData().Property as Record<string, unknown> | undefined,
    );
    return label ? ` [${label}]` : "";
}

/**
 * Whether the item's type may be changed right now.
 *
 * Both the config-level and the option-level `ChangeWhenLocked` flags exist in
 * the data; the option-level one wins when present, matching the client.
 */
export function canChangeWhileLocked(
    entry: ExtEntry,
    currentOption: ExtOption | undefined,
    prop: Record<string, unknown> | undefined,
): boolean {
    if (!prop?.LockedBy) return true;
    const optionLevel = currentOption?.ChangeWhenLocked;
    if (optionLevel !== undefined) return optionLevel;
    return entry.changeWhenLocked;
}

/** Human-readable list of valid typed option names, for error messages. */
export function optionNameList(entry: ExtEntry): string {
    return entry.options.map((o) => o.Name).join(", ");
}

/** Outcome of trying to select a typed option on a worn item. */
export interface ApplyOptionResult {
    ok: boolean;
    /** Populated when the change was refused; always names the valid options. */
    error?: string;
    /** Option name before the change, when it could be determined. */
    before?: string;
    /** Option name after the change. */
    after?: string;
}

/**
 * Select a `typed` option on a worn item, validating everything the game would
 * complain about before touching the item.
 *
 * Shared by the setExtendedType tool and by addItem's `extendedType` argument so
 * both paths enforce the same rules. `ExtendedItem.SetType` writes
 * `Property.TypeRecord` and the option's properties, then queues the appearance
 * update that the server relays to the room.
 */
export function applyTypedOption(
    item: API_AppearanceItem,
    optionName: string,
): ApplyOptionResult {
    const entry = getExtendedEntry(item.Group, item.Name);
    if (!entry)
        return {
            ok: false,
            error: `${item.Group}:${item.Name} is a plain item with no configurable options.`,
        };

    if (entry.archetype !== "typed") {
        if (entry.archetype === "modular")
            return {
                ok: false,
                error: `${item.Group}:${item.Name} is a modular extended item; the bot cannot reconfigure those yet.`,
            };
        return {
            ok: false,
            error: `${item.Group}:${item.Name} uses the '${entry.archetype}' extended archetype, which the bot cannot configure.`,
        };
    }

    if (entry.options.length === 0)
        return {
            ok: false,
            error: `${item.Group}:${item.Name} is a typed extended item but declares no options.`,
        };

    const currentIdx = currentTypedIndex(
        entry,
        item.getData().Property as Record<string, unknown> | undefined,
    );
    const currentOption = entry.options[currentIdx];

    if (!canChangeWhileLocked(entry, currentOption, item.getData().Property))
        return {
            ok: false,
            error: `${item.Group}:${item.Name} is locked and its option cannot be changed while locked. Unlock it first.`,
        };

    const option = entry.options.find((o) => o.Name === optionName);
    if (!option)
        return {
            ok: false,
            error: `'${optionName}' is not a valid option for ${item.Group}:${item.Name}. Valid options: ${optionNameList(entry)}.`,
        };

    if (!item.Extended)
        return {
            ok: false,
            error: `${item.Group}:${item.Name} has no extended item state available.`,
        };

    const before = currentOption?.Name;
    try {
        item.Extended.SetType(option.Name);
    } catch (e) {
        return {
            ok: false,
            error: `Could not set ${item.Group}:${item.Name} to '${optionName}': ${String(e)}. Valid options: ${optionNameList(entry)}.`,
        };
    }
    return { ok: true, before, after: option.Name };
}

/**
 * Compact one-line summary of what an option does, so the model can choose
 * without reading raw property objects.
 */
export function describeOption(option: ExtOption): string {
    const bits: string[] = [];
    const prop = option.Property ?? {};

    const difficulty = prop["Difficulty"];
    if (typeof difficulty === "number" && difficulty !== 0)
        bits.push(`diff ${difficulty}`);
    if (option.BondageLevel) bits.push(`needs bondage ${option.BondageLevel}`);

    const effect = prop["Effect"];
    if (Array.isArray(effect) && effect.length > 0)
        bits.push(`effects: ${effect.join("/")}`);

    const setPose = prop["SetPose"];
    if (Array.isArray(setPose) && setPose.length > 0)
        bits.push(`forces pose: ${setPose.join("/")}`);

    const block = prop["Block"];
    if (Array.isArray(block) && block.length > 0)
        bits.push(`blocks ${block.join("/")}`);

    const hide = prop["Hide"];
    if (Array.isArray(hide) && hide.length > 0)
        bits.push(`hides ${hide.join("/")}`);

    if (option.AllowLock === true) bits.push("can be locked");
    if (option.HasSubscreen) bits.push("(opens a sub-screen)");

    return bits.length > 0 ? ` (${bits.join(", ")})` : "";
}
