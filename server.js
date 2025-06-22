require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const sequelize = require('./sequelize');
const User = require('./models/user');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const port = process.env.PORT || 3000;

let tables = {
  default: {
    players: Array(6).fill(null),
    dealerHand: [],
    status: 'waiting',
    phase: 'waiting_for_bets',
    currentPlayerIndex: 0
  }
};

app.use(cors());
app.use(express.json());

function drawCard() {
  const values = [2,3,4,5,6,7,8,9,10,10,10,10,11];
  return values[Math.floor(Math.random()*values.length)];
}

function calculateHand(hand) {
  let total = hand.reduce((a,b)=>a+(typeof b==='number'?b:0),0);
  let aces = hand.filter(c=>c===11).length;
  while(total>21 && aces>0){total-=10;aces--;}
  return total;
}

// 🟢 Endpoint rejestracji
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      balance: 1000
    });
    res.status(201).json({ username: user.username });
  } catch (error) {
    res.status(400).json({ message: 'Użytkownik już istnieje lub błąd danych.' });
  }
});

// 🔵 Endpoint logowania
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ where: { username } });
  if (!user) return res.status(400).json({ message: 'Użytkownik nie istnieje.' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ message: 'Niepoprawne hasło.' });

  res.json({ username: user.username, balance: user.balance });
});

io.on('connection', socket => {
  console.log('🧠 Nowe połączenie:', socket.id);

  socket.on('get_table_state', ({ tableId }) => {
    const table = tables[tableId];
    if (table) {
      socket.emit('table_update', table);
    }
  });

  socket.on('join_table', ({ tableId, username, slotIndex }) => {
    const table = tables[tableId];
    if (!table) return;

    const alreadyJoined = table.players.some(p => p?.username === username);
    if (alreadyJoined) return;

    if (slotIndex >= 0 && slotIndex < 6 && !table.players[slotIndex]) {
      table.players[slotIndex] = { username, hand: [], bet: 0, status: 'waiting', result: '' };
      socket.join(tableId);
      io.to(tableId).emit('table_update', table);
    }
  });

  socket.on('leave_table', ({ tableId, username }) => {
    const table = tables[tableId];
    if (!table) return;
    table.players = table.players.map(p => (p?.username === username ? null : p));
    io.to(tableId).emit('table_update', table);
  });

  socket.on('place_bet', ({ tableId, username, amount }) => {
    const table = tables[tableId];
    if (!table || table.phase !== 'waiting_for_bets') return;

    const player = table.players.find(p => p && p.username === username);
    if (!player) return;

    User.findOne({ where: { username } }).then(user => {
      if (!user || user.balance < amount) return;

      player.bet = amount;
      player.status = 'bet_placed';
      user.balance -= amount;
      user.save();

      const activePlayers = table.players.filter(p => p && p.bet > 0);
      if (activePlayers.length >= 1 && table.players.every(p => !p || p.bet > 0 || p.status === 'waiting')) {
        startRound(tableId);
      } else {
        io.to(tableId).emit('table_update', table);
      }
    });
  });

  socket.on('player_action', ({ tableId, username, action }) => {
    const table = tables[tableId];
    const current = table.players[table.currentPlayerIndex];
    if (!current || current.username !== username) return;

    if (action === 'hit') {
      current.hand.push(drawCard());
      io.to(tableId).emit('player_updated', { username: current.username, hand: current.hand });
      if (calculateHand(current.hand) > 21) {
        current.status = 'bust';
        nextTurn(tableId);
      }
    } else if (action === 'stand') {
      current.status = 'stand';
      nextTurn(tableId);
    }
    io.to(tableId).emit('table_update', table);
  });
});

function startRound(tableId) {
  const table = tables[tableId];
  table.dealerHand = [drawCard(), '❓'];
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
  let idx = table.currentPlayerIndex;
  while (idx < table.players.length && (!table.players[idx] || table.players[idx].status !== 'playing')) idx++;
  if (idx >= table.players.length) {
    playDealer(tableId);
  } else {
    table.currentPlayerIndex = idx;
    io.to(tableId).emit('your_turn', table.players[idx].username);
  }
}

function nextTurn(tableId) {
  tables[tableId].currentPlayerIndex++;
  promptNextPlayer(tableId);
}

function playDealer(tableId) {
  const table = tables[tableId];
  if (table.dealerHand[1] === '❓') table.dealerHand[1] = drawCard();
  let total = calculateHand(table.dealerHand);
  while (total < 17) {
    table.dealerHand.push(drawCard());
    total = calculateHand(table.dealerHand);
  }

  table.players.forEach(p => {
    if (!p) return;
    const playerTotal = calculateHand(p.hand);
    if (playerTotal > 21) {
      p.result = 'Przegrana';
    } else if (total > 21 || playerTotal > total) {
      p.result = 'Wygrana';
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += p.bet * 2;
          user.save();
        }
      });
    } else if (playerTotal === total) {
      p.result = 'Remis';
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += p.bet;
          user.save();
        }
      });
    } else {
      p.result = 'Przegrana';
    }
  });

  io.to(tableId).emit('round_result', table);
  setTimeout(() => resetTable(tableId), 8000);
}

function resetTable(tableId) {
  const table = tables[tableId];
  table.players = table.players.map(p => p ? { ...p, hand: [], bet: 0, status: 'waiting', result: '' } : null);
  table.dealerHand = [];
  table.phase = 'waiting_for_bets';
  table.currentPlayerIndex = 0;
  io.to(tableId).emit('table_update', table);
}

app.get('/player/:username', async (req, res) => {
  const user = await User.findOne({ where: { username: req.params.username } });
  if (!user) return res.status(404).json({ balance: 0 });
  res.json({ balance: user.balance });
});

app.get('/users', async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'email', 'balance', 'createdAt']
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania użytkowników.' });
  }
});

sequelize.sync().then(() => {
  server.listen(port, () => console.log(`🃏 Serwer blackjack działa na http://localhost:${port}`));
}).catch(err => console.error('Błąd bazy danych:', err));