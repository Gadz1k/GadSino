const User = require('../models/user');
const Transaction = require('../models/transaction');

function createShoe(decks = 3) {
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['clubs', 'diamonds', 'hearts', 'spades'];
    let shoe = [];
    for (let i = 0; i < decks; i++) {
        for (let rank of ranks) {
            for (let suit of suits) {
                shoe.push({ rank, suit });
            }
        }
    }
    return shuffle(shoe);
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const blackjackService = {
    io: null,
    tables: {
        default: {
            players: Array(5).fill(null),
            dealerHand: [],
            phase: 'waiting_for_bets',
            currentPlayerIndex: 0,
            countdown: null,
            countdownValue: 8,
            shoe: createShoe()
        }
    },

    initialize(ioInstance) {
        this.io = ioInstance;
    },

    getTable(tableId = 'default') {
        return this.tables[tableId];
    },

    getSafeTable(tableId = 'default') {
        const table = this.getTable(tableId);
        if (!table) return null;

        const { countdown, shoe, ...safeTable } = table;

        const dealerCards = table.dealerHand || [];
        const dealerHasHidden = dealerCards.some(c => c.rank === '❓');
        const dealerValue = dealerHasHidden ? null : this.calculateHand(dealerCards);

        return {
            ...safeTable,
            shoeSize: shoe.length,
            dealerValue
        };
    },

    drawCard(tableId = 'default') {
        const table = this.getTable(tableId);
        if (table.shoe.length < 30) {
            table.shoe = createShoe();
        }
        return table.shoe.pop();
    },

    cardValue(card) {
        if (card.rank === 'A') return 11;
        if (['K', 'Q', 'J'].includes(card.rank)) return 10;
        return parseInt(card.rank);
    },

    calculateHand(hand) {
        let total = hand.reduce((acc, card) => acc + this.cardValue(card), 0);
        let aces = hand.filter(card => card.rank === 'A').length;
        while (total > 21 && aces > 0) {
            total -= 10;
            aces--;
        }
        return total;
    },

    async startRound(tableId = 'default') {
        const table = this.getTable(tableId);
        table.phase = 'playing';

        const activePlayers = table.players
            .map((player, idx) => ({ player, idx }))
            .filter(({ player }) => player && player.bet > 0);

        for (const { player } of activePlayers) {
            player.hand = [this.drawCard(tableId)];
            this.io.to(tableId).emit('table_update', this.getSafeTable(tableId));
            await sleep(500);
        }

        table.dealerHand = [this.drawCard(tableId)];
        this.io.to(tableId).emit('table_update', this.getSafeTable(tableId));
        await sleep(500);

        for (const { player } of activePlayers) {
            player.hand.push(this.drawCard(tableId));
            const total = this.calculateHand(player.hand);
            if (player.hand.length === 2 && total === 21) {
                player.status = 'stand'; // Blackjack
            } else {
                player.status = 'playing';
            }
            this.io.to(tableId).emit('table_update', this.getSafeTable(tableId));
            await sleep(500);
        }

        table.dealerHand.push({ rank: '❓', suit: null });
        table.currentPlayerIndex = -1; // Reset before finding the first player
        this.io.to(tableId).emit('round_started', this.getSafeTable(tableId));
        await this.nextTurn(tableId);
    },

    async nextTurn(tableId = 'default') {
        const table = this.getTable(tableId);
        let nextPlayerIndex = table.currentPlayerIndex + 1;
        while (nextPlayerIndex < table.players.length && (!table.players[nextPlayerIndex] || table.players[nextPlayerIndex].status !== 'playing')) {
            nextPlayerIndex++;
        }

        if (nextPlayerIndex >= table.players.length) {
            await this.playDealer(tableId);
        } else {
            table.currentPlayerIndex = nextPlayerIndex;
            this.io.to(tableId).emit('your_turn', table.players[nextPlayerIndex].username);
        }
    },
    
    async playDealer(tableId = 'default') {
        const table = this.getTable(tableId);
        table.phase = 'dealer_turn';

        if (table.dealerHand[1] && table.dealerHand[1].rank === '❓') {
            await sleep(1000);
            table.dealerHand[1] = this.drawCard(tableId);
            this.io.to(tableId).emit('table_update', this.getSafeTable(tableId));
        }

        let dealerTotal = this.calculateHand(table.dealerHand);
        while (dealerTotal < 17) {
            await sleep(1000);
            table.dealerHand.push(this.drawCard(tableId));
            dealerTotal = this.calculateHand(table.dealerHand);
            this.io.to(tableId).emit('table_update', this.getSafeTable(tableId));
        }

        await this.resolveBets(tableId);
    },

    async resolveBets(tableId = 'default') {
        const table = this.getTable(tableId);
        const dealerTotal = this.calculateHand(table.dealerHand);
        const isDealerBJ = table.dealerHand.length === 2 && dealerTotal === 21;

        for (const player of table.players) {
            if (!player || player.bet === 0) continue;

            const playerTotal = this.calculateHand(player.hand);
            const isPlayerBJ = player.hand.length === 2 && playerTotal === 21;
            let winnings = 0;
            let resultType = 'loss';

            if (playerTotal > 21) {
                player.result = 'Przegrana';
            } else if (isPlayerBJ && !isDealerBJ) {
                player.result = 'Blackjack!';
                winnings = Math.floor(player.bet * 2.5);
                resultType = 'blackjack';
            } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
                player.result = 'Wygrana';
                winnings = player.bet * 2;
                resultType = 'win';
            } else if (playerTotal === dealerTotal) {
                player.result = 'Remis';
                winnings = player.bet;
                resultType = 'refund';
            } else {
                player.result = 'Przegrana';
            }

            if (winnings > 0) {
                const user = await User.findOne({ where: { username: player.username } });
                if (user) {
                    user.balance += winnings;
                    await user.save();
                    await Transaction.create({ userId: user.id, balanceChange: winnings, type: resultType });
                }
            }
        }
        
        table.phase = 'results';
        this.io.to(tableId).emit('round_result', this.getSafeTable(tableId));
        setTimeout(() => this.resetTable(tableId), 8000);
    },

    resetTable(tableId = 'default') {
        const table = this.getTable(tableId);
        table.players.forEach(p => {
            if(p) {
                p.hand = [];
                p.bet = 0;
                p.status = 'waiting';
                p.result = '';
            }
        });
        table.dealerHand = [];
        table.phase = 'waiting_for_bets';
        table.currentPlayerIndex = 0;
        if(table.countdown) {
            clearInterval(table.countdown);
            table.countdown = null;
        }
        this.io.to(tableId).emit('table_update', this.getSafeTable(tableId));
    }
};

module.exports = blackjackService;