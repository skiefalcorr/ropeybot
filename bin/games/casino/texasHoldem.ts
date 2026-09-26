import { resolve } from "path";
import { waitForCondition } from "../../hub/utils";
import { Casino } from "../casino";
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

//TODO
const TEXASHOLDEMCOMMANDS = `Three Card Poker commands:



/bot chips - Show your current chip balance.
/bot give <name or member number> <amount> - Give chips to another player.
/bot help - Show this help
/bot commands - Show all available commands.
/bot forfeits - Show available forfeits.
/bot checkforfeits - Shows all forfeits currently applied to you.
/bot score - Show your current score.
/bot color <color or Default> - Change the color of your forfeits. 
`;

//TODO
const TEXASHOLDEMHELP = `

Hand rankings from highest to lowest:
- Straight Flush (five cards in sequence of the same suit)
- Three of a Kind
- Straight (five cards in sequence)
- Flush (five cards of the same suit)
- Pair
- High Card`;

const TEXASHOLDEMHELPCOMMAND = `
${TEXASHOLDEMHELP}

For more information on commands or forfeits, use the following commands:
/bot commands - Show all available commands.
/bot forfeits - Show available forfeits.
`;

const TEXASHOLDEMEXAMPLES = `
/bot bet 10
    bets 10 chips
/bot bet leg binder
    bets the 'leg binder' forfeit (worth 7 chips)
`;
const FULLTEXASHOLDEMHELP = `${TEXASHOLDEMHELP}

${TEXASHOLDEMCOMMANDS}
`;

const TIME_UNTIL_DEAL_MS = 35000;
const BET_CANCEL_THRESHOLD_MS = 1000;
const AUTO_FOLD_TIMEOUT_MS = 45000;
const RESET_TIMEOUT_MS = 10000; // Time after a game ends before a new game can start

const MAX_PLAYERS = 6;

export interface TexasHoldemPlayer {
    memberNumber: number;
    memberName: string;
    bet: TexasHoldemBet;
}

export interface TexasHoldemBet extends Bet {
    stake: number;
    hadTurn: boolean;
    allin: boolean;
    status: "pending" | "folded" | "waiting";
}

type Hand = Card[];

enum HandRank {
    HighCard = 1,
    Pair,
    TwoPair,
    ThreeOfAKind,
    Straight,
    Flush,
    FullHouse,
    FourOfAKind,
    StraightFlush,
}

export class TexasHoldemGame implements Game {
    private casino: Casino;
    private deck: Card[] = [];
    private playerHands: Map<TexasHoldemBet, Hand> = new Map();
    private willDealAt: number | undefined;
    private players: TexasHoldemPlayer[] = [];
    private resetTimeout: NodeJS.Timeout | undefined; // after finishing a game
    private dealTimeout: NodeJS.Timeout | undefined; // after first bet until the deal

    private communityCards: Card[] = [
        { suit: "", value: "" },
        { suit: "", value: "" },
        { suit: "", value: "" },
        { suit: "", value: "" },
        { suit: "", value: "" },
    ];
    private minimumBet: number = 0;
    private gameState: "Preflop" | "Flop" | "Turn" | "River" = "Preflop";

    public HELPMESSAGE = FULLTEXASHOLDEMHELP;
    public EXAMPLES = TEXASHOLDEMEXAMPLES;
    public HELPCOMMANDMESSAGE = TEXASHOLDEMHELPCOMMAND;
    public COMMANDSMESSAGE = TEXASHOLDEMCOMMANDS;

    constructor(
        private conn: API_Connector,
        casino: Casino,
    ) {
        this.casino = casino;
        this.casino.commandParser.register("play", this.onCommandPlay);
        this.casino.commandParser.register("pause", this.onCommandPause);
        this.casino.commandParser.register("raise", this.onCommandRaise);
        this.casino.commandParser.register("check", this.onCommandCheck);
        this.casino.commandParser.register("fold", this.onCommandFold);
        this.casino.commandParser.register("call", this.onCommandCall);
        this.casino.commandParser.register("allin", this.onCommandAllin);
        this.casino.commandParser.register("sign", (sender, msg, args) => {
            const sign = this.casino.getSign();

            sign.setProperty("OverridePriority", { Text: 63 });
            sign.setProperty("Text", "Playing");
            sign.setProperty("Text2", "Poker");
            this.casino.setSignColor(["#202020", "Default", "#ffffff"]);
        });

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

    placeBet(bet: Bet): void {
        throw new Error("Method not implemented.");
    }

    getPole(): API_AppearanceItem {
        let pole = this.conn.Player.Appearance.InventoryGet("ItemDevices");
        if (pole && pole.Name === "Pole") {
            // console.log("Pole already exists in inventory", pole);
            return pole;
        }

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

        this.casino.commandParser.unregister("raise");
        this.casino.commandParser.unregister("check");
        this.casino.commandParser.unregister("fold");
        this.casino.commandParser.unregister("call");
        this.casino.commandParser.unregister("allin");
        this.casino.commandParser.unregister("sign");
        this.clear();
        resolve();
    }

    parseBetCommand(
        senderCharacter: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ): TexasHoldemBet | undefined {
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
                "I couldn't understand that raise. Try, eg. /bot raise 10",
                senderCharacter.MemberNumber,
            );
            return;
        }

        const stake = args[0];
        let stakeValue: number;

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

        return {
            memberNumber: senderCharacter.MemberNumber,
            memberName: senderCharacter.toString(),
            stake: stakeValue,
            stakeForfeit: undefined,
            allin: false,
            hadTurn: false,
            status: "waiting",
        };
    }

    private async resolveGame(): Promise<void> {
        if (this.gameState === "Preflop") {
            this.communityCards.splice(0, 3, ...this.deck.splice(0, 3));
            this.gameState = "Flop";
            this.showHands(false);
        } else if (this.gameState === "Flop") {
            this.communityCards.splice(3, 1, ...this.deck.splice(0, 1));
            this.gameState = "Turn";
            this.showHands(false);
        } else if (this.gameState === "Turn") {
            this.communityCards.splice(4, 1, ...this.deck.splice(0, 1));
            this.gameState = "River";
            this.showHands(false);
        } else if (this.gameState === "River") {
            this.showHands(true);
            await this.showdown();
        }
    }

    //TODO
    private async showdown(): Promise<void> {}

    getBets(): TexasHoldemBet[] {
        return this.players.map((b) => b.bet);
    }

    public getBetsForPlayer(memberNumber: number): TexasHoldemBet[] {
        return this.players
            .filter((b) => b.memberNumber === memberNumber)
            .flatMap((b) => b.bet);
    }

    public clearBetsForPlayer(memberNumber: number): undefined {
        this.players.forEach((b) => {
            if (b && b.memberNumber === memberNumber) {
                b.bet = undefined;
            }
        });
    }

    onCommandPlay = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        //TODO
    };

    onCommandPause = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        //TODO
    };

    onCommandRaise = async (
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

        const raise = this.parseBetCommand(sender, msg, args);
        if (raise === undefined) {
            return;
        }

        const spent = await this.casino.store.trySpendCredits(
            sender.MemberNumber,
            raise.stake,
        );
        if (!spent) {
            this.conn.SendMessage(
                "Whisper",
                `You don't have enough chips.`,
                sender.MemberNumber,
            );
            return;
        }
        let player = this.players.find(
            (b) => b.memberNumber === sender.MemberNumber,
        );
        let bet = player.bet;

        if (bet.stake + raise.stake < this.minimumBet) {
            this.conn.SendMessage(
                "Whisper",
                "To raise you need to bet at least " +
                    (this.minimumBet - bet.stake) +
                    " more.",
                sender.MemberNumber,
            );
            return;
        }

        bet.stake += raise.stake;
        this.minimumBet = bet.stake;
        bet.status = "waiting";
        bet.hadTurn = true;
        this.conn.SendMessage(
            "Chat",
            `${bet.memberName} raises by ${raise.stake} to ${this.minimumBet}.`,
        );
        this.getNextPlayer(player);
        // Round cannot be done after a raise
    };

    onCommandCheck = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        const player = this.players.find(
            (p) => p.memberNumber === sender.MemberNumber,
        );
        const bet = player.bet;
        if (bet.status === "folded") {
            this.conn.SendMessage(
                "Whisper",
                "You already folded.",
                sender.MemberNumber,
            );
            return;
        } else if (bet.status === "waiting") {
            this.conn.SendMessage(
                "Whisper",
                "It is not your turn.",
                sender.MemberNumber,
            );
            return;
        }

        if (bet.stake !== this.minimumBet) {
            this.conn.SendMessage(
                "Whisper",
                "You cannot check as you need to call at least " +
                    (this.minimumBet - bet.stake) +
                    " to " +
                    this.minimumBet +
                    ".",
                sender.MemberNumber,
            );
        }

        bet.status = "waiting";
        bet.hadTurn = true;

        this.conn.SendMessage("Chat", `${player.memberName} checks.`);

        if (this.allPlayersDone()) this.resolveGame();
        this.getNextPlayer(player);
    };

    onCommandFold = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        const player = this.players.find(
            (p) => p.memberNumber === sender.MemberNumber,
        );

        const bet = player.bet;
        if (bet.status === "waiting") {
            this.conn.SendMessage(
                "Whisper",
                "It is not your turn.",
                sender.MemberNumber,
            );
            return;
        } else if (bet.status === "folded") {
            this.conn.SendMessage(
                "Whisper",
                "You already folded.",
                sender.MemberNumber,
            );
            return;
        }

        bet.status = "folded";
        bet.hadTurn = true;

        this.conn.SendMessage("Chat", `${player.memberName} folds.`);

        if (this.allPlayersDone()) this.resolveGame();
        this.getNextPlayer(player);
    };

    private onCommandCall = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        const player = this.players.find(
            (p) => p.memberNumber === sender.MemberNumber,
        );

        const bet = player.bet;
        if (bet.status === "waiting") {
            this.conn.SendMessage(
                "Whisper",
                "It is not your turn.",
                sender.MemberNumber,
            );
            return;
        } else if (bet.status === "folded") {
            this.conn.SendMessage(
                "Whisper",
                "You already folded.",
                sender.MemberNumber,
            );
            return;
        }

        const callAmount = this.minimumBet - bet.stake;
        const spent = await this.casino.store.trySpendCredits(
            sender.MemberNumber,
            callAmount,
        );
        if (!spent) {
            this.conn.SendMessage(
                "Whisper",
                `You don't have enough chips. You'd need to go /bot allin to call.`,
                sender.MemberNumber,
            );
            return;
        }
        bet.stake = this.minimumBet;

        bet.status = "waiting";
        bet.hadTurn = true;

        this.conn.SendMessage("Chat", `${player.memberName} calls.`);

        if (this.allPlayersDone()) this.resolveGame();
        this.getNextPlayer(player);
    };

    private onCommandAllin = async (
        sender: API_Character,
        msg: BC_Server_ChatRoomMessage,
        args: string[],
    ) => {
        const player = this.players.find(
            (p) => p.memberNumber === sender.MemberNumber,
        );

        const bet = player.bet;
        if (bet.status === "waiting") {
            this.conn.SendMessage(
                "Whisper",
                "It is not your turn.",
                sender.MemberNumber,
            );
            return;
        } else if (bet.status === "folded") {
            this.conn.SendMessage(
                "Whisper",
                "You already folded.",
                sender.MemberNumber,
            );
            return;
        }

        const playerStore = await this.casino.store.getPlayer(
            sender.MemberNumber,
        );

        bet.stake += playerStore.credits;

        this.conn.SendMessage(
            "Chat",
            `${player.memberName} goes all in for ${playerStore.credits} more making a total bet of ${bet.stake}.`,
        );

        bet.allin = true;
        bet.status = "waiting";
        bet.hadTurn = true;

        playerStore.credits = 0;
        await this.casino.store.savePlayer(playerStore);
        if (this.allPlayersDone()) this.resolveGame();
        this.getNextPlayer(player);
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
            sign.setProperty("Text", "Texas Holdem");
            sign.setProperty("Text2", `${Math.ceil(timeLeft / 1000)}`);
        }
    }

    private getPlayerStatus(player: TexasHoldemPlayer): string {
        if (player.bet.status === "folded") return "folded";
        else if (player.bet.status === "waiting") {
            if (player.bet.allin) return `allin for ${player.bet.stake}`;
            else if (player.bet.stake === this.minimumBet) return "call";
            else return `raise ${player.bet.stake - this.minimumBet}`;
        } else if (player.bet.status === "pending")
            return `${player.bet.stake - this.minimumBet} to call`;
    }

    private getNextPlayer(lastPlayer: TexasHoldemPlayer): TexasHoldemPlayer {
        let lastPlayerIndex = this.players.indexOf(lastPlayer) + 1;
        if (lastPlayerIndex > this.players.length - 1) {
            lastPlayerIndex = 0;
        }
        while (this.players[lastPlayerIndex].bet.status === "folded") {
            lastPlayerIndex++;
            if (lastPlayerIndex > this.players.length - 1) {
                lastPlayerIndex = 0;
            }
        }
        this.players.forEach((p) => {
            if (p.bet.status !== "folded") {
                p.bet.status == "waiting";
            }
        });
        this.players[lastPlayerIndex].bet.status = "pending";
        return this.players[lastPlayerIndex];
    }

    private allPlayersDone(): boolean {
        return this.players.every(
            (p) => p.bet.stake === this.minimumBet && p.bet.hadTurn,
        );
    }

    clear(): void {
        this.players.forEach((p) => {
            p.bet = undefined;
        });
        this.playerHands.clear();
    }

    private async initialDeal(): Promise<void> {
        this.deck = createDeck();
        shuffleDeck(this.deck);

        for (const player of this.players) {
            this.playerHands.set(
                player.bet,
                sortCards([this.deck.pop()!, this.deck.pop()!]),
            );
            this.conn.SendMessage(
                "Whisper",
                `Your cards are: ${
                    (this.handToString(this.playerHands.get(player.bet)),
                    player.memberNumber)
                }`,
            );
        }
        this.conn.SendMessage("Chat", "All cards have been dealt.");
    }

    private evaluateHand(hand: Hand): {
        rank: HandRank;
        rankedCards: number[];
    } {
        const allCards = [...hand, ...this.communityCards];

        const combinations = this.getCombinations(allCards, 5);

        let best = null;

        for (const combo of combinations) {
            const evaluated = this.evaluateFiveCardHand(combo);

            if (!best || this.compareHands(evaluated, best) > 0) {
                best = evaluated;
            }
        }

        return best;
    }

    private evaluateFiveCardHand(cards: Card[]): {
        rank: HandRank;
        rankedCards: number[];
    } {
        const values = cards.map(getNumericCardValue).sort((a, b) => b - a);

        const suits = cards.map((c) => c.suit);

        const valueCounts = new Map<number, number>();
        for (const v of values) {
            valueCounts.set(v, (valueCounts.get(v) || 0) + 1);
        }

        const counts = Array.from(valueCounts.values()).sort((a, b) => b - a);

        const isFlush = suits.every((s) => s === suits[0]);

        const isStraight = (() => {
            const unique = [...new Set(values)];
            if (unique.length !== 5) return false;

            // normal straight
            if (unique[0] - unique[4] === 4) return true;

            // wheel (A-2-3-4-5)
            return JSON.stringify(unique) === JSON.stringify([14, 5, 4, 3, 2]);
        })();

        if (isStraight && isFlush) {
            const isWheel =
                JSON.stringify(values) === JSON.stringify([14, 5, 4, 3, 2]);

            const straightValues = isWheel ? [5, 4, 3, 2, 1] : values;

            return {
                rank: HandRank.StraightFlush,
                rankedCards: straightValues,
            };
        } else if (counts[0] === 4)
            return { rank: HandRank.FourOfAKind, rankedCards: values };
        else if (counts[0] === 3 && counts[1] === 2)
            return { rank: HandRank.FullHouse, rankedCards: values };
        else if (isFlush) return { rank: HandRank.Flush, rankedCards: values };
        else if (isStraight) {
            const isWheel =
                JSON.stringify(values) === JSON.stringify([14, 5, 4, 3, 2]);

            const straightValues = isWheel ? [5, 4, 3, 2, 1] : values;

            return { rank: HandRank.Straight, rankedCards: straightValues };
        } else if (counts[0] === 3)
            return { rank: HandRank.ThreeOfAKind, rankedCards: values };
        else if (counts[0] === 2 && counts[1] === 2)
            return { rank: HandRank.TwoPair, rankedCards: values };
        else if (counts[0] === 2)
            return { rank: HandRank.Pair, rankedCards: values };

        return { rank: HandRank.HighCard, rankedCards: values };
    }

    private compareHands(a: any, b: any): number {
        if (a.rank !== b.rank) return a.rank - b.rank;

        for (let i = 0; i < a.values.length; i++) {
            if (a.values[i] !== b.values[i]) {
                return a.values[i] - b.values[i];
            }
        }
        return 0;
    }

    private getCombinations(cards: Card[], k: number): Card[][] {
        const result: Card[][] = [];

        function helper(start: number, combo: Card[]) {
            if (combo.length === k) {
                result.push([...combo]);
                return;
            }

            for (let i = start; i < cards.length; i++) {
                combo.push(cards[i]);
                helper(i + 1, combo);
                combo.pop();
            }
        }

        helper(0, []);
        return result;
    }

    private async showHands(allShown: boolean = false): Promise<void> {
        let outString = `Community cards: ${this.handToString(this.communityCards)}\n`;
        if (allShown) {
            this.players.forEach(async (p) => {
                const handString: string = await this.buildHandString(
                    p,
                    true,
                    true,
                );
                outString += `${p.memberName} (${p.bet.memberNumber}) hand: ${handString} -- (${this.getPlayerStatus(p)})\n`;
            });
            this.conn.SendMessage("Chat", outString);
        } else {
            this.players.forEach(async (requestingPlayer) => {
                this.players.forEach(async (p) => {
                    const handString: string = await this.buildHandString(
                        p,
                        requestingPlayer.memberNumber === p.memberNumber,
                    );
                    outString += `${p.memberName} (${p.bet.memberNumber}) hand: ${handString} -- (${this.getPlayerStatus(p)})\n`;
                });
                this.conn.SendMessage(
                    "Whisper",
                    outString,
                    requestingPlayer.memberNumber,
                );
            });
        }
    }

    private async buildHandString(
        requestingPlayer: TexasHoldemPlayer,
        cardsShown: boolean = false,
        calculated: boolean = false,
    ): Promise<string> {
        if (!cardsShown)
            return `${requestingPlayer.memberName} (${requestingPlayer.bet.memberNumber}) hand: [???] [???]\n`;
        else
            return `${requestingPlayer.memberName} (${requestingPlayer.bet.memberNumber}) hand: ${this.handToString(
                this.playerHands.get(requestingPlayer.bet),
                calculated,
            )}\n`;
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
            switch (this.evaluateHand(hand).rank) {
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
