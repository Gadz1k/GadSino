const User = require('../models/user');
const Transaction = require('../models/transaction');

let playerGameStates = {};

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
        { type: 'CASH', value: [10, 20, 30, 40, 50, 100], chance: 0.8 },
        { type: 'MINI_JACKPOT', chance: 0.05 },
        { type: 'MINOR_JACKPOT', chance: 0.02 }
    ]
};

function initializeGameState(username) {
    if (!playerGameStates[username]) {
        playerGameStates[username] = {
            grid: Array(THIRTY_COINS_CONFIG.GRID_ROWS * THIRTY_COINS_CONFIG.GRID_COLS).fill(null)
        };
    }
}

exports.spin = async (req, res) => {
    const { username, bet } = req.body;
    const user = await User.findOne({ where: { username } });
    if (!user || user.balance < bet) {
        return res.status(400).json({ message: 'Niewystarczające środki' });
    }

    initializeGameState(username);
    const gameState = playerGameStates[username];

    user.balance -= bet;
    await Transaction.create({ userId: user.id, balanceChange: -bet, type: '30coins_bet' });

    const { GRID_ROWS, GRID_COLS, BASE_GAME_SYMBOLS } = THIRTY_COINS_CONFIG;
    const newGrid = Array(GRID_ROWS * GRID_COLS).fill(null);

    for (let i = 0; i < gameState.grid.length; i++) {
        if (gameState.grid[i] && gameState.grid[i].sticky) {
            newGrid[i] = gameState.grid[i];
        }
    }

    for (let i = 0; i < newGrid.length; i++) {
        if (newGrid[i] === null) {
            for (const symbol of BASE_GAME_SYMBOLS) {
                if (Math.random() < symbol.chance) {
                    let newSymbol = { type: symbol.type, sticky: symbol.sticky };
                    if (symbol.value) {
                        newSymbol.value = symbol.value[Math.floor(Math.random() * symbol.value.length)];
                    }
                    newGrid[i] = newSymbol;
                    break;
                }
            }
        }
    }
    
    gameState.grid = newGrid;

    let symbolsInActiveZone = 0;
    for (let row = 2; row <= 3; row++) {
        for (let col = 1; col <= 3; col++) {
            const index = row * GRID_COLS + col;
            if (gameState.grid[index] !== null) {
                symbolsInActiveZone++;
            }
        }
    }

    let bonusTriggered = symbolsInActiveZone >= THIRTY_COINS_CONFIG.BONUS_TRIGGER_COUNT;
    
    await user.save();

    res.json({
        grid: gameState.grid,
        newBalance: user.balance,
        bonusTriggered: bonusTriggered,
        winAmount: 0
    });
};

exports.bonusSpin = async (req, res) => {
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

            for (const symbol of THIRTY_COINS_CONFIG.BONUS_GAME_SYMBOLS) {
                if (Math.random() < symbol.chance) {
                    let newSymbol = { type: symbol.type, sticky: true };
                    if (symbol.value) {
                        newSymbol.value = symbol.value[Math.floor(Math.random() * symbol.value.length)];
                    }
                    grid[slotIndexToFill] = newSymbol;
                    break;
                }
            }
        }
    }
    
    res.json({
        grid: grid,
        bonusEnded: emptySlotsIndexes.length === 0,
        hasLandedNewSymbol: hasLandedNewSymbol
    });
};