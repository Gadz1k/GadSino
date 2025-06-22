require('dotenv').config();  // dodaj na górze, żeby czytać .env

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const sequelize = require('./sequelize'); // twoja konfiguracja Sequelize
const User = require('./models/user'); // model User

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const port = process.env.PORT || 3000;

// Tablice i funkcje z gry (bez zmian)
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

// Funkcje do blackjacka (bez zmian)
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

// REJESTRACJA
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Wypełnij wszystkie pola.' });
  }

  try {
    // Sprawdź czy istnieje użytkownik o takim emailu
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: 'Użytkownik z tym emailem już istnieje.' });
    }

    // Hashuj hasło
    const hashedPassword = await bcrypt.hash(password, 10);

    // Twórz użytkownika
    const newUser = await User.create({
      username,
      email,
      password: hashedPassword,
      balance: 1000  // domyślne saldo
    });

    res.json({ message: 'Zarejestrowano pomyślnie.', userId: newUser.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// LOGOWANIE
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ message: 'Podaj email i hasło.' });

  try {
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(400).json({ message: 'Nieprawidłowy email lub hasło.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Nieprawidłowy email lub hasło.' });

    // Tworzymy token JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ message: 'Zalogowano pomyślnie.', token, username: user.username, balance: user.balance });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// Endpoint do pobrania danych o graczu po username (już w bazie)
app.get('/player/:username', async (req, res) => {
  try {
    const user = await User.findOne({ where: { username: req.params.username } });
    if (!user) return res.status(404).json({ message: 'Nie znaleziono gracza.' });

    res.json({ username: user.username, balance: user.balance });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

// --- Kod z blackjacka, socket.io i reszta gry ---

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
    if (!player) return;

    // Pobierz saldo z bazy
    User.findOne({ where: { username } }).then(user => {
      if (!user || user.balance < amount) return;

      player.bet = amount;
      player.status = 'bet_placed';

      // Aktualizuj saldo w bazie
      user.balance -= amount;
      user.save();

      if (table.players.every(p => !p || p.bet > 0 || p.status === 'waiting')) {
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

//... dalej funkcje startRound, promptNextPlayer, nextTurn, playDealer, resetTable bez zmian (dodaj jak miałeś wcześniej) ...

// Reszta kodu z blackjacka tutaj (żeby nie było niedomówień):

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
      // Aktualizacja salda w bazie:
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += p.bet * 2;
          user.save();
        }
      });
    } else if (playerTotal === dealerTotal) {
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

// DEBUG: Zwróć wszystkich użytkowników (TYLKO DO TESTÓW)
app.get('/users', async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'email', 'balance', 'createdAt']
    });
    res.json(users);
  } catch (err) {
    console.error('Błąd pobierania użytkowników:', err);
    res.status(500).json({ message: 'Błąd serwera.' });
  }
});

sequelize.sync().then(() => {
  server.listen(port, () => {
    console.log(`🃏 Kasyno Blackjack Multiplayer działa na http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Błąd synchronizacji bazy:', err);
});

