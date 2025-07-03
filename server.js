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
  return { ...safe, shoeSize: table.shoe.length, dealerValue };
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
  if (!card || !card.rank) return 0;
  const rank = card.rank;
  if (rank === 'A') return 11;
  if (['K', 'Q', 'J'].includes(rank)) return 10;
  return parseInt(rank);
}

function calculateHand(hand) {
  if (!hand || hand.length === 0) return 0;
  let total = hand.reduce((acc, c) => acc + cardValue(c), 0);
  let aces = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces--) total -= 10;
  return total;
}

// Funkcje pomocnicze do oceny Side Betów
function evaluate_21_plus_3(playerCards, dealerCard) {
    const hand = [...playerCards, dealerCard];
    if (hand.some(c => !c || !c.rank || !c.suit)) return null;

    const ranks = hand.map(c => cardValue(c)).sort((a, b) => a - b);
    const suits = hand.map(c => c.suit);

    const isFlush = suits.every(s => s === suits[0]);
    const isThreeOfAKind = new Set(hand.map(c => c.rank)).size === 1;

    // Poprawiona logika dla strita
    const numericRanks = '2345678910JQKA';
    const sortedUniqueRanks = [...new Set(hand.map(c => c.rank))].sort((a, b) => numericRanks.indexOf(a) - numericRanks.indexOf(b));
    let isStraight = false;
    if(sortedUniqueRanks.length === 3) {
      const firstIndex = numericRanks.indexOf(sortedUniqueRanks[0]);
      if(numericRanks.substring(firstIndex, firstIndex + 3) === sortedUniqueRanks.join('')) isStraight = true;
      // Sprawdzenie dla strita A-2-3
      if (sortedUniqueRanks.join('') === '23A') isStraight = true;
    }


    if (isThreeOfAKind && isFlush) return { name: 'Trójka w kolorze', payout: 100 };
    if (isStraight && isFlush) return { name: 'Strit w kolorze', payout: 40 };
    if (isThreeOfAKind) return { name: 'Trójka', payout: 30 };
    if (isStraight) return { name: 'Strit', payout: 10 };
    if (isFlush) return { name: 'Kolor', payout: 5 };
    return null;
}

function evaluate_perfect_pair(playerCards) {
    if (playerCards.length < 2) return null;
    const [card1, card2] = playerCards;
    if (card1.rank !== card2.rank) return null;

    const suitColors = { spades: 'black', clubs: 'black', hearts: 'red', diamonds: 'red' };
    if (card1.suit === card2.suit) return { name: 'Identyczne karty', payout: 25 };
    if (suitColors[card1.suit] === suitColors[card2.suit]) return { name: 'Kolorowa para', payout: 12 };
    return { name: 'Mieszana para', payout: 6 };
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
    if (!table || table.players.some(p => p?.username === username)) return;
    if (slotIndex >= 0 && slotIndex < 5 && !table.players[slotIndex]) {
      table.players[slotIndex] = {
          username,
          hand: [],
          bet: 0,
          sideBets: {},
          betsOnOthers: {},
          status: 'waiting',
          result: '',
          results: {},
          winnings: 0
      };
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

  socket.on('place_bet', ({ tableId, username, amount, type = 'main', targetSlotIndex }) => {
    const table = tables[tableId];
    if (!table || table.phase !== 'waiting_for_bets') return;
    const player = table.players.find(p => p && p.username === username);
    if (!player) return;

    User.findOne({ where: { username } }).then(user => {
      if (!user || user.balance < amount) return;

      let betPlaced = false;
      if (type === 'main') {
        player.bet = (player.bet || 0) + amount;
        betPlaced = true;
      } else if (['21+3', 'pair'].includes(type)) {
        player.sideBets[type] = (player.sideBets[type] || 0) + amount;
        betPlaced = true;
      } else if (type === 'vs' && targetSlotIndex !== undefined) {
          const targetPlayer = table.players[targetSlotIndex];
          if (targetPlayer && targetPlayer.username !== username) {
             player.betsOnOthers[targetSlotIndex] = (player.betsOnOthers[targetSlotIndex] || 0) + amount;
             betPlaced = true;
          }
      }

      if (betPlaced) {
        user.balance -= amount;
        user.save();
        Transaction.create({ userId: user.id, balanceChange: -amount, type: `bet-${type}` });
        player.status = 'bet_placed';
        io.to(tableId).emit('table_update', getSafeTable(table));

        const activePlayers = table.players.filter(p => p && p.bet > 0).length;
        if (activePlayers === 1 && !table.countdown) {
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

         const splitCard = current.hand.pop();
         current.splitHand = [splitCard, drawCard(tableId)];
         current.hand.push(drawCard(tableId));
         current.hasSplit = true;
         current.activeHand = 'main'; // Start with main hand

         io.to(tableId).emit('table_update', getSafeTable(table));
       }
     }
   });

  socket.on('sync_state', ({ tableId, username }) => {
    const table = tables[tableId];
    if (!table) return;

    const player = table.players.find(p => p && p.username === username);
    if (!player) return;

    socket.emit('table_update', getSafeTable(table));

    if (table.phase === 'playing' && table.players[table.currentPlayerIndex]?.username === username) {
      socket.emit('your_turn', username);
    }
  });
});

async function startRound(tableId) {
  const table = tables[tableId];
  const activePlayers = table.players.map((player, idx) => ({ player, idx })).filter(({ player }) => player && player.bet > 0);

  for (let { player } of activePlayers) {
    player.hand = [drawCard(tableId)];
    io.to(tableId).emit('table_update', getSafeTable(table));
    await sleep(600);
  }

  table.dealerHand = [drawCard(tableId)];
  io.to(tableId).emit('table_update', getSafeTable(table));
  await sleep(600);

  for (let { player } of activePlayers) {
    player.hand.push(drawCard(tableId));
    const total = calculateHand(player.hand);
    player.status = (total === 21 && player.hand.length === 2) ? 'stand' : 'playing';
    io.to(tableId).emit('table_update', getSafeTable(table));
    await sleep(600);
  }

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
    await playDealer(tableId);
  } else {
    table.currentPlayerIndex = idx;
    io.to(tableId).emit('your_turn', table.players[idx].username);
  }
}

async function nextTurn(tableId) {
  const table = tables[tableId];
  const current = table.players[table.currentPlayerIndex];

  if (current?.hasSplit && current.activeHand === 'main') {
    current.activeHand = 'split';
    current.status = 'playing';
  } else {
    table.currentPlayerIndex++;
    if (current) current.activeHand = 'main';
  }

  await promptNextPlayer(tableId);
}

async function playDealer(tableId) {
  const table = tables[tableId];
  if (table.dealerHand.length > 1 && table.dealerHand[1].rank === '❓') {
    await sleep(1300);
    table.dealerHand[1] = drawCard(tableId);
    io.to(tableId).emit('table_update', getSafeTable(table));
  }

  let dealerTotal = calculateHand(table.dealerHand);
  while (dealerTotal < 17) {
    await sleep(1300);
    table.dealerHand.push(drawCard(tableId));
    dealerTotal = calculateHand(table.dealerHand);
    io.to(tableId).emit('table_update', getSafeTable(table));
  }

  const isDealerBJ = table.dealerHand.length === 2 && dealerTotal === 21;
  const dealerUpCard = table.dealerHand[0];

  // Krok 1: Oceń zakłady główne i poboczne (Pair, 21+3)
  for (const p of table.players) {
    if (!p) continue;
    p.winnings = 0;
    p.results = {};

    // A. Zakłady poboczne
    if (p.sideBets?.pair > 0) {
      const result = evaluate_perfect_pair(p.hand);
      if (result) {
        const winAmount = p.sideBets.pair * result.payout;
        p.winnings += winAmount + p.sideBets.pair;
        p.results.pair = `${result.name} (+${winAmount})`;
      } else p.results.pair = 'Przegrana';
    }
    if (p.sideBets?.['21+3'] > 0) {
      const result = evaluate_21_plus_3(p.hand, dealerUpCard);
      if (result) {
        const winAmount = p.sideBets['21+3'] * result.payout;
        p.winnings += winAmount + p.sideBets['21+3'];
        p.results['21+3'] = `${result.name} (+${winAmount})`;
      } else p.results['21+3'] = 'Przegrana';
    }

    // B. Zakład główny (logika nie obsługuje wypłat ze splita)
    if (p.bet > 0) {
        const playerTotal = calculateHand(p.hand);
        const isPlayerBJ = p.hand.length === 2 && playerTotal === 21;

        if (playerTotal > 21 || p.status === 'bust') p.results.main = 'Przegrana';
        else if (isPlayerBJ && !isDealerBJ) { p.results.main = 'Blackjack!'; p.winnings += Math.floor(p.bet * 2.5); }
        else if (isDealerBJ && !isPlayerBJ) { p.results.main = 'Przegrana'; }
        else if (dealerTotal > 21 || playerTotal > dealerTotal) { p.results.main = 'Wygrana'; p.winnings += p.bet * 2; }
        else if (playerTotal === dealerTotal) { p.results.main = 'Remis'; p.winnings += p.bet; }
        else p.results.main = 'Przegrana';
    }
  }

  // Krok 2: Oceń zakłady "za plecami" (VS)
  for (const p_better of table.players) {
    if (!p_better || !Object.keys(p_better.betsOnOthers || {}).length) continue;
    p_better.results.vs = {};

    for (const targetIndex in p_better.betsOnOthers) {
        const p_target = table.players[targetIndex];
        const betAmount = p_better.betsOnOthers[targetIndex];
        let outcome = 'Przegrana';

        if (p_target?.results.main) {
            if (p_target.results.main === 'Blackjack!') { p_better.winnings += Math.floor(betAmount * 2.5); outcome = `Wygrana (BJ) na ${p_target.username}`; }
            else if (p_target.results.main === 'Wygrana') { p_better.winnings += betAmount * 2; outcome = `Wygrana na ${p_target.username}`; }
            else if (p_target.results.main === 'Remis') { p_better.winnings += betAmount; outcome = `Remis na ${p_target.username}`; }
        }
        p_better.results.vs[targetIndex] = outcome;
    }
  }

  // Krok 3: Zaktualizuj salda w bazie danych
  for (const p of table.players) {
    if (p && p.winnings > 0) {
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          user.balance += p.winnings;
          user.save();
          Transaction.create({ userId: user.id, balanceChange: p.winnings, type: 'payout' });
        }
      });
    }
  }

  io.to(tableId).emit('round_result', getSafeTable(table));
  setTimeout(() => resetTable(tableId), 8000);
}

function resetTable(tableId) {
  const table = tables[tableId];
  if (!table) return;
  table.players = table.players.map(p => {
    if (!p) return null;
    return {
      ...p,
      hand: [],
      splitHand: null,
      hasSplit: false,
      activeHand: 'main',
      bet: 0,
      sideBets: {},
      betsOnOthers: {},
      status: 'waiting',
      result: '',
      results: {},
      winnings: 0
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
    const transactions = await sequelize.query(`
      SELECT u.username, SUM(t."balanceChange") AS balance
      FROM "Users" u
      JOIN "Transactions" t ON u.id = t."userId"
      WHERE t.type IN ('win', 'blackjack', 'refund', 'bet', 'double', 'payout', 'bet-main', 'bet-pair', 'bet-21+3', 'bet-vs')
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

app.get('/player/:username/history', async (req, res) => {
  const { username } = req.params;
  const user = await User.findOne({ where: { username } });
  if (!user) return res.status(404).json([]);

  const transactions = await Transaction.findAll({
    where: { userId: user.id },
    order: [['createdAt', 'DESC']],
    limit: 20
  });
  return res.json(transactions);
});


sequelize.sync().then(() => {
  server.listen(port, () => console.log(`🃏 Serwer blackjack działa na http://localhost:${port}`));
}).catch(err => console.error('Błąd bazy danych:', err));