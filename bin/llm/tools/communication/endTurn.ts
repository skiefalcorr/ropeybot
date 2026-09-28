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

export const endTurnTool: Tool = {
    name: "endTurn",
    definition: def(
        "endTurn",
        "Signal that you are done with all actions for this turn. Call this when you have finished everything you wanted to do. Do not call it in the same batch as lookup tools (listItems, listClothing, listPoses) — perform your action first, then call endTurn.",
        {},
    ),
    handler: () => {
        return "Turn ended.";
    },
};
