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
    API_Character,
    API_Connector,
    BC_Server_ChatRoomMessage,
    CommandParser,
} from "bc-bot";
import { CommandArgs, CommandContribution } from "./types";

export type { CommandArgs, CommandContribution, CommandHandler, CommandMode } from "./types";

/**
 * Owner tag used by the base LLM bot's own commands.
 */
export const CORE_OWNER = "core";

interface Registered {
    contribution: CommandContribution;
    /** Monotonic insertion counter, used as a stable tie-breaker. */
    order: number;
}

/**
 * A command hub layered on top of the existing {@link CommandParser}.
 *
 * The parser does not allow two handlers on the same command — the last
 * registration silently replaces the earlier one. That makes it impossible
 * for an activity to *add* to `/bot status` without hijacking it. The hub
 * solves this by registering a single dispatching handler per command name
 * and resolving multiple contributions itself:
 *
 *  - `replace` contributions compete for the single base slot (highest
 *    priority wins, ties go to the earliest registration);
 *  - `append` contributions run after the base and have their output stacked.
 *
 * Handlers return text instead of calling `conn.reply()` directly, so every
 * contribution to one command produces ONE chat message rather than several.
 *
 * Removing an owner (`unregisterOwner`) detaches all of an activity's
 * commands at once, which is what happens when an activity is disabled.
 */
export class CommandHub {
    private contributions = new Map<string, Registered[]>();
    private wired = new Set<string>();
    private counter = 0;
    private disposed = false;

    constructor(
        private conn: API_Connector,
        private parser: CommandParser,
    ) {}

    /**
     * Register a contribution. The command name is matched case-insensitively,
     * matching the CommandParser's own lowercasing.
     */
    register(contribution: CommandContribution): void {
        if (this.disposed) return;
        const name = contribution.name.toLowerCase();
        const list = this.contributions.get(name) ?? [];
        list.push({ contribution, order: this.counter++ });
        this.contributions.set(name, list);

        if (!this.wired.has(name)) {
            this.wired.add(name);
            this.parser.register(name, (sender, message, args) =>
                this.dispatch(name, sender, message, args),
            );
        }
    }

    /**
     * Remove every contribution owned by `owner`. Contributions from other
     * owners keep working. The parser registration is intentionally kept
     * (it is cheap and idempotent), so a re-enabled activity can register
     * again without re-wiring.
     */
    unregisterOwner(owner: string): void {
        for (const [name, list] of this.contributions) {
            const kept = list.filter((r) => r.contribution.owner !== owner);
            if (kept.length === 0) {
                this.contributions.delete(name);
            } else {
                this.contributions.set(name, kept);
            }
        }
    }

    /**
     * Whether any contribution exists for the command.
     */
    has(name: string): boolean {
        return this.contributions.has(name.toLowerCase());
    }

    /**
     * All registered command names (lowercase, de-duplicated, sorted).
     */
    commandNames(): string[] {
        return [...this.contributions.keys()].sort();
    }

    /**
     * Help lines for every contribution that declares `help`, sorted by name.
     */
    helpLines(): string[] {
        const lines: string[] = [];
        for (const name of this.commandNames()) {
            const list = this.contributions.get(name) ?? [];
            for (const { contribution } of list) {
                if (!contribution.help) continue;
                lines.push(`/bot ${name} — ${contribution.help}`);
            }
        }
        return lines;
    }

    /**
     * Resolve and run the contributions for one command invocation, then send
     * the assembled result as a single reply.
     */
    private async dispatch(
        name: string,
        sender: API_Character,
        message: BC_Server_ChatRoomMessage,
        args: string[],
    ): Promise<void> {
        // After dispose() the hub is inert: stay silent rather than replying
        // "Unknown command" to commands that used to work during shutdown.
        if (this.disposed) return;

        const list = this.contributions.get(name);
        if (!list || list.length === 0) {
            this.conn.reply(message, "Unknown command");
            return;
        }

        // Highest priority first; later registrations win ties because we sort
        // by descending priority and ascending order as a stable fallback.
        const sorted = [...list].sort((a, b) => {
            const pa = a.contribution.priority ?? 0;
            const pb = b.contribution.priority ?? 0;
            if (pb !== pa) return pb - pa;
            return a.order - b.order;
        });

        const base = sorted.find(
            (r) => (r.contribution.mode ?? "replace") === "replace",
        );
        const appenders = sorted.filter(
            (r) => r.contribution.mode === "append",
        );

        const chosen = base ? [base, ...appenders] : appenders;
        if (chosen.length === 0) {
            this.conn.reply(message, "Unknown command");
            return;
        }

        const ctx: CommandArgs = { sender, message, args, conn: this.conn };
        const lines: string[] = [];
        let wantsPrivate = false;

        for (const { contribution } of chosen) {
            if (contribution.private) wantsPrivate = true;
            try {
                const out = await contribution.handler(ctx);
                if (out === undefined || out === null) continue;
                const parts = Array.isArray(out) ? out : [out];
                for (const part of parts) {
                    if (part && String(part).trim().length > 0) {
                        lines.push(String(part).trimEnd());
                    }
                }
            } catch (e) {
                console.log(
                    `Command handler for '${name}' (owner ${contribution.owner}) threw:`,
                    e,
                );
                lines.push(`(${contribution.owner} command failed)`);
            }
        }

        if (lines.length === 0) return;
        const text = lines.join("\n");

        if (wantsPrivate) {
            this.conn.SendMessage("Whisper", text, sender.MemberNumber);
        } else {
            this.conn.reply(message, text);
        }
    }

    /**
     * Detach completely. After this the hub ignores further registrations.
     */
    dispose(): void {
        this.disposed = true;
        this.contributions.clear();
        this.wired.clear();
    }
}
