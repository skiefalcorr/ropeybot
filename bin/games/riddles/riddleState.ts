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

import type { Riddle } from "./riddleStore";

/**
 * Per-player riddle state.
 *
 *   idle  --assignRiddle/getSingleRiddle-->  asked
 *   asked --markRiddleResult(correct)----->  solved
 *   asked --markRiddleResult(giveUp)------>  failed
 *   asked --markRiddleResult(wrong)------->  asked   (attempts += 1)
 *   solved/failed --clearRiddle----------->  idle
 *
 * "solved" and "failed" are terminal *for a single riddle*; the player is
 * immediately ready for the next one. They are stored explicitly rather than
 * collapsing into idle so the LLM (and the player) can still be told how the
 * last riddle ended during the same turn.
 */
export type RiddlePlayerState = "idle" | "asked" | "solved" | "failed";

export interface RiddlePlayerRecord {
    state: RiddlePlayerState;
    /** Display name at the time of the last interaction, for leaderboards. */
    name: string;
    /** Id of the riddle currently being asked (or last answered). */
    riddleId?: string;
    /** The question text, mirrored so an edited CSV cannot change a live riddle. */
    question?: string;
    /** The answer, mirrored for the same reason. */
    answer?: string;
    /** Wrong guesses on the current riddle. */
    attempts: number;
    /** Ids of every riddle this player has solved. */
    solvedIds: string[];
    /** How many riddles this player gave up on. */
    failedCount: number;
    /** Epoch ms the current riddle was assigned. */
    askedAt?: number;
    /** Epoch ms the player was last given the entry whisper. */
    greetedAt?: number;
}

export interface RiddleStateData {
    version: 1;
    players: Record<string, RiddlePlayerRecord>;
}

export interface RiddleGoalReached {
    memberNumber: number;
    name: string;
    solved: number;
}

/**
 * The riddle state machine. Pure in-memory logic with no I/O and no knowledge
 * of the chat connection, so it can be unit-tested directly and driven from
 * either the LLM tools or the `/bot riddles` command.
 *
 * The LLM writes into this and nothing else does — every transition below is
 * either initiated by an LLM tool call or by an explicit player-facing
 * command, never inferred from raw chat text.
 */
export class RiddleState {
    private players = new Map<number, RiddlePlayerRecord>();
    private onChange: (() => void) | undefined;

    constructor(private goal: number = 10) {}

    /** Register a callback fired after every mutation (used to persist). */
    setOnChange(cb: () => void): void {
        this.onChange = cb;
    }

    private changed(): void {
        this.onChange?.();
    }

    getGoal(): number {
        return this.goal;
    }

    setGoal(goal: number): void {
        this.goal = Math.max(1, Math.floor(goal));
        this.changed();
    }

    private ensure(memberNumber: number, name: string): RiddlePlayerRecord {
        let record = this.players.get(memberNumber);
        if (!record) {
            record = {
                state: "idle",
                name,
                attempts: 0,
                solvedIds: [],
                failedCount: 0,
            };
            this.players.set(memberNumber, record);
        }
        if (name && record.name !== name) record.name = name;
        return record;
    }

    /** The record for a player, if they have ever interacted. */
    peek(memberNumber: number): RiddlePlayerRecord | undefined {
        return this.players.get(memberNumber);
    }

    /** All tracked players, newest-first by last ask. */
    all(): { memberNumber: number; record: RiddlePlayerRecord }[] {
        return [...this.players.entries()]
            .map(([memberNumber, record]) => ({ memberNumber, record }))
            .sort((a, b) => (b.record.askedAt ?? 0) - (a.record.askedAt ?? 0));
    }

    solvedCount(memberNumber: number): number {
        return this.players.get(memberNumber)?.solvedIds.length ?? 0;
    }

    hasSolved(memberNumber: number, riddleId: string): boolean {
        return (
            this.players
                .get(memberNumber)
                ?.solvedIds.includes(riddleId) ?? false
        );
    }

    /** Ids this player has already solved, for excluding from the pool. */
    solvedIds(memberNumber: number): string[] {
        return [...(this.players.get(memberNumber)?.solvedIds ?? [])];
    }

    /**
     * Assign a riddle to a player. Allowed from any state: assigning a new
     * riddle implicitly abandons the previous one (the LLM may reassign after
     * an ambiguous guess).
     */
    assign(
        memberNumber: number,
        name: string,
        riddle: Pick<Riddle, "id" | "question" | "answer">,
    ): RiddlePlayerRecord {
        const record = this.ensure(memberNumber, name);
        record.state = "asked";
        record.riddleId = riddle.id;
        record.question = riddle.question;
        record.answer = riddle.answer;
        record.attempts = 0;
        record.askedAt = Date.now();
        this.changed();
        return record;
    }

    /**
     * Record the LLM's verdict for the player's current riddle.
     *
     * The LLM is the sole judge: it reads the canonical answer out of its
     * context and decides. This method only applies the consequence.
     *
     * Returns `undefined` when there is no riddle in flight — the caller
     * should tell the model to assign one first.
     */
    markResult(
        memberNumber: number,
        correct: boolean,
        options: { giveUp?: boolean } = {},
    ):
        | {
              record: RiddlePlayerRecord;
              outcome: "solved" | "failed" | "wrong";
              solved: number;
              goal: number;
              goalReached: boolean;
          }
        | undefined {
        const record = this.players.get(memberNumber);
        if (!record || record.state !== "asked" || !record.riddleId) {
            return undefined;
        }

        if (correct) {
            if (!record.solvedIds.includes(record.riddleId)) {
                record.solvedIds.push(record.riddleId);
            }
            record.state = "solved";
            const solved = record.solvedIds.length;
            this.changed();
            return {
                record,
                outcome: "solved",
                solved,
                goal: this.goal,
                goalReached: solved >= this.goal,
            };
        }

        if (options.giveUp) {
            record.failedCount += 1;
            record.state = "failed";
            this.changed();
            return {
                record,
                outcome: "failed",
                solved: record.solvedIds.length,
                goal: this.goal,
                goalReached: false,
            };
        }

        record.attempts += 1;
        this.changed();
        return {
            record,
            outcome: "wrong",
            solved: record.solvedIds.length,
            goal: this.goal,
            goalReached: false,
        };
    }

    /**
     * Clear the finished riddle, returning the player to idle. Called when the
     * LLM moves on, or automatically on the next assign.
     */
    clearRiddle(memberNumber: number): void {
        const record = this.players.get(memberNumber);
        if (!record) return;
        record.state = "idle";
        record.riddleId = undefined;
        record.question = undefined;
        record.answer = undefined;
        record.attempts = 0;
        record.askedAt = undefined;
        this.changed();
    }

    /**
     * Ensure a record exists for a player without changing game state. Used by
     * the entry whisper so it can persist its "already greeted" flag.
     */
    touch(memberNumber: number, name: string): RiddlePlayerRecord {
        const record = this.ensure(memberNumber, name);
        this.changed();
        return record;
    }

    /**
     * Mark the player as having received the entry whisper. Returns whether
     * this was the first time.
     */
    markGreeted(memberNumber: number, name: string): boolean {
        const record = this.ensure(memberNumber, name);
        const first = record.greetedAt === undefined;
        record.greetedAt = Date.now();
        this.changed();
        return first;
    }

    wasGreeted(memberNumber: number): boolean {
        return this.players.get(memberNumber)?.greetedAt !== undefined;
    }

    /** Players sorted by riddles solved, descending, then fewest failures. */
    leaderboard(limit = 10): {
        memberNumber: number;
        name: string;
        solved: number;
        failed: number;
    }[] {
        return [...this.players.entries()]
            .filter(([, r]) => r.solvedIds.length > 0 || r.failedCount > 0)
            .map(([memberNumber, r]) => ({
                memberNumber,
                name: r.name,
                solved: r.solvedIds.length,
                failed: r.failedCount,
            }))
            .sort(
                (a, b) =>
                    b.solved - a.solved ||
                    a.failed - b.failed ||
                    a.name.localeCompare(b.name),
            )
            .slice(0, limit);
    }

    /**
     * Everyone who has hit the goal, for the "congratulations" path.
     */
    goalReached(): RiddleGoalReached[] {
        return [...this.players.entries()]
            .filter(([, r]) => r.solvedIds.length >= this.goal)
            .map(([memberNumber, r]) => ({
                memberNumber,
                name: r.name,
                solved: r.solvedIds.length,
            }));
    }

    /** Drop everything, keeping no history. Superuser action. */
    reset(): void {
        this.players.clear();
        this.changed();
    }

    /** Serialise for persistence. */
    toJSON(): RiddleStateData {
        return {
            version: 1,
            players: Object.fromEntries(this.players.entries()),
        };
    }

    /** Restore from persistence, tolerating partial or old data. */
    load(data: RiddleStateData | undefined): void {
        this.players.clear();
        if (!data || typeof data !== "object" || !data.players) return;
        for (const [key, raw] of Object.entries(data.players)) {
            const memberNumber = Number(key);
            if (!Number.isFinite(memberNumber) || !raw) continue;
            this.players.set(memberNumber, {
                state: raw.state ?? "idle",
                name: raw.name ?? String(memberNumber),
                riddleId: raw.riddleId,
                question: raw.question,
                answer: raw.answer,
                attempts: raw.attempts ?? 0,
                solvedIds: Array.isArray(raw.solvedIds)
                    ? [...new Set(raw.solvedIds)]
                    : [],
                failedCount: raw.failedCount ?? 0,
                askedAt: raw.askedAt,
                greetedAt: raw.greetedAt,
            });
        }
    }

    /**
     * A compact one-line status for a player, used by `/bot riddles` and the
     * entry whisper.
     */
    progressText(memberNumber: number): string {
        const record = this.players.get(memberNumber);
        const solved = record?.solvedIds.length ?? 0;
        const failed = record?.failedCount ?? 0;
        return `${solved}/${this.goal} solved${failed > 0 ? `, ${failed} given up` : ""}`;
    }
}
