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

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * One riddle from the CSV table.
 *
 * `id` is a stable content hash rather than a row index, so editing the CSV
 * (adding rows, reordering, fixing a typo in an *unrelated* row) does not
 * silently re-point every player's saved progress at different riddles.
 */
export interface Riddle {
    id: string;
    question: string;
    answer: string;
}

const DEFAULT_PATH = "bin/games/riddles/riddles.csv";

/**
 * Parse a single CSV record starting at `start`, honouring RFC 4180 quoting:
 * double quotes wrap a field, `""` inside a quoted field is a literal quote,
 * and commas/newlines inside quotes are part of the value.
 *
 * Returns the parsed fields and the index just past the record, or
 * `undefined` if the input is exhausted.
 */
function parseRecord(
    text: string,
    start: number,
): { fields: string[]; next: number } | undefined {
    if (start >= text.length) return undefined;

    const fields: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = start;

    while (i < text.length) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
            i += 1;
            continue;
        }
        if (ch === ",") {
            fields.push(field);
            field = "";
            i += 1;
            continue;
        }
        if (ch === "\r") {
            // Treat CRLF and a bare CR as a record terminator.
            fields.push(field);
            i += text[i + 1] === "\n" ? 2 : 1;
            return { fields, next: i };
        }
        if (ch === "\n") {
            fields.push(field);
            i += 1;
            return { fields, next: i };
        }

        field += ch;
        i += 1;
    }

    // End of input: flush the trailing field.
    fields.push(field);
    return { fields, next: i };
}

/**
 * Parse the whole CSV into records of string fields. Blank records are
 * dropped. Robust to a UTF-8 BOM, CRLF line endings, quoted fields
 * containing commas, and escaped quotes.
 */
export function parseCsv(text: string): string[][] {
    // Strip a UTF-8 BOM if the file was written by Excel.
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }

    const records: string[][] = [];
    let pos = 0;
    while (pos < text.length) {
        const record = parseRecord(text, pos);
        if (!record) break;
        pos = record.next;
        const trimmed = record.fields.map((f) => f.trim());
        if (trimmed.some((f) => f.length > 0)) {
            records.push(trimmed);
        }
    }
    return records;
}

/**
 * Stable id for a riddle, derived from its question text.
 *
 * The question is normalised first (lowercase, collapsed whitespace, no
 * trailing punctuation) so a cosmetic edit to the CSV does not orphan a
 * player's saved progress. Two genuinely different riddles get different ids
 * even when their answers coincide.
 */
export function riddleId(question: string): string {
    const normalised = question
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[\s.!?,;:'"]+$/g, "")
        .trim();
    return createHash("sha1").update(normalised).digest("hex").slice(0, 12);
}

/**
 * Load and validate the riddle table.
 *
 * The source CSV repeats the same question with different answers in a few
 * places (e.g. "air", "breath"), which would otherwise let a player be asked
 * an identical riddle twice. Records are therefore de-duplicated by question
 * text, keeping the first occurrence. Rows with a missing question or answer
 * are skipped and counted.
 */
export async function loadRiddles(
    path: string = DEFAULT_PATH,
): Promise<{ riddles: Riddle[]; skipped: number; duplicates: number }> {
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch (e) {
        console.warn(`[riddles] Could not read ${path}:`, String(e));
        return { riddles: [], skipped: 0, duplicates: 0 };
    }

    const records = parseCsv(raw);
    const riddles: Riddle[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    let duplicates = 0;

    for (const record of records) {
        const question = record[0] ?? "";
        const answer = record[1] ?? "";

        // Skip the header row ("QUESTIONS,ANSWERS") and any malformed rows.
        if (!question || !answer) {
            skipped += 1;
            continue;
        }
        if (question.toLowerCase() === "questions") {
            skipped += 1;
            continue;
        }

        const id = riddleId(question);
        if (seen.has(id)) {
            duplicates += 1;
            continue;
        }
        seen.add(id);
        riddles.push({ id, question, answer: answer.toLowerCase() });
    }

    return { riddles, skipped, duplicates };
}

/**
 * Pick `count` distinct random riddles from `pool`, excluding any id present
 * in `exclude` when possible. Falls back to allowing solved riddles only when
 * the unsolved pool is smaller than `count`, so a player who has solved most
 * of the table still gets a riddle instead of an empty result.
 */
export function pickRandomRiddles(
    pool: Riddle[],
    count: number,
    exclude: Iterable<string> = [],
): Riddle[] {
    if (pool.length === 0 || count <= 0) return [];
    const excluded = new Set(exclude);
    const fresh = pool.filter((r) => !excluded.has(r.id));
    const source = fresh.length >= count ? fresh : pool;

    // Partial Fisher-Yates: shuffle just enough of a copy to take `count`.
    const copy = [...source];
    const take = Math.min(count, copy.length);
    for (let i = 0; i < take; i++) {
        const j = i + Math.floor(Math.random() * (copy.length - i));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, take);
}
