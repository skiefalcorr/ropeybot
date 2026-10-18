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

import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A tiny debounced, atomically-written JSON file store.
 *
 * Activities change state frequently (every riddle assignment, every verdict),
 * so writing synchronously on each change would hammer the disk and, worse,
 * risk a truncated file if the process dies mid-write. This store:
 *
 *  - coalesces rapid saves into one write per `debounceMs` window,
 *  - writes to `<path>.tmp` and renames over the target (atomic on the same
 *    filesystem, so a crash leaves either the old or the new file, never a
 *    half-written one),
 *  - exposes `flush()` so shutdown can force a final synchronous write.
 *
 * Failures are logged, never thrown: a broken state file must not take the
 * bot down mid-conversation.
 */
export class JsonStore<T> {
    private timer: NodeJS.Timeout | undefined;
    private pending: T | undefined;
    private inFlight: Promise<void> | undefined;
    private closed = false;

    constructor(
        private readonly path: string,
        private readonly debounceMs: number = 1000,
    ) {}

    /**
     * Read and parse the file. Returns `undefined` if it does not exist or is
     * not valid JSON (a corrupt file is treated as "start fresh" rather than
     * crashing the bot).
     */
    async load(): Promise<T | undefined> {
        let raw: string;
        try {
            raw = await readFile(this.path, "utf-8");
        } catch {
            return undefined;
        }
        try {
            return JSON.parse(raw) as T;
        } catch (e) {
            console.warn(
                `[JsonStore] ${this.path} is not valid JSON, starting fresh:`,
                String(e),
            );
            return undefined;
        }
    }

    /**
     * Schedule a save. Repeated calls within the debounce window replace the
     * pending value, so only the latest state is written.
     */
    save(value: T): void {
        if (this.closed) return;
        this.pending = value;
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.drain();
        }, this.debounceMs);
    }

    /** Write the pending state immediately, bypassing the debounce. */
    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        await this.drain();
        // Wait for any write that was already in flight.
        if (this.inFlight) {
            await this.inFlight;
        }
    }

    /** Stop accepting saves and flush whatever is pending. */
    async close(): Promise<void> {
        if (this.closed) {
            await this.flush();
            return;
        }
        await this.flush();
        this.closed = true;
    }

    private async drain(): Promise<void> {
        if (this.inFlight) {
            await this.inFlight;
        }
        const value = this.pending;
        if (value === undefined) return;
        this.pending = undefined;

        this.inFlight = this.writeAtomically(value).finally(() => {
            this.inFlight = undefined;
        });
        await this.inFlight;
    }

    private async writeAtomically(value: T): Promise<void> {
        const tmp = `${this.path}.tmp`;
        try {
            await mkdir(dirname(this.path), { recursive: true }).catch(
                () => undefined,
            );
            await writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
            await rename(tmp, this.path);
        } catch (e) {
            console.error(`[JsonStore] Failed to write ${this.path}:`, e);
            // Best effort cleanup so a stale .tmp doesn't confuse the next run.
            await unlink(tmp).catch(() => undefined);
        }
    }
}
