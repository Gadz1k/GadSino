const crypto = require('crypto');
const User = require('../models/user');
const Transaction = require('../models/transaction');

// Definicje mnożników dla różnych poziomów ryzyka i liczby rzędów
const MULTIPLIERS = {
    low: {
        8: [2.9, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 2.9],
        12: [5.6, 2.1, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 2.1, 5.6], // Dodałem przykładowe
        16: [8, 3, 2, 1.5, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.5, 2, 3, 8] // Dodałem przykładowe
    },
    medium: {
        8: [5, 2, 1.2, 1.1, 0.4, 1.1, 1.2, 2, 5],
        12: [10, 3, 1.4, 1.1, 1, 0.4, 1, 1.1, 1.4, 3, 10], // Dodałem przykładowe
        16: [16, 9, 2, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 2, 9, 16] // Twoje oryginalne
    },
    high: {
        8: [13, 3, 1.3, 1, 0.3, 1, 1.3, 3, 13],
        12: [30, 5, 2, 1.1, 0.5, 0.3, 0.5, 1.1, 2, 5, 30], // Dodałem przykładowe
        16: [130, 24, 5, 2, 1.5, 0.5, 0.3, 0.2, 0.3, 0.5, 1.5, 2, 5, 24, 130] // Dodałem przykładowe
    }
};

exports.dropBall = async (req, res) => {
    // Odczytujemy nowe parametry z żądania
    const { username, bet, risk, rows } = req.body;
    if (!username || !bet || bet <= 0 || !risk || !rows) {
        return res.status(400).json({ message: 'Nieprawidłowe parametry gry.' });
    }

    const user = await User.findOne({ where: { username } });
    if (!user || user.balance < bet) {
        return res.status(400).json({ message: 'Niewystarczające środki.' });
    }

    const availableMultipliers = MULTIPLIERS[risk]?.[rows];
    if (!availableMultipliers) {
        return res.status(400).json({ message: 'Niedostępna konfiguracja ryzyka/rzędów.' });
    }

    user.balance -= bet;
    await Transaction.create({ userId: user.id, balanceChange: -bet, type: 'plinko_bet' });

    let path = [];
    let position = 0;

    for (let i = 0; i < rows; i++) { // Używamy liczby rzędów z żądania
        const direction = crypto.randomInt(0, 2);
        path.push(direction);
        if (direction === 1) {
            position++;
        }
    }
    
    const finalPosition = Math.min(position, availableMultipliers.length - 1);
    const multiplier = availableMultipliers[finalPosition];
    const winnings = Math.floor(bet * multiplier);

    if (winnings > 0) {
        user.balance += winnings;
        await Transaction.create({ userId: user.id, balanceChange: winnings, type: 'plinko_win' });
    }

    await user.save();

    res.json({
        path,
        multiplier,
        winnings,
        newBalance: user.balance
    });
};