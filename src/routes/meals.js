const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../models/db');
const { authenticate } = require('../middleware/auth');
const { analyzeFoodImage } = require('../services/foodVision');

const router = express.Router();

// Multer config for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `meal-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|heic|heif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype) || file.mimetype === 'image/heic';
    if (ext || mime) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Helper to update daily summary
async function updateDailySummary(userId, date) {
  await query(`
    INSERT INTO daily_summaries (user_id, date, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g, meals_count, calorie_target)
    SELECT 
      $1, 
      $2::date,
      COALESCE(SUM(total_calories), 0),
      COALESCE(SUM(total_protein_g), 0),
      COALESCE(SUM(total_carbs_g), 0),
      COALESCE(SUM(total_fat_g), 0),
      COALESCE(SUM(total_fiber_g), 0),
      COUNT(*),
      COALESCE((SELECT daily_calorie_target FROM user_profiles WHERE user_id = $1), 2000)
    FROM meal_logs
    WHERE user_id = $1 AND DATE(logged_at) = $2::date
    ON CONFLICT (user_id, date) DO UPDATE SET
      total_calories = EXCLUDED.total_calories,
      total_protein_g = EXCLUDED.total_protein_g,
      total_carbs_g = EXCLUDED.total_carbs_g,
      total_fat_g = EXCLUDED.total_fat_g,
      total_fiber_g = EXCLUDED.total_fiber_g,
      meals_count = EXCLUDED.meals_count,
      updated_at = NOW()
  `, [userId, date]);
}

// POST /api/meals/analyze - Analyze food image (no save)
router.post('/analyze', authenticate, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    const imagePath = req.file.path;

    try {
      const analysis = await analyzeFoodImage(imagePath);
      
      // Don't delete the file yet - return path for confirmation
      res.json({
        success: true,
        imagePath: `/uploads/${path.basename(imagePath)}`,
        analysis
      });
    } catch (aiError) {
      // Clean up file on AI error
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      throw aiError;
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/meals - Log a meal (save analyzed meal)
router.post('/', authenticate, async (req, res, next) => {
  try {
    const {
      meal_type, image_url, analysis, notes,
      logged_at
    } = req.body;

    if (!analysis) {
      return res.status(400).json({ error: 'Analysis data is required' });
    }

    const loggedDate = logged_at ? new Date(logged_at) : new Date();

    // Insert meal log
    const mealResult = await query(`
      INSERT INTO meal_logs (user_id, meal_type, image_url, raw_ai_response, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g, notes, logged_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      req.user.id,
      meal_type || 'snack',
      image_url || null,
      JSON.stringify(analysis),
      analysis.total_calories || 0,
      analysis.total_protein_g || 0,
      analysis.total_carbs_g || 0,
      analysis.total_fat_g || 0,
      analysis.total_fiber_g || 0,
      notes || analysis.meal_description || null,
      loggedDate
    ]);

    const meal = mealResult.rows[0];

    // Insert food items
    if (analysis.food_items && analysis.food_items.length > 0) {
      for (const item of analysis.food_items) {
        await query(`
          INSERT INTO meal_food_items (meal_log_id, name, quantity, calories, protein_g, carbs_g, fat_g, fiber_g, confidence)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          meal.id,
          item.name,
          item.quantity || '',
          item.calories || 0,
          item.protein_g || 0,
          item.carbs_g || 0,
          item.fat_g || 0,
          item.fiber_g || 0,
          item.confidence || 0.8
        ]);
      }
    }

    // Update daily summary
    const dateStr = loggedDate.toISOString().split('T')[0];
    await updateDailySummary(req.user.id, dateStr);

    res.status(201).json({ success: true, meal });
  } catch (error) {
    next(error);
  }
});

// GET /api/meals/today - Get today's meals with food items
router.get('/today', authenticate, async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const mealsResult = await query(`
      SELECT ml.*, 
        json_agg(
          json_build_object(
            'id', mfi.id, 'name', mfi.name, 'quantity', mfi.quantity,
            'calories', mfi.calories, 'protein_g', mfi.protein_g,
            'carbs_g', mfi.carbs_g, 'fat_g', mfi.fat_g, 'fiber_g', mfi.fiber_g,
            'confidence', mfi.confidence
          ) ORDER BY mfi.id
        ) FILTER (WHERE mfi.id IS NOT NULL) as food_items
      FROM meal_logs ml
      LEFT JOIN meal_food_items mfi ON mfi.meal_log_id = ml.id
      WHERE ml.user_id = $1 AND DATE(ml.logged_at) = $2
      GROUP BY ml.id
      ORDER BY ml.logged_at DESC
    `, [req.user.id, today]);

    // Get today's summary
    const summaryResult = await query(`
      SELECT ds.*, up.daily_calorie_target, up.daily_protein_target, up.daily_carbs_target, up.daily_fat_target
      FROM daily_summaries ds
      LEFT JOIN user_profiles up ON up.user_id = ds.user_id
      WHERE ds.user_id = $1 AND ds.date = $2
    `, [req.user.id, today]);

    // Get targets even if no meals today
    const targetsResult = await query(
      'SELECT daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );

    const targets = targetsResult.rows[0] || {
      daily_calorie_target: 2000,
      daily_protein_target: 150,
      daily_carbs_target: 250,
      daily_fat_target: 65
    };

    const summary = summaryResult.rows[0];

    res.json({
      meals: mealsResult.rows,
      summary: {
        total_calories: parseFloat(summary?.total_calories) || 0,
        total_protein_g: parseFloat(summary?.total_protein_g) || 0,
        total_carbs_g: parseFloat(summary?.total_carbs_g) || 0,
        total_fat_g: parseFloat(summary?.total_fat_g) || 0,
        total_fiber_g: parseFloat(summary?.total_fiber_g) || 0,
        meals_count: parseInt(summary?.meals_count) || 0
      },
      targets: {
        calories: targets.daily_calorie_target,
        protein_g: targets.daily_protein_target,
        carbs_g: targets.daily_carbs_target,
        fat_g: targets.daily_fat_target
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/meals/history?date=YYYY-MM-DD
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const { date, limit = 20, offset = 0 } = req.query;

    let whereClause = 'WHERE ml.user_id = $1';
    let params = [req.user.id];

    if (date) {
      whereClause += ` AND DATE(ml.logged_at) = $2`;
      params.push(date);
    }

    const mealsResult = await query(`
      SELECT ml.*, 
        json_agg(
          json_build_object(
            'id', mfi.id, 'name', mfi.name, 'quantity', mfi.quantity,
            'calories', mfi.calories, 'protein_g', mfi.protein_g,
            'carbs_g', mfi.carbs_g, 'fat_g', mfi.fat_g
          ) ORDER BY mfi.id
        ) FILTER (WHERE mfi.id IS NOT NULL) as food_items
      FROM meal_logs ml
      LEFT JOIN meal_food_items mfi ON mfi.meal_log_id = ml.id
      ${whereClause}
      GROUP BY ml.id
      ORDER BY ml.logged_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({ meals: mealsResult.rows });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/meals/:id
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const mealResult = await query(
      'SELECT * FROM meal_logs WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (mealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Meal not found' });
    }

    const meal = mealResult.rows[0];

    // Delete image file if exists
    if (meal.image_url) {
      const imagePath = path.join(__dirname, '../..', meal.image_url);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    await query('DELETE FROM meal_logs WHERE id = $1', [id]);

    // Update daily summary
    const dateStr = meal.logged_at.toISOString().split('T')[0];
    await updateDailySummary(req.user.id, dateStr);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
