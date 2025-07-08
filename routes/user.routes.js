const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');

router.get('/leaderboard', userController.getLeaderboard);
router.get('/player/:username', userController.getPlayerDetails);
router.post('/player/:username/deposit', userController.deposit);

module.exports = router;