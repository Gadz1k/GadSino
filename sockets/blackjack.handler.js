const blackjackService = require('../services/blackjack.service');
const User = require('../models/user');
const Transaction = require('../models/transaction');

module.exports = (socket, io) => {
    const tableId = 'default'; // Zakładamy, że jest tylko jeden stół

    // Gracz prosi o stan stołu
    socket.on('get_table_state', () => {
        socket.emit('table_update', blackjackService.getSafeTable(tableId));
    });

    // Gracz dołącza do stołu
    socket.on('join_table', ({ username, slotIndex }) => {
        const table = blackjackService.getTable(tableId);
        if (!table || slotIndex < 0 || slotIndex >= table.players.length) return;

        // Sprawdź, czy gracz już nie siedzi lub czy slot jest zajęty
        const isAlreadySeated = table.players.some(p => p?.username === username);
        if (isAlreadySeated || table.players[slotIndex]) return;

        table.players[slotIndex] = { username, hand: [], bet: 0, status: 'waiting', result: '' };
        socket.join(tableId);
        io.to(tableId).emit('table_update', blackjackService.getSafeTable(tableId));
    });

    // Gracz opuszcza stół
    socket.on('leave_table', ({ username }) => {
        const table = blackjackService.getTable(tableId);
        if (!table) return;

        const playerIndex = table.players.findIndex(p => p?.username === username);
        if (playerIndex !== -1) {
            table.players[playerIndex] = null;
            socket.leave(tableId);
            io.to(tableId).emit('table_update', blackjackService.getSafeTable(tableId));
        }
    });

    // Gracz stawia zakład
    socket.on('place_bet', async ({ username, amount }) => {
        const table = blackjackService.getTable(tableId);
        if (!table || table.phase !== 'waiting_for_bets' || !amount || amount <= 0) return;

        const player = table.players.find(p => p?.username === username);
        const user = await User.findOne({ where: { username } });

        if (!player || !user || user.balance < amount) return;

        // Aktualizuj bazę danych i stan gry
        user.balance -= amount;
        await user.save();
        await Transaction.create({ userId: user.id, balanceChange: -amount, type: 'bet' });

        player.bet += amount;
        player.status = 'bet_placed';

        io.to(tableId).emit('table_update', blackjackService.getSafeTable(tableId));

        // Start odliczania, jeśli to pierwszy gracz i nie ma jeszcze odliczania
        const activePlayers = table.players.filter(p => p && p.bet > 0).length;
        if (activePlayers > 0 && !table.countdown) {
            table.countdownValue = 8;
            table.countdown = setInterval(() => {
                table.countdownValue--;
                io.to(tableId).emit('countdown_tick', table.countdownValue);
                if (table.countdownValue <= 0) {
                    clearInterval(table.countdown);
                    table.countdown = null;
                    blackjackService.startRound(tableId);
                }
            }, 1000);
        }
    });

    // Gracz wykonuje ruch (hit, stand, etc.)
    socket.on('player_action', async ({ username, action }) => {
        const table = blackjackService.getTable(tableId);
        const player = table.players[table.currentPlayerIndex];

        if (!player || player.username !== username || table.phase !== 'playing') return;

        // Logika dla 'hit'
        if (action === 'hit') {
            player.hand.push(blackjackService.drawCard(tableId));
            const total = blackjackService.calculateHand(player.hand);
            if (total >= 21) {
                await blackjackService.nextTurn(tableId);
            }
        }

        // Logika dla 'stand'
        if (action === 'stand') {
            await blackjackService.nextTurn(tableId);
        }

        if (action === 'double') {
            await blackjackService.doubleDown(username, tableId);
        }

        if (action === 'split') {
            await blackjackService.split(username, tableId);
        }
        
        // Można tutaj dodać logikę dla 'double' i 'split' w podobny sposób

        io.to(tableId).emit('table_update', blackjackService.getSafeTable(tableId));
    });

    // Gracz odświeża stronę i chce zsynchronizować stan
    socket.on('sync_state', ({ username }) => {
        const table = blackjackService.getTable(tableId);
        if (!table) return;

        const player = table.players.find(p => p?.username === username);
        if (!player) return;
        
        socket.emit('table_update', blackjackService.getSafeTable(tableId));
        
        // Jeśli jest jego tura, wyślij ponownie powiadomienie
        if (table.phase === 'playing' && table.players[table.currentPlayerIndex]?.username === username) {
            socket.emit('your_turn', username);
        }
    });
};