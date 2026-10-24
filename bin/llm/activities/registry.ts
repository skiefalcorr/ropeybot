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

import type { LLMConfig, RiddlesConfig } from "../../config";
import { RiddlesActivity } from "../../games/riddles/activity";
import type { LLMActivity } from "./types";

export type { ActivityContext, LLMActivity } from "./types";

/**
 * Factory for a known activity id. Registering a factory here is the only
 * change needed to make a new activity available to config.
 */
type ActivityFactory = (config: LLMConfig) => LLMActivity;

const FACTORIES: Record<string, ActivityFactory> = {
    riddles: (config) => {
        const shorthand = config.riddles;
        const fromMap = config.activities?.riddles;
        const merged: RiddlesConfig = {
            ...(shorthand ?? {}),
            ...(fromMap && typeof fromMap === "object" ? fromMap : {}),
        };
        return new RiddlesActivity(merged);
    },
};

/**
 * Resolve the enabled activity configs.
 *
 * Rules:
 *  - `activities` is the canonical map: a key present and not `false` enables
 *    that activity. `{ enabled: false }` disables it too.
 *  - `llm.riddles` is a convenience shorthand; it enables riddles unless
 *    `activities.riddles` explicitly disables it.
 *  - Unknown ids are ignored with a warning, so a typo does not crash the bot.
 */
function enabledEntries(config: LLMConfig): {
    id: string;
    enabled: boolean;
}[] {
    const entries = new Map<string, boolean>();

    if (config.riddles) {
        entries.set("riddles", true);
    }

    for (const [id, value] of Object.entries(config.activities ?? {})) {
        if (value === false) {
            entries.set(id, false);
            continue;
        }
        const enabled = value.enabled !== false;
        // An explicit entry wins over the shorthand.
        entries.set(id, enabled);
    }

    return [...entries.entries()].map(([id, enabled]) => ({ id, enabled }));
}

/**
 * Build every enabled activity from config. Order is deterministic (map
 * insertion order), which keeps prompt sections and tool lists stable.
 */
export function buildActivities(config: LLMConfig): LLMActivity[] {
    const activities: LLMActivity[] = [];
    for (const { id, enabled } of enabledEntries(config)) {
        if (!enabled) continue;
        const factory = FACTORIES[id];
        if (!factory) {
            console.warn(
                `[activities] Unknown activity '${id}' in config; ignoring.`,
            );
            continue;
        }
        try {
            activities.push(factory(config));
        } catch (e) {
            console.error(`[activities] Failed to build '${id}':`, e);
        }
    }
    return activities;
}

/**
 * The ids of all activities that would be enabled for this config, without
 * constructing them. Used by `/bot status`.
 */
export function enabledActivityIds(config: LLMConfig): string[] {
    return enabledEntries(config)
        .filter((e) => e.enabled && FACTORIES[e.id])
        .map((e) => e.id);
}
