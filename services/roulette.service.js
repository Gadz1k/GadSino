const crypto = require('crypto');
const User = require('../models/user');
const Transaction = require('../models/transaction');

const ROULETTE_NUMBERS = {
    0: 'green', 32: 'red', 15: 'black', 19: 'red', 4: 'black', 21: 'red', 2: 'black',
    25: 'red', 17: 'black', 34: 'red', 6: 'black', 27: 'red', 13: 'black', 36: 'red',
    11: 'black', 30: 'red', 8: 'black', 23: 'red', 10: 'black', 5: 'red', 24: 'black',
    16: 'red', 33: 'black', 1: 'red', 20: 'black', 14: 'red', 31: 'black', 9: 'red',
    22: 'black', 18: 'red', 29: 'black', 7: 'red', 28: 'black', 12: 'red', 35: 'black',
    3: 'red', 26: 'black'
};

const ROULETTE_BETS = {
    'straight': { payout: 36, type: 'number' },
    'red': { payout: 2, condition: (num) => num > 0 && ROULETTE_NUMBERS[num] === 'red' },
    'black': { payout: 2, condition: (num) => num > 0 && ROULETTE_NUMBERS[num] === 'black' },
    'even': { payout: 2, condition: (num) => num > 0 && num % 2 === 0 },
    'odd': { payout: 2, condition: (num) => num > 0 && num % 2 !== 0 },
    'low': { payout: 2, condition: (num) => num >= 1 && num <= 18 },
    'high': { payout: 2, condition: (num) => num >= 19 && num <= 36 },
    'dozen1': { payout: 3, condition: (num) => num >= 1 && num <= 12 },
    'dozen2': { payout: 3, condition: (num) => num >= 13 && num <= 24 },
    'dozen3': { payout: 3, condition: (num) => num >= 25 && num <= 36 },
    'col1': { payout: 3, condition: (num) => num > 0 && num % 3 === 1 },
    'col2': { payout: 3, condition: (num) => num > 0 && num % 3 === 2 },
    'col3': { payout: 3, condition: (num) => num > 0 && num % 3 === 0 },
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const rouletteService = {
    io: null,
    phase: 'waiting',
    players: {},
    history: [],
    winningNumber: null,

    initialize(ioInstance) {
        this.io = ioInstance;
        this.runGameLoop();
    },
    
    async runGameLoop() {
        this.phase = 'betting';
        this.players = {};
        this.io.emit('roulette_state', { phase: 'betting', history: this.history, players: this.players });

        let bettingTimeLeft = 20;
        const bettingInterval = setInterval(() => {
            bettingTimeLeft--;
            this.io.emit('roulette_bet_tick', bettingTimeLeft);
            if (bettingTimeLeft <= 0) {
                clearInterval(bettingInterval);
                this.startSpinning();
            }
        }, 1000);
    },

    async startSpinning() {
        this.phase = 'spinning';
        this.winningNumber = crypto.randomInt(0, 37); // 0-36
        this.io.emit('roulette_state', { phase: 'spinning' });

        await sleep(8000); // Czas na animację

        this.phase = 'result';
        this.history.unshift(this.winningNumber);
        if (this.history.length > 15) this.history.pop();
        
        await this.resolveBets();

        this.io.emit('roulette_state', {
            phase: 'result',
            winningNumber: this.winningNumber,
            history: this.history,
            players: this.players
        });

        await sleep(7000);
        this.runGameLoop();
    },

    async resolveBets() {
        const num = this.winningNumber;
        for (const username in this.players) {
            let totalWinnings = 0;
            const user = await User.findOne({ where: { username } });
            if (!user) continue;

            for (const bet of this.players[username]) {
                let win = false;
                let betDefinitionKey = bet.betType.startsWith('straight_') ? 'straight' : bet.betType;
                const betDefinition = ROULETTE_BETS[betDefinitionKey];
                
                if (!betDefinition) continue;

                if (betDefinition.type === 'number') {
                    const betNumber = parseInt(bet.betType.split('_')[1]);
                    if (betNumber === num) win = true;
                } else if (betDefinition.condition(num)) {
                    win = true;
                }

                if (win) {
                    const winnings = Math.floor(bet.amount * betDefinition.payout);
                    totalWinnings += winnings;
                    bet.result = 'win';
                    bet.winnings = winnings;
                } else {
                    bet.result = 'loss';
                }
            }

            if (totalWinnings > 0) {
                user.balance += totalWinnings;
                await user.save();
                await Transaction.create({ userId: user.id, balanceChange: totalWinnings, type: 'roulette_win' });
            }
        }
    },

    async addBet(username, betType, amount) {
        if (this.phase !== 'betting' || !amount || amount <= 0) return;

        const user = await User.findOne({ where: { username } });
        if (!user || user.balance < amount) return;

        if (!this.players[username]) {
            this.players[username] = [];
        }

        user.balance -= amount;
        await user.save();
        await Transaction.create({ userId: user.id, balanceChange: -amount, type: 'roulette_bet' });

        const existingBet = this.players[username].find(b => b.betType === betType);
        if (existingBet) {
            existingBet.amount += amount;
        } else {
            this.players[username].push({ amount, betType });
        }
        
        this.io.emit('roulette_players_update', this.players);
    }
};

module.exports = rouletteService;