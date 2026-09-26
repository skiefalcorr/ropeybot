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

import { Db } from "mongodb";
import {
    API_Connector,
    CommandParser,
    API_Character,
    ItemPermissionLevel,
    BC_Server_ChatRoomMessage,
    API_AppearanceItem,
    AssetGet,
    BC_AppearanceItem,
    importBundle,
    API_Message,
} from "bc-bot";
import { RouletteGame } from "./casino/roulette";
import { CasinoStore, Player } from "./casino/casinostore";
import { generatePassword, remainingTimeString } from "../utils";
import {
    Forfeit,
    FORFEITS,
    forfeitsString,
    restraintsRemoveString,
    SERVICES,
    servicesString,
} from "./casino/forfeits";
import { Cocktail, COCKTAILS } from "./casino/cocktails";
import { Bet, Game } from "./casino/game";
import { BlackjackGame } from "./casino/blackjack";
import { ThreeCardPokerGame } from "./casino/threeCardPoker";

const FREE_CHIPS = 20;
const VOTE_DURATION_MS = 60 * 1000;
const VOTE_COOLDOWN_MS = 5 * 60 * 1000;
type CasinoGameName = "roulette" | "blackjack" | "threecardpoker";

export function getItemsBlockingForfeit(
    char: API_Character,
    items: BC_AppearanceItem[],
): API_AppearanceItem[] {
    const slots = new Set(items.map((i) => i.Group));

    return char.Appearance.Appearance.filter((i) => slots.has(i.Group));
}

export function getSlotsNeededByForfeit(
    items: BC_AppearanceItem[],
): AssetGroupName[] {
    return items.map((i) => i.Group);
}

export const makeBio = (
    leaderBoard: string,
    exampleString: string,
    helpString: string,
) => `🎰🎰🎰 Welcome to the Casino! 🎰🎰🎰

All visitors will automatically ber awarded ${FREE_CHIPS} chips every day!
You can bet with either chips or forefeits. If you win when betting with a forfeit, you gain the corresponding
amount of chips in the forfeits table. If you lose, the forfeit is applied. You bet forfeits by
using the keyword in the table instead of a chip amount.

Examples:
${exampleString}

ℹ️ How To Play
==============
${helpString}
⛓️ Forfeit Table
================
Restraints are for 20 minutes, unless otherwise stated.

${forfeitsString()}

🛒 Shop
=======
Restraint removal: /bot remove <name> (eg. /bot remove gag):
${restraintsRemoveString()}

Other:
${servicesString()}

(All services are subject to limits of the people involved, obviously)

🏆 Leaderboard
==============
${leaderBoard}

🍀🍀🍀 Good luck! 🍀🍀🍀

This bot is made with ropeybot, fixes and improvements welcome!
https://github.com/LillyBlueHair/ropeybot
`;

export interface CasinoConfig {
    cocktail: string;
}

export class Casino {
    private game: Game;
    public commandParser: CommandParser;
    public store: CasinoStore;
    private cocktailOfTheDay: Cocktail | undefined;
    public multiplier = 1;
    public lockedItems: Map<number, Map<AssetGroupName, number>> = new Map();
    private activeVote:
        | {
              votes: Map<number, CasinoGameName>;
          }
        | undefined;
    private lastVoteAt = 0;

    public constructor(
        private conn: API_Connector,
        db: Db,
        config?: CasinoConfig,
    ) {
        this.store = new CasinoStore(db);
        this.commandParser = new CommandParser(conn);
        this.game = new BlackjackGame(conn, this);

        if (config?.cocktail) {
            this.cocktailOfTheDay = COCKTAILS[config.cocktail];
            if (this.cocktailOfTheDay === undefined) {
                throw new Error(`Unknown cocktail: ${config.cocktail}`);
            }
        }

        conn.on("CharacterEntered", this.onCharacterEntered);
        conn.on("Message", this.onMessage);
        conn.on("Beep", (msg) => this.onBeep(msg));

        this.commandParser.register("help", this.onCommandHelp);
        this.commandParser.register("forfeits", this.onCommandForfeits);
        this.commandParser.register("commands", this.onCommandCommands);
        this.commandParser.register("chips", this.onCommandChips);
        this.commandParser.register("addfriend", this.onCommandAddFriend);
        this.commandParser.register("remove", this.onCommandRemove);
        this.commandParser.register("buy", this.onCommandBuy);
        this.commandParser.register("vouchers", this.onCommandVouchers);
        this.commandParser.register("give", this.onCommandGive);
        this.commandParser.register(
            "checkforfeits",
            this.onCommandCheckForfeits,
        );
        this.commandParser.register("score", this.onCommandScore);
        this.commandParser.register("bonus", this.onCommandBonusRound);
        this.commandParser.register("game", this.onCommandGame);
        this.commandParser.register("vote", this.onCommandVote);
        this.commandParser.register("scoreboard", this.onCommandScoreboard);
        this.commandParser.register("color", this.onCommandColor);
        this.commandParser.register("refund", this.onCommandRefund);
        this.commandParser.register("getstrikes", this.onCommandGetStrikes);
        this.commandParser.register("resetstrikes", this.onCommandResetStrikes);
        this.commandParser.register(
            "markcompleted",
            this.onCommandMarkCompleted,
        );

        this.conn.setItemPermission(ItemPermissionLevel.OwnerLoverWhitelist);
    }

    private onMessage = (message: API_Message) => {
        if (
            message.message.Type === "Chat" &&
            message.message.Content.startsWith("!") &&
            message.message.Content.length > 1
        ) {
            this.conn.SendMessage(
                "Whisper",
                "Please either whisper me the command or use /bot to combat spam.",
                message.sender.MemberNumber,
            );
        }
    };

    private onCharacterEntered = async (character: API_Character) => {
        const player = await this.store.getPlayer(character.MemberNumber);
        player.name = character.toString();

        const nextFreeChipsAt = player.lastFreeCredits + 20 * 60 * 60 * 1000;
        if (nextFreeChipsAt < Date.now()) {
            player.credits += FREE_CHIPS;
            player.lastFreeCredits = Date.now();
            await this.store.savePlayer(player);
            character.Tell(
                "Whisper",
                `Welcome to the Casino, ${character}! Here are your ${FREE_CHIPS} free chips for today. See my bio for how to play. Good luck!`,
            );
        } else {
            character.Tell(
                "Whisper",
                `Welcome back, ${character}. ${remainingTimeString(nextFreeChipsAt)} until your next free chips. See my bio for how to play.`,
            );
        }
    };

    private onBeep = (beep: ServerAccountBeepResponse) => {
        if (
            typeof beep?.Message !== "string" ||
            beep.Message.includes("TypingStatus") ||
            beep.Message.includes("ReqRoom") ||
            beep.BeepType.includes("LCPlayerInfo")
        ) {
            return;
        }
        try {
            if (beep.Message?.startsWith("outfit add")) {
                const parts = beep.Message.split(" ");
                if (parts.length < 4) {
                    this.conn.AccountBeep(
                        beep.MemberNumber,
                        null,
                        "Usage: outfit add <name> <code>",
                    );
                    return;
                }
                const code = parts[parts.length - 1];
                const name = parts.slice(2, parts.length - 1).join(" ");

                try {
                    const outfit = importBundle(code);
                    this.store.saveOutfit({
                        name,
                        addedBy: beep.MemberNumber,
                        addedByName: beep.MemberName,
                        items: outfit,
                    });
                    this.conn.AccountBeep(
                        beep.MemberNumber,
                        null,
                        `Outfit ${name} added, thank you!`,
                    );
                } catch (e) {
                    this.conn.AccountBeep(
                        beep.MemberNumber,
                        null,
                        "Invalid outfit code",
                    );
                    return;
                }
            } else if (beep.Message?.startsWith("end game")) {
                if (!this.game) {
                    this.conn.AccountBeep(
                        beep.MemberNumber,
                        null,
                        "No game is currently running.",
                    );
                    return;
                }
                this.conn.AccountBeep(
                    beep.MemberNumber,
                    null,
                    "Ending game...",
                );
                this.conn.SendMessage(
                    "Chat",
                    `This is the last round, the game ends after.`,
                );
                this.game.endGame().then(() => {
                    this.conn.AccountBeep(
                        beep.MemberNumber,
                        null,
                        "Game ended.",
                    );
                    this.conn.SendMessage(
                        "Chat",
                        `The game has ended, thank you for playing!`,
                    );
                    this.commandParser.unregisterAll();
                });
            } else {
                console.log(
                    `Received beep: ${beep.Message} from ${beep.MemberName} (${beep.MemberNumber})`,
                );
                this.conn.AccountBeep(
                    beep.MemberNumber,
                    null,
                    "Unknown command",
                );
                // console.log(beep)
            }
        } catch (e) {
            console.error("Failed to process beep", e);
        }
    };

    private onCommandHelp = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        this.conn.SendMessage(
            "Whisper",
            this.game.HELPCOMMANDMESSAGE,
            sender.MemberNumber,
        );
    };

    private onCommandForfeits = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        let text = `Forfeit Table
Restraints are for 20 minutes, unless otherwise stated.

${forfeitsString()}
`;
        this.conn.SendMessage("Whisper", text, sender.MemberNumber);
    };

    private onCommandCommands = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        this.conn.SendMessage(
            "Whisper",
            this.game.COMMANDSMESSAGE,
            sender.MemberNumber,
        );
    };

    private onCommandChips = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (args.length > 0) {
            if (!sender.IsRoomAdmin()) {
                this.conn.reply(
                    msg,
                    "Only admins can see other people's balances.",
                );
                return;
            }

            const target = this.conn.chatRoom.findCharacter(args[0]);
            if (!target) {
                this.conn.reply(msg, "I can't find that person.");
                return;
            }
            const player = await this.store.getPlayer(target.MemberNumber);
            this.conn.reply(msg, `${target} has ${player.credits} chips.`);
        } else {
            const player = await this.store.getPlayer(sender.MemberNumber);
            this.conn.reply(
                msg,
                `${sender}, you have ${player.credits} chips${sender.MemberNumber === 78366 ? ` (${Math.floor(player.credits / (FORFEITS["cage"].value * 2.5))} Lillys)` : ""}.`,
            );
        }
    };

    public async setBio(): Promise<void> {
        const topPlayers = await this.store.getTopPlayers(50);
        const unredeemed = await this.store.getUnredeemedPurchases();

        this.conn.setBotDescription(
            makeBio(
                topPlayers
                    .map((player, idx) => {
                        return `${idx + 1}. ${player.name} (${player.memberNumber}): ${player.score} chips won`;
                    })
                    .join("\n"),
                this.game.EXAMPLES,
                this.game.HELPMESSAGE,
            ),
        );
    }

    private onCommandAddFriend = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (!sender.IsRoomAdmin()) {
            this.conn.reply(msg, "Sorry, you need to be an admin");
            return;
        }

        if (args.length < 1) {
            this.conn.reply(msg, "Please specify a member number.");
            return;
        }

        const toAdd = this.conn.chatRoom.findCharacter(args[0]);
        if (!toAdd) {
            this.conn.reply(msg, "I can't find that person");
            return;
        }

        toAdd.friend();

        this.conn.reply(msg, `I am now friends with ${toAdd}! I like friends!`);
    };

    private onCommandRemove = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (args.length < 1) {
            this.conn.reply(msg, "Usage: /bot remove <restraint>");
            return;
        }

        const restraintName = args[0].toLowerCase();
        const restraint = FORFEITS[restraintName];
        if (!restraint) {
            this.conn.reply(msg, "Unknown restraint.");
            return;
        }

        const player = await this.store.getPlayer(sender.MemberNumber);
        if (player.credits < restraint.value * 4) {
            this.conn.reply(msg, "You don't have enough chips.");
            return;
        }

        if (!sender.Appearance.InventoryGet(restraint.items(sender)[0].Group)) {
            this.conn.reply(
                msg,
                `It doesn't look like you're wearing ${restraint.name}.`,
            );
            return;
        }

        if (
            sender.Appearance.InventoryGet(
                restraint.items(sender)[0].Group,
            ).getData().Property.LockMemberNumber !==
            this.conn.Player.MemberNumber
        ) {
            this.conn.reply(
                msg,
                `You can only buy yourself out of my restraints, not others.`,
            );
            return;
        }

        const spent = await this.store.trySpendCredits(
            sender.MemberNumber,
            restraint.value * 4,
        );
        if (!spent) {
            this.conn.reply(msg, "You don't have enough chips.");
            return;
        }

        sender.Appearance.RemoveItem(restraint.items(sender)[0].Group);

        this.lockedItems
            .get(sender.MemberNumber)
            ?.delete(restraint.items(sender)[0].Group);

        this.conn.SendMessage(
            "Chat",
            `${sender} paid to remove their ${restraint.name}. Enjoy your freedom, while it lasts.`,
        );
    };

    private onCommandBuy = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (args.length < 1) {
            this.conn.reply(msg, "Usage: buy <service>");
            return;
        }

        const serviceName = args[0].toLowerCase();
        const service = SERVICES[serviceName];
        if (service === undefined) {
            this.conn.reply(msg, "Unknown service.");
            return;
        }

        let target: API_Character | undefined;
        let forfeit: Forfeit | undefined;
        if (serviceName === "player") {
            if (args.length < 2) {
                this.conn.reply(
                    msg,
                    "Usage: buy player <name or member number>",
                );
                return;
            }
            target = this.conn.chatRoom.findCharacter(args[1]);
            if (!target) {
                this.conn.reply(msg, "I can't find that person.");
                return;
            }

            if (target.MemberNumber === sender.MemberNumber) {
                this.conn.reply(msg, "You can't buy yourself.");
                return;
            }

            if (
                target.Appearance.InventoryGet("ItemDevices")?.Name !== "Kennel"
            ) {
                this.conn.reply(
                    msg,
                    "Sorry, that player is not for sale (yet...)",
                );
                return;
            }

            if (
                target.Appearance.InventoryGet("ItemDevices")?.getData()
                    .Property.LockMemberNumber !== this.conn.Player.MemberNumber
            ) {
                this.conn.reply(
                    msg,
                    "Sorry, that player is not for sale by me",
                );
                return;
            }
        }

        if (serviceName === "restraint") {
            if (args.length < 3) {
                this.conn.reply(
                    msg,
                    "Usage: buy restraint <name or member number> <name of the forfeit>",
                );
                return;
            }
            target = this.conn.chatRoom.findCharacter(args[1]);
            forfeit = FORFEITS[args[2]];
            if (!target) {
                this.conn.reply(msg, "I can't find that person.");
                return;
            }
            if (!forfeit) {
                this.conn.reply(msg, "I can't find that forfeit.");
                return;
            }

            if (forfeit.name === "Cage") {
                this.conn.reply(
                    msg,
                    "To buy cages please use 'buy player' instead",
                );
                return;
            }

            if (target.MemberNumber === sender.MemberNumber) {
                this.conn.reply(msg, "You can't buy your own codes.");
                return;
            }

            if (
                !target.Appearance.InventoryGet(forfeit.items(target)[0].Group)
            ) {
                this.conn.reply(
                    msg,
                    `It doesn't look like that player is wearing ${forfeit.name}.`,
                );
                return;
            }

            if (
                target.Appearance.InventoryGet(
                    forfeit.items(target)[0].Group,
                ).getData().Property.LockMemberNumber !==
                this.conn.Player.MemberNumber
            ) {
                this.conn.reply(
                    msg,
                    `You can only buy codes of my restraints, not others.`,
                );
                return;
            }
        }

        if (serviceName === "bonus") {
            if (this.multiplier != 1) {
                this.conn.reply(msg, "There is already a bonus round active.");
                return;
            }

            if (this.game.getBets().length > 0) {
                this.conn.reply(msg, "There are already bets placed.");
                return;
            }
        }

        const player = await this.store.getPlayer(sender.MemberNumber);
        let serviceValue = service.value;
        if (!serviceValue) {
            if (serviceName === "restraint") {
                serviceValue = forfeit.value * 3;
            }
        }
        if (player.credits < serviceValue) {
            this.conn.reply(msg, "You don't have enough chips.");
            return;
        }

        const spent = await this.store.trySpendCredits(
            sender.MemberNumber,
            serviceValue,
        );
        if (!spent) {
            this.conn.reply(msg, "You don't have enough chips.");
            return;
        }

        if (serviceName === "player") {
            target.Appearance.RemoveItem("ItemDevices");
            if (!target.Appearance.InventoryGet("ItemNeck")) {
                const collar = target.Appearance.AddItem(
                    AssetGet("ItemNeck", "LeatherChoker"),
                );
                collar.SetCraft({
                    Name: `${sender}'s Sub`,
                    Description: `Bought after an unfortunate bet, ${target}'s freedom now belongs to ${sender}.`,
                });
            }
            target.Appearance.AddItem(
                AssetGet("ItemNeckRestraints", "CollarLeash"),
            );
            const sign = target.Appearance.AddItem(
                AssetGet("ItemMisc", "WoodenSign"),
            );
            sign.setProperty("Text", "Property of");
            sign.setProperty("Text2", sender.toString());

            this.lockedItems.get(target.MemberNumber)?.delete("ItemDevices");

            this.conn.SendMessage(
                "Chat",
                `${sender} has bought ${target} and is now the proud owner of an unfortunate gambler.`,
            );
        } else if (serviceName === "restraint") {
            this.conn.SendMessage(
                "Chat",
                `${sender} has bought the codes to ${target}'s ${forfeit.name}.`,
            );
            this.conn.SendMessage(
                "Whisper",
                `The code to ${forfeit.name} on ${target} is: ${target.Appearance.InventoryGet(forfeit.items(target)[0].Group).getData().Property.Password}.`,
                sender.MemberNumber,
            );
            this.lockedItems
                .get(target.MemberNumber)
                ?.delete(forfeit.items(sender)[0].Group);
        } else if (serviceName === "cocktail") {
            const keys = Object.keys(COCKTAILS);
            const randomKey = keys[Math.floor(Math.random() * keys.length)];
            const cocktail = this.cocktailOfTheDay ?? COCKTAILS[randomKey];

            const cocktailItem = sender.Appearance.AddItem(
                AssetGet("ItemHandheld", "GlassFilled"),
            );
            cocktailItem.SetColor(cocktail.colour);
            cocktailItem.SetCraft({
                Name: cocktail.name,
                Description: cocktail.description,
                MemberName: this.conn.Player.toString(),
                MemberNumber: this.conn.Player.MemberNumber,
            });

            this.conn.SendMessage(
                "Chat",
                `Please enjoy your cocktail, ${sender}.`,
            );
        } else if (serviceName === "bonus") {
            this.multiplier = 2;
            this.conn.SendMessage(
                "Chat",
                `${sender} has bought a ⭐️⭐️⭐️ Bonus round! ⭐️⭐️⭐️ All forfeit bets are worth ${this.multiplier}x their normal value!`,
            );
        } else {
            await this.store.addPurchase({
                memberNumber: sender.MemberNumber,
                memberName: sender.toString(),
                time: Date.now(),
                service: serviceName,
                redeemed: false,
                refunded: false,
            });

            this.conn.SendMessage(
                "Chat",
                `${sender} has bought a voucher for ${service.name}! Please contact ${service.offeringPlayer ? `Player with Member Number ${service.offeringPlayer}` : "Lilly"} to redeem your service.`,
            );
        }
    };

    private onCommandMarkCompleted = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (
            !sender.IsRoomAdmin() &&
            !Object.values(SERVICES).some(
                (s) => s.offeringPlayer === sender.MemberNumber,
            )
        ) {
            this.conn.reply(
                msg,
                "Sorry, you need to be an admin or offer a service",
            );
            return;
        }

        if (args.length < 1) {
            this.conn.reply(
                msg,
                "Please add the number of whichever Voucher you want to mark as completed",
            );
            return;
        }
        if (!args[0].match(/^[0-9]+$/)) {
            this.conn.reply(
                msg,
                "Please add the number of whichever Voucher you want to mark as completed",
            );
            return;
        }

        let index: number = parseInt(args[0]);
        let purchases = await this.store.getUnredeemedPurchases();
        if (!sender.IsRoomAdmin())
            purchases = purchases.filter(
                (p) =>
                    SERVICES[p.service] &&
                    SERVICES[p.service].offeringPlayer &&
                    SERVICES[p.service].offeringPlayer === sender.MemberNumber,
            );

        if (purchases.length === 0) {
            this.conn.reply(msg, "No vouchers outstanding");
            return;
        } else if (purchases.length < index || index < 1) {
            this.conn.reply(
                msg,
                "The voucher you want to mark as completed does not exist",
            );
            return;
        }

        let purchase = purchases[index - 1];
        await this.store.savePurchace({
            memberNumber: purchase.memberNumber,
            memberName: purchase.memberName,
            time: purchase.time,
            service: purchase.service,
            redeemed: true,
            refunded: false,
        });
        if (SERVICES[purchase.service].offeringPlayer) {
            let offeringPlayer = await this.store.getPlayer(
                SERVICES[purchase.service].offeringPlayer,
            );
            offeringPlayer.credits += SERVICES[purchase.service].value;
            await this.store.savePlayer(offeringPlayer);
            this.conn.reply(
                msg,
                `The voucher for ${SERVICES[purchase.service].name} has been marked as completed! The offering Player has been given the coins.`,
            );
        } else {
            this.conn.reply(
                msg,
                `${purchase.memberName}'s service has been marked as completed!`,
            );
        }
    };

    private onCommandGetStrikes = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (!sender.IsRoomAdmin()) {
            this.conn.reply(msg, "Sorry, you need to be an admin");
            return;
        }

        if (args.length < 1) {
            this.conn.reply(
                msg,
                "Please add the name/number of the player whose strikes you want to see",
            );
            return;
        }
        const target = this.conn.chatRoom.findCharacter(args[0]);
        if (!target) {
            this.conn.reply(
                msg,
                "I can't find that person. (They need to be in the room)",
            );
            return;
        }

        const player = await this.store.getPlayer(target.MemberNumber);
        this.conn.reply(
            msg,
            `${target} (${target.MemberNumber}) has ${player.cheatStrikes} strikes`,
        );
    };

    private onCommandResetStrikes = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (!sender.IsRoomAdmin()) {
            this.conn.reply(msg, "Sorry, you need to be an admin");
            return;
        }

        if (args.length < 1) {
            this.conn.reply(
                msg,
                "Please add the name/number of the player whose strikes you want to reset",
            );
            return;
        }
        const target = this.conn.chatRoom.findCharacter(args[0]);
        if (!target) {
            this.conn.reply(
                msg,
                "I can't find that person. (They need to be in the room)",
            );
            return;
        }

        let strikes = 0;
        if (args.length == 2 && args[1]) {
            strikes = Number.parseInt(args[1]);
            if (isNaN(strikes)) {
                this.conn.reply(msg, "Invalid amount of strikes.");
                return;
            }
        }

        const player = await this.store.getPlayer(target.MemberNumber);
        player.cheatStrikes = strikes;

        await this.store.savePlayer(player);
        this.conn.reply(
            msg,
            `Successfully reset ${target} (${target.MemberNumber}) strikes to ${strikes}`,
        );
    };

    private onCommandRefund = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (
            !sender.IsRoomAdmin() &&
            !Object.values(SERVICES).some(
                (s) => s.offeringPlayer === sender.MemberNumber,
            )
        ) {
            this.conn.reply(
                msg,
                "Sorry, you need to be an admin or offer a service",
            );
            return;
        }

        if (args.length < 1) {
            this.conn.reply(
                msg,
                "Please add the number of whichever Voucher you want to refund",
            );
            return;
        }
        if (!args[0].match(/^[0-9]+$/)) {
            this.conn.reply(
                msg,
                "Please add the number of whichever Voucher you want to refund",
            );
            return;
        }

        let index: number = parseInt(args[0]);
        let purchases = await this.store.getUnredeemedPurchases();
        if (!sender.IsRoomAdmin())
            purchases = purchases.filter(
                (p) =>
                    SERVICES[p.service] &&
                    SERVICES[p.service].offeringPlayer &&
                    SERVICES[p.service].offeringPlayer === sender.MemberNumber,
            );

        if (purchases.length === 0) {
            this.conn.reply(msg, "No vouchers outstanding");
            return;
        } else if (purchases.length < index || index < 1) {
            this.conn.reply(
                msg,
                "The voucher you want to refund does not exist",
            );
            return;
        }

        let purchase = purchases[index - 1];
        let player = await this.store.getPlayer(purchase.memberNumber);
        await this.store.savePurchace({
            memberNumber: purchase.memberNumber,
            memberName: purchase.memberName,
            time: purchase.time,
            service: purchase.service,
            redeemed: false,
            refunded: true,
        });
        player.credits += SERVICES[purchase.service].value;
        await this.store.savePlayer(player);
        this.conn.SendMessage(
            "Chat",
            `${purchase.memberName} has been refunded their voucher for ${SERVICES[purchase.service].name}`,
        );
    };

    private onCommandVouchers = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (
            !sender.IsRoomAdmin() &&
            !Object.values(SERVICES).some(
                (s) => s.offeringPlayer === sender.MemberNumber,
            )
        ) {
            this.conn.reply(
                msg,
                "Sorry, you need to be an admin or offer a service",
            );
            return;
        }

        let purchases = await this.store.getUnredeemedPurchases();
        if (!sender.IsRoomAdmin())
            purchases = purchases.filter(
                (p) =>
                    SERVICES[p.service] &&
                    SERVICES[p.service].offeringPlayer &&
                    SERVICES[p.service].offeringPlayer === sender.MemberNumber,
            );
        if (purchases.length === 0) {
            this.conn.reply(msg, "No vouchers outstanding");
            return;
        }
        let index: number = 1;
        this.conn.reply(
            msg,
            purchases
                .map((p) => {
                    if (SERVICES[p.service] === undefined) {
                        return `(${index++}) ${p.memberName} (${p.memberNumber}): Unknown service ${p.service}`;
                    }
                    return `(${index++}) ${p.memberName} (${p.memberNumber}): ${SERVICES[p.service].name}`;
                })
                .join("\n"),
        );
    };

    private onCommandGive = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (args.length < 2) {
            this.conn.reply(
                msg,
                "Usage: give <name or member number> <amount>",
            );
            return;
        }

        const amount = parseInt(args[1], 10);
        if (isNaN(amount) || amount < 1) {
            this.conn.reply(msg, "Invalid amount.");
            return;
        }

        const target = this.conn.chatRoom.findCharacter(args[0]);
        if (!target) {
            this.conn.reply(msg, "I can't find that person.");
            return;
        }
        if (target.MemberNumber === sender.MemberNumber) {
            this.conn.reply(msg, "You can't give yourself chips.");
            return;
        }

        const sourcePlayer = await this.store.getPlayer(sender.MemberNumber);
        if (sourcePlayer.credits < amount) {
            this.conn.reply(msg, "You don't have enough chips.");
            return;
        }

        const targetPlayer = await this.store.getPlayer(target.MemberNumber);

        const spent = await this.store.trySpendCredits(
            sender.MemberNumber,
            amount,
        );
        if (!spent) {
            this.conn.reply(msg, "You don't have enough chips.");
            return;
        }
        targetPlayer.credits += amount;
        await this.store.savePlayer(targetPlayer);

        this.conn.SendMessage(
            "Chat",
            `${sender} gave ${amount} chips to ${target}`,
        );
    };

    private onCommandScore = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (args.length > 0) {
            if (!sender.IsRoomAdmin()) {
                this.conn.reply(
                    msg,
                    "Only admins can see other people's scores.",
                );
                return;
            }

            const target = this.conn.chatRoom.findCharacter(args[0]);
            if (!target) {
                this.conn.reply(msg, "I can't find that person.");
                return;
            }
            const player = await this.store.getPlayer(target.MemberNumber);
            this.conn.reply(msg, `${target} has a score of ${player.score}.`);
        } else {
            const player = await this.store.getPlayer(sender.MemberNumber);
            this.conn.reply(
                msg,
                `${sender}, you have a score of ${player.score}.`,
            );
        }
    };

    private onCommandCheckForfeits = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        let message = "";
        this.lockedItems.get(sender.MemberNumber)?.forEach((expiry, group) => {
            const item = sender.Appearance.InventoryGet(group);
            if (expiry < Date.now()) {
                this.lockedItems.get(sender.MemberNumber)?.delete(group);
                return;
            } else if (item) {
                message += `${item.Name} (${group}): ${remainingTimeString(expiry)} remaining\n`;
            } else {
                message += `${group} (no item found): ${remainingTimeString(expiry)} remaining\n`;
            }
        });
        this.conn.reply(msg, message || "You have no active forfeits.");
    };

    private onCommandBonusRound = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (!sender.IsRoomAdmin()) {
            this.conn.reply(msg, "Sorry, you need to be an admin");
            return;
        }

        if (this.game.getBets().length > 0) {
            this.conn.reply(msg, "There are already bets placed.");
            return;
        }

        if (args.length > 0) {
            const multiplier = parseInt(args[0], 10);
            if (isNaN(multiplier) || multiplier < 1) {
                this.conn.reply(msg, "Invalid multiplier.");
                return;
            }
            this.multiplier = multiplier;
        } else {
            this.multiplier = 2;
        }

        this.conn.SendMessage(
            "Chat",
            `⭐️⭐️⭐️ Bonus round! ⭐️⭐️⭐️ All forfeit bets are worth ${this.multiplier}x their normal value!`,
        );
    };

    public getSign(): API_AppearanceItem {
        let sign = this.conn.Player.Appearance.InventoryGet("ItemMisc");
        if (!sign) {
            sign = this.conn.Player.Appearance.AddItem(
                AssetGet("ItemMisc", "WoodenSign"),
            );
            sign.setProperty("Text", "");
            sign.setProperty("Text2", "");
        }
        return sign;
    }

    public setSignColor(colors: [BCColor, BCColor, BCColor]): void {
        this.getSign().SetColor(colors);
    }

    public setTextColor(color: string): void {
        let colors = this.getSign().GetColor();
        if (Array.isArray(colors)) {
            colors = [...colors];
        } else {
            colors = [colors, "Default", "Default"];
        }
        colors[colors.length - 1] = color as BCColor;
        this.getSign().SetColor(colors);
    }

    public async applyForfeit(
        bet: Bet,
        timeMultiplayer: number = 1,
    ): Promise<void> {
        const char = this.conn.chatRoom.findMember(bet.memberNumber);
        const applyFn = FORFEITS[bet.stakeForfeit].applyItems;
        const items = FORFEITS[bet.stakeForfeit].items(char);
        const colourLayers = FORFEITS[bet.stakeForfeit].colourLayers;
        let color = char?.Appearance?.InventoryGet("HairFront")?.GetColor();
        if (!color) color = "Default";
        if (Array.isArray(color)) color = color[0] as BCColor;
        else color = color as BCColor;

        let storeColor = await this.store.getPlayer(bet.memberNumber);
        if (storeColor.color !== "default" && storeColor.color)
            color = storeColor.color as BCColor;

        if (items.length === 1) {
            const lockTime =
                FORFEITS[bet.stakeForfeit].lockTimeMs * timeMultiplayer;
            if (lockTime) {
                this.lockedItems.set(
                    bet.memberNumber,
                    this.lockedItems.get(bet.memberNumber) ?? new Map(),
                );
                this.lockedItems
                    .get(bet.memberNumber)
                    ?.set(items[0].Group, Date.now() + lockTime);
            }
        }

        if (!char) return;

        if (applyFn) {
            applyFn(char, this.conn.Player.MemberNumber, color);
        } else if (items.length === 1) {
            const added = char.Appearance.AddItem(items[0]);
            try {
                let colors: BCColor[] = [];
                if (colourLayers) {
                    for (let i = 0; i <= Math.max(...colourLayers); i++) {
                        if (colourLayers.includes(i)) {
                            colors.push(color);
                        } else {
                            colors.push("Default");
                        }
                    }
                    added.SetColor(colors);
                } else {
                    added.SetColor(color);
                }
            } catch (e) {
                console.error(
                    `Failed to set color for item ${items[0].Name} on character ${char.MemberNumber}`,
                    e,
                );
                // Fallback to default color if setting color fails
                added.SetColor(color);
            }

            added.SetDifficulty(20);
            added.SetCraft({
                Name: `CC Casino ${FORFEITS[bet.stakeForfeit].name}`,
                Description:
                    "This item is property of Cotton Candy Casino. Better luck next time!",
                MemberName: this.conn.Player.toString(),
                MemberNumber: this.conn.Player.MemberNumber,
            });
            if (FORFEITS[bet.stakeForfeit].lockTimeMs) {
                console.log(
                    `Locking item ${added.Name} for ${FORFEITS[bet.stakeForfeit].lockTimeMs * timeMultiplayer}ms`,
                );
                added.lock(
                    "TimerPasswordPadlock",
                    this.conn.Player.MemberNumber,
                    {
                        Password: generatePassword(),
                        Hint: "Better luck next time!",
                        RemoveItem: true,
                        RemoveTimer:
                            Date.now() +
                            FORFEITS[bet.stakeForfeit].lockTimeMs *
                                timeMultiplayer,
                        ShowTimer: true,
                        LockSet: true,
                    },
                );
            } else {
                console.log(
                    `Not locking item ${added.Name} as no lock time is set`,
                );
            }
        } else {
            char.Appearance.slowlyApplyBundle(items);
        }
    }

    public cheatPunishment(char: API_Character, player: Player): void {
        if (player.cheatStrikes === 1) {
            char.Tell(
                "Whisper",
                "Cheating in the casino, hmm? Check your active forfeits with /bot checkforfeits.",
            );
        } else if (player.cheatStrikes === 2) {
            char.Tell(
                "Whisper",
                `Still trying to cheat, ${char}? Check your active forfeits with /bot checkforfeits.`,
            );
        } else {
            if (player.cheatStrikes === 3) {
                char.Tell(
                    "Whisper",
                    `Didn't want to take the warnings? You've been removed from the scoreboard. If you think there has been a mistake, please contact Lilly (35982).`,
                );
            } else {
                char.Tell(
                    "Whisper",
                    `You've been detected to be cheating (again). If you think there has been a mistake, please contact Lilly (35982). Remember to check your active forfeits when in doubt using /bot checkforfeits.`,
                );
            }
            const dunceHat = char.Appearance.AddItem(
                AssetGet("Hat", "CollegeDunce"),
            );
            dunceHat.SetColor("#741010");
            const sign = char.Appearance.AddItem(
                AssetGet("ItemMisc", "WoodenSign"),
            );
            sign.setProperty("Text", "Cheater");
            sign.setProperty("Text2", "");
        }
    }

    private onCommandGame = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (!sender.IsRoomWhitelistedOrAdmin()) {
            this.conn.reply(msg, "Sorry, you need to be whitelisted");
            return;
        }
        if (args.length < 1) {
            this.conn.reply(
                msg,
                "Usage: /bot game <game> -- available games: roulette, blackjack, threecardpoker",
            );
            return;
        }
        const game = args[0].toLowerCase();
        if (game === "roulette" && !(this.game instanceof RouletteGame)) {
            this.conn.SendMessage(
                "Chat",
                "After this round the game will switch to roulette.",
            );
            await this.game.endGame();
            this.game = new RouletteGame(this.conn, this);
            this.conn.reply(msg, "Switched to roulette.");
            this.conn.SendMessage(
                "Chat",
                `The game has switched to roulette, please place your bets!`,
            );
        } else if (
            game === "blackjack" &&
            !(this.game instanceof BlackjackGame)
        ) {
            this.conn.SendMessage(
                "Chat",
                "After this round the game will switch to blackjack.",
            );
            await this.game.endGame();
            this.game = new BlackjackGame(this.conn, this);
            this.conn.reply(msg, "Switched to blackjack.");
            this.conn.SendMessage(
                "Chat",
                `The game has switched to blackjack, please place your bets!`,
            );
        } else if (
            game === "threecardpoker" &&
            !(this.game instanceof ThreeCardPokerGame)
        ) {
            this.conn.SendMessage(
                "Chat",
                "After this round the game will switch to three card poker.",
            );
            await this.game.endGame();
            this.game = new ThreeCardPokerGame(this.conn, this);
            this.conn.reply(msg, "Switched to three card poker.");
            this.conn.SendMessage(
                "Chat",
                `The game has switched to three card poker, please place your bets!`,
            );
        } else {
            this.conn.reply(msg, `Unknown game: ${game}`);
            return;
        }
        this.setBio();
    };

    private onCommandVote = (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        const game = args[0]?.toLowerCase();
        const validGames: Array<CasinoGameName> = [
            "roulette",
            "blackjack",
            "threecardpoker",
        ];

        if (this.activeVote) {
            if (!game || !validGames.includes(game as CasinoGameName)) {
                this.conn.reply(
                    msg,
                    "Usage: /bot vote <roulette|blackjack|threecardpoker>",
                );
                return;
            }
            if (
                !this.conn.chatRoom.characters.some(
                    (character) =>
                        character.MemberNumber === sender.MemberNumber,
                )
            ) {
                this.conn.reply(msg, "You must be in the room to vote.");
                return;
            }

            this.activeVote.votes.set(
                sender.MemberNumber,
                game as CasinoGameName,
            );
            this.conn.reply(msg, `Your vote for ${game} has been counted.`);
            return;
        }

        if (
            args.length !== 1 ||
            !game ||
            !validGames.includes(game as CasinoGameName)
        ) {
            this.conn.reply(
                msg,
                "Usage: /bot vote <roulette|blackjack|threecardpoker>",
            );
            return;
        }

        const cooldownRemaining =
            this.lastVoteAt + VOTE_COOLDOWN_MS - Date.now();
        if (cooldownRemaining > 0) {
            this.conn.reply(
                msg,
                `A new vote can be started in ${remainingTimeString(this.lastVoteAt + VOTE_COOLDOWN_MS)}.`,
            );
            return;
        }

        this.lastVoteAt = Date.now();
        this.conn.SendMessage(
            "Chat",
            "A vote has started! For the next minute, vote with /bot vote roulette, /bot vote blackjack or /bot vote threecardpoker. You may change your vote before the vote ends.",
        );
        const vote = {
            votes: new Map<number, CasinoGameName>(),
        };
        vote.votes.set(sender.MemberNumber, game as CasinoGameName);
        this.activeVote = vote;
        this.conn.reply(msg, `Your vote for ${game} has been counted.`);
        setTimeout(() => {
            void this.finishVote(vote);
        }, VOTE_DURATION_MS);
    };

    private finishVote = async (
        vote: NonNullable<typeof this.activeVote>,
    ): Promise<void> => {
        if (this.activeVote !== vote) {
            return;
        }
        this.activeVote = undefined;

        const counts = new Map<CasinoGameName, number>();
        for (const choice of vote.votes.values()) {
            counts.set(choice, (counts.get(choice) ?? 0) + 1);
        }

        let winningGame: CasinoGameName | undefined;
        let winningVotes = 0;
        let tied = false;
        for (const [choice, count] of counts) {
            if (count > winningVotes) {
                winningGame = choice;
                winningVotes = count;
                tied = false;
            } else if (count === winningVotes && count > 0) {
                tied = true;
            }
        }

        if (tied || !winningGame) {
            this.conn.SendMessage(
                "Chat",
                tied
                    ? "The vote ended in a tie. The current game will stay."
                    : "The vote ended without a game change. The current game will stay.",
            );
            return;
        }

        if (this.isCurrentGame(winningGame)) {
            this.conn.SendMessage(
                "Chat",
                "The vote selected the current game. The current game will stay.",
            );
            return;
        }
        this.conn.SendMessage(
            "Chat",
            `The vote is over. The game will switch to ${winningGame} after this round.`,
        );

        await this.switchGame(winningGame);
        this.conn.SendMessage(
            "Chat",
            `The game has switched to ${winningGame}, please place your bets!`,
        );
        await this.setBio();
    };

    private isCurrentGame(game: CasinoGameName): boolean {
        if (
            (game === "roulette" && this.game instanceof RouletteGame) ||
            (game === "blackjack" && this.game instanceof BlackjackGame) ||
            (game === "threecardpoker" &&
                this.game instanceof ThreeCardPokerGame)
        ) {
            return true;
        }
        return false;
    }

    private switchGame = async (game: CasinoGameName): Promise<boolean> => {
        await this.game.endGame();
        if (game === "roulette") {
            this.game = new RouletteGame(this.conn, this);
        } else if (game === "blackjack") {
            this.game = new BlackjackGame(this.conn, this);
        } else {
            this.game = new ThreeCardPokerGame(this.conn, this);
        }
        return true;
    };

    private onCommandScoreboard = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (!sender.IsRoomWhitelistedOrAdmin()) {
            this.conn.reply(msg, "Sorry, you need to be whitelisted");
            return;
        }
        this.setBio();
        this.conn.reply(
            msg,
            "Scoreboard updated, please check my bio for the latest scores.",
        );
    };

    private onCommandColor = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (args.length === 0) {
            let player = await this.store.getPlayer(sender.MemberNumber);
            this.conn.SendMessage(
                "Whisper",
                `Your color is currently set to: ${player.color}. If you want to change it, try, eg. /bot color #00c8ff`,
                sender.MemberNumber,
            );
            return;
        }
        if (args.length !== 1) {
            this.conn.SendMessage(
                "Whisper",
                "I couldn't understand that command. Try, eg. /bot color #00c8ff",
                sender.MemberNumber,
            );
            return;
        }
        let color = args[0].toLowerCase();
        if (color == "default" || color.match(/^#?([a-f0-9]{6})$/)) {
            if (color[0] !== "#" && color != "default") color = "#" + color;
            this.conn.SendMessage(
                "Whisper",
                `Your color has been set to ${color}.`,
                sender.MemberNumber,
            );
            let player = await this.store.getPlayer(sender.MemberNumber);
            player.color = color as BCColor;
            this.store.savePlayer(player);
        } else {
            this.conn.SendMessage(
                "Whisper",
                "I couldn't understand that color. Try, eg. /bot color #00c8ff",
                sender.MemberNumber,
            );
        }
    };
}
