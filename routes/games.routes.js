const express = require('express');
const router = express.Router();

// Importuj wszystkie kontrolery gier
const minesController = require('../controllers/mines.controller');
const towerController = require('../controllers/tower.controller');
const plinkoController = require('../controllers/plinko.controller');
const slotsController = require('../controllers/slots.controller');

// Trasy dla gry Mines
router.post('/mines/start', minesController.startGame);
router.post('/mines/reveal', minesController.revealTile);
router.post('/mines/cashout', minesController.cashout);

// Trasy dla gry Tower
router.post('/tower/start', towerController.startGame);
router.post('/tower/pick', towerController.pickTile);
router.post('/tower/cashout', towerController.cashout);

// Trasy dla gry Plinko
router.post('/plinko/drop', plinkoController.dropBall);

// Trasy dla gry Slots (30 Coins)
router.post('/30coins/spin', slotsController.spin);
router.post('/30coins/bonus-spin', slotsController.bonusSpin);

module.exports = router;