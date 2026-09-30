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

/**
 * Argument parsing for the in-game `!tool` test command.
 *
 * Accepts two forms (auto-detected):
 *  1. A JSON object:  {"memberNumber":123,"poses":["Kneel"]}
 *  2. key=value pairs: memberNumber=123 poses=Kneel,Stand color1=#FF0000
 *
 * key=value values are coerced: true/false -> boolean, numeric -> number,
 * comma-separated -> string array, otherwise raw string.
 *
 * Returns [args, error]; error is null on success.
 */
export function parseToolArgs(
    raw: string,
): [Record<string, unknown>, string | null] {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [{}, null];

    // Form 1: JSON object.
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "object" && parsed !== null) {
                return [parsed as Record<string, unknown>, null];
            }
            return [{}, "JSON argument must be an object."];
        } catch (e) {
            return [{}, `Invalid JSON: ${String(e)}`];
        }
    }

    // Form 2: key=value pairs separated by whitespace.
    const args: Record<string, unknown> = {};
    for (const token of trimmed.split(/\s+/)) {
        const eq = token.indexOf("=");
        if (eq <= 0) {
            return [
                {},
                `Invalid argument '${token}', expected key=value or a JSON object.`,
            ];
        }
        const key = token.slice(0, eq);
        const value = token.slice(eq + 1);
        args[key] = coerceValue(value);
    }
    return [args, null];
}

function coerceValue(value: string): unknown {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
    if (value.includes(",")) {
        return value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }
    return value;
}
