const crypto = require('crypto');
const User = require('../models/user');
const Transaction = require('../models/transaction');

// Stan gier Tower
let towerGames = {};

// Konfiguracja gry
const TOWER_CONFIG = {
    WIDTH: 3, // 3 pola w rzędzie
    HEIGHT: 8, // 8 poziomów wieży
    SKULLS_PER_ROW: 1, // 1 pułapka na poziom
    HOUSE_EDGE: 0.99
};

// Funkcja obliczająca mnożnik
function calculateTowerMultiplier(clearedRows) {
    const safeTiles = TOWER_CONFIG.WIDTH - TOWER_CONFIG.SKULLS_PER_ROW;
    if (safeTiles === 0) return 0;
    const probabilityOfOneRow = TOWER_CONFIG.WIDTH / safeTiles;
    const multiplier = Math.pow(probabilityOfOneRow, clearedRows);
    return parseFloat((multiplier * TOWER_CONFIG.HOUSE_EDGE).toFixed(2));
}

exports.startGame = async (req, res) => {
    const { username, bet } = req.body;
    const user = await User.findOne({ where: { username } });

    if (!user || user.balance < bet || bet <= 0) {
        return res.status(400).json({ message: 'Niewystarczające środki lub nieprawidłowy zakład.' });
    }

    user.balance -= bet;
    await user.save();
    await Transaction.create({ userId: user.id, balanceChange: -bet, type: 'tower_bet' });

    let towerLayout = [];
    for (let i = 0; i < TOWER_CONFIG.HEIGHT; i++) {
        towerLayout.push(crypto.randomInt(0, TOWER_CONFIG.WIDTH));
    }

    towerGames[username] = {
        bet,
        layout: towerLayout,
        clearedRows: 0,
        gameOver: false
    };

    res.json({ newBalance: user.balance, nextMultiplier: calculateTowerMultiplier(1) });
};

exports.pickTile = async (req, res) => {
    const { username, row, col } = req.body;
    const game = towerGames[username];

    if (!game || game.gameOver || row !== game.clearedRows) {
        return res.status(400).json({ message: 'Nieprawidłowy ruch.' });
    }

    if (game.layout[row] === col) {
        game.gameOver = true;
        const layout = game.layout;
        delete towerGames[username];
        return res.json({ isSkull: true, layout });
    }

    game.clearedRows++;
    const currentMultiplier = calculateTowerMultiplier(game.clearedRows);
    const nextMultiplier = (game.clearedRows < TOWER_CONFIG.HEIGHT) ? calculateTowerMultiplier(game.clearedRows + 1) : currentMultiplier;
    
    if (game.clearedRows === TOWER_CONFIG.HEIGHT) {
        game.gameOver = true;
        const winnings = Math.floor(game.bet * currentMultiplier);
        const user = await User.findOne({ where: { username } });
        if (user) {
            user.balance += winnings;
            await user.save();
            await Transaction.create({ userId: user.id, balanceChange: winnings, type: 'tower_win' });
        }
        delete towerGames[username];
        return res.json({ isSkull: false, isWin: true, winnings, newBalance: user.balance, currentMultiplier });
    }
    
    res.json({ isSkull: false, isWin: false, clearedRows: game.clearedRows, currentMultiplier, nextMultiplier });
};

exports.cashout = async (req, res) => {
    const { username } = req.body;
    const game = towerGames[username];

    if (!game || game.gameOver || game.clearedRows === 0) {
        return res.status(400).json({ message: 'Nie można teraz wypłacić.' });
    }
    
    const currentMultiplier = calculateTowerMultiplier(game.clearedRows);
    const winnings = Math.floor(game.bet * currentMultiplier);
    const user = await User.findOne({ where: { username } });

    if (user) {
        user.balance += winnings;
        await user.save();
        await Transaction.create({ userId: user.id, balanceChange: winnings, type: 'tower_win' });
    }

    delete towerGames[username];
    res.json({ winnings, newBalance: user.balance });
};