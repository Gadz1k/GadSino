require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');

const sequelize = require('./sequelize');
const User = require('./models/user');
const Transaction = require('./models/transaction');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
const port = process.env.PORT || 3000;

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

sequelize.sync().then(() => {
  server.listen(port, () => console.log(`🃏 Serwer blackjack działa na http://localhost:${port}`));
}).catch(err => console.error('Błąd bazy danych:', err));