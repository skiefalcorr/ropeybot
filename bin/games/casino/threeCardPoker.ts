import { resolve } from "path";
import { waitForCondition } from "../../hub/utils";
import { Casino, getItemsBlockingForfeit } from "../casino";
import { FORFEITS } from "./forfeits";
import { Bet, Game } from "./game";
import {
    Card,
    createDeck,
    getCardString,
    getNumericCardValue,
    shuffleDeck,
    sortCards,
} from "./pokerCards";
import {
    API_Character,
    API_Connector,
    BC_Server_ChatRoomMessage,
    API_AppearanceItem,
    AssetGet,
} from "bc-bot";

const THREECARDPOKERCOMMANDS = `Three Card Poker commands:
/bot bet <amount> - Bet on the current hand. Odds: 1:1.
/bot play - Play the current hand.
/bot fold - Fold the current hand.
/bot cancel - Cancel your bet. Only available before any cards are dealt.
/bot chips - Show your current chip balance.
/bot give <name or member number> <amount> - Give chips to another player.
/bot help - Show this help
/bot commands - Show all available commands.
/bot forfeits - Show available forfeits.
/bot checkforfeits - Shows all forfeits currently applied to you.
/bot score - Show your current score.
/bot color <color or Default> - Change the color of your forfeits. 
/bot vote <roulette|blackjack|threecardpoker> - Vote for a game to be played
`;

const THREECARDPOKERHELP = `Three Card Poker is a card game where you play against the dealer using a 3-card hand.
The goal is to have a better hand than the dealer, or win when the dealer does not qualify.

Each player places an Ante bet and is dealt three cards face up.
You can then choose to "play" (continue by matching your Ante) or "fold" (give up your Ante).

The dealer also receives three cards, but only qualifies with a Queen high or better.
If the dealer does not qualify, your Ante is paid 1:1 and your Play bet is returned.

The forfeit time is halfed if you fold your bet.

If the dealer qualifies:
- If your hand is better, both Ante and Play pay 1:1.
- If the dealer's hand is better, both bets lose.
- If tied, both bets are returned.

Hand rankings from highest to lowest:
- Straight Flush (three cards in sequence of the same suit)
- Three of a Kind
- Straight (three cards in sequence)
- Flush (three cards of the same suit)
- Pair
- High Card`;

const THREECARDPOKERHELPCOMMAND = `
${THREECARDPOKERHELP}

For more information on commands or forfeits, use the following commands:
/bot commands - Show all available commands.
/bot forfeits - Show available forfeits.
`;

const THREECARDPOKEREXAMPLES = `
/bot bet 10
    bets 10 chips
/bot bet leg binder
    bets the 'leg binder' forfeit (worth 7 chips)
`;
const FULLTHREECARDPOKERHELP = `${THREECARDPOKERHELP}

${THREECARDPOKERCOMMANDS}
`;

const TIME_UNTIL_DEAL_MS = 35000;
// const TIME_UNTIL_DEAL_MS = 6000;
const BET_CANCEL_THRESHOLD_MS = 1000;
const AUTO_FOLD_TIMEOUT_MS = 45000;
// const AUTO_FOLD_TIMEOUT_MS = 10000;
const RESET_TIMEOUT_MS = 10000; // Time after a game ends before a new game can start

const MAX_PLAYERS = 15; // Don't go over 16 or you don't have enough cards

export interface ThreeCardPokerPlayer {
    memberNumber: number;
    memberName: string;
    bet: ThreeCardPokerBet;
}

export interface ThreeCardPokerBet extends Bet {
    status: "pending" | "folded" | "playing";
}

type Hand = Card[];

enum HandRank {
    HighCard = 1,
    Pair,
    Flush,
    Straight,
    ThreeOfAKind,
    StraightFlush,
}

export class ThreeCardPokerGame implements Game {
    private casino: Casino;
    private deck: Card[] = [];
    private dealerHand: Hand = [];
    private playerHands: Map<ThreeCardPokerBet, Hand> = new Map();
    private willDealAt: number | undefined;
    private willFoldAt: number | undefined;
    private players: ThreeCardPokerPlayer[] = [];
    private resetTimeout: NodeJS.Timeout | undefined; // after finishing a game
    private dealTimeout: NodeJS.Timeout | undefined; // after first bet until the deal
    private autoFoldTimeout: NodeJS.Timeout; // after the deal until all players stand

    public HELPMESSAGE = FULLTHREECARDPOKERHELP;
    public EXAMPLES = THREECARDPOKEREXAMPLES;
    public HELPCOMMANDMESSAGE = THREECARDPOKERHELPCOMMAND;
    public COMMANDSMESSAGE = THREECARDPOKERCOMMANDS;

    constructor(
        private conn: API_Connector,
        casino: Casino,
    ) {
        this.casino = casino;
        this.casino.commandParser.register("cancel", this.onCommandCancel);
        this.casino.commandParser.register("bet", this.onCommandBet);
        this.casino.commandParser.register("play", this.onCommandPlay);
        this.casino.commandParser.register("fold", this.onCommandFold);
        this.casino.commandParser.register("sign", (sender, msg, args) => {
            const sign = this.casino.getSign();

            sign.setProperty("OverridePriority", { Text: 63 });
            sign.setProperty("Text", "Playing");
            sign.setProperty("Text2", "Poker");
            this.casino.setSignColor(["#202020", "Default", "#ffffff"]);
        });
        this.casino.commandParser.register("skipwait", this.onCommandSkipWait);

        setTimeout(() => {
            this.getPole();
            const sign = this.casino.getSign();

            sign.setProperty("OverridePriority", { Text: 63 });
            sign.setProperty("Text", "Playing");
            sign.setProperty("Text2", "Poker");
            this.casino.setSignColor(["#202020", "Default", "#ffffff"]);

            this.casino.setBio().catch((e) => {
                console.error("Failed to set bio.", e);
            });

            this.conn.Player.setScriptPermissions(true, false);

            const scriptItem = this.conn.Player.Appearance.AddItem(
                AssetGet("ItemScript", "Script"),
            );
            scriptItem.setProperty("Hide", [
                "Height",
                "BodyUpper",
                "ArmsLeft",
                "ArmsRight",
                "HandsLeft",
                "HandsRight",
                "BodyLower",
                "HairFront",
                "HairBack",
                "Eyebrows",
                "Eyes",
                "Eyes2",
                "Mouth",
                "Nipples",
                "Pussy",
                "Pronouns",
                "Head",
                "Blush",
                "Fluids",
                "Emoticon",
                "ItemNeck",
                "ItemHead",
                "Cloth",
                "Bra",
                "Socks",
                "Shoes",
                "ClothAccessory",
                "Necklace",
                "ClothLower",
                "Panties",
                "Suit",
                "Gloves",
                "Hat",
                "HairAccessory1",
                "HairAccessory2",
                "HairAccessory3",
            ]);
        }, 500);
    }

    getPole(): API_AppearanceItem {
        let pole = this.conn.Player.Appearance.InventoryGet("ItemDevices");
        if (pole && pole.Name === "Pole") {
            // console.log("Pole already exists in inventory", pole);
            return pole;
        }

        /*this.conn.Player.Appearance.RemoveItem("ItemDevices");
        pole = this.conn.Player.Appearance.AddItem(
            AssetGet("ItemDevices", "Pole"),
        );
        console.log("Adding pole to appearance");
        pole.SetColor(["#AC9A85"]);
/**/
        console.log("Adding pole to inventory");
        let newPole = AssetGet("ItemDevices", "Pole");
        newPole.Color = ["#AC9A85"];
        this.conn.Player.Appearance.AddItem(newPole);
        return this.conn.Player.Appearance.InventoryGet("ItemDevices");
    }

    getGameSign(): API_AppearanceItem {
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

    async endGame(): Promise<void> {
        await waitForCondition(() => this.willDealAt === undefined);
        // await wait(2000);

        this.casino.commandParser.unregister("cancel");
        this.casino.commandParser.unregister("bet");
        this.casino.commandParser.unregister("fold");
        this.casino.commandParser.unregister("play");
        this.casino.commandParser.unregister("sign");
        this.casino.commandParser.unregister("skipwait");
        this.clear();
        resolve();
    }

    parseBetCommand(
        senderCharacter: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ): ThreeCardPokerBet | undefined {
        if (this.resetTimeout !== undefined) {
            this.conn.SendMessage(
                "Whisper",
                "The next game hasn't started yet",
                senderCharacter.MemberNumber,
            );
            return;
        }

        if (args.length !== 1) {
            this.conn.SendMessage(
                "Whisper",
                "I couldn't understand that bet. Try, eg. /bot bet 10 or /bot bet boots",
                senderCharacter.MemberNumber,
            );
            return;
        }

        if (
            this.players.find(
                (b) => b.memberNumber === senderCharacter.MemberNumber,
            )
        ) {
            this.conn.SendMessage(
                "Whisper",
                "You already placed a bet. Use !cancel to cancel it.",
                senderCharacter.MemberNumber,
            );
            return;
        }

        const stake = args[0];
        let stakeValue: number;
        let stakeForfeit: string;
        if (FORFEITS[stake] !== undefined) {
            stakeValue = FORFEITS[stake].value;
            stakeForfeit = stake;
        } else {
            if (!/^\d+$/.test(stake)) {
                this.conn.SendMessage(
                    "Whisper",
                    "Invalid stake",
                    senderCharacter.MemberNumber,
                );
                return;
            }
            stakeValue = parseInt(stake, 10);
            if (isNaN(stakeValue) || stakeValue < 1) {
                this.conn.SendMessage(
                    "Whisper",
                    "Invalid stake",
                    senderCharacter.MemberNumber,
                );
                return;
            }
        }
        return {
            memberNumber: senderCharacter.MemberNumber,
            memberName: senderCharacter.toString(),
            stake: stakeValue,
            stakeForfeit,
            status: "pending",
        };
    }

    private async resolveGame(): Promise<void> {
        clearTimeout(this.autoFoldTimeout);
        this.autoFoldTimeout = undefined;
        await this.showHands(false);

        const { rank: dealerRank, rankedCards: dealerRankedCards } =
            this.evaluteHand(this.dealerHand);
        const dealerQualfies =
            dealerRank > HandRank.HighCard || dealerRankedCards[0] >= 12;

        let message = `Dealer has a hand of ${this.handToString(this.dealerHand)}\n`;
        if (!dealerQualfies)
            message +=
                "Since the dealer doesn't qualify, they don't play the hand.\n";

        const sign = this.casino.getSign();
        sign.setProperty("Text", "Dealer has");
        sign.setProperty(
            "Text2",
            `${this.handToString(this.dealerHand, false, true)}`,
        );
        this.casino.setTextColor("#ffffff");

        let sendMessage = false;

        for (const player of this.players) {
            const playerHand = this.playerHands.get(player.bet);
            if (!playerHand) {
                console.error(
                    `No hand found for player ${player.memberName} (${player.memberNumber})`,
                );
                continue;
            }
            const winnings = this.getWinnings(
                playerHand,
                player.bet,
                dealerRank,
                dealerRankedCards,
                dealerQualfies,
            );

            if (winnings > 0) {
                await this.casino.store.addWinnings(
                    player.memberNumber,
                    winnings,
                );
                message += `${player.memberName} wins ${winnings} chips\n`;
                sendMessage = true;
            } else if (player.bet.stakeForfeit && winnings !== -100) {
                this.casino.applyForfeit(
                    player.bet,
                    player.bet.status === "playing" ? 1 : 0.5,
                );
                let time =
                    FORFEITS[player.bet.stakeForfeit].lockTimeMs / 1000 / 60;
                time = player.bet.status === "playing" ? time : time / 2;
                message += `${player.memberName} lost and gets ${FORFEITS[player.bet.stakeForfeit].name} for ${time} Minutes!\n`;
                sendMessage = true;
            }
        }
        this.clear();
        this.willDealAt = undefined;
        this.casino.multiplier = 1;

        if (this.dealTimeout) {
            clearInterval(this.dealTimeout);
            this.dealTimeout = undefined;
        }
        this.resetTimeout = setTimeout(() => {
            this.resetTimeout = undefined;
            const sign = this.casino.getSign();
            sign.setProperty("Text", "Playing");
            sign.setProperty("Text2", "Poker");
            this.casino.setTextColor("#ffffff");
        }, RESET_TIMEOUT_MS);

        if (sendMessage) this.conn.SendMessage("Chat", message);
    }

    placeBet(bet: ThreeCardPokerBet): void {
        this.players.push({
            memberNumber: bet.memberNumber,
            memberName: bet.memberName,
            bet,
        });
        if (bet.stakeForfeit) {
            this.conn.SendMessage(
                "Chat",
                `${bet.memberName} bets ${FORFEITS[bet.stakeForfeit].name} for ${bet.stake} chips`,
            );
        } else {
            this.conn.SendMessage(
                "Chat",
                `${bet.memberName} bets ${bet.stake} chips`,
            );
        }
    }

    getBets(): ThreeCardPokerBet[] {
        return this.players.map((b) => b.bet);
    }
    public getBetsForPlayer(memberNumber: number): ThreeCardPokerBet[] {
        return this.players
            .filter((b) => b.memberNumber === memberNumber)
            .flatMap((b) => b.bet);
    }

    public clearBetsForPlayer(memberNumber: number): undefined {
        this.players = this.players.filter(
            (b) => b.memberNumber !== memberNumber,
        );
    }

    onCommandSkipWait = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (!sender.IsRoomWhitelistedOrAdmin()) {
            this.conn.reply(
                msg,
                "You must be whitelisted or an admin to use this command.",
            );
            return;
        }
        if (this.willDealAt === undefined) {
            this.conn.reply(msg, "There's no game in progress.");
            return;
        }
        this.willDealAt = Date.now();
        this.conn.reply(msg, "The wait has been skipped.");
    };

    onCommandBet = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (this.resetTimeout !== undefined) {
            this.conn.SendMessage(
                "Whisper",
                "The next game hasn't started yet",
                sender.MemberNumber,
            );
            return;
        }
        if (
            this.autoFoldTimeout !== undefined ||
            this.willDealAt - Date.now() < BET_CANCEL_THRESHOLD_MS
        ) {
            this.conn.SendMessage(
                "Whisper",
                "You can't bet right now.",
                sender.MemberNumber,
            );
            return;
        }

        const bet = this.parseBetCommand(sender, msg, args);
        if (bet === undefined) {
            return;
        }

        if (this.players.length >= MAX_PLAYERS) {
            this.conn.SendMessage(
                "Whisper",
                "The maximum number of players has been reached, try again next round.",
                sender.MemberNumber,
            );
            return;
        }

        if (bet.stakeForfeit === undefined) {
            const spent = await this.casino.store.trySpendCredits(
                sender.MemberNumber,
                bet.stake,
            );
            if (!spent) {
                this.conn.SendMessage(
                    "Whisper",
                    `You don't have enough chips (Remember that you need double your bet so you can play).`,
                    sender.MemberNumber,
                );
                return;
            }
        } else {
            const blockers = getItemsBlockingForfeit(
                sender,
                FORFEITS[bet.stakeForfeit].items(sender),
            );
            if (blockers.length > 0) {
                console.log(
                    `Blocked forfeit bet of ${bet.stakeForfeit} with blockers `,
                    blockers,
                );
                this.conn.SendMessage(
                    "Whisper",
                    `You can't bet that while you have: ${blockers.map((i) => i.Name).join(", ")}`,
                    sender.MemberNumber,
                );
                return;
            }
            const canInteract = await sender.GetAllowItem();
            if (!canInteract) {
                this.conn.SendMessage(
                    "Whisper",
                    "You'll need to open up your permissions or whitelist the bot to bet restraints.",
                    sender.MemberNumber,
                );
                return;
            }

            const needItems = [...FORFEITS[bet.stakeForfeit].items(sender)];
            if (FORFEITS[bet.stakeForfeit].lock)
                needItems.push(FORFEITS[bet.stakeForfeit].lock);
            const blocked = needItems.filter(
                (i) => !sender.IsItemPermissionAccessible(i),
            );
            if (blocked.length > 0) {
                this.conn.SendMessage(
                    "Whisper",
                    `You can't bet that forfeit because you've blocked: ${blocked.map((i) => i.Name).join(", ")}.`,
                    sender.MemberNumber,
                );
                return;
            }

            bet.stake *= this.casino.multiplier;
        }

        if (FORFEITS[bet.stakeForfeit]?.items(sender).length === 1) {
            const forfeitItem = FORFEITS[bet.stakeForfeit].items(sender)[0];
            if (
                Date.now() <
                this.casino.lockedItems
                    .get(sender.MemberNumber)
                    ?.get(forfeitItem.Group)
            ) {
                const player = await this.casino.store.getPlayer(
                    sender.MemberNumber,
                );
                console.log(
                    `CHEATER DETECTED: ${sender} tried to bet ${bet.stakeForfeit} which should be locked`,
                );
                ++player.cheatStrikes;
                await this.casino.store.savePlayer(player);

                this.casino.cheatPunishment(sender, player);

                return;
            }
        }

        this.placeBet(bet);

        if (this.willDealAt === undefined) {
            if (this.resetTimeout !== undefined) {
                clearTimeout(this.resetTimeout);
                this.resetTimeout = undefined;
            }
            this.willDealAt = Date.now() + TIME_UNTIL_DEAL_MS;
            this.dealTimeout = setInterval(() => {
                this.onDealTimeout();
            }, 1000);
        }
    };

    onCommandPlay = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (this.autoFoldTimeout === undefined) {
            this.conn.SendMessage(
                "Whisper",
                "You can't play right now.",
                sender.MemberNumber,
            );
            return;
        }
        const player = this.players.find(
            (p) => p.memberNumber === sender.MemberNumber,
        );
        const bet = player.bet;
        if (!bet) {
            this.conn.SendMessage(
                "Whisper",
                "You don't have a bet in play.",
                sender.MemberNumber,
            );
            return;
        } else if (bet.status !== "pending") {
            this.conn.SendMessage(
                "Whisper",
                "You already did your action.",
                sender.MemberNumber,
            );
            return;
        }
        if (this.playerHands.get(bet) === undefined) {
            this.conn.SendMessage(
                "Whisper",
                "You don't have a hand in play.",
                sender.MemberNumber,
            );
            return;
        }

        const playerStore = await this.casino.store.getPlayer(
            sender.MemberNumber,
        );

        if (bet.stakeForfeit === undefined) {
            if (playerStore.credits < bet.stake) {
                this.conn.SendMessage(
                    "Whisper",
                    "You don't have enough chips.",
                    sender.MemberNumber,
                );
                return;
            }

            const spent = await this.casino.store.trySpendCredits(
                sender.MemberNumber,
                bet.stake,
            );
            if (!spent) {
                this.conn.SendMessage(
                    "Whisper",
                    "You don't have enough chips.",
                    sender.MemberNumber,
                );
                return;
            }
            bet.stake *= 2;
        }

        bet.status = "playing";

        this.conn.SendMessage(
            "Whisper",
            "You are playing.",
            sender.MemberNumber,
        );

        if (this.allPlayersDone()) this.resolveGame();
    };

    onCommandFold = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (this.autoFoldTimeout === undefined) {
            this.conn.SendMessage(
                "Whisper",
                "You can't fold right now.",
                sender.MemberNumber,
            );
            return;
        }
        const player = this.players.find(
            (p) => p.memberNumber === sender.MemberNumber,
        );
        const bet = player.bet;
        if (!bet) {
            this.conn.SendMessage(
                "Whisper",
                "You don't have a bet in play.",
                sender.MemberNumber,
            );
            return;
        } else if (bet.status !== "pending") {
            this.conn.SendMessage(
                "Whisper",
                "You already did your action.",
                sender.MemberNumber,
            );
            return;
        }
        if (this.playerHands.get(bet) === undefined) {
            this.conn.SendMessage(
                "Whisper",
                "You don't have a hand in play.",
                sender.MemberNumber,
            );
            return;
        }

        bet.status = "folded";

        this.conn.SendMessage(
            "Whisper",
            "You are folding.",
            sender.MemberNumber,
        );

        if (this.allPlayersDone()) this.resolveGame();
    };

    private onDealTimeout(): void {
        if (!this.willDealAt) return;

        const sign = this.casino.getSign();

        const timeLeft = this.willDealAt - Date.now();
        if (timeLeft <= 0) {
            sign.Extended.SetText("");
            sign.setProperty("Text2", "");

            clearInterval(this.dealTimeout);
            this.initialDeal();
        } else {
            this.casino.setTextColor("#ffffff");
            sign.setProperty("Text", "Poker");
            sign.setProperty("Text2", `${Math.ceil(timeLeft / 1000)}`);
        }
    }
    private onFoldTimeout(): void {
        if (!this.willFoldAt) return;

        const sign = this.casino.getSign();
        const timeLeft = this.willFoldAt - Date.now();
        if (timeLeft <= 0) {
            this.players.forEach((player) => {
                if (player.bet.status == "pending") {
                    player.bet.status = "folded";
                }
            });
            this.conn.SendMessage(
                "Chat",
                "All open bets have been automatically folded.",
            );
            clearInterval(this.autoFoldTimeout);
            this.resolveGame();
        } else {
            this.casino.setTextColor("#ffffff");
            sign.setProperty("Text", "Time left");
            sign.setProperty("Text2", `${Math.ceil(timeLeft / 1000)}`);
        }
    }

    private allPlayersDone(): boolean {
        return this.players.every((player) => player.bet.status !== "pending");
    }

    onCommandCancel = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        if (this.getBetsForPlayer(sender.MemberNumber).length === 0) {
            this.conn.SendMessage(
                "Whisper",
                "You don't have a bet in play.",
                sender.MemberNumber,
            );
            return;
        }

        const timeLeft = this.willDealAt - Date.now();
        if (timeLeft <= BET_CANCEL_THRESHOLD_MS) {
            this.conn.SendMessage(
                "Whisper",
                "You can't cancel your bet now.",
                sender.MemberNumber,
            );
            return;
        }

        if (!this.getBetsForPlayer(sender.MemberNumber)[0].stakeForfeit) {
            const player = await this.casino.store.getPlayer(
                sender.MemberNumber,
            );

            this.getBetsForPlayer(sender.MemberNumber).forEach((b) => {
                player.credits += b.stake;
            });
            await this.casino.store.savePlayer(player);
        }

        this.clearBetsForPlayer(sender.MemberNumber);
        this.conn.SendMessage("Chat", `${sender.Name} cancelled their bet.`);
    };

    getWinnings(
        playerHand: Hand,
        bet: ThreeCardPokerBet,
        dealerRank: number,
        dealerRankedCards: number[],
        dealerQualfies: boolean,
    ): number {
        const { rank: playerRank, rankedCards: playerRankedCards } =
            this.evaluteHand(playerHand);

        if (bet.status === "folded") return 0;

        if (!dealerQualfies) {
            if (bet.stakeForfeit) {
                return Math.floor((bet.stake * 3) / 4);
            } else {
                return Math.floor((bet.stake * 3) / 2);
            }
        }
        if (bet.stakeForfeit) {
            if (playerRank > dealerRank) {
                return bet.stake;
            } else if (playerRank < dealerRank) {
                return 0;
            } else {
                for (let i = 0; i < playerRankedCards.length; i++) {
                    if (playerRankedCards[i] > dealerRankedCards[i]) {
                        return bet.stake;
                    } else if (playerRankedCards[i] < dealerRankedCards[i]) {
                        return 0;
                    }
                }
                return -100;
            }
        } else {
            if (playerRank > dealerRank) {
                return bet.stake * 2;
            } else if (playerRank < dealerRank) {
                return 0;
            } else {
                for (let i = 0; i < playerRankedCards.length; i++) {
                    if (playerRankedCards[i] > dealerRankedCards[i]) {
                        return bet.stake * 2;
                    } else if (playerRankedCards[i] < dealerRankedCards[i]) {
                        return 0;
                    }
                }
                return bet.stake;
            }
        }
    }

    clear(): void {
        this.players = [];
        this.playerHands.clear();
    }

    private async initialDeal(): Promise<void> {
        this.deck = createDeck();
        shuffleDeck(this.deck);

        this.dealerHand = sortCards([
            this.deck.pop()!,
            this.deck.pop()!,
            this.deck.pop()!,
        ]);

        for (const player of this.players) {
            this.playerHands.set(
                player.bet,
                sortCards([
                    this.deck.pop()!,
                    this.deck.pop()!,
                    this.deck.pop()!,
                ]),
            );
        }

        this.willFoldAt = Date.now() + AUTO_FOLD_TIMEOUT_MS;
        this.showHands(true);

        this.autoFoldTimeout = setInterval(() => {
            this.onFoldTimeout();
        }, 1000);
    }

    private evaluteHand(hand: Hand): { rank: HandRank; rankedCards: number[] } {
        const values = hand
            .map((card) => getNumericCardValue(card))
            .sort((a, b) => a - b);
        const suits = hand.map((card) => card.suit).sort();

        const uniqueValues = new Set(values);
        const isStraight =
            (values[1] == values[0] + 1 && values[2] == values[1] + 1) ||
            (values.includes(14) && values.includes(2) && values.includes(3));
        const isFlush = suits.every((suit) => suit === suits[0]);
        const rankedCards =
            isStraight && values.includes(14) && values.includes(2)
                ? [3, 2, 1]
                : values.sort((a, b) => b - a); // On a wheel the high card is 3 since the Ace counts as 1

        if (isStraight && isFlush) {
            return { rank: HandRank.StraightFlush, rankedCards };
        } else if (uniqueValues.size === 1) {
            return { rank: HandRank.ThreeOfAKind, rankedCards };
        } else if (isStraight) {
            return { rank: HandRank.Straight, rankedCards };
        } else if (isFlush) {
            return { rank: HandRank.Flush, rankedCards };
        } else if (uniqueValues.size === 2) {
            const counts: Record<number, number> = {};
            values.forEach((v) => {
                counts[v] = (counts[v] || 0) + 1;
            });
            const pairValue = Number(
                Object.keys(counts).find((v) => counts[Number(v)] === 2),
            );
            const kicker = Number(
                Object.keys(counts).find((v) => counts[Number(v)] === 1),
            );
            return {
                rank: HandRank.Pair,
                rankedCards: [pairValue, pairValue, kicker],
            };
        } else {
            return { rank: HandRank.HighCard, rankedCards };
        }
    }

    private async showHands(dealerHidden: boolean): Promise<void> {
        const handString = await this.buildHandString(dealerHidden);
        this.conn.SendMessage("Chat", handString);
    }

    private async buildHandString(
        dealerHidden: boolean,
        requestingPlayer: ThreeCardPokerPlayer | undefined = undefined,
    ): Promise<string> {
        let outString = dealerHidden
            ? "Dealer's hand: [???] [???] [???]\n"
            : `Dealer's hand: ${this.handToString(this.dealerHand, true)}\n`;
        for (const player of this.players) {
            const bet = player.bet;
            const hand = this.playerHands.get(bet);
            const handString = this.handToString(hand!, true);
            if (
                requestingPlayer &&
                player.memberNumber === requestingPlayer.memberNumber
            ) {
                outString += `> ${player.memberName} (${bet.memberNumber}) hand: ${handString}\n`;
            } else {
                outString += `${player.memberName} (${bet.memberNumber}) hand: ${handString}\n`;
            }
        }
        return outString;
    }

    private handToString(
        hand: Hand,
        calculated: boolean = false,
        signFriendly: boolean = false,
    ): string {
        if (!hand || hand.length === 0) {
            return "";
        }
        if (calculated) {
            let rank = "";
            switch (this.evaluteHand(hand).rank) {
                case HandRank.StraightFlush:
                    rank = "Straight Flush";
                    break;
                case HandRank.ThreeOfAKind:
                    rank = "Three of a Kind";
                    break;
                case HandRank.Flush:
                    rank = "Flush";
                    break;
                case HandRank.Straight:
                    rank = "Straight";
                    break;
                case HandRank.Pair:
                    rank = "Pair";
                    break;
                case HandRank.HighCard:
                    rank = "High Card";
                    break;
                default:
                    break;
            }
            return (
                hand.map((card) => `[${getCardString(card)}]`).join(", ") +
                ` (${rank})`
            );
        }
        if (signFriendly) {
            return hand
                .map((card) => `${getCardString(card, signFriendly)}`)
                .join(" ");
        }
        return hand.map((card) => `[${getCardString(card)}]`).join(", ");
    }
}
