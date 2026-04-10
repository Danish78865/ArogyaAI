const express = require('express');
const { query } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /api/users/weight - Log weight
router.post('/weight', authenticate, async (req, res, next) => {
  try {
    const { weight_kg, notes } = req.body;
    if (!weight_kg) return res.status(400).json({ error: 'Weight is required' });

    const result = await query(
      'INSERT INTO weight_logs (user_id, weight_kg, notes) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, weight_kg, notes || null]
    );

    // Update profile weight
    await query(
      'UPDATE user_profiles SET weight_kg = $1, updated_at = NOW() WHERE user_id = $2',
      [weight_kg, req.user.id]
    );

    res.status(201).json({ weightLog: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/users/weight - Get weight history
router.get('/weight', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM weight_logs WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 30',
      [req.user.id]
    );
    res.json({ weights: result.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
