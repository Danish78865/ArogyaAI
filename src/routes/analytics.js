const express = require('express');
const { query } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/analytics/weekly - Last 7 days
router.get('/weekly', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        ds.date,
        TO_CHAR(ds.date, 'Dy') as day_name,
        COALESCE(ds.total_calories, 0) as calories,
        COALESCE(ds.total_protein_g, 0) as protein_g,
        COALESCE(ds.total_carbs_g, 0) as carbs_g,
        COALESCE(ds.total_fat_g, 0) as fat_g,
        COALESCE(ds.meals_count, 0) as meals_count,
        COALESCE(ds.calorie_target, up.daily_calorie_target, 2000) as calorie_target
      FROM generate_series(
        CURRENT_DATE - INTERVAL '6 days',
        CURRENT_DATE,
        '1 day'::interval
      ) AS gs(date)
      LEFT JOIN daily_summaries ds ON ds.date = gs.date AND ds.user_id = $1
      LEFT JOIN user_profiles up ON up.user_id = $1
      ORDER BY gs.date ASC
    `, [req.user.id]);

    // Calculate averages
    const days = result.rows;
    const avgCalories = days.reduce((sum, d) => sum + parseFloat(d.calories), 0) / days.length;
    const totalCalories = days.reduce((sum, d) => sum + parseFloat(d.calories), 0);

    res.json({
      days: days.map(d => ({
        date: d.date,
        dayName: d.day_name,
        calories: parseFloat(d.calories),
        protein_g: parseFloat(d.protein_g),
        carbs_g: parseFloat(d.carbs_g),
        fat_g: parseFloat(d.fat_g),
        mealsCount: parseInt(d.meals_count),
        calorieTarget: parseInt(d.calorie_target)
      })),
      summary: {
        avgCalories: Math.round(avgCalories),
        totalCalories: Math.round(totalCalories),
        daysLogged: days.filter(d => d.meals_count > 0).length
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/monthly - Last 30 days
router.get('/monthly', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        ds.date,
        TO_CHAR(ds.date, 'DD Mon') as label,
        COALESCE(ds.total_calories, 0) as calories,
        COALESCE(ds.total_protein_g, 0) as protein_g,
        COALESCE(ds.total_carbs_g, 0) as carbs_g,
        COALESCE(ds.total_fat_g, 0) as fat_g,
        COALESCE(ds.meals_count, 0) as meals_count,
        COALESCE(ds.calorie_target, up.daily_calorie_target, 2000) as calorie_target
      FROM generate_series(
        CURRENT_DATE - INTERVAL '29 days',
        CURRENT_DATE,
        '1 day'::interval
      ) AS gs(date)
      LEFT JOIN daily_summaries ds ON ds.date = gs.date AND ds.user_id = $1
      LEFT JOIN user_profiles up ON up.user_id = $1
      ORDER BY gs.date ASC
    `, [req.user.id]);

    const days = result.rows;
    const daysLogged = days.filter(d => parseInt(d.meals_count) > 0);
    const avgCalories = daysLogged.length > 0
      ? daysLogged.reduce((sum, d) => sum + parseFloat(d.calories), 0) / daysLogged.length
      : 0;

    // Weekly averages for bar chart
    const weeklyAverages = [];
    for (let i = 0; i < 4; i++) {
      const weekDays = days.slice(i * 7, (i + 1) * 7);
      const weekLogged = weekDays.filter(d => parseInt(d.meals_count) > 0);
      weeklyAverages.push({
        week: `Week ${i + 1}`,
        avgCalories: weekLogged.length > 0
          ? Math.round(weekLogged.reduce((sum, d) => sum + parseFloat(d.calories), 0) / weekLogged.length)
          : 0
      });
    }

    res.json({
      days: days.map(d => ({
        date: d.date,
        label: d.label,
        calories: parseFloat(d.calories),
        protein_g: parseFloat(d.protein_g),
        carbs_g: parseFloat(d.carbs_g),
        fat_g: parseFloat(d.fat_g),
        mealsCount: parseInt(d.meals_count),
        calorieTarget: parseInt(d.calorie_target)
      })),
      weeklyAverages,
      summary: {
        avgCalories: Math.round(avgCalories),
        daysLogged: daysLogged.length,
        totalDays: days.length,
        consistency: Math.round((daysLogged.length / days.length) * 100)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/macros/today
router.get('/macros/today', authenticate, async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const result = await query(`
      SELECT 
        COALESCE(ds.total_calories, 0) as calories,
        COALESCE(ds.total_protein_g, 0) as protein_g,
        COALESCE(ds.total_carbs_g, 0) as carbs_g,
        COALESCE(ds.total_fat_g, 0) as fat_g,
        COALESCE(ds.total_fiber_g, 0) as fiber_g,
        COALESCE(up.daily_calorie_target, 2000) as calorie_target,
        COALESCE(up.daily_protein_target, 150) as protein_target,
        COALESCE(up.daily_carbs_target, 250) as carbs_target,
        COALESCE(up.daily_fat_target, 65) as fat_target
      FROM user_profiles up
      LEFT JOIN daily_summaries ds ON ds.user_id = up.user_id AND ds.date = $2
      WHERE up.user_id = $1
    `, [req.user.id, today]);

    if (result.rows.length === 0) {
      return res.json({
        consumed: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
        targets: { calories: 2000, protein_g: 150, carbs_g: 250, fat_g: 65 }
      });
    }

    const row = result.rows[0];
    res.json({
      consumed: {
        calories: parseFloat(row.calories),
        protein_g: parseFloat(row.protein_g),
        carbs_g: parseFloat(row.carbs_g),
        fat_g: parseFloat(row.fat_g),
        fiber_g: parseFloat(row.fiber_g)
      },
      targets: {
        calories: parseInt(row.calorie_target),
        protein_g: parseInt(row.protein_target),
        carbs_g: parseInt(row.carbs_target),
        fat_g: parseInt(row.fat_target)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/streak
router.get('/streak', authenticate, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT date, meals_count
      FROM daily_summaries
      WHERE user_id = $1 AND meals_count > 0
      ORDER BY date DESC
    `, [req.user.id]);

    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < result.rows.length; i++) {
      const rowDate = new Date(result.rows[i].date);
      rowDate.setHours(0, 0, 0, 0);
      const expected = new Date(today);
      expected.setDate(today.getDate() - i);

      if (rowDate.getTime() === expected.getTime()) {
        streak++;
      } else {
        break;
      }
    }

    res.json({ streak });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
