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

import { Tool, def, checkRateLimit } from "../shared";

export const moveSelfTool: Tool = {
    name: "moveSelf",
    definition: def(
        "moveSelf",
        "Move the bot's own character to a position on the room map (if the room uses a map).",
        {
            x: { type: "number", description: "Map X coordinate" },
            y: { type: "number", description: "Map Y coordinate" },
        },
        ["x", "y"],
    ),
    handler: (args, ctx) => {
        const x = Number(args.x);
        const y = Number(args.y);
        if (Number.isNaN(x) || Number.isNaN(y))
            return "Error: x and y must be numbers.";
        const limited = checkRateLimit(ctx);
        if (limited) return limited;
        ctx.conn.moveOnMap(x, y);
        return `Moved self to (${x}, ${y}).`;
    },
};
