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

import { Tool, def } from "../shared";
import { pickRandomRiddles } from "../../../games/riddles/riddleStore";
import type { RiddleState } from "../../../games/riddles/riddleState";
import {
    PLAYER_PARAMS,
    formatRiddle,
    resolvePlayer,
    type RiddleToolOptions,
} from "./shared";

/**
 * `getRiddles` — hand the model N riddles to choose from.
 *
 * The model is the one that decides which riddle to ask and how to phrase it;
 * this tool only supplies material. When a player is given, riddles they have
 * already solved are avoided, so a long-running player does not get repeats.
 */
export function createGetRiddlesTool(
    state: RiddleState,
    options: RiddleToolOptions,
): Tool {
    return {
        name: "getRiddles",
        category: "riddles",
        lookup: true,
        definition: def(
            "getRiddles",
            "Get N random riddles from the table to choose from. Each result has an id, the question, and the canonical answer. Use the id when calling assignRiddle. Optionally pass a player to exclude riddles they already solved.",
            {
                count: {
                    type: "number",
                    description: `How many riddles to return (default ${options.defaultBatchSize}).`,
                },
                ...PLAYER_PARAMS,
            },
        ),
        handler: (args, ctx) => {
            const count =
                typeof args.count === "number" && args.count > 0
                    ? Math.floor(args.count)
                    : options.defaultBatchSize;

            const target = resolvePlayer(ctx, args);
            const solved = target ? state.solvedIds(target.memberNumber) : [];
            const recent = target
                ? state.recentOffered(target.memberNumber)
                : [];

            const picked = pickRandomRiddles(
                options.pool,
                count,
                solved,
                recent,
            );
            if (picked.length === 0) {
                return "No riddles available. The riddle table appears to be empty.";
            }

            // Remember what was handed out so the next draw does not repeat
            // these — the model often asks for a batch and uses only one.
            if (target) {
                state.markOffered(
                    target.memberNumber,
                    picked.map((r) => r.id),
                );
            }

            const note = target
                ? ` (avoiding ${solved.length} riddle(s) ${target.name} already solved)`
                : "";
            return [
                `Got ${picked.length} riddle(s)${note}:`,
                ...picked.map(formatRiddle),
            ].join("\n");
        },
    };
}
