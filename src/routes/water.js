const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const db = require('../models/db');

// Apply authentication middleware to all routes
router.use(authenticate);

// Get today's water intake
router.get('/today', async (req, res) => {
  try {
    const userId = req.user.id; // From auth middleware
    const today = new Date().toISOString().split('T')[0];
    
    const query = `
      SELECT 
        COALESCE(SUM(amount), 0) as total_intake,
        COUNT(*) as glass_count
      FROM water_logs 
      WHERE user_id = $1 AND DATE(created_at) = $2
    `;
    
    const result = await db.query(query, [userId, today]);
    
    // Get individual glasses for today
    const glassesQuery = `
      SELECT id, amount, created_at
      FROM water_logs 
      WHERE user_id = $1 AND DATE(created_at) = $2
      ORDER BY created_at DESC
    `;
    
    const glassesResult = await db.query(glassesQuery, [userId, today]);
    
    res.json({
      total_intake: parseInt(result.rows[0].total_intake),
      glass_count: parseInt(result.rows[0].glass_count),
      glasses: glassesResult.rows,
      goal: 2000 // Default daily goal in ml
    });
  } catch (error) {
    console.error('Error fetching water data:', error);
    res.status(500).json({ error: 'Failed to fetch water data' });
  }
});

// Add water intake
router.post('/add', async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount = 250 } = req.body; // Default glass size
    
    const query = `
      INSERT INTO water_logs (user_id, amount, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id, amount, created_at
    `;
    
    const result = await db.query(query, [userId, amount]);
    
    // Update daily summary
    await updateDailySummary(userId);
    
    res.json({
      success: true,
      water_log: result.rows[0]
    });
  } catch (error) {
    console.error('Error adding water intake:', error);
    res.status(500).json({ error: 'Failed to add water intake' });
  }
});

// Remove water intake
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const logId = req.params.id;
    
    // Verify the log belongs to the user
    const verifyQuery = 'SELECT user_id FROM water_logs WHERE id = $1';
    const verifyResult = await db.query(verifyQuery, [logId]);
    
    if (verifyResult.rows.length === 0 || verifyResult.rows[0].user_id !== userId) {
      return res.status(404).json({ error: 'Water log not found' });
    }
    
    const deleteQuery = 'DELETE FROM water_logs WHERE id = $1';
    await db.query(deleteQuery, [logId]);
    
    // Update daily summary
    await updateDailySummary(userId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing water intake:', error);
    res.status(500).json({ error: 'Failed to remove water intake' });
  }
});

// Get water history
router.get('/history', async (req, res) => {
  try {
    const userId = req.user.id;
    const { days = 7 } = req.query;
    
    const query = `
      SELECT 
        DATE(created_at) as date,
        COALESCE(SUM(amount), 0) as total_intake,
        COUNT(*) as glass_count
      FROM water_logs 
      WHERE user_id = $1 
        AND created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `;
    
    const result = await db.query(query, [userId]);
    
    res.json({
      history: result.rows,
      goal: 2000
    });
  } catch (error) {
    console.error('Error fetching water history:', error);
    res.status(500).json({ error: 'Failed to fetch water history' });
  }
});

// Helper function to update daily summary
async function updateDailySummary(userId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Check if daily summary exists
    const checkQuery = `
      SELECT id FROM daily_summaries 
      WHERE user_id = $1 AND date = $2
    `;
    const checkResult = await db.query(checkQuery, [userId, today]);
    
    // Calculate today's water intake
    const waterQuery = `
      SELECT COALESCE(SUM(amount), 0) as total_water
      FROM water_logs 
      WHERE user_id = $1 AND DATE(created_at) = $2
    `;
    const waterResult = await db.query(waterQuery, [userId, today]);
    const totalWater = parseInt(waterResult.rows[0].total_water);
    
    if (checkResult.rows.length > 0) {
      // Update existing summary
      const updateQuery = `
        UPDATE daily_summaries 
        SET water_intake = $3
        WHERE user_id = $1 AND date = $2
      `;
      await db.query(updateQuery, [userId, today, totalWater]);
    } else {
      // Create new summary
      const insertQuery = `
        INSERT INTO daily_summaries (user_id, date, water_intake)
        VALUES ($1, $2, $3)
      `;
      await db.query(insertQuery, [userId, today, totalWater]);
    }
  } catch (error) {
    console.error('Error updating daily summary:', error);
  }
}

module.exports = router;
