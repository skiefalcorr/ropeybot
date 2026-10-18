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

import { readFile } from "fs/promises";
import { API_Character } from "bc-bot";
import { displayName, pronounsFor, type PronounSet } from "./tools/shared";

/**
 * A lookup of message Content (e.g. "ChatSelf-ItemArms-Wiggle") ->
 * human-readable text template, parsed from
 * `src/bcdata/ActivityDictionary.csv`. The templates contain placeholders
 * (SourceCharacter, TargetCharacter, PronounPossessive, etc.) that are
 * substituted at render time.
 */
export type ActivityDictionary = Map<string, string>;

/**
 * Load and parse the activity dictionary CSV. Column 1 is the ActivityName
 * key, column 2 is the text template. Blank lines are skipped. Returns an
 * empty map if the file cannot be read (so callers can fall back gracefully).
 */
export async function loadActivityDictionary(
    path = "src/bcdata/ActivityDictionary.csv",
): Promise<ActivityDictionary> {
    const map = new Map<string, string>();
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch {
        return map;
    }

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const comma = trimmed.indexOf(",");
        if (comma <= 0) continue;
        const key = trimmed.slice(0, comma).trim();
        const value = trimmed.slice(comma + 1).trim();
        if (key && value) map.set(key, value);
    }
    return map;
}

interface RenderContext {
    source: API_Character | undefined;
    target: API_Character | undefined;
    assetName: string | undefined;
}

/**
 * Render a human-readable sentence for an activity by looking up its
 * template in the dictionary and substituting the placeholders. The lookup
 * key is the message `Content` (e.g. "ChatSelf-ItemArms-Wiggle"), which is
 * what the dictionary CSV is keyed by. Returns undefined if the content is
 * not in the dictionary.
 */
export function renderActivityText(
    content: string,
    dict: ActivityDictionary,
    ctx: RenderContext,
): string | undefined {
    const template = dict.get(content);
    if (!template) return undefined;

    const sourcePronouns = pronounsFor(ctx.source);
    const targetPronouns = pronounsFor(ctx.target);
    const sourceName = ctx.source ? displayName(ctx.source) : "Someone";
    const targetName = ctx.target ? displayName(ctx.target) : "someone";

    // Replace longer / more specific tokens first so that e.g.
    // "TargetPronounPossessive" is not clobbered by "PronounPossessive".
    let text = template;
    text = text.replace(/TargetPronounPossessive/g, targetPronouns.possessive);
    text = text.replace(/PronounPossessive/g, sourcePronouns.possessive);
    text = text.replace(/PronounSelf/g, sourcePronouns.self);
    text = text.replace(/PronounObject/g, sourcePronouns.object);
    text = text.replace(/SourceCharacter/g, sourceName);
    text = text.replace(/TargetCharacter/g, targetName);
    text = text.replace(/ActivityAsset/g, ctx.assetName ?? "the item");

    return text.trim();
}
