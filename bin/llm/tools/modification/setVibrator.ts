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

import { API_AppearanceItem } from "bc-bot";
import {
    Tool,
    def,
    findCharacter,
    isProtected,
    requireParticipant,
    checkRateLimit,
} from "../shared";

/**
 * Groups where vibrator items are typically found.
 */
const VIBRATOR_GROUPS = new Set([
    "ItemVulva",
    "ItemPelvis",
    "ItemButt",
    "ItemLegs",
]);

/**
 * Map a numeric vibrator intensity to a human-readable label.
 * -1 = off, 0 = low, 1 = medium, 2 = high, 3 = maximum.
 */
const INTENSITY_LABELS: Record<number, string> = {
    [-1]: "Off",
    0: "Low",
    1: "Medium",
    2: "High",
    3: "Maximum",
};

/**
 * Detect whether an item is a controllable vibrator.
 * Vibrators can have many custom names, so we detect by:
 * 1. Location (intimate groups)
 * 2. Properties (Extended, TypeRecord, Mode, Intensity)
 */
export function isVibrator(item: API_AppearanceItem): boolean {
    const name = item.Name;
    const prop = item.getData().Property;

    const hasVibratorName =
        name.includes("Vibrator") || name.includes("Vibrat");
    const hasExtended = item.Extended !== undefined;
    const hasTypeRecord = prop?.TypeRecord !== undefined;
    const hasMode = prop?.Mode !== undefined;
    const hasIntensity = prop?.Intensity !== undefined;

    return hasVibratorName || hasExtended || hasTypeRecord || hasMode || hasIntensity;
}

/**
 * Read the current vibrator state of an item.
 * Returns a short label like "High" / "Off" / "Escalate", or null when the
 * item has no readable vibrator state.
 */
export function vibratorState(item: API_AppearanceItem): string | null {
    const prop = item.getData().Property;
    if (!prop) return null;

    // Try Mode first (most descriptive)
    if (typeof prop.Mode === "string" && prop.Mode.length > 0) {
        return prop.Mode;
    }

    // Try Intensity
    if (typeof prop.Intensity === "number") {
        return INTENSITY_LABELS[prop.Intensity] ?? `Intensity ${prop.Intensity}`;
    }

    // Try Extended.Type (typed vibrators store intensity as a string)
    if (item.Extended) {
        const extType = item.Extended.Type;
        if (extType !== undefined && extType !== null) {
            const n = typeof extType === "string" ? parseInt(extType) : extType;
            if (!isNaN(n)) return INTENSITY_LABELS[n] ?? `Level ${n}`;
        }
    }

    return null;
}

/**
 * Read the current numeric intensity from an item, trying multiple property
 * paths (mirrors the working CatDogSystem logic).
 */
function readCurrentIntensity(item: API_AppearanceItem): number {
    const prop = item.getData().Property;

    // Try Extended.Type first (for typed vibrators)
    if (item.Extended) {
        const rawType = item.Extended.Type;
        if (rawType !== undefined && rawType !== null) {
            const n = typeof rawType === "string" ? parseInt(rawType) : rawType;
            if (!isNaN(n)) return n;
        }
    }

    // Try TypeRecord (v key for vibrating items)
    if (prop?.TypeRecord) {
        const v = (prop.TypeRecord as Record<string, number>).v;
        if (v !== undefined) return v;
    }

    // Try Mode (some vibrators store numeric mode)
    if (prop?.Mode !== undefined) {
        const n = typeof prop.Mode === "string" ? parseInt(prop.Mode) : (prop.Mode as unknown as number);
        if (!isNaN(n)) return n;
    }

    // Try Intensity
    if (prop?.Intensity !== undefined) {
        const n = typeof prop.Intensity === "string" ? parseInt(prop.Intensity) : prop.Intensity;
        if (!isNaN(n)) return n;
    }

    return 0;
}

/**
 * Apply a new intensity to a vibrator item, trying multiple methods
 * (mirrors the working CatDogSystem escalateVibrator logic).
 * Returns true if any method succeeded.
 */
function applyIntensity(item: API_AppearanceItem, newIntensity: number): boolean {
    const prop = item.getData().Property;

    // Method 1: Extended.SetType for typed vibrators
    if (item.Extended && typeof item.Extended.SetType === "function") {
        try {
            item.Extended.SetType(String(newIntensity));
            return true;
        } catch {
            // fall through
        }
    }

    // Method 2: setProperty for TypeRecord-based vibrators
    if (prop?.TypeRecord !== undefined) {
        try {
            const typeRecord = { ...(prop.TypeRecord as Record<string, number>), v: newIntensity };
            item.setProperty("TypeRecord", typeRecord as never);
            return true;
        } catch {
            // fall through
        }
    }

    // Method 3: Direct Intensity assignment
    item.setProperty("Intensity", newIntensity as never);
    return true;
}

export const setVibratorTool: Tool = {
    name: "setVibrator",
    definition: def(
        "setVibrator",
        "Control a vibrator item already worn by a character: set its intensity level and/or mode. The character must already have the item in the given group. Intensity: -1 off, 0 low, 1 medium, 2 high, 3 maximum. Mode: Off, Low, Medium, High, Maximum, Random, Escalate, Tease, Deny, Edge.",
        {
            memberNumber: {
                type: "number",
                description: "Target character's member number",
            },
            group: {
                type: "string",
                description:
                    "Asset group of the vibrator, e.g. 'ItemVulva', 'ItemPelvis', 'ItemButt'",
            },
            intensity: {
                type: "number",
                enum: [-1, 0, 1, 2, 3],
                description:
                    "Vibration intensity: -1 off, 0 low, 1 medium, 2 high, 3 maximum",
            },
            mode: {
                type: "string",
                enum: [
                    "Off",
                    "Low",
                    "Medium",
                    "High",
                    "Maximum",
                    "Random",
                    "Escalate",
                    "Tease",
                    "Deny",
                    "Edge",
                ],
                description:
                    "Vibrator mode, e.g. 'High', 'Escalate', 'Tease', 'Deny', 'Edge'",
            },
        },
        ["memberNumber", "group"],
    ),
    handler: (args, ctx) => {
        const memberNumber = args.memberNumber as number;
        const group = args.group as string;
        const intensity = args.intensity as number | undefined;
        const mode = args.mode as string | undefined;

        const target = findCharacter(ctx.conn, args);
        if (!target) return "Error: character not found in room.";
        if (isProtected(ctx, memberNumber))
            return "Refused: that character is protected or suspended.";
        const refused = requireParticipant(ctx, memberNumber);
        if (refused) return refused;

        const item = target.Appearance.InventoryGet(group as never);
        if (!item)
            return `Character has no item in group '${group}'. Add one first with addItem.`;

        // Verify it's actually a vibrator
        if (!isVibrator(item))
            return `Item '${group}:${item.Name}' does not appear to be a controllable vibrator.`;

        if (intensity === undefined && mode === undefined)
            return "Nothing to do: provide 'intensity' and/or 'mode'.";

        const limited = checkRateLimit(ctx, memberNumber);
        if (limited) return limited;

        const before = vibratorState(item);

        // Apply intensity (numeric level)
        if (intensity !== undefined) {
            applyIntensity(item, intensity);
        }

        // Apply mode (named mode like Escalate, Tease, etc.)
        if (mode !== undefined) {
            item.setProperty("Mode", mode as never);
        }

        const after = vibratorState(item);
        return `Set ${group}:${item.Name} on ${target.Name}: ${before ?? "off"} → ${after ?? "unknown"}.`;
    },
};
