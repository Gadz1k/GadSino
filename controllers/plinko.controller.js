const crypto = require('crypto');
const User = require('../models/user');
const Transaction = require('../models/transaction');

// Konfiguracja gry Plinko
const PLINKO_ROWS = 12;
const PLINKO_MULTIPLIERS = [16, 9, 2, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 2, 9, 16];

exports.dropBall = async (req, res) => {
    const { username, bet } = req.body;
    if (!username || !bet || bet <= 0) {
        return res.status(400).json({ message: 'Nieprawidłowy zakład.' });
    }

    const user = await User.findOne({ where: { username } });
    if (!user || user.balance < bet) {
        return res.status(400).json({ message: 'Niewystarczające środki.' });
    }

    // Pobranie opłaty
    user.balance -= bet;
    await Transaction.create({ userId: user.id, balanceChange: -bet, type: 'plinko_bet' });

    // Symulacja spadania kulki
    let path = [];
    let position = 0; // Pozycja końcowa (liczba ruchów w prawo)

    for (let i = 0; i < PLINKO_ROWS; i++) {
        const direction = crypto.randomInt(0, 2); // 0 lub 1
        path.push(direction);
        if (direction === 1) {
            position++;
        }
    }
    
    // Zapewnienie, że pozycja mieści się w zakresie
    const finalPosition = Math.min(position, PLINKO_MULTIPLIERS.length - 1);
    const multiplier = PLINKO_MULTIPLIERS[finalPosition];
    const winnings = Math.floor(bet * multiplier);

    // Dodanie wygranej
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