const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { authenticate } = require('../middleware/auth');
const db = require('../models/db');

// Apply authentication middleware to all routes
router.use(authenticate);

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Chat with AI coach
router.post('/chat', async (req, res) => {
  try {
    const userId = req.user.id;
    const { message, context = 'general' } = req.body;

    // Get user context for personalized advice
    const userQuery = `
      SELECT u.name, up.age, up.sex, up.height_cm, up.weight_kg, 
             up.activity_level, up.goal, up.daily_calorie_target,
             up.daily_protein_target, up.daily_carbs_target, up.daily_fat_target
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE u.id = $1
    `;
    const userResult = await db.query(userQuery, [userId]);
    const userProfile = userResult.rows[0];

    // Get today's food intake for context
    const todayQuery = `
      SELECT COALESCE(SUM(total_calories), 0) as calories,
             COALESCE(SUM(total_protein_g), 0) as protein,
             COALESCE(SUM(total_carbs_g), 0) as carbs,
             COALESCE(SUM(total_fat_g), 0) as fat
      FROM meal_logs 
      WHERE user_id = $1 AND DATE(logged_at) = CURRENT_DATE
    `;
    const todayResult = await db.query(todayQuery, [userId]);
    const todayIntake = todayResult.rows[0];

    // Get today's water intake
    const waterQuery = `
      SELECT COALESCE(SUM(amount), 0) as water_intake
      FROM water_logs 
      WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE
    `;
    const waterResult = await db.query(waterQuery, [userId]);
    const waterIntake = parseInt(waterResult.rows[0].water_intake);

    // Build context for OpenAI
    let systemPrompt = `You are a helpful AI nutrition and fitness coach. Be encouraging, knowledgeable, and provide practical advice. Keep responses concise but informative.`;

    if (userProfile) {
      systemPrompt += `\n\nUser Profile:
- Name: ${userProfile.name || 'User'}
- Age: ${userProfile.age || 'Not specified'}
- Gender: ${userProfile.sex || 'Not specified'}
- Height: ${userProfile.height_cm || 'Not specified'} cm
- Weight: ${userProfile.weight_kg || 'Not specified'} kg
- Activity Level: ${userProfile.activity_level || 'Not specified'}
- Goal: ${userProfile.goal || 'Not specified'}
- Daily Targets: ${userProfile.daily_calorie_target || 'Not specified'} calories, ${userProfile.daily_protein_target || 'Not specified'}g protein, ${userProfile.daily_carbs_target || 'Not specified'}g carbs, ${userProfile.daily_fat_target || 'Not specified'}g fat`;
    }

    systemPrompt += `\n\nToday's Intake:
- Calories: ${todayIntake.calories} / ${userProfile?.daily_calorie_target || 'Not specified'}
- Protein: ${todayIntake.protein}g / ${userProfile?.daily_protein_target || 'Not specified'}g
- Carbs: ${todayIntake.carbs}g / ${userProfile?.daily_carbs_target || 'Not specified'}g
- Fat: ${todayIntake.fat}g / ${userProfile?.daily_fat_target || 'Not specified'}g
- Water: ${waterIntake}ml / 2000ml goal`;

    // Adjust system prompt based on context
    switch (context) {
      case 'meal':
        systemPrompt += `\n\nFocus on providing meal advice, nutrition information, and food-related guidance.`;
        break;
      case 'workout':
        systemPrompt += `\n\nFocus on fitness advice, workout recommendations, and exercise-related guidance.`;
        break;
      case 'goal':
        systemPrompt += `\n\nFocus on goal setting, progress tracking, and motivational guidance.`;
        break;
      default:
        systemPrompt += `\n\nProvide general nutrition and wellness advice.`;
    }

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const aiResponse = completion.choices[0].message.content;

    // Save conversation to database
    const saveQuery = `
      INSERT INTO coach_messages (user_id, message, role, context, created_at)
      VALUES ($1, $2, 'user', $3, NOW())
      RETURNING id
    `;
    await db.query(saveQuery, [userId, message, context]);

    const saveResponseQuery = `
      INSERT INTO coach_messages (user_id, message, role, context, created_at)
      VALUES ($1, $2, 'assistant', $3, NOW())
      RETURNING id
    `;
    await db.query(saveResponseQuery, [userId, aiResponse, context]);

    res.json({
      message: aiResponse,
      context,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Coach chat error:', error);
    res.status(500).json({ error: 'Failed to get coach response' });
  }
});

// Get chat history
router.get('/history', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50 } = req.query;

    const query = `
      SELECT id, message, role, context, created_at
      FROM coach_messages 
      WHERE user_id = $1
      ORDER BY created_at ASC
      LIMIT $2
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching coach history:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// Clear chat history
router.delete('/history', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const query = 'DELETE FROM coach_messages WHERE user_id = $1';
    await db.query(query, [userId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing coach history:', error);
    res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

module.exports = router;
