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

import { API_Character, AssetGet, BC_AppearanceItem } from "bc-bot";
import { generatePassword } from "../../utils";
import { PET_EARS } from "../petspa";

export interface Forfeit {
    name: string;
    value: number;
    items: (player: API_Character) => BC_AppearanceItem[];
    lock?: BC_AppearanceItem;
    lockTimeMs?: number;
    colourLayers?: number[];
    applyItems?: (char: API_Character, lockMemberNumber: number, color) => void;
}

export const FORFEITS: Record<string, Forfeit> = {
    boots: {
        name: "Boots",
        value: 15,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        items: () => [AssetGet("ItemBoots", "BalletHeels")],
    },
    legbinder: {
        name: "Leg binder",
        value: 17,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        colourLayers: [0],
        items: () => [AssetGet("ItemLegs", "ShinyLegBinder")],
    },
    frogtie: {
        name: "Frogtie straps",
        value: 21,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        items: () => [AssetGet("ItemLegs", "FrogtieStraps")],
    },
    gag: {
        name: "Gag",
        value: 25,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        colourLayers: [0],
        items: () => {
            const gag = AssetGet("ItemMouth", "HarnessBallGag");
            gag.Property = { TypeRecord: { typed: 2 } };
            return [gag];
        },
    },
    blindfold: {
        name: "Blindfold",
        value: 25,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        items: () => [AssetGet("ItemHead", "LatexBlindfold")],
    },
    mittens: {
        name: "Mittens",
        value: 18,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        colourLayers: [0],
        items: () => {
            const mittens = AssetGet("ItemHands", "LatexBondageMitts");
            mittens.Property = { TypeRecord: { t: 1, w: 1, r: 0, l: 0 } };
            return [mittens];
        },
    },
    paws: {
        name: "Paws",
        value: 18,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        colourLayers: [0],
        items: () => {
            const mittens = AssetGet("ItemHands", "ElbowLengthMittens");
            mittens.Property = { TypeRecord: { typed: 0 } };
            return [mittens];
        },
    },
    armbinder: {
        name: "Armbinder",
        value: 24,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        items: () => [AssetGet("ItemArms", "LeatherArmbinder")],
    },
    yoke: {
        name: "Yoke",
        value: 24,
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        items: () => [AssetGet("ItemArms", "Yoke")],
    },
    cage: {
        name: "Cage",
        value: 60,
        items: () => {
            const cage = AssetGet("ItemDevices", "Kennel");
            cage.Property = { TypeRecord: { d: 1, p: 1 } };
            return [cage];
        },
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        applyItems: (character: API_Character, lockMemberNumber: number) => {
            //TODO CAGE COLOR?
            const cage = character.Appearance.AddItem(
                AssetGet("ItemDevices", "Kennel"),
            );
            cage.setProperty("TypeRecord", { d: 1, p: 1 });
            cage.SetDifficulty(20);
            cage.lock("TimerPasswordPadlock", lockMemberNumber, {
                Password: generatePassword(),
                Hint: "Better luck next time!",
                RemoveItem: true,
                RemoveTimer: Date.now() + FORFEITS.cage.lockTimeMs,
                ShowTimer: true,
                LockSet: true,
            });
        },
    },
    pet: {
        name: "Pet",
        value: 28,
        items: () => [AssetGet("ItemArms", "ShinyPetSuit")],
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        applyItems: makePet.bind(null, 0),
    },
    /*pet1hour: {
        name: "Pet: 1 hour",
        value: 15,
        items: () => [AssetGet("ItemArms", "ShinyPetSuit")],
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 1 * 60 * 60 * 1000,
        applyItems: makePet.bind(null, 1),
    },
    pet2hours: {
        name: "Pet: 2 hours",
        value: 20,
        items: () => [AssetGet("ItemArms", "ShinyPetSuit")],
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 2 * 60 * 60 * 1000,
        applyItems: makePet.bind(null, 2),
    },
    pet3hours: {
        name: "Pet: 3 hours",
        value: 25,
        items: () => [AssetGet("ItemArms", "ShinyPetSuit")],
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 3 * 60 * 60 * 1000,
        applyItems: makePet.bind(null, 3),
    },
    pet4hours: {
        name: "Pet: 4 hours",
        value: 30,
        items: () => [AssetGet("ItemArms", "ShinyPetSuit")],
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 4 * 60 * 60 * 1000,
        applyItems: makePet.bind(null, 4),
    },*/
    chastity: {
        name: "Chastity",
        value: 18,
        items: (sender) => {
            if (!sender || !sender.Appearance) {
                return [AssetGet("ItemPelvis", "ModularChastityBelt")];
            }
            const item = sender.Appearance.InventoryGet("Pussy");
            if (item.Name == "Penis") {
                return [AssetGet("ItemVulva", "PlasticChastityCage2")];
            } else {
                return [AssetGet("ItemPelvis", "ModularChastityBelt")];
            }
        },
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
        applyItems: makeChaste.bind(null),
    },
    upperpetsuit: {
        name: "Upper Pet Suit",
        colourLayers: [0],
        value: 24,
        items: () => [AssetGet("ItemArms", "PawPaddedPetsuitArms")],
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
    },
    lowerpetsuit: {
        name: "Lower Pet Suit",
        colourLayers: [0],
        value: 20,
        items: () => [AssetGet("ItemLegs", "PawPaddedPetsuitLegs")],
        lock: AssetGet("ItemLegs", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
    },
    /*
    hypnovisor: {
        name: "Hypnotic Visor",
        colourLayers: [2],
        value: 6,
        items: () => [AssetGet("ItemHead", "HypnoticVisor")],
        lock: AssetGet("ItemMisc", "TimerPasswordPadlock"),
        lockTimeMs: 20 * 60 * 1000,
    }*/
};

interface Service {
    name: string;
    description: string;
    value?: number;
    priceString?: string;
    commandExample?: string;
    offeringPlayer?: number;
}

// TODO buy outfits?

export const SERVICES: Record<string, Service> = {
    cocktail: {
        name: "House Special Cocktail",
        description:
            "Hand crafted by our expert mixologist. Please drink responsibly.",
        value: 10,
    },
    player: {
        name: "Buy a caged player",
        description: "Why waste their misfortune?",
        value: Math.ceil(FORFEITS["cage"].value * 2.5),
        commandExample: "/bot buy player <name or member number>",
    },
    restraint: {
        name: "Buy the code to a restriant of a player",
        description: "Guaranteed to be the correct code - usually.",
        priceString: "3x the restraint value",
        commandExample:
            "/bot buy restraint <name or member number> <forfeit name>",
    },
    lap: {
        name: "Sit in Lilly's lap",
        description: "Enjoy sitting in Lilly's lap for an hour.",
        value: 20000,
        offeringPlayer: 35982,
    },
    kittylilly: {
        name: "Kitty Lilly",
        description:
            "Let Lilly wear both a pair of cat ears and a tail for an hour.",
        value: 15000,
        offeringPlayer: 35982,
    },
    /* sessionlilly: {
        name: "Session with Lilly",
        description:
            "Some time with Lilly in private. Wanna be a cute little pet? Or perhaps an owner for once?~",
        value: 696900000000,
    }, */
    outfitlisa: {
        name: "Outfit from Lisa",
        description:
            "Let Lisa (201046) make an outfit just for you~ (Be aware that Lisa is quite busy these days and therefore hardly around)",
        value: 500,
        offeringPlayer: 201046,
    },
    /*"massage": {
        name: "Pixie Massage",
        description: "Let Miss Ellie melt away those tensions with a soothing massage.",
        value: 800,
    },
    "session": {
        name: "Session with Miss Ellie",
        description: "Something you'd like to try? Need to give up control? Name your kink and let Miss Ellie take you to the depths of your subby desires.",
        value: 1000,
    },
    "rent-a-pixie": {
        name: "Rent-a-pixie™️",
        description: "Ellie is at your service for up to 60 mins. Skills include bar work, pet walking and casino management.",
        value: 2000,
    },
    "modelling": {
        name: "Modelling",
        description: "Ellie will wear an outfit of your choice (clothes only) for a full 24 hours. No nudity!",
        value: 5000,
    },
    "pixiepet": {
        name: "Pixie Pet",
        description: "Your very own personal pet for 2 hours.",
        value: 10000,
    },*/
};

function makeChaste(
    character: API_Character,
    lockMemberNumber: number,
    color: BCColor,
): void {
    if (character.Appearance.InventoryGet("Pussy").Name == "Penis") {
        const chastityCage = character.Appearance.AddItem(
            AssetGet("ItemVulva", "PlasticChastityCage2"),
        );
        chastityCage.SetCraft({
            Name: `CC Casino Chastity Cage`,
            Description:
                `After betting and losing at the Cotton Candy Casino, ${character} has lost the privilege to orgasm. ` +
                `This chastity cage will ensure that the rule is followed.`,
        });
        chastityCage.SetColor(["Default", color, color, "#FFBC00"]);
        chastityCage.lock("TimerPasswordPadlock", lockMemberNumber, {
            Password: generatePassword(),
            Hint: "Better luck next time!",
            RemoveItem: true,
            RemoveTimer: Date.now() + FORFEITS.chastity.lockTimeMs,
            ShowTimer: true,
            LockSet: true,
        });
    } else {
        const chastityBelt = character.Appearance.AddItem(
            AssetGet("ItemPelvis", "ModularChastityBelt"),
        );
        chastityBelt.SetCraft({
            Name: `CC Casino Chastity Belt`,
            Description:
                `After betting and losing at the Cotton Candy Casino, ${character} has lost her privileges to orgasm. ` +
                `This chastity belt will ensure that she is kept chaste until her time is up.`,
        });
        chastityBelt.SetColor(color);
        chastityBelt.setProperty("TypeRecord", {
            a: 1,
            c: 1,
            i: 0,
            o: 0,
            p: 0,
            s: 0,
            v: 0,
        });
        chastityBelt.lock("TimerPasswordPadlock", lockMemberNumber, {
            Password: generatePassword(),
            Hint: "Better luck next time!",
            RemoveItem: true,
            RemoveTimer: Date.now() + FORFEITS.chastity.lockTimeMs,
            ShowTimer: true,
            LockSet: true,
        });
    }
}

function makePet(
    hours: number,
    character: API_Character,
    lockMemberNumber: number,
    color: BCColor,
): void {
    const petSuitItem = character.Appearance.AddItem(
        AssetGet("ItemArms", "ShinyPetSuit"),
    );
    petSuitItem.SetCraft({
        Name: `CC Casino Pet Suit`,
        Description:
            `A bold but unfortunate bet from ${character} means that they are now an official Cotton Candy Casino Pet, ` +
            `here to be adorable for all our patrons. Please enjoy their helplessness!`,
    });
    petSuitItem.SetColor(color);
    petSuitItem.Extended.SetType("Classic");
    petSuitItem.lock("TimerPasswordPadlock", lockMemberNumber, {
        Password: generatePassword(),
        Hint: "Better luck next time!",
        RemoveItem: true,
        RemoveTimer:
            Date.now() + (hours > 0 ? hours * 60 * 60 * 1000 : 20 * 60 * 1000),
        ShowTimer: true,
        LockSet: true,
    });

    if (!character.Appearance.InventoryGet("HairAccessory2")) {
        const ears = character.Appearance.AddItem(PET_EARS);
        ears.SetDifficulty(20);
        ears.SetColor(color);
    }

    if (!character.Appearance.InventoryGet("TailStraps")) {
        const tail = character.Appearance.AddItem(
            AssetGet("TailStraps", "PuppyTailStrap"),
        );
        tail.SetColor(color);
    }

    if (!character.Appearance.InventoryGet("ItemNeck")) {
        const collar = character.Appearance.AddItem(
            AssetGet("ItemNeck", "PetCollar"),
        );
        /*collar.lock("TimerPasswordPadlock", lockMemberNumber, {
            Password: generatePassword(),
            Hint: "Better luck next time!",
            RemoveItem: true,
            RemoveTimer: Date.now() + hours * 60 * 60 * 1000,
            ShowTimer: true,
            LockSet: true,
        });*/
        collar.SetCraft({
            Name: `CC Casino Pet Collar`,
            Description:
                `A bold but unfortunate bet from ${character} means that they are now an official Cotton Candy Casino Pet. ` +
                `This collar will remind them of their place until their time is up.`,
        });
    }
}

export function forfeitsString(): string {
    return Object.entries(FORFEITS)
        .map(([name, f]) => `${name}: ${f.value} chips`)
        .join("\n");
}

export function restraintsRemoveString(): string {
    return Object.entries(FORFEITS)
        .map(([name, forfeit]) => `${forfeit.name}: ${forfeit.value * 4} chips`)
        .join("\n");
}

function commandForService(name: string): string {
    if (SERVICES[name].commandExample) {
        return SERVICES[name].commandExample;
    }
    return `/bot buy ${name}`;
}

export function servicesString(): string {
    return Object.entries(SERVICES)
        .map(
            ([name, s]) =>
                `${s.name}: ${s.value ? s.value + " chips" : s.priceString}\n${s.description}\n${commandForService(name)}\n`,
        )
        .join("\n");
}
