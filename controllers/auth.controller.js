const bcrypt = require('bcrypt');
const User = require('../models/user');
const Transaction = require('../models/transaction');

// Logika rejestracji
exports.register = async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ username, email, password: hashedPassword, balance: 1000 });
        await Transaction.create({ userId: user.id, balanceChange: 1000, type: 'register_bonus' });
        res.status(201).json({ username: user.username });
    } catch {
        res.status(400).json({ message: 'Użytkownik już istnieje lub błąd danych.' });
    }
};

// Logika logowania
exports.login = async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(400).json({ message: 'Użytkownik nie istnieje.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Niepoprawne hasło.' });
    res.json({ username: user.username, balance: user.balance });
};