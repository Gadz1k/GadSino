const { Op } = require("sequelize");
const User = require('../models/user');
const Transaction = require('../models/transaction');
const sequelize = require('../config/database');

// Pobieranie danych o graczu
exports.getPlayerDetails = async (req, res) => {
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
};

// Wpłata środków
exports.deposit = async (req, res) => {
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
};

// Logika leaderboardu
exports.getLeaderboard = async (req, res) => {
    try {
        const topPlayers = await User.findAll({
            order: [['balance', 'DESC']],
            limit: 5,
            attributes: ['username', 'balance']
        });
        res.json(topPlayers);
    } catch (err) {
        res.status(500).json({ message: 'Błąd pobierania leaderboardu' });
    }
};