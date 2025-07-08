const crashService = require('../services/crash.service');

module.exports = (socket, io) => {
    socket.on('crash_bet', async ({ username, amount }) => {
        await crashService.addBet(username, amount);
        io.emit('crash_players_update', crashService.players);
    });

    socket.on('crash_cashout', async ({ username }) => {
        await crashService.cashout(username);
        io.emit('crash_players_update', crashService.players);
    });

    socket.on('get_crash_state', () => {
        socket.emit('crash_state', {
            phase: crashService.phase,
            multiplier: crashService.multiplier,
            players: crashService.players,
            history: crashService.history,
        });
    });
};