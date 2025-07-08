const crypto = require('crypto');
const User = require('../models/user');
const Transaction = require('../models/transaction');

let minesGames = {};

function factorial(n) {
    if (n < 0) return 0;
    if (n === 0 || n === 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
}

function combinations(n, k) {
    if (k < 0 || k > n) return 0;
    return factorial(n) / (factorial(k) * factorial(n - k));
}

function calculateMinesMultiplier(totalTiles, minesCount, revealedCount) {
    const houseEdge = 0.99;
    const probability = combinations(totalTiles - revealedCount, minesCount) / combinations(totalTiles, minesCount);
    if (probability === 0) return 0; // Avoid division by zero
    const multiplier = houseEdge / probability;
    return parseFloat(multiplier.toFixed(2));
}

exports.startGame = async (req, res) => {
    const { username, bet, mines, tiles } = req.body;
    if (!username || !bet || bet <= 0 || !mines || !tiles) {
        return res.status(400).json({ message: 'Nieprawidłowe parametry gry.' });
    }

    const user = await User.findOne({ where: { username } });
    if (!user || user.balance < bet) {
        return res.status(400).json({ message: 'Niewystarczające środki.' });
    }

    user.balance -= bet;
    await user.save();
    await Transaction.create({ userId: user.id, balanceChange: -bet, type: 'mines_bet' });

    const mineLocations = new Set();
    while (mineLocations.size < mines) {
        mineLocations.add(crypto.randomInt(0, tiles));
    }

    minesGames[username] = {
        bet, tiles, mines,
        mineLocations: Array.from(mineLocations),
        revealedTiles: [],
        gameOver: false,
    };

    const nextMultiplier = calculateMinesMultiplier(tiles, mines, 1);
    res.json({ newBalance: user.balance, nextMultiplier });
};

exports.revealTile = async (req, res) => {
    const { username, tileIndex } = req.body;
    const game = minesGames[username];

    if (!game || game.gameOver || game.revealedTiles.includes(tileIndex)) {
        return res.status(400).json({ message: 'Nie można odkryć tego pola.' });
    }

    if (game.mineLocations.includes(tileIndex)) {
        game.gameOver = true;
        delete minesGames[username];
        return res.json({ isMine: true, mineLocations: game.mineLocations });
    }

    game.revealedTiles.push(tileIndex);
    const currentMultiplier = calculateMinesMultiplier(game.tiles, game.mines, game.revealedTiles.length);
    const nextMultiplier = calculateMinesMultiplier(game.tiles, game.mines, game.revealedTiles.length + 1);

    res.json({ isMine: false, currentMultiplier, nextMultiplier });
};

exports.cashout = async (req, res) => {
    const { username } = req.body;
    const game = minesGames[username];

    if (!game || game.gameOver || game.revealedTiles.length === 0) {
        return res.status(400).json({ message: 'Nie można teraz wypłacić.' });
    }
    
    const currentMultiplier = calculateMinesMultiplier(game.tiles, game.mines, game.revealedTiles.length);
    const winnings = Math.floor(game.bet * currentMultiplier);
    const user = await User.findOne({ where: { username } });

    if (user) {
        user.balance += winnings;
        await user.save();
        await Transaction.create({ userId: user.id, balanceChange: winnings, type: 'mines_win' });
    }

    delete minesGames[username];
    res.json({ winnings, newBalance: user.balance });
};