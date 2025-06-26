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

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getSafeTable(table) {
  const { countdown, ...safe } = table;
  return {
    ...safe,
    shoeSize: table.shoe.length
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
      table.players[slotIndex] = {
        username,
        hand: [],
        bet: 0,
        status: 'waiting',
        result: '',
        splitHand: null,
        splitBet: 0,
        activeHand: 'main' // 'main' albo 'split'
      };
      socket.join(tableId);
      io.to(tableId).emit('table_update', getSafeTable(table));
    }
  });

  socket.on('leave_table', ({ tableId, username }) => {
    const table = tables[tableId];
    if (!table) return;
    table.players = table.players.map(p => (p?.username === username ? null : p));
    io.to(tableId).emit('table_update', getSafeTable(table));
  });

  socket.on('place_bet', ({ tableId, username, amount }) => {
    const table = tables[tableId];
    if (!table || table.phase !== 'waiting_for_bets') return;
    const player = table.players.find(p => p && p.username === username);
    if (!player) return;

    User.findOne({ where: { username } }).then(user => {
      if (!user || user.balance < amount) return;

      // Sumujemy zakład zamiast nadpisywać
      player.bet += amount;
      user.balance -= amount;
      user.save();

      Transaction.create({
        userId: user.id,
        balanceChange: -amount,
        type: 'bet'
      });

      // Status ustawiamy tylko raz
      if (player.status !== 'bet_placed') {
        player.status = 'bet_placed';
      }

      io.to(tableId).emit('table_update', getSafeTable(table));

      const activeCount = table.players.filter(p => p && p.bet > 0).length;
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

  const getActiveCards = (player) =>
    player.activeHand === 'split' ? player.splitHand : player.hand;

  const getActiveBet = (player) =>
    player.activeHand === 'split' ? player.splitBet : player.bet;

  if (action === 'hit') {
    const cards = getActiveCards(current);
    cards.push(drawCard(tableId));
    const total = calculateHand(cards);

    io.to(tableId).emit('player_updated', {
      username: current.username,
      hand: current.hand,
      splitHand: current.splitHand
    });

    if (total === 21) {
      if (current.activeHand === 'main' && current.splitHand) {
        current.activeHand = 'split';
      } else {
        current.status = 'stand';
        nextTurn(tableId);
      }
    } else if (total > 21) {
      if (current.activeHand === 'main' && current.splitHand) {
        current.activeHand = 'split';
      } else {
        current.status = 'bust';
        nextTurn(tableId);
      }
    }

  } else if (action === 'stand') {
    if (current.activeHand === 'main' && current.splitHand) {
      current.activeHand = 'split';
    } else {
      current.status = 'stand';
      nextTurn(tableId);
    }

  } else if (action === 'double') {
    const cards = getActiveCards(current);
    const bet = getActiveBet(current);

    if (cards.length === 2) {
      const user = await User.findOne({ where: { username } });
      if (user && user.balance >= bet) {
        user.balance -= bet;
        await user.save();

        await Transaction.create({
          userId: user.id,
          balanceChange: -bet,
          type: 'double'
        });

        if (current.activeHand === 'split') {
          current.splitBet *= 2;
        } else {
          current.bet *= 2;
        }

        cards.push(drawCard(tableId));

        io.to(tableId).emit('player_updated', {
          username: current.username,
          hand: current.hand,
          splitHand: current.splitHand
        });

        if (current.activeHand === 'main' && current.splitHand) {
          current.activeHand = 'split';
        } else {
          current.status = 'stand';
          nextTurn(tableId);
        }
      }
    }

  } else if (action === 'split') {
    if (current.hand.length === 2 && current.hand[0].rank === current.hand[1].rank && !current.splitHand) {
      const user = await User.findOne({ where: { username } });
      if (!user || user.balance < current.bet) return;

      user.balance -= current.bet;
      await user.save();

      await Transaction.create({
        userId: user.id,
        balanceChange: -current.bet,
        type: 'split'
      });

      const splitCard = current.hand.pop();

      current.splitHand = [splitCard];
      current.splitBet = current.bet;

      current.hand.push(drawCard(tableId));
      current.splitHand.push(drawCard(tableId));

      current.activeHand = 'main'; // gra najpierw główną ręką

      io.to(tableId).emit('player_updated', {
        username: current.username,
        hand: current.hand,
        splitHand: current.splitHand
      });
    }
  }

  io.to(tableId).emit('table_update', getSafeTable(table));
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

  // znajdź wszystkich aktywnych graczy z zakładem
  const activePlayers = table.players
    .map((player, idx) => ({ player, idx }))
    .filter(({ player }) => player && player.bet > 0);

  // pierwsza runda rozdawania po jednej karcie dla graczy
  activePlayers.forEach(({ player }) => {
    player.hand = [drawCard(tableId)];
  });

  // jedna karta dla krupiera (widoczna)
  table.dealerHand = [drawCard(tableId)];

  // druga runda rozdawania po jednej karcie dla graczy
  activePlayers.forEach(({ player }) => {
    player.hand.push(drawCard(tableId));
    const total = calculateHand(player.hand);
    if (total === 21 && player.hand.length === 2) {
      player.status = 'stand'; // automatyczny stand przy blackjacku
    } else {
      player.status = 'playing';
    }
  });

  // druga karta dla krupiera (ukryta)
  table.dealerHand.push({ rank: '❓', suit: null });

  table.phase = 'playing';
  table.currentPlayerIndex = 0;

  io.to(tableId).emit('round_started', getSafeTable(table));
  promptNextPlayer(tableId);
}

function promptNextPlayer(tableId) {
  const table = tables[tableId];
  let idx = table.currentPlayerIndex;
  while (idx < table.players.length && (!table.players[idx] || table.players[idx].status !== 'playing')) idx++;
  if (idx >= table.players.length) playDealer(tableId);
  else {
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
  if (table.dealerHand.length > 1 && table.dealerHand[1].rank === '❓') {
    table.dealerHand[1] = drawCard(tableId);
    io.to(tableId).emit('table_update', getSafeTable(table));
  }

  let dealerTotal = calculateHand(table.dealerHand);
  while (dealerTotal < 17) {
    table.dealerHand.push(drawCard(tableId));
    dealerTotal = calculateHand(table.dealerHand);
  }

  table.players.forEach(p => {
    if (!p || p.bet === 0) return;

    const handsToCheck = [
      { cards: p.hand, bet: p.bet, type: 'main' }
    ];

    if (p.splitHand) {
      handsToCheck.push({ cards: p.splitHand, bet: p.splitBet, type: 'split' });
    }

    handsToCheck.forEach(({ cards, bet, type }) => {
      const playerTotal = calculateHand(cards);
      const isPlayerBJ = cards.length === 2 && playerTotal === 21;
      const isDealerBJ = table.dealerHand.length === 2 && dealerTotal === 21;

      let result = 'Przegrana';

      if (playerTotal > 21) {
        result = 'Przegrana';
      } else if (isPlayerBJ && !isDealerBJ) {
        result = 'Blackjack!';
      } else if (!isPlayerBJ && isDealerBJ) {
        result = 'Przegrana';
      } else if (isPlayerBJ && isDealerBJ) {
        result = 'Remis';
      } else if (dealerTotal > 21 || playerTotal > dealerTotal) {
        result = 'Wygrana';
      } else if (playerTotal === dealerTotal) {
        result = 'Remis';
      }

      // Zapisz wynik
      if (type === 'main') p.result = result;
      else p.splitResult = result;

      // Wypłać kasę
      User.findOne({ where: { username: p.username } }).then(user => {
        if (!user) return;

        let payout = 0;
        if (result === 'Wygrana') payout = bet * 2;
        else if (result === 'Blackjack!') payout = Math.floor(bet * 2.5);
        else if (result === 'Remis') payout = bet;

        if (payout > 0) {
          user.balance += payout;
          user.save();

          Transaction.create({
            userId: user.id,
            balanceChange: payout,
            type: result === 'Blackjack!' ? 'blackjack' :
                  result === 'Wygrana' ? 'win' : 'refund'
          });
        }
      });
    });
  });

  io.to(tableId).emit('round_result', getSafeTable(table));
  setTimeout(() => resetTable(tableId), 8000);
}

function resetTable(tableId) {
  const table = tables[tableId];
  table.players = table.players.map(p =>
    p ? {
      ...p,
      hand: [],
      bet: 0,
      splitHand: null,
      splitBet: 0,
      status: 'waiting',
      result: '',
      splitResult: '',
      activeHand: 'main'
    } : null
  );
  table.dealerHand = [];
  table.phase = 'waiting_for_bets';
  table.currentPlayerIndex = 0;
  table.countdown = null;
  table.countdownValue = 8;
  io.to(tableId).emit('table_update', getSafeTable(table));
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

sequelize.sync().then(() => {
  server.listen(port, () => console.log(`🃏 Serwer blackjack działa na http://localhost:${port}`));
}).catch(err => console.error('Błąd bazy danych:', err));
