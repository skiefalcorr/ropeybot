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
import { PoseFemale3DCG } from "../catalog";

export const listPosesTool: Tool = {
    name: "listPoses",
    definition: def(
        "listPoses",
        "List all valid pose names (with their body category) so you can use valid names with setPose.",
        {},
    ),
    handler: () => {
        const lines = PoseFemale3DCG.map((p) => `${p.Name} (${p.Category})`);
        return `${lines.length} poses:\n${lines.join("\n")}`;
    },
};
