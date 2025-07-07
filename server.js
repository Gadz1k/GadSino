require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const sequelize = require('./sequelize');
const User = require('./models/user');
const Transaction = require('./models/transaction');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
const port = process.env.PORT || 3000;

// =======================================================
//          DEFINICJE I STAŁE GRY W RULETKĘ
// =======================================================
const ROULETTE_NUMBERS = {
    0: 'green', 32: 'red', 15: 'black', 19: 'red', 4: 'black', 21: 'red', 2: 'black',
    25: 'red', 17: 'black', 34: 'red', 6: 'black', 27: 'red', 13: 'black', 36: 'red',
    11: 'black', 30: 'red', 8: 'black', 23: 'red', 10: 'black', 5: 'red', 24: 'black',
    16: 'red', 33: 'black', 1: 'red', 20: 'black', 14: 'red', 31: 'black', 9: 'red',
    22: 'black', 18: 'red', 29: 'black', 7: 'red', 28: 'black', 12: 'red', 35: 'black',
    3: 'red', 26: 'black'
};

// Definicje każdego możliwego zakładu, jego wypłaty i warunków wygranej
const ROULETTE_BETS = {
    'straight': { payout: 36, type: 'number' },
    'red': { payout: 2, condition: (num) => num > 0 && ROULETTE_NUMBERS[num] === 'red' },
    'black': { payout: 2, condition: (num) => num > 0 && ROULETTE_NUMBERS[num] === 'black' },
    'even': { payout: 2, condition: (num) => num > 0 && num % 2 === 0 },
    'odd': { payout: 2, condition: (num) => num > 0 && num % 2 !== 0 },
    'low': { payout: 2, condition: (num) => num >= 1 && num <= 18 },
    'high': { payout: 2, condition: (num) => num >= 19 && num <= 36 },
    'dozen1': { payout: 3, condition: (num) => num >= 1 && num <= 12 },
    'dozen2': { payout: 3, condition: (num) => num >= 13 && num <= 24 },
    'dozen3': { payout: 3, condition: (num) => num >= 25 && num <= 36 },
    'col1': { payout: 3, condition: (num) => num > 0 && num % 3 === 1 },
    'col2': { payout: 3, condition: (num) => num > 0 && num % 3 === 2 },
    'col3': { payout: 3, condition: (num) => num > 0 && num % 3 === 0 },
};

// =======================================================
//          KONFIGURACJA GRY PLINKO
// =======================================================
const PLINKO_ROWS = 12; // Liczba rzędów kołków
// Mnożniki na dole piramidy, od lewej do prawej
const PLINKO_MULTIPLIERS = [16, 9, 2, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 2, 9, 16];

function createShoe(decks = 3) {
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits = ['clubs', 'diamonds', 'hearts', 'spades'];
  let shoe = [];
  for (let i = 0; i < decks; i++) {
    for (let rank of ranks) {
      for (let suit of suits) {
        shoe.push({ rank, suit });
      }
    }
  }
  return shuffle(shoe);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getSafeTable(table) {
  const { countdown, ...safe } = table;

  const dealerCards = table.dealerHand || [];
  const dealerHasHidden = dealerCards.some(c => c.rank === '❓');
  const dealerValue = dealerHasHidden ? null : calculateHand(dealerCards);

  return {
    ...safe,
    shoeSize: table.shoe.length,
    dealerValue
  };
}


let tables = {
  default: {
    players: Array(5).fill(null),
    dealerHand: [],
    phase: 'waiting_for_bets',
    currentPlayerIndex: 0,
    countdown: null,
    countdownValue: 8,
    shoe: createShoe()
  }
};

// =======================================================
//          LOGIKA GRY "CRASH" - CZĘŚĆ GŁÓWNA
// =======================================================

const crashGame = {
  phase: 'waiting', // waiting, betting, running, crashed
  multiplier: 1.00,
  crashPoint: 0,
  players: {}, // { username: { bet: 100, cashoutAt: null, status: 'playing' } }
  history: [], // przechowuje ostatnie 10 crashów
  startTime: null
};

function generateCrashPoint() {
  const e = 2 ** 32;
  const h = crypto.randomInt(0, e - 1);

  // Szansa 1 do 25 na natychmiastowy crash na 1.00x
  if (h % 25 === 0) {
    return 1.00;
  }

  const houseEdge = 0.99; // 99% RTP (Return to Player)

  // Poprawiona formuła matematyczna
  const crashPoint = Math.floor(100 * houseEdge * e / (e - h)) / 100;
  
  return Math.max(1.00, crashPoint); // Zabezpieczenie, aby nigdy nie zwrócić mniej niż 1.00
}

async function runCrashGame() {
  crashGame.phase = 'betting';
  crashGame.players = {};
  crashGame.crashPoint = generateCrashPoint();
  let bettingTimeLeft = 10;

  io.emit('crash_state', { phase: 'betting', history: crashGame.history });

  const bettingInterval = setInterval(() => {
    bettingTimeLeft--;
    io.emit('crash_bet_tick', bettingTimeLeft);
    if (bettingTimeLeft <= 0) {
      clearInterval(bettingInterval);
      
      crashGame.phase = 'running';
      crashGame.multiplier = 1.00;
      crashGame.startTime = Date.now();
      io.emit('crash_state', { phase: 'running', players: crashGame.players });

      const gameInterval = setInterval(() => {
        const elapsedTime = (Date.now() - crashGame.startTime) / 1000;
        crashGame.multiplier = Math.pow(1.05, elapsedTime).toFixed(2);

        if (crashGame.multiplier >= crashGame.crashPoint) {
          clearInterval(gameInterval);
          crashGame.phase = 'crashed';
          crashGame.history.unshift(crashGame.crashPoint);
          if (crashGame.history.length > 10) crashGame.history.pop();

          io.emit('crash_state', { 
            phase: 'crashed', 
            crashPoint: crashGame.crashPoint, 
            history: crashGame.history 
          });
          
          setTimeout(runCrashGame, 5000);
        } else {
          io.emit('crash_tick', crashGame.multiplier);
        }
      }, 100);
    }
  }, 1000);
}

// Uruchomienie gry po starcie serwera
runCrashGame();

app.use(cors());
app.use(express.json());

function drawCard(tableId) {
  const table = tables[tableId];
  if (table.shoe.length < 30) table.shoe = createShoe();
  return table.shoe.pop();
}

function cardValue(card) {
  const rank = card.rank;
  if (rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(rank)) return 10;
  return parseInt(rank);
}

function calculateHand(hand) {
  let total = hand.reduce((acc, c) => acc + cardValue(c), 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces--) total -= 10;
  return total;
}

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashedPassword, balance: 1000 });
    res.status(201).json({ username: user.username });
  } catch {
    res.status(400).json({ message: 'Użytkownik już istnieje lub błąd danych.' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ where: { username } });
  if (!user) return res.status(400).json({ message: 'Użytkownik nie istnieje.' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ message: 'Niepoprawne hasło.' });
  res.json({ username: user.username, balance: user.balance });
});

io.on('connection', socket => {
  socket.on('get_table_state', ({ tableId }) => {
    const table = tables[tableId];
    if (table) socket.emit('table_update', getSafeTable(table));
  });

  socket.on('join_table', ({ tableId, username, slotIndex }) => {
    const table = tables[tableId];
    if (!table) return;
    if (table.players.some(p => p?.username === username)) return;
    if (slotIndex >= 0 && slotIndex < 6 && !table.players[slotIndex]) {
      table.players[slotIndex] = { username, hand: [], bet: 0, status: 'waiting', result: '' };
      socket.join(tableId);
      io.to(tableId).emit('table_update', getSafeTable(table));
    }
  });

  socket.on('leave_table', ({ tableId, username }) => {
  const table = tables[tableId];
  if (!table) return;

  const playerIndex = table.players.findIndex(p => p && p.username === username);
  if (playerIndex !== -1) {
    table.players[playerIndex] = null;
    io.to(tableId).emit('table_update', getSafeTable(table));
    console.log(`❌ ${username} opuścił stół ${tableId}`);
  }
});

socket.on('place_bet', ({ tableId, username, amount, type = 'main' }) => {
  const table = tables[tableId];
  if (!table || table.phase !== 'waiting_for_bets') return;
  const player = table.players.find(p => p && p.username === username);
  if (!player) return;

  User.findOne({ where: { username } }).then(user => {
    if (!user || user.balance < amount) return;

    // Przygotuj sideBets jeśli nie istnieją
    if (!player.sideBets) {
      player.sideBets = { '21+3': 0, 'pair': 0, 'vs': 0 };
    }

    // Sprawdź jaki typ zakładu
    if (type === 'main') {
      player.bet += amount;
    } else if (['21+3', 'pair', 'vs'].includes(type)) {
      player.sideBets[type] += amount;
    } else {
      return; // nieznany typ
    }

    user.balance -= amount;
    user.save();

    Transaction.create({
      userId: user.id,
      balanceChange: -amount,
      type: type === 'main' ? 'bet' : `side-bet-${type}`
    });

    if (player.status !== 'bet_placed') {
      player.status = 'bet_placed';
    }

    io.to(tableId).emit('table_update', getSafeTable(table));

    const activeCount = table.players.filter(p => p && (p.bet > 0)).length;
    if (activeCount === 1 && !table.countdown) {
      table.countdownValue = 8;
      table.countdown = setInterval(() => {
        if (!tables[tableId]) return clearInterval(table.countdown);
        table.countdownValue--;
        io.to(tableId).emit('countdown_tick', table.countdownValue);
        if (table.countdownValue <= 0) {
          clearInterval(table.countdown);
          table.countdown = null;
          startRound(tableId);
        }
      }, 1000);
    }
  });
});

socket.on('player_action', async ({ tableId, username, action }) => {
  const table = tables[tableId];
  const current = table.players[table.currentPlayerIndex];
  if (!current || current.username !== username) return;

  if (action === 'hit') {
    const activeHand = current.activeHand === 'split' ? current.splitHand : current.hand;
    activeHand.push(drawCard(tableId));
    const total = calculateHand(activeHand);

    if (total === 21) {
      current.status = 'stand';
      if (current.hasSplit && current.activeHand === 'main') {
        current.activeHand = 'split';
      } else {
        await nextTurn(tableId);
      }
    } else if (total > 21) {
      current.status = 'bust';
      if (current.hasSplit && current.activeHand === 'main') {
        current.activeHand = 'split';
        current.status = 'playing';
      } else {
        await nextTurn(tableId);
      }
    }

    io.to(tableId).emit('table_update', getSafeTable(table));
  } else if (action === 'stand') {
    if (current.hasSplit && current.activeHand === 'main') {
      current.activeHand = 'split';
    } else {
      current.status = 'stand';
      await nextTurn(tableId);
    }
    io.to(tableId).emit('table_update', getSafeTable(table));
  } else if (action === 'double') {
    if ((current.activeHand === 'main' ? current.hand : current.splitHand).length === 2) {
      const user = await User.findOne({ where: { username } });
      if (user && user.balance >= current.bet) {
        user.balance -= current.bet;
        await user.save();

        await Transaction.create({
          userId: user.id,
          balanceChange: -current.bet,
          type: 'double'
        });

        const activeHand = current.activeHand === 'split' ? current.splitHand : current.hand;
        activeHand.push(drawCard(tableId));
        current.status = 'stand';

        if (current.hasSplit && current.activeHand === 'main') {
          current.activeHand = 'split';
          current.status = 'playing';
        } else {
          await nextTurn(tableId);
        }
      }
    }
  } else if (action === 'split') {
    if (current.hand.length === 2 && current.hand[0].rank === current.hand[1].rank) {
      const user = await User.findOne({ where: { username } });
      if (!user || user.balance < current.bet) return;

      user.balance -= current.bet;
      await user.save();

      await Transaction.create({
        userId: user.id,
        balanceChange: -current.bet,
        type: 'split'
      });

      // Split logic
      const splitCard = current.hand.pop();
      current.splitHand = [splitCard, drawCard(tableId)];
      current.hand.push(drawCard(tableId));
      current.hasSplit = true;
      current.activeHand = 'main'; // Start with main hand

      io.to(tableId).emit('table_update', getSafeTable(table));
    }
  }
});
// Automatyczna synchronizacja po odświeżeniu
socket.on('sync_state', ({ tableId, username }) => {
  const table = tables[tableId];
  if (!table) return;

  const player = table.players.find(p => p && p.username === username);
  if (!player) return;

  socket.emit('table_update', getSafeTable(table));

  if (table.phase === 'playing' && table.players[table.currentPlayerIndex]?.username === username) {
    socket.emit('your_turn', username); // ponownie wyślij sygnał, że jego tura
  }
});

// =======================================================
  //      TUTAJ WKLEJ KOD DLA GRY CRASH
  // =======================================================
  socket.on('crash_bet', async ({ username, amount }) => {
    if (crashGame.phase !== 'betting' || crashGame.players[username]) return;

    const user = await User.findOne({ where: { username } });
    if (!user || user.balance < amount || amount <= 0) return;

    user.balance -= amount;
    await user.save();
    await Transaction.create({ userId: user.id, balanceChange: -amount, type: 'crash_bet' });

    crashGame.players[username] = { bet: amount, status: 'playing' };
    io.emit('crash_players_update', crashGame.players);
  });


  socket.on('crash_cashout', async ({ username }) => {
    const player = crashGame.players[username];
    if (crashGame.phase !== 'running' || !player || player.status !== 'playing') return;

    const cashoutMultiplier = crashGame.multiplier;
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

    io.emit('crash_players_update', crashGame.players);
  });

  socket.on('get_crash_state', () => {
    socket.emit('crash_state', {
      phase: crashGame.phase,
      multiplier: crashGame.multiplier,
      players: crashGame.players,
      history: crashGame.history,
    });
  });

  // =======================================================
//          EVENTY RULETKI W SOCKET.IO
// =======================================================
socket.on('roulette_bet', async ({ username, betType, amount }) => {
  if (rouletteGame.phase !== 'betting') return;

  const user = await User.findOne({ where: { username } });
  if (!user || user.balance < amount || amount <= 0) return;
  
  // Sprawdzamy, czy gracz już istnieje w tej rundzie
  if (!rouletteGame.players[username]) {
    rouletteGame.players[username] = [];
  }
  
  // Sprawdzamy, czy taki zakład już istnieje i aktualizujemy go, lub dodajemy nowy
  const existingBet = rouletteGame.players[username].find(b => b.betType === betType);
  if (existingBet) {
    existingBet.bet += amount;
  } else {
    rouletteGame.players[username].push({ bet: amount, betType });
  }

  user.balance -= amount;
  await user.save();
  await Transaction.create({ userId: user.id, balanceChange: -amount, type: 'roulette_bet' });
  
  io.emit('roulette_players_update', rouletteGame.players);
});

socket.on('get_roulette_state', () => {
  socket.emit('roulette_state', {
    phase: rouletteGame.phase,
    history: rouletteGame.history,
    players: rouletteGame.players
  });
});

});

async function startRound(tableId) {
  const table = tables[tableId];

  const activePlayers = table.players
    .map((player, idx) => ({ player, idx }))
    .filter(({ player }) => player && player.bet > 0);

  // 🃏 Pierwsza karta dla każdego gracza (z delayem)
  for (let { player } of activePlayers) {
    player.hand = [drawCard(tableId)];
    io.to(tableId).emit('table_update', getSafeTable(table));
    await sleep(600); // <– delay między kartami
  }

  // 🃏 Pierwsza karta dla dealera (widoczna)
  table.dealerHand = [drawCard(tableId)];
  io.to(tableId).emit('table_update', getSafeTable(table));
  await sleep(600); // <– lekkie napięcie

  // 🃏 Druga karta dla graczy
  for (let { player } of activePlayers) {
    player.hand.push(drawCard(tableId));
    const total = calculateHand(player.hand);
    player.status = (total === 21 && player.hand.length === 2) ? 'stand' : 'playing';
    io.to(tableId).emit('table_update', getSafeTable(table));
    await sleep(600);
  }

  // 🕵️‍♂️ Zakryta karta dealera (do późniejszego odkrycia)
  table.dealerHand.push({ rank: '❓', suit: null });

  table.phase = 'playing';
  table.currentPlayerIndex = 0;

  io.to(tableId).emit('round_started', getSafeTable(table));
  await promptNextPlayer(tableId);
}

async function promptNextPlayer(tableId) {
  const table = tables[tableId];
  let idx = table.currentPlayerIndex;
  while (idx < table.players.length && (!table.players[idx] || table.players[idx].status !== 'playing')) idx++;
  if (idx >= table.players.length) {
    await playDealer(tableId); // 💥 To teraz działa z delayem
  } else {
    table.currentPlayerIndex = idx;
    io.to(tableId).emit('your_turn', table.players[idx].username);
  }
}

async function nextTurn(tableId) {
  const table = tables[tableId];
  const current = table.players[table.currentPlayerIndex];
  
  if (current?.hasSplit && current.activeHand === 'main') {
    // Switch to split hand
    current.activeHand = 'split';
    current.status = 'playing';
  } else {
    // Move to next player
    table.currentPlayerIndex++;
    if (current) {
      current.activeHand = 'main'; // Reset for next time
    }
  }
  
  await promptNextPlayer(tableId);
}

async function playDealer(tableId) {
  const table = tables[tableId];

  // 🔓 Odsłoń zakrytą kartę krupiera z dramatycznym opóźnieniem
  if (table.dealerHand.length > 1 && table.dealerHand[1].rank === '❓') {
    await sleep(1300); // napięcie!
    table.dealerHand[1] = drawCard(tableId);
    io.to(tableId).emit('table_update', getSafeTable(table));
  }

  let dealerTotal = calculateHand(table.dealerHand);

  // 🃏 Dobieraj karty do 17 z opóźnieniem
  while (dealerTotal < 17) {
    await sleep(1300); // czas na oddech widzów
    table.dealerHand.push(drawCard(tableId));
    dealerTotal = calculateHand(table.dealerHand);
    io.to(tableId).emit('table_update', getSafeTable(table));
  }

  // 🎯 Rozlicz graczy
  table.players.forEach(p => {
    if (!p || p.bet === 0) return;
    const playerTotal = calculateHand(p.hand);
    const isPlayerBJ = p.hand.length === 2 && playerTotal === 21;
    const isDealerBJ = table.dealerHand.length === 2 && dealerTotal === 21;

    if (playerTotal > 21) {
      p.result = 'Przegrana';
    } else if (isPlayerBJ && !isDealerBJ) {
      p.result = 'Blackjack!';
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += Math.floor(p.bet * 2.5);
          user.save();
          Transaction.create({
            userId: user.id,
            balanceChange: Math.floor(p.bet * 2.5),
            type: 'blackjack'
          });
        }
      });
    } else if (!isPlayerBJ && isDealerBJ) {
      p.result = 'Przegrana';
    } else if (isPlayerBJ && isDealerBJ) {
      p.result = 'Remis';
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += p.bet;
          user.save();
        }
      });
    } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
      p.result = 'Wygrana';
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += p.bet * 2;
          user.save();
          Transaction.create({
            userId: user.id,
            balanceChange: p.bet * 2,
            type: 'win'
          });
        }
      });
    } else if (playerTotal === dealerTotal) {
      p.result = 'Remis';
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += p.bet;
          user.save();
          Transaction.create({
            userId: user.id,
            balanceChange: p.bet,
            type: 'refund'
          });
        }
      });
    } else {
      p.result = 'Przegrana';
    }
  });

  io.to(tableId).emit('round_result', getSafeTable(table));
  setTimeout(() => resetTable(tableId), 8000);
}

function resetTable(tableId) {
  const table = tables[tableId];
  table.players = table.players.map(p => {
    if (!p) return null;
    return {
      ...p,
      hand: [],
      splitHand: null,
      hasSplit: false,
      activeHand: 'main',
      bet: 0,
      status: 'waiting',
      result: ''
    };
  });
  table.dealerHand = [];
  table.phase = 'waiting_for_bets';
  table.currentPlayerIndex = 0;
  table.countdown = null;
  table.countdownValue = 8;
  io.to(tableId).emit('table_update', getSafeTable(table));
}

app.get('/player/:username', async (req, res) => {
  const user = await User.findOne({ where: { username: req.params.username } });

  if (!user) {
    return res.status(404).json({ message: "Użytkownik nie został znaleziony" });
  }

  res.json({
    username: user.username,
    email: user.email,
    balance: user.balance,
    createdAt: user.createdAt
  });
});

app.get('/users', async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'email', 'balance', 'createdAt']
    });
    res.json(users);
  } catch {
    res.status(500).json({ message: 'Błąd podczas pobierania użytkowników.' });
  }
});

app.get('/leaderboard', async (req, res) => {
  try {
    const topPlayers = await User.findAll({
      order: [['balance', 'DESC']],
      limit: 5,
      attributes: ['username', 'balance']
    });
    res.json(topPlayers);
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ message: 'Błąd pobierania leaderboardu' });
  }
});

const { Op } = require("sequelize");
const { fn, col, where, literal } = require("sequelize");

app.get('/leaderboard/:type', async (req, res) => {
  const { type } = req.params;
  let whereClause = {};

  if (type === 'daily') {
    whereClause.createdAt = {
      [Op.gte]: new Date(new Date().setHours(0, 0, 0, 0))
    };
  } else if (type === 'monthly') {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    whereClause.createdAt = { [Op.gte]: firstDay };
  }

  try {
    // Zakładamy, że masz model Transaction lub inny, który trzyma bilans zmian
    const transactions = await sequelize.query(`
      SELECT u.username, SUM(t."balanceChange") AS balance
      FROM "Users" u
      JOIN "Transactions" t ON u.id = t."userId"
      WHERE t.type IN ('win', 'blackjack', 'refund', 'bet', 'double')
      ${type !== 'all' ? 'AND t."createdAt" >= :start' : ''}
      GROUP BY u.id
      ORDER BY balance DESC
      LIMIT 5
    `, {
      replacements: {
        start:
          type === 'daily' ? new Date(new Date().setHours(0, 0, 0, 0)) :
          type === 'monthly' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) :
          null
      },
      type: sequelize.QueryTypes.SELECT
    });

    res.json(transactions);
  } catch (err) {
    console.error(`Błąd leaderboard/${type}:`, err);
    res.status(500).json({ message: 'Błąd leaderboardu' });
  }
});

app.post('/player/:username/deposit', async (req, res) => {
  const { username } = req.params;
  const { amount } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ message: "Nieprawidłowa kwota." });

  const user = await User.findOne({ where: { username } });
  if (!user) return res.status(404).json({ message: "Użytkownik nie istnieje." });

  user.balance += amount;
  await user.save();

  await Transaction.create({
  userId: user.id,
  balanceChange: amount,
  type: 'deposit'
  });

  res.json({ balance: user.balance });
});

// Historia transakcji (mock – zakłada, że masz model Transaction)
// Jeśli nie masz modelu Transaction, poniżej daję też wersję "fake"
app.get('/player/:username/history', async (req, res) => {
  const { username } = req.params;

  // Zakładając, że masz model Transaction:
  /*
  const transactions = await Transaction.findAll({
    where: { username },
    order: [['createdAt', 'DESC']],
    limit: 20
  });
  return res.json(transactions);
  */

  // Tymczasowy mock:
  const fakeHistory = [
    { date: new Date(), type: 'Wpłata', amount: 1000, balanceAfter: 2000 },
    { date: new Date(Date.now() - 86400000), type: 'Zakład', amount: -500, balanceAfter: 1000 },
    { date: new Date(Date.now() - 172800000), type: 'Wygrana', amount: 1500, balanceAfter: 1500 },
  ];
  res.json(fakeHistory);
});

// =======================================================
//          LOGIKA AUTOMATU "30 COINS" (WERSJA 2.0)
// =======================================================

const playerGameStates = {};

const THIRTY_COINS_CONFIG = {
    GRID_ROWS: 6,
    GRID_COLS: 5,
    BASE_GAME_SYMBOLS: [
        { type: 'CASH', value: [10, 20, 30], sticky: false, chance: 0.10 },
        { type: 'CASH_INFINITY', value: [50, 100], sticky: true, chance: 0.02 },
        { type: 'MYSTERY', sticky: false, chance: 0.01 },
        { type: 'MINI_JACKPOT', sticky: false, chance: 0.005 },
        { type: 'MINOR_JACKPOT', sticky: false, chance: 0.002 }
    ],
    BONUS_TRIGGER_COUNT: 6,

    BONUS_GAME_SYMBOLS: [
        { type: 'CASH', value: [10, 20, 30, 40, 50, 100], chance: 0.8 }, // 80% szansy na zwykłą monetę
        { type: 'MINI_JACKPOT', chance: 0.05 }, // 5% szansy na Mini Jackpot
        { type: 'MINOR_JACKPOT', chance: 0.02 }  // 2% szansy na Minor Jackpot
    ]
};

function initializeGameState(username) {
    if (!playerGameStates[username]) {
        playerGameStates[username] = {
            grid: Array(THIRTY_COINS_CONFIG.GRID_ROWS * THIRTY_COINS_CONFIG.GRID_COLS).fill(null)
        };
    }
}

app.post('/30coins/spin', async (req, res) => {
    const { username, bet } = req.body;
    const user = await User.findOne({ where: { username } });
    if (!user || user.balance < bet) {
        return res.status(400).json({ message: 'Niewystarczające środki' });
    }

    initializeGameState(username); // Upewniamy się, że gracz ma stan gry
    const gameState = playerGameStates[username];

    // Pobranie opłaty
    user.balance -= bet;
    await Transaction.create({ userId: user.id, balanceChange: -bet, type: '30coins_bet' });

    // --- NOWA, POPRAWIONA LOGIKA SPINA ---
    const { GRID_ROWS, GRID_COLS, BASE_GAME_SYMBOLS } = THIRTY_COINS_CONFIG;
    const newGrid = Array(GRID_ROWS * GRID_COLS).fill(null);

    // 1. Zachowaj lepkie symbole (Cash Infinity) z poprzedniego stanu
    for (let i = 0; i < gameState.grid.length; i++) {
        if (gameState.grid[i] && gameState.grid[i].sticky) {
            newGrid[i] = gameState.grid[i];
        }
    }

    // 2. Wylosuj nowe symbole na pozostałych, pustych polach
    for (let i = 0; i < newGrid.length; i++) {
        // Jeśli pole jest puste (nie ma na nim lepkiego symbolu)
        if (newGrid[i] === null) {
            // Losujemy, czy pojawi się nowy symbol
            for (const symbol of BASE_GAME_SYMBOLS) {
                if (Math.random() < symbol.chance) {
                    let newSymbol = { type: symbol.type, sticky: symbol.sticky };
                    if (symbol.value) {
                        newSymbol.value = symbol.value[Math.floor(Math.random() * symbol.value.length)];
                    }
                    newGrid[i] = newSymbol;
                    break; // Wylosowaliśmy symbol, przerywamy dla tego pola
                }
            }
        }
    }
    
    // Zapisujemy nowy stan siatki dla gracza
    gameState.grid = newGrid;

    // 3. Sprawdź warunek aktywacji bonusu (tylko w aktywnej strefie)
    let symbolsInActiveZone = 0;
    for (let row = 2; row <= 3; row++) { // Nasza strefa 2x3
        for (let col = 1; col <= 3; col++) {
            const index = row * GRID_COLS + col;
            if (gameState.grid[index] !== null) {
                symbolsInActiveZone++;
            }
        }
    }

    let bonusTriggered = false;
    if (symbolsInActiveZone >= THIRTY_COINS_CONFIG.BONUS_TRIGGER_COUNT) {
        bonusTriggered = true;
        // Ważne: Po aktywacji bonusu, siatka jest czyszczona dopiero po jego zakończeniu.
        // Na razie zostawiamy ją w takim stanie, w jakim jest.
    }
    
    await user.save();

    res.json({
        grid: gameState.grid,
        newBalance: user.balance,
        bonusTriggered: bonusTriggered,
        winAmount: 0 // Gra podstawowa nadal nie daje bezpośrednich wygranych
    });
});

app.post('/30coins/bonus-spin', async (req, res) => {
    const { username, grid } = req.body;
    
    const emptySlotsIndexes = [];
    for (let i = 0; i < grid.length; i++) {
        if (grid[i] === null) {
            emptySlotsIndexes.push(i);
        }
    }

    if (emptySlotsIndexes.length === 0) {
        return res.json({ grid, bonusEnded: true, hasLandedNewSymbol: false });
    }

    const newSymbolsCount = Math.floor(Math.random() * 3) + 1;
    let hasLandedNewSymbol = false;

    for (let i = 0; i < newSymbolsCount; i++) {
        if (emptySlotsIndexes.length > 0) {
            hasLandedNewSymbol = true;
            const randomIndex = Math.floor(Math.random() * emptySlotsIndexes.length);
            const slotIndexToFill = emptySlotsIndexes.splice(randomIndex, 1)[0];

            // --- POCZĄTEK POPRAWKI ---
            // Poprawna logika losowania symbolu na podstawie szans
            for (const symbol of THIRTY_COINS_CONFIG.BONUS_GAME_SYMBOLS) {
                if (Math.random() < symbol.chance) {
                    let newSymbol = { type: symbol.type, sticky: true }; // W bonusie wszystkie symbole są lepkie
                    if (symbol.value) { // Jeśli to moneta, wylosuj jej wartość
                        newSymbol.value = symbol.value[Math.floor(Math.random() * symbol.value.length)];
                    }
                    grid[slotIndexToFill] = newSymbol;
                    break; 
                }
            }
            // --- KONIEC POPRAWKI ---
        }
    }
    
    res.json({
        grid: grid,
        bonusEnded: emptySlotsIndexes.length === 0,
        hasLandedNewSymbol: hasLandedNewSymbol
    });
});

// =======================================================
//          GŁÓWNA LOGIKA GRY W RULETKĘ
// =======================================================
const rouletteGame = {
  phase: 'waiting', // waiting, betting, spinning, result
  players: {}, // { username: [{ betType: 'red', amount: 100 }, { betType: 'straight_17', amount: 10 }] }
  history: [],
  winningNumber: null
};

async function runRouletteGame() {
  // --- Faza obstawiania ---
  rouletteGame.phase = 'betting';
  rouletteGame.players = {};
  io.emit('roulette_state', { phase: 'betting', history: rouletteGame.history });
  
  // Odliczanie czasu na zakłady
  let bettingTimeLeft = 20;
  const bettingInterval = setInterval(() => {
    bettingTimeLeft--;
    io.emit('roulette_bet_tick', bettingTimeLeft);
    if (bettingTimeLeft <= 0) {
      clearInterval(bettingInterval);
      startSpinning();
    }
  }, 1000);
}

async function startSpinning() {
  // --- Faza kręcenia kołem ---
  rouletteGame.phase = 'spinning';
  rouletteGame.winningNumber = crypto.randomInt(0, 36); // Losowanie numeru na początku kręcenia
  io.emit('roulette_state', { phase: 'spinning' });
  
  await sleep(8000); // 8 sekund na animację kręcenia się koła
  
  // --- Faza wyników ---
  rouletteGame.phase = 'result';
  // Dodajemy do historii i ograniczamy do 15 ostatnich
  rouletteGame.history.unshift(rouletteGame.winningNumber);
  if (rouletteGame.history.length > 15) rouletteGame.history.pop();
  
  await resolveRouletteBets(); // Obliczamy wygrane

  io.emit('roulette_state', { 
    phase: 'result', 
    winningNumber: rouletteGame.winningNumber,
    history: rouletteGame.history,
    players: rouletteGame.players
  });
  
  await sleep(7000); // 7 sekund na pokazanie wyników
  runRouletteGame(); // Rozpocznij nową rundę
}

async function resolveRouletteBets() {
  const num = rouletteGame.winningNumber;
  for (const username in rouletteGame.players) {
    let totalWinnings = 0;
    const user = await User.findOne({ where: { username } });
    if (!user) continue;

    for (const bet of rouletteGame.players[username]) {
      let win = false;
      const betDefinition = ROULETTE_BETS[bet.betType];

      if (bet.betType.startsWith('straight_')) {
        const betNumber = parseInt(bet.betType.split('_')[1]);
        if (betNumber === num) win = true;
      } else if (betDefinition && betDefinition.condition(num)) {
        win = true;
      }
      
      if (win) {
        const winnings = Math.floor(bet.bet * betDefinition.payout);
        totalWinnings += winnings;
        bet.result = 'win';
        bet.winnings = winnings;
      } else {
        bet.result = 'loss';
      }
    }

    if (totalWinnings > 0) {
      user.balance += totalWinnings;
      await user.save();
      await Transaction.create({ userId: user.id, balanceChange: totalWinnings, type: 'roulette_win' });
    }
  }
}

// Uruchomienie gry
runRouletteGame();

// =======================================================
//          ENDPOINT API DLA GRY PLINKO
// =======================================================
app.post('/plinko/drop', async (req, res) => {
    const { username, bet } = req.body;
    if (!username || !bet || bet <= 0) {
        return res.status(400).json({ message: 'Nieprawidłowy zakład.' });
    }

    const user = await User.findOne({ where: { username } });
    if (!user || user.balance < bet) {
        return res.status(400).json({ message: 'Niewystarczające środki.' });
    }

    // Pobieramy opłatę za grę
    user.balance -= bet;
    await Transaction.create({ userId: user.id, balanceChange: -bet, type: 'plinko_bet' });

    // --- Symulacja spadania kulki ---
    let path = []; // Zapis ścieżki (0 = w lewo, 1 = w prawo)
    let position = 0; // Pozycja końcowa (liczba ruchów w prawo)

    for (let i = 0; i < PLINKO_ROWS; i++) {
        const direction = crypto.randomInt(0, 2); // 0 lub 1
        path.push(direction);
        if (direction === 1) {
            position++;
        }
    }
    
    // Zapewniamy, że pozycja mieści się w zakresie tablicy mnożników
    const finalPosition = Math.min(position, PLINKO_MULTIPLIERS.length - 1);
    const multiplier = PLINKO_MULTIPLIERS[finalPosition];
    const winnings = Math.floor(bet * multiplier);

    // Dodajemy wygraną do salda
    if (winnings > 0) {
        user.balance += winnings;
        await Transaction.create({ userId: user.id, balanceChange: winnings, type: 'plinko_win' });
    }

    await user.save();

    res.json({
        path,           // np. [0, 1, 1, 0, ...]
        multiplier,     // np. 2
        winnings,       // np. 200
        newBalance: user.balance
    });
});

sequelize.sync().then(() => {
  server.listen(port, () => console.log(`🃏 Serwer blackjack działa na http://localhost:${port}`));
}).catch(err => console.error('Błąd bazy danych:', err));