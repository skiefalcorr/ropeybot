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

// Deep import of the compiled asset catalog (bc-bot ships dist/ with .d.ts).
// Used to validate item/pose names and to power the listItems / listClothing / listPoses
// discovery tools, so the LLM can pick valid names without us dumping the
// whole 1.7MB catalog into the prompt.
import {
    AssetFemale3DCG,
    PoseFemale3DCG,
    PoseFemale3DCGNames,
} from "bc-bot/dist/bcdata/female3DCG.js";

export interface CatalogGroup {
    Group: string;
    Category?: string;
    Clothing?: boolean;
    AllowNone?: boolean;
    Asset?: (
        | string
        | {
              Name: string;
              Fetish?: string[];
              /** 'M' = male-only, 'F' = female-only, undefined = unisex. */
              Gender?: "F" | "M";
              [k: string]: unknown;
          }
    )[];
}

export const CATALOG = AssetFemale3DCG as unknown as CatalogGroup[];

/** Item (restraint/BDSM) group names, derived from the catalog. */
export const ITEM_GROUPS = CATALOG.filter((g) => g.Category === "Item").map(
    (g) => g.Group,
);

/** Clothing group names, derived from the catalog (Clothing: true flag). */
export const CLOTHING_GROUPS = CATALOG.filter((g) => g.Clothing === true).map(
    (g) => g.Group,
);

/**
 * All valid fetish tag names (mirrors the `FetishName` type from
 * bc-stubs). Used to constrain the `fetish` filter param so the LLM
 * can't hallucinate a tag.
 */
export const FETISH_NAMES = [
    "Bondage",
    "Gagged",
    "Blindness",
    "Deafness",
    "Chastity",
    "Exhibitionist",
    "Masochism",
    "Sadism",
    "Rope",
    "Latex",
    "Leather",
    "Metal",
    "Tape",
    "Nylon",
    "Lingerie",
    "Pet",
    "Pony",
    "ABDL",
    "Forniphilia",
    "Spandex",
];

/**
 * Validate that a (group, asset) pair exists in the catalog.
 * Returns the group definition if valid, null otherwise.
 */
export function validateAsset(
    group: string,
    asset: string,
): CatalogGroup | null {
    const grp = CATALOG.find((g) => g.Group === group);
    if (!grp) return null;
    const ok = grp.Asset?.some(
        (a) => (typeof a === "string" ? a : a.Name) === asset,
    );
    return ok ? grp : null;
}

export { PoseFemale3DCG, PoseFemale3DCGNames };
