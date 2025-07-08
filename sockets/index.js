const crashHandler = require('./crash.handler');
// Importuj inne handlery, gdy je stworzysz
// const rouletteHandler = require('./roulette.handler');
// const blackjackHandler = require('./blackjack.handler');

function initializeSockets(io) {
    io.on('connection', (socket) => {
        console.log(`🔌 Użytkownik połączony: ${socket.id}`);

        crashHandler(socket, io);
        // rouletteHandler(socket, io);
        // blackjackHandler(socket, io);

        socket.on('disconnect', () => {
            console.log(`🔌 Użytkownik rozłączony: ${socket.id}`);
        });
    });
}

module.exports = initializeSockets;