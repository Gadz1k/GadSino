const rouletteService = require('../services/roulette.service');

module.exports = (socket, io) => {
    // Gracz stawia zakład
    socket.on('roulette_bet', async ({ username, betType, amount }) => {
        // Przekazujemy dane do serwisu, który zajmie się logiką
        await rouletteService.addBet(username, betType, amount);
    });

    // Gracz prosi o aktualny stan gry (np. po dołączeniu)
    socket.on('get_roulette_state', () => {
        socket.emit('roulette_state', {
            phase: rouletteService.phase,
            history: rouletteService.history,
            players: rouletteService.players,
            winningNumber: rouletteService.winningNumber
        });
    });
};