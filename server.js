<<<<<<< HEAD
// 📦 Express + Socket.IO backend for Karol's Kasyno Blackjack – Multiplayer Realtime Edition

const express = require('express');
const cors = require('cors');
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

let players = {}; // { username: { balance, history } }
let tables = {
  default: {
    players: Array(6).fill(null),
    dealerHand: [],
    status: 'waiting',
    phase: 'waiting_for_players',
    currentPlayerIndex: 0
  }
};

app.use(cors());
app.use(express.json());

function drawCard() {
  const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11];
  return values[Math.floor(Math.random() * values.length)];
}

function calculateHand(hand) {
  let total = hand.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
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
  players[username] = { balance: 1000, history: [] };
  res.json({ message: `Zarejestrowano gracza ${username}`, balance: 1000 });
});

app.post('/join-table', (req, res) => {
  const { username, tableId, slot } = req.body;
  const player = players[username];
  const table = tables[tableId];

  if (!player) return res.status(404).json({ message: 'Gracz nie istnieje.' });
  if (!table) return res.status(404).json({ message: 'Stół nie istnieje.' });
  if (slot < 0 || slot >= 6) return res.status(400).json({ message: 'Nieprawidłowy slot.' });
  if (table.players[slot]) return res.status(400).json({ message: 'Slot zajęty.' });
  if (table.players.some(p => p && p.username === username)) return res.status(400).json({ message: 'Już jesteś przy tym stole.' });

  table.players[slot] = { username, hand: [], bet: 0, status: 'waiting', slot };
  io.to(tableId).emit('table_update', table);
  res.json({ message: `Dołączono do stołu ${tableId}`, players: table.players.filter(p => p).map(p => p.username) });
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

  socket.on('place_bet', ({ tableId, username, amount }) => {
    const table = tables[tableId];
    const player = table.players.find(p => p && p.username === username);
    if (!player || players[username].balance < amount) return;

    player.bet = amount;
    player.status = 'bet_placed';
    players[username].balance -= amount;

    if (table.players.every(p => !p || p.bet > 0 || p.status === 'waiting')) {
      startRound(tableId);
    } else {
      io.to(tableId).emit('table_update', table);
    }
  });

  socket.on('player_action', ({ tableId, username, action }) => {
    const table = tables[tableId];
    const current = table.players[table.currentPlayerIndex];
    if (!current || current.username !== username) return;

    if (action === 'hit') {
      current.hand.push(drawCard());
      io.to(tableId).emit('player_updated', {
        username: current.username,
        hand: current.hand
      });
      io.to(tableId).emit('table_update', table);

      if (calculateHand(current.hand) > 21) {
        current.status = 'bust';
        nextTurn(tableId);
      }
    } else if (action === 'stand') {
      current.status = 'stand';
      nextTurn(tableId);
    }
  });
});

function startRound(tableId) {
  const table = tables[tableId];
  table.dealerHand = [drawCard(), '?'];
  table.players.forEach(p => {
    if (p) {
      p.hand = [drawCard(), drawCard()];
      p.status = 'playing';
    }
  });
  table.phase = 'playing';
  table.currentPlayerIndex = 0;
  io.to(tableId).emit('round_started', table);
  promptNextPlayer(tableId);
}

function promptNextPlayer(tableId) {
  const table = tables[tableId];
  let currentIndex = table.currentPlayerIndex;

  while (currentIndex < table.players.length && (!table.players[currentIndex] || table.players[currentIndex].status !== 'playing')) {
    currentIndex++;
  }
  table.currentPlayerIndex = currentIndex;

  const player = table.players[currentIndex];
  if (!player) {
    playDealer(tableId);
  } else {
    io.to(tableId).emit('your_turn', player.username);
  }
}

function nextTurn(tableId) {
  const table = tables[tableId];
  table.currentPlayerIndex++;
  promptNextPlayer(tableId);
}

function playDealer(tableId) {
  const table = tables[tableId];
  if (table.dealerHand[1] === '?') {
    table.dealerHand[1] = drawCard();
  }

  let total = calculateHand(table.dealerHand);
  while (total < 17) {
    table.dealerHand.push(drawCard());
    total = calculateHand(table.dealerHand);
  }

  table.players.forEach(p => {
    if (!p) return;
    const playerTotal = calculateHand(p.hand);
    const dealerTotal = total;
    if (playerTotal > 21) {
      p.result = 'Przegrana';
    } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
      p.result = 'Wygrana';
      players[p.username].balance += p.bet * 2;
    } else if (playerTotal === dealerTotal) {
      p.result = 'Remis';
      players[p.username].balance += p.bet;
    } else {
      p.result = 'Przegrana';
    }
  });

  io.to(tableId).emit('round_result', table);
  setTimeout(() => resetTable(tableId), 8000);
}

function resetTable(tableId) {
  const table = tables[tableId];
  table.players.forEach((p, i) => {
    if (p) {
      table.players[i] = { ...p, hand: [], bet: 0, status: 'waiting', result: '' };
    }
  });
  table.dealerHand = [];
  table.phase = 'waiting_for_bets';
  table.currentPlayerIndex = 0;
  io.to(tableId).emit('table_update', table);
}

server.listen(port, () => {
  console.log(`🃏 Kasyno Blackjack Multiplayer działa na http://localhost:${port}`);
});
=======
// 📦 Express + Socket.IO backend for Karol's Kasyno Blackjack – Multiplayer Realtime Edition

const express = require('express');
const cors = require('cors');
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

let players = {}; // { username: { balance, history } }
let tables = {
  default: {
    players: Array(6).fill(null),
    dealerHand: [],
    status: 'waiting',
    phase: 'waiting_for_players',
    currentPlayerIndex: 0
  }
};

app.use(cors());
app.use(express.json());

function drawCard() {
  const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11];
  return values[Math.floor(Math.random() * values.length)];
}

function calculateHand(hand) {
  let total = hand.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
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
  players[username] = { balance: 1000, history: [] };
  res.json({ message: `Zarejestrowano gracza ${username}`, balance: 1000 });
});

app.post('/join-table', (req, res) => {
  const { username, tableId, slot } = req.body;
  const player = players[username];
  const table = tables[tableId];

  if (!player) return res.status(404).json({ message: 'Gracz nie istnieje.' });
  if (!table) return res.status(404).json({ message: 'Stół nie istnieje.' });
  if (slot < 0 || slot >= 6) return res.status(400).json({ message: 'Nieprawidłowy slot.' });
  if (table.players[slot]) return res.status(400).json({ message: 'Slot zajęty.' });
  if (table.players.some(p => p && p.username === username)) return res.status(400).json({ message: 'Już jesteś przy tym stole.' });

  table.players[slot] = { username, hand: [], bet: 0, status: 'waiting', slot };
  io.to(tableId).emit('table_update', table);
  res.json({ message: `Dołączono do stołu ${tableId}`, players: table.players.filter(p => p).map(p => p.username) });
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

  socket.on('place_bet', ({ tableId, username, amount }) => {
    const table = tables[tableId];
    const player = table.players.find(p => p && p.username === username);
    if (!player || players[username].balance < amount) return;

    player.bet = amount;
    player.status = 'bet_placed';
    players[username].balance -= amount;

    if (table.players.every(p => !p || p.bet > 0 || p.status === 'waiting')) {
      startRound(tableId);
    } else {
      io.to(tableId).emit('table_update', table);
    }
  });

  socket.on('player_action', ({ tableId, username, action }) => {
    const table = tables[tableId];
    const current = table.players[table.currentPlayerIndex];
    if (!current || current.username !== username) return;

    if (action === 'hit') {
      current.hand.push(drawCard());
      io.to(tableId).emit('player_updated', {
        username: current.username,
        hand: current.hand
      });
      io.to(tableId).emit('table_update', table);

      if (calculateHand(current.hand) > 21) {
        current.status = 'bust';
        nextTurn(tableId);
      }
    } else if (action === 'stand') {
      current.status = 'stand';
      nextTurn(tableId);
    }
  });
});

function startRound(tableId) {
  const table = tables[tableId];
  table.dealerHand = [drawCard(), '?'];
  table.players.forEach(p => {
    if (p) {
      p.hand = [drawCard(), drawCard()];
      p.status = 'playing';
    }
  });
  table.phase = 'playing';
  table.currentPlayerIndex = 0;
  io.to(tableId).emit('round_started', table);
  promptNextPlayer(tableId);
}

function promptNextPlayer(tableId) {
  const table = tables[tableId];
  let currentIndex = table.currentPlayerIndex;

  while (currentIndex < table.players.length && (!table.players[currentIndex] || table.players[currentIndex].status !== 'playing')) {
    currentIndex++;
  }
  table.currentPlayerIndex = currentIndex;

  const player = table.players[currentIndex];
  if (!player) {
    playDealer(tableId);
  } else {
    io.to(tableId).emit('your_turn', player.username);
  }
}

function nextTurn(tableId) {
  const table = tables[tableId];
  table.currentPlayerIndex++;
  promptNextPlayer(tableId);
}

function playDealer(tableId) {
  const table = tables[tableId];
  if (table.dealerHand[1] === '?') {
    table.dealerHand[1] = drawCard();
  }

  let total = calculateHand(table.dealerHand);
  while (total < 17) {
    table.dealerHand.push(drawCard());
    total = calculateHand(table.dealerHand);
  }

  table.players.forEach(p => {
    if (!p) return;
    const playerTotal = calculateHand(p.hand);
    const dealerTotal = total;
    if (playerTotal > 21) {
      p.result = 'Przegrana';
    } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
      p.result = 'Wygrana';
      players[p.username].balance += p.bet * 2;
    } else if (playerTotal === dealerTotal) {
      p.result = 'Remis';
      players[p.username].balance += p.bet;
    } else {
      p.result = 'Przegrana';
    }
  });

  io.to(tableId).emit('round_result', table);
  setTimeout(() => resetTable(tableId), 8000);
}

function resetTable(tableId) {
  const table = tables[tableId];
  table.players.forEach((p, i) => {
    if (p) {
      table.players[i] = { ...p, hand: [], bet: 0, status: 'waiting', result: '' };
    }
  });
  table.dealerHand = [];
  table.phase = 'waiting_for_bets';
  table.currentPlayerIndex = 0;
  io.to(tableId).emit('table_update', table);
}

server.listen(port, () => {
  console.log(`🃏 Kasyno Blackjack Multiplayer działa na http://localhost:${port}`);
});
>>>>>>> 9acdbda (first vsc commit)
