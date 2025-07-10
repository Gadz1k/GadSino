require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// Importy z nowej struktury
const sequelize = require('./config/sequelize');
const initializeSockets = require('./sockets');

// Importy serwisów gier
const crashService = require('./services/crash.service');   
const blackjackService = require('./services/blackjack.service');
// const rouletteService = require('./services/roulette.service');

// Importy tras
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const gameRoutes = require('./routes/games.routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(cors());
app.use(express.json());

// Rejestracja tras
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/games', gameRoutes);

// Inicjalizacja Socket.IO
initializeSockets(io);

// Inicjalizacja pętli gier
crashService.initialize(io);
blackjackService.initialize(io);
// rouletteService.initialize(io);

const PORT = process.env.PORT || 3000;

// Start serwera
sequelize.sync().then(() => {
    server.listen(PORT, () => console.log(`🚀 Serwer działa na porcie ${PORT}`));
}).catch(err => console.error('❌ Błąd połączenia z bazą danych:', err));