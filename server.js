// 📦 Express + Socket.IO backend for Karol's Kasyno Blackjack – Multiplayer Realtime Edition

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const port = 3000;

let players = {};  // { username: { balance, history } }
let tables = {};   // { tableId: { players, dealerHand, status } }

app.use(cors());
app.use(express.json());

function drawCard() {
  const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11];
  return values[Math.floor(Math.random() * values.length)];
}

function calculateHand(hand) {
  let total = hand.reduce((a, b) => a + b, 0);
  let aces = hand.filter(c => c === 11).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

app.post('/register', (req, res) => {
  const { username } = req.body;
  if (players[username]) return res.status(400).json({ message: 'Użytkownik już istnieje.' });
  players[username] = { balance: 100, history: [] };
  res.json({ message: `Zarejestrowano gracza ${username}`, balance: 100 });
});

app.post('/create-table', (req, res) => {
  const tableId = uuidv4();
  tables[tableId] = { players: [], dealerHand: [], status: 'waiting' };
  res.json({ tableId });
});

app.post('/join-table', (req, res) => {
  const { username, tableId } = req.body;
  const player = players[username];
  const table = tables[tableId];

  if (!player) return res.status(404).json({ message: 'Gracz nie istnieje.' });
  if (!table) return res.status(404).json({ message: 'Stół nie istnieje.' });
  if (table.players.find(p => p.username === username)) return res.status(400).json({ message: 'Już jesteś przy tym stole.' });
  if (table.players.length >= 4) return res.status(400).json({ message: 'Stół pełny.' });

  table.players.push({ username, hand: [], bet: 0, status: 'waiting' });
  io.to(tableId).emit('table_update', table);
  res.json({ message: `Dołączono do stołu ${tableId}`, players: table.players.map(p => p.username) });
});

app.get('/player/:username', (req, res) => {
  const player = players[req.params.username];
  if (!player) return res.status(404).json({ message: 'Nie znaleziono gracza.' });
  res.json(player);
});

io.on('connection', (socket) => {
  console.log('🧠 Nowe połączenie:', socket.id);

  socket.on('join_table', ({ tableId, username }) => {
    socket.join(tableId);
    const table = tables[tableId];
    if (table) {
      io.to(tableId).emit('table_update', table);
    }
  });

  socket.on('start_round', ({ tableId }) => {
    const table = tables[tableId];
    if (!table) return;
    table.dealerHand = [drawCard()];

    table.players.forEach(player => {
      player.hand = [drawCard(), drawCard()];
      player.status = 'playing';
    });

    io.to(tableId).emit('round_started', table);

    setTimeout(() => {
      io.to(tableId).emit('timer_end');
      // Tu potem logika rozstrzygnięcia rundy
    }, 15000);
  });
});

server.listen(port, () => {
  console.log(`🃏 Kasyno Blackjack Multiplayer działa na http://localhost:${port}`);
});
