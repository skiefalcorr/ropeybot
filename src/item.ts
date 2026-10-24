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

import { API_Character } from "./apiCharacter.ts";
import { AssetType } from "./appearance.ts";
import { AssetFemale3DCG, PoseFemale3DCG } from "./bcdata/female3DCG.js";
import { AssetFemale3DCGExtended } from "./bcdata/Female3DCGExtended.ts";

// An item as it appears on the wire (similar to Item but instead of the Asset
// there's just Name representing the asset name), plus a Group

export type BC_AppearanceItem = ServerItemBundle;

interface PartialCraftingData {
    Name: string;
    Description: string;
    Property?: CraftingPropertyType;
    MemberName?: string;
    MemberNumber?: number;
    Effects?: CraftingItem["Effects"];
}

/**
 *
 * @param poses Given a list of poses, return a set of the pose categories that have poses in the list
 */
function getPoseCategories(
    poses: Iterable<AssetPoseName>,
): Set<AssetPoseCategory> {
    const cats = new Set<AssetPoseCategory>();
    for (const pose of poses) {
        const poseObj = PoseFemale3DCG.find((x) => x.Name === pose);
        if (!poseObj) {
            console.warn("Couldn't find pose", pose);
        } else {
            cats.add(poseObj.Category);
        }
    }

    return cats;
}

export class API_AppearanceItem {
    private _removed: boolean = false;
    private _extendedItem: ExtendedItem | undefined;

    private updateTask: NodeJS.Immediate | undefined;

    constructor(
        private character: API_Character,
        private data: BC_AppearanceItem,
    ) {
        const def = getAssetDef(AssetGet(data.Group, data.Name));
        // The client treats any asset that has an extended-item config as
        // extended: `TypedItemRegister`/`ModularItemRegister` set
        // `Asset.Extended = true` themselves, so the `Extended` flag in
        // Female3DCG.js is not the real gate. Keying off the resolved config
        // keeps us aligned with what the game actually allows, and skips
        // assets whose config is missing or has a broken CopyConfig chain.
        if (def && resolveExtendedAsset(data.Group, data.Name)) {
            try {
                this._extendedItem = new ExtendedItem(this, data);
            } catch (e) {
                console.warn(
                    `No usable extended config for ${data.Group}:${data.Name}`,
                    e,
                );
            }
        }
    }

    public get Group(): AssetGroupName {
        return this.data.Group;
    }
    public get Name(): string {
        return this.data.Name;
    }
    public get Asset(): AssetType {
        return makeAssetType(AssetGet(this.data.Group, this.data.Name));
    }
    public get AssetGroup(): AssetGroupDefinition {
        return AssetFemale3DCG.find((x) => x.Group === this.Group)!;
    }
    public get Extended(): ExtendedItem | undefined {
        return this._extendedItem;
    }

    public getAssetDef(): AssetDefinition {
        return getAssetDef(AssetGet(this.data.Group, this.data.Name))!;
    }

    public GetExpression(): ExpressionName | undefined {
        return this.data.Property?.Expression;
    }

    public SetExpression(expr: ExpressionName) {
        this.data.Property = this.data.Property ?? {};
        if (expr) {
            this.data.Property.Expression = expr;
        } else {
            delete this.data.Property.Expression;
        }

        this.queueUpdate();
    }

    public SetDifficulty(difficulty: number): void {
        this.data.Difficulty = difficulty;
        this.queueUpdate();
    }

    public GetColor(): ItemColor | undefined {
        return this.data.Color;
    }

    public SetColor(colors: ItemColor): void {
        this.data.Color = Array.isArray(colors)
            ? (colors as BCColor[])
            : ([colors] as BCColor[]);
        this.queueUpdate();
    }

    /**
     * Color the item's layers after the character's own appearance:
     * layer 0 takes the character's hair color (from the HairFront item),
     * layer 1 takes the character's eye color (from the Eyes item).
     * Explicit `color1` / `color2` arguments override the character's
     * colors. Remaining layers stay "Default".
     */
    public setColorFromCharacter(color1?: string, color2?: string): void {
        const layers = this.Asset.countColorableLayers();
        if (layers === 0) return;

        const hair =
            this.character.Appearance.InventoryGet("HairFront")?.GetColor();
        const hairColor = Array.isArray(hair) ? hair[0] : hair;
        const eyes = this.character.Appearance.InventoryGet("Eyes")?.GetColor();
        const eyeColor = Array.isArray(eyes) ? eyes[0] : eyes;

        const c1 = color1 ?? hairColor;
        const c2 = color2 ?? eyeColor;

        const colors: string[] = new Array(layers).fill("Default");
        if (c1) colors[0] = c1;
        if (c2 && layers > 1) colors[1] = c2;

        this.SetColor(colors as BCColor[]);
    }

    public SetCraft(craft: PartialCraftingData): void {
        this.data.Craft = Object.assign(
            {
                Item: this.data.Name,
                MemberName: this.character.Name,
                MemberNumber: this.character.MemberNumber,
                Property: "Normal" as CraftingPropertyType,
                Color: new Array(this.Asset.countColorableLayers())
                    .fill("Default")
                    .join(","),
                Lock: "" as "",
                Private: true,
                ItemProperty: {} as ItemProperties,
                Effects: craft.Effects ?? {},
            },
            craft,
        );

        this.queueUpdate();
    }

    public AllowRemove(): boolean {
        // TODO
        return true;
    }

    public lock(
        lockType: AssetLockType,
        lockedBy: number,
        opts: Record<string, any>,
    ): void {
        if (!this.getAssetDef().AllowLock) return;

        this.data.Property ??= {};
        this.data.Property.LockedBy = lockType;
        this.data.Property.LockMemberNumber = lockedBy;
        this.data.Property.Effect = this.data.Property.Effect ?? [];
        if (!this.data.Property.Effect.includes("Lock"))
            this.data.Property.Effect.push("Lock");
        Object.assign(this.data.Property, opts);
        this.queueUpdate();
    }

    public SetOverrideHeight(height: number | undefined): void {
        if (height) {
            this.data.Property ??= {};
            this.data.Property.OverrideHeight = {
                Priority: 100,
                Height: height,
            };
        } else if (this.data.Property) {
            delete this.data.Property.OverrideHeight;
        }
        this.queueUpdate();
    }

    public getEffects(): EffectName[] {
        return this.data.Property?.Effect ?? [];
    }

    public setRemoved(): void {
        this._removed = true;
    }

    public setProperty<K extends keyof ItemProperties>(
        prop: K,
        value: ItemProperties[K],
    ): void {
        this.data.Property ??= {};
        this.data.Property[prop] = value;
        this.queueUpdate();
    }

    public getData(): BC_AppearanceItem {
        return this.data;
    }

    public queueUpdate(): void {
        this.character.Appearance.updateItemData(this.data);
        if (this.updateTask) return;

        this.updateTask = setImmediate(this.doUpdate);
    }

    private doUpdate = (): void => {
        this.updateTask = undefined;
        this.character.sendItemUpdate(this.data);
        // this.character.sendAppearanceUpdate();
    };
}

/**
 * Resolve an asset's extended-item configuration, following `CopyConfig`
 * references until a concrete config is reached. Exported so callers outside
 * this file (the LLM tool layer) do not have to reimplement the walk.
 *
 * Returns null for assets without an extended config, and for `CopyConfig`
 * cycles rather than looping forever. Unlike `getExtendedAssetDef` this is
 * quiet: it is consulted for every worn item, and most groups simply have no
 * extended config, which is not a warning worth logging.
 */
export function resolveExtendedAsset(
    group: AssetGroupName,
    asset: string,
): AssetArchetypeConfig | null {
    let config: AssetArchetypeConfig | null =
        AssetFemale3DCGExtended[group]?.[asset] ?? null;
    const seen = new Set<string>([`${group}:${asset}`]);
    while (config && config.CopyConfig) {
        const nextGroup = (config.CopyConfig.GroupName ??
            group) as AssetGroupName;
        const nextAsset = config.CopyConfig.AssetName;
        const key = `${nextGroup}:${nextAsset}`;
        if (seen.has(key)) {
            console.warn(`CopyConfig cycle while resolving ${group}:${asset}`);
            return null;
        }
        seen.add(key);
        config = AssetFemale3DCGExtended[nextGroup]?.[nextAsset] ?? null;
    }
    return config;
}

export class ExtendedItem {
    private readonly extendedDef: AssetArchetypeConfig;

    constructor(
        private itemType: API_AppearanceItem,
        private item: BC_AppearanceItem,
    ) {
        let config = resolveExtendedAsset(this.item.Group, this.item.Name);
        if (!config) throw new Error();
        this.extendedDef = config;
        //console.log(`Made extended item for ${item.Group} / ${item.Name}, Extended def is ${this.extendedDef}`);
    }

    public get Type() {
        return this.item.Property?.Type;
    }

    public SetText(text: string): void {
        const textParts = text.split("\n");

        this.item.Property ??= {};
        this.item.Property.Text = textParts[0];
        this.item.Property.Text2 = textParts[1];
        this.item.Property.Text3 = textParts[2];
        this.itemType.queueUpdate();
    }

    public SetType(t: string): void {
        //console.log(`Setting type for asset ${this.item.Group} / ${this.item.Name} with extended def ${JSON.stringify(this.extendedDef)} to ${t}`);
        if (this.extendedDef.Archetype !== "typed") {
            throw new Error(
                `Tried to set type of non-typed asset ${this.item.Name}`,
            );
        }

        const optionSetIdx =
            this.extendedDef.Options?.findIndex((x) => x.Name === t) ?? -1;
        if (optionSetIdx === -1) {
            throw new Error(`Invalid type ${t} for item ${this.item.Name}`);
        }
        const optionSet = this.extendedDef.Options?.[optionSetIdx];

        this.item.Property ??= {};
        this.applyOptionProperties(optionSetIdx, optionSet);
        this.fixupAllowActivePose(); // we probably need to do this other times too
        this.itemType.queueUpdate();
    }

    /**
     * Swap the selected option's properties in, the same way the game does it.
     *
     * The client runs `PropertyDifference(item.Property, previousOption.Property)`
     * followed by `PropertyUnion(item.Property, newOption.Property)`
     * (ExtendedItem.js `ExtendedItemSetOption`). Doing a plain `Object.assign`
     * instead only ever adds or overwrites, which diverges from the game in two
     * ways: properties the old option contributed but the new one does not stay
     * glued to the item (`SetPose`, `Block`, `Hide`, `AllowActivity`), and
     * additive keys accumulate — `Difficulty`/`HeightModifier` are summed, and
     * array keys such as `Effect` are unioned, so switching back and forth
     * inflates them.
     *
     * Keys declared in `BaselineProperty` are excluded from the removal pass,
     * matching the client, which strips them from the previous option's
     * properties before diffing. That protects baseline state and anything a
     * script hook owns.
     */
    private applyOptionProperties(
        newOptionIdx: number,
        newOption: TypedItemOptionConfig | undefined,
    ): void {
        if (this.extendedDef.Archetype !== "typed") return;
        const prop = this.item.Property as Record<string, unknown>;
        const options = this.extendedDef.Options ?? [];

        // Only undo the previous option's properties when a selection was
        // actually recorded.
        //
        // The client can always subtract the previous option because applying an
        // extended item runs its init, which writes the first option's
        // properties onto the item. We do not do that on `AddItem`, so an item
        // we just added has an empty `Property` and subtracting option 0 would
        // drive `Difficulty` negative and strip effects it never had.
        const recorded = (
            prop["TypeRecord"] as Record<string, unknown> | undefined
        )?.["typed"];
        let previousIdx =
            typeof recorded === "number"
                ? recorded
                : options.findIndex(
                      (o) => o.Name === (prop["Type"] as string | undefined),
                  );
        if (previousIdx < 0 || previousIdx >= options.length) {
            previousIdx = -1;
        }
        const previousOption =
            previousIdx === -1 ? undefined : options[previousIdx];

        const baselineKeys = new Set(
            Object.keys(this.extendedDef.BaselineProperty ?? {}),
        );

        const previousProperty = previousOption?.Property as
            Record<string, unknown> | undefined;
        if (previousProperty) {
            for (const [key, value] of Object.entries(previousProperty)) {
                if (key === "TypeRecord") continue;
                if (baselineKeys.has(key)) continue;
                this.differenceProperty(prop, key, value);
            }
        }

        const nextProperty = newOption?.Property as
            Record<string, unknown> | undefined;
        if (nextProperty) {
            for (const [key, value] of Object.entries(nextProperty)) {
                if (key === "TypeRecord") continue;
                this.unionProperty(prop, key, value);
            }
        }

        prop["TypeRecord"] = {
            ...((prop["TypeRecord"] as Record<string, unknown>) ?? {}),
            typed: newOptionIdx,
        };

        // A locked item must keep the Lock effect; the client re-adds it after
        // swapping properties for the same reason.
        if (
            prop["LockedBy"] &&
            Array.isArray(prop["Effect"]) &&
            !(prop["Effect"] as unknown[]).includes("Lock")
        ) {
            (prop["Effect"] as unknown[]).push("Lock");
        }
    }

    /**
     * Remove one property the previous option contributed, mirroring the
     * client's `PropertyDifference`: numeric `Difficulty`/`HeightModifier` are
     * subtracted rather than deleted, array entries present in the previous
     * option are filtered out (and the key dropped once empty), everything else
     * is deleted outright.
     */
    private differenceProperty(
        prop: Record<string, unknown>,
        key: string,
        value: unknown,
    ): void {
        if (key === "Difficulty" || key === "HeightModifier") {
            const current =
                typeof prop[key] === "number" ? (prop[key] as number) : 0;
            const delta = typeof value === "number" ? value : 0;
            prop[key] = current - delta;
            return;
        }

        if (key === "Tint" && Array.isArray(value)) {
            const current = Array.isArray(prop[key])
                ? (prop[key] as unknown[])
                : [];
            prop[key] = current.filter(
                (i) => !value.some((v) => this.deepEqual(i, v)),
            );
            if ((prop[key] as unknown[]).length === 0) delete prop[key];
            return;
        }

        if (Array.isArray(value)) {
            if (Array.isArray(prop[key])) {
                const current = prop[key] as unknown[];
                const kept = current.filter((i) => !value.includes(i));
                if (kept.length > 0) {
                    prop[key] = kept;
                    return;
                }
            }
            delete prop[key];
            return;
        }

        delete prop[key];
    }

    /**
     * Add one property the newly selected option contributes, mirroring the
     * client's `PropertyUnion`: numeric `Difficulty`/`HeightModifier` are
     * summed, arrays are unioned without duplicates, everything else is
     * assigned.
     */
    private unionProperty(
        prop: Record<string, unknown>,
        key: string,
        value: unknown,
    ): void {
        if (key === "Difficulty" || key === "HeightModifier") {
            const current =
                typeof prop[key] === "number" ? (prop[key] as number) : 0;
            const delta = typeof value === "number" ? value : 0;
            prop[key] = current + delta;
            return;
        }

        if (key === "Tint" && Array.isArray(value)) {
            const current = Array.isArray(prop[key])
                ? (prop[key] as unknown[])
                : [];
            prop[key] = [
                ...current,
                ...value.filter(
                    (v) => !current.some((c) => this.deepEqual(c, v)),
                ),
            ];
            return;
        }

        if (Array.isArray(value)) {
            const current = Array.isArray(prop[key])
                ? (prop[key] as unknown[])
                : [];
            prop[key] = [
                ...current,
                ...value.filter((i) => !current.includes(i)),
            ];
            return;
        }

        prop[key] = value;
    }

    /**
     * Structural comparison, used for `Tint` entries (objects), matching the
     * client's `CommonObjectEqual`.
     */
    private deepEqual(a: unknown, b: unknown): boolean {
        if (a === b) return true;
        if (
            a &&
            b &&
            typeof a === "object" &&
            typeof b === "object" &&
            !Array.isArray(a) &&
            !Array.isArray(b)
        ) {
            return JSON.stringify(a) === JSON.stringify(b);
        }
        return false;
    }

    private fixupAllowActivePose(): void {
        this.item.Property ??= {};
        if (this.item.Property.SetPose) {
            // AllowActivePos is sometimes specified explictly and sometimes not, coming from SetPose.
            // Either way, extra ones need to be added implicitly - see AssetParsePosePrerequisite in BC
            // Unfortunately if you don't get it right, BC's validator will reject the whole change.
            const allowActivePoseSet = new Set<AssetPoseName>();
            if (this.item.Property.AllowActivePose) {
                for (const pose of this.item.Property.AllowActivePose) {
                    allowActivePoseSet.add(pose);
                }
            }
            if (this.item.Property.SetPose) {
                for (const pose of this.item.Property.SetPose) {
                    allowActivePoseSet.add(pose);
                }
            }
            if (this.item.Property.AllowActivePose) {
                for (const pose of this.item.Property.AllowActivePose) {
                    allowActivePoseSet.add(pose);
                }
            }
            const poseCategories = getPoseCategories(allowActivePoseSet);

            if (
                (poseCategories.has("BodyLower") ||
                    poseCategories.has("BodyUpper")) &&
                (!poseCategories.has("BodyUpper") ||
                    allowActivePoseSet.has("BackElbowTouch")) &&
                (!poseCategories.has("BodyLower") ||
                    allowActivePoseSet.has("Kneel"))
            ) {
                allowActivePoseSet.add("Hogtied");
            }

            if (
                !poseCategories.has("BodyUpper") &&
                poseCategories.has("BodyLower") &&
                allowActivePoseSet.has("Kneel")
            ) {
                allowActivePoseSet.add("AllFours");
            }

            this.item.Property.AllowActivePose = Array.from(allowActivePoseSet);
        }
    }
}

export function AssetGet(
    groupName: AssetGroupName,
    assetName: string,
): BC_AppearanceItem {
    return {
        Group: groupName,
        Name: assetName,
    };
}

export function getAssetDef(desc: BC_AppearanceItem): AssetDefinition | null {
    const grp = AssetFemale3DCG.find((g) => g.Group === desc.Group);
    if (!grp) {
        // We could add support for the echo slots, but until then, don't spam about them
        if (!desc.Group.includes("Luzi") && !desc.Group.includes("外观"))
            console.warn("Invalid item group: " + desc.Group);
        return null;
    }

    const assetDef = grp.Asset.find(
        (a) => typeof a !== "string" && a.Name === desc.Name,
    );

    // FIXME: those are the simple string; they'd need to be expanded
    if (typeof assetDef === "string" || assetDef === undefined) return null;

    return assetDef;
}

export function getExtendedAssetDef(
    desc: BC_AppearanceItem,
): AssetArchetypeConfig | null {
    const grp = AssetFemale3DCGExtended[desc.Group];
    if (!grp) {
        console.warn("Invalid item group: " + desc.Group);
        return null;
    }

    return grp[desc.Name];
}

function makeAssetType(desc: BC_AppearanceItem) {
    return new AssetType(getAssetDef(desc) as unknown as Asset);
}
