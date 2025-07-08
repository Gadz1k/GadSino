const crypto = require('crypto');
const User = require('../models/user');
const Transaction = require('../models/transaction');

const crashService = {
    io: null,
    phase: 'waiting', // waiting, betting, running, crashed
    multiplier: 1.00,
    crashPoint: 0,
    players: {}, // { username: { bet: 100, cashoutAt: null, status: 'playing' } }
    history: [], // przechowuje ostatnie 10 crashów
    startTime: null,

    initialize(ioInstance) {
        this.io = ioInstance;
        this.runGameLoop();
    },

    generateCrashPoint() {
        const e = 2 ** 32;
        const h = crypto.randomInt(0, e - 1);

        if (h % 25 === 0) {
            return 1.00;
        }

        const houseEdge = 0.99;
        const crashPoint = Math.floor(100 * houseEdge * e / (e - h)) / 100;
        return Math.max(1.00, crashPoint);
    },

    runGameLoop() {
        this.phase = 'betting';
        this.players = {};
        this.crashPoint = this.generateCrashPoint();
        let bettingTimeLeft = 10;

        this.io.emit('crash_state', { phase: 'betting', history: this.history });

        const bettingInterval = setInterval(() => {
            bettingTimeLeft--;
            this.io.emit('crash_bet_tick', bettingTimeLeft);
            if (bettingTimeLeft <= 0) {
                clearInterval(bettingInterval);

                this.phase = 'running';
                this.multiplier = 1.00;
                this.startTime = Date.now();
                this.io.emit('crash_state', { phase: 'running', players: this.players });

                const gameInterval = setInterval(() => {
                    const elapsedTime = (Date.now() - this.startTime) / 1000;
                    this.multiplier = Math.pow(1.05, elapsedTime).toFixed(2);

                    if (this.multiplier >= this.crashPoint) {
                        clearInterval(gameInterval);
                        this.phase = 'crashed';
                        this.history.unshift(this.crashPoint);
                        if (this.history.length > 10) this.history.pop();

                        this.io.emit('crash_state', {
                            phase: 'crashed',
                            crashPoint: this.crashPoint,
                            history: this.history
                        });
                        
                        setTimeout(() => this.runGameLoop(), 5000);
                    } else {
                        this.io.emit('crash_tick', this.multiplier);
                    }
                }, 100);
            }
        }, 1000);
    },

    async addBet(username, amount) {
        if (this.phase !== 'betting' || this.players[username] || !amount || amount <= 0) return;

        const user = await User.findOne({ where: { username } });
        if (!user || user.balance < amount) return;

        user.balance -= amount;
        await user.save();
        await Transaction.create({ userId: user.id, balanceChange: -amount, type: 'crash_bet' });

        this.players[username] = { bet: amount, status: 'playing', cashoutAt: null, winnings: 0 };
        this.io.emit('crash_players_update', this.players);
    },

    async cashout(username) {
        const player = this.players[username];
        if (this.phase !== 'running' || !player || player.status !== 'playing') return;

        const cashoutMultiplier = this.multiplier;
        const winnings = Math.floor(player.bet * cashoutMultiplier);

        player.status = 'cashed_out';
        player.cashoutAt = cashoutMultiplier;
        player.winnings = winnings;

        const user = await User.findOne({ where: { username } });
        if (user) {
            user.balance += winnings;
            await user.save();
            await Transaction.create({ userId: user.id, balanceChange: winnings, type: 'crash_win' });
        }

        this.io.emit('crash_players_update', this.players);
    }
};

module.exports = crashService;