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

// ✨ NEW: Side Bet Evaluation Logic
async function evaluateSideBets(player, dealerUpCard, user) {
    if (!player || !player.sideBets || !player.hand || player.hand.length < 2) {
        return;
    }

    let sideBetWinnings = 0;
    let transactionDetails = [];

    // --- Perfect Pair Evaluation (uses player's first two cards) ---
    const pairBet = player.sideBets.pair || 0;
    if (pairBet > 0) {
        const [card1, card2] = player.hand;
        let pairPayout = 0;

        if (card1.rank === card2.rank) {
            if (card1.suit === card2.suit) {
                pairPayout = 25; // Perfect Pair
            } else {
                const isRed1 = ['hearts', 'diamonds'].includes(card1.suit);
                const isRed2 = ['hearts', 'diamonds'].includes(card2.suit);
                if (isRed1 === isRed2) {
                    pairPayout = 12; // Colored Pair
                } else {
                    pairPayout = 6; // Mixed Pair
                }
            }
        }

        if (pairPayout > 0) {
            const winnings = pairBet * pairPayout;
            sideBetWinnings += winnings;
            player.result += ` Pair Win! (+${winnings})`;
            transactionDetails.push({ balanceChange: winnings, type: 'side-bet-win-pair' });
        }
    }

    // --- 21+3 Evaluation (uses player's first two cards + dealer's up card) ---
    const p213Bet = player.sideBets['21+3'] || 0;
    if (p213Bet > 0) {
        const threeCards = [player.hand[0], player.hand[1], dealerUpCard];
        const ranks = threeCards.map(c => cardValue(c === 11 ? 1 : c.rank)).sort((a, b) => a - b);
        const suits = threeCards.map(c => c.suit);
        const rankValues = "2345678910JQKA";
        const numericRanks = threeCards.map(c => rankValues.indexOf(c.rank)).sort((a,b) => a - b);

        const isFlush = new Set(suits).size === 1;
        const isStraight = numericRanks[2] - numericRanks[0] === 2 && numericRanks[1] - numericRanks[0] === 1;
        const isThreeOfAKind = new Set(numericRanks).size === 1;
        
        let p213Payout = 0;

        if (isFlush && isStraight) p213Payout = 40; // Straight Flush
        else if (isThreeOfAKind) p213Payout = 30;   // Three of a Kind
        else if (isStraight) p213Payout = 10;       // Straight
        else if (isFlush) p213Payout = 5;           // Flush
        
        // Suited Three of a Kind is the rarest, check specifically
        if (isThreeOfAKind && isFlush) p213Payout = 100;

        if (p213Payout > 0) {
            const winnings = p213Bet * p213Payout;
            sideBetWinnings += winnings;
            player.result += ` 21+3 Win! (+${winnings})`;
            transactionDetails.push({ balanceChange: winnings, type: 'side-bet-win-21+3' });
        }
    }

    if (sideBetWinnings > 0) {
        user.balance += sideBetWinnings;
        await user.save();
        for (const detail of transactionDetails) {
            await Transaction.create({ userId: user.id, ...detail });
        }
    }
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
      table.players[slotIndex] = { username, hand: [], bet: 0, status: 'waiting', result: '', sideBets: { '21+3': 0, 'pair': 0 } };
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

    // ✨ MODIFIED: Main bet prerequisite for side bets
    if (['21+3', 'pair'].includes(type) && player.bet === 0) {
        // Optional: send a message back to the user
        // socket.emit('error_message', 'Musisz postawić główny zakład przed zakładem bocznym.');
        return; 
    }

    User.findOne({ where: { username } }).then(user => {
      if (!user || user.balance < amount) return;

      if (!player.sideBets) {
        player.sideBets = { '21+3': 0, 'pair': 0 };
      }

      if (type === 'main') {
        player.bet += amount;
      } else if (['21+3', 'pair'].includes(type)) {
        player.sideBets[type] += amount;
      } else {
        return; 
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
      if (activeCount > 0 && !table.countdown) { // Logic changed to start countdown on any first bet
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
          current.bet *= 2; // Double the bet for the hand
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
  table.phase = 'dealing'; // lock bets

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

  // ✨ MODIFIED: Evaluate side bets now that players and dealer have initial cards
  const dealerUpCard = table.dealerHand[0];
  for (const { player } of activePlayers) {
      const user = await User.findOne({ where: { username: player.username } });
      if (user) {
          await evaluateSideBets(player, dealerUpCard, user);
      }
  }
  io.to(tableId).emit('table_update', getSafeTable(table));
  await sleep(1000); // Pause to show side bet results

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
    current.status = 'playing'; // Make sure the split hand can be played
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
    
    // This logic now only handles the main bet, side bets are done.
    const playerTotal = calculateHand(p.hand);
    const isPlayerBJ = p.hand.length === 2 && playerTotal === 21;
    const isDealerBJ = table.dealerHand.length === 2 && dealerTotal === 21;

    if (playerTotal > 21) {
      p.result = 'Przegrana';
    } else if (isPlayerBJ && !isDealerBJ) {
      p.result = 'Blackjack!';
      User.findOne({ where: { username: p.username } }).then(user => {
        if (user) {
          const winnings = Math.floor(p.bet * 2.5);
          user.balance += winnings;
          user.save();
          Transaction.create({
            userId: user.id,
            balanceChange: winnings,
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
          const winnings = p.bet * 2;
          user.balance += winnings;
          user.save();
          Transaction.create({
            userId: user.id,
            balanceChange: winnings,
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
      sideBets: { '21+3': 0, 'pair': 0 }, // Reset side bets
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
      WHERE t.type IN ('win', 'blackjack', 'refund', 'bet', 'double', 'side-bet-win-pair', 'side-bet-win-21+3', 'side-bet-pair', 'side-bet-21+3')
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
    if (!user) return res.status(404).send('User not found');

    const transactions = await Transaction.findAll({
        where: { userId: user.id },
        order: [['createdAt', 'DESC']],
        limit: 20
    });
    res.json(transactions);
});

sequelize.sync().then(() => {
  server.listen(port, () => console.log(`🃏 Serwer blackjack działa na http://localhost:${port}`));
}).catch(err => console.error('Błąd bazy danych:', err));