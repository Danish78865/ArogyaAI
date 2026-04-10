/**
 * HARDCORE GYM API - ADVANCED FITNESS INTELLIGENCE ENGINE
 * AI Coach · Periodization · Form Analysis · Biometrics · Injury Prevention
 */

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const db = require('../models/db');

router.use(authenticate);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// HELPERS
const calc1RM = (weight, reps) => Math.round(weight * (1 + reps / 30));
const calc1RMBrzycki = (weight, reps) => Math.round(weight / (1.0278 - 0.0278 * reps));
const calcWilks = (total, bodyweight, isMale) => {
  const a = isMale ? [-216.0475144, 16.2606339, -0.002388645, -0.00113732, 7.01863e-6, -1.291e-8]
                   : [594.31747775582, -27.23842536447, 0.82112226871, -0.00930733913, 4.731582e-5, -9.054e-8];
  const bw = bodyweight;
  const coeff = 500 / (a[0] + a[1]*bw + a[2]*bw**2 + a[3]*bw**3 + a[4]*bw**4 + a[5]*bw**5);
  return Math.round(total * coeff * 100) / 100;
};
const calcDOTS = (total, bodyweight) => {
  const a = -307.75076, b = 24.0900756, c = -0.1918759221, d = 0.0007391293, e = -0.000001093;
  const denom = a + b*bodyweight + c*bodyweight**2 + d*bodyweight**3 + e*bodyweight**4;
  return Math.round((500 / denom) * total * 100) / 100;
};
const calcFFMI = (weightKg, heightCm, bodyFatPct) => {
  const leanMass = weightKg * (1 - bodyFatPct / 100);
  const heightM = heightCm / 100;
  return Math.round((leanMass / (heightM ** 2) + 6.1 * (1.8 - heightM)) * 100) / 100;
};
const calcVolumeLoad = (sets, reps, weight) => sets * parseFloat(reps) * weight;
const rpeToPercentage = { 10: 1.0, 9.5: 0.978, 9: 0.955, 8.5: 0.939, 8: 0.924, 7.5: 0.909, 7: 0.893, 6: 0.862 };
const rpeWeight = (oneRM, targetRPE) => Math.round(oneRM * (rpeToPercentage[targetRPE] || 0.85));

const getUserContext = async (userId) => {
  const [profile, history, prs, biometrics, recentSessions] = await Promise.all([
    db.query(`
      SELECT u.name, u.email, up.age, up.sex, up.height_cm, up.weight_kg,
             up.activity_level, up.goal, up.injuries, up.experience_years,
             up.sport, up.body_fat_pct, up.target_weight_kg
      FROM users u LEFT JOIN user_profiles up ON u.id = up.user_id WHERE u.id = $1
    `, [userId]),
    db.query(`
      SELECT wp.name, wp.goal, wp.experience_level, ws.duration_minutes,
             ws.completed_at, ws.perceived_exertion, ws.notes
      FROM workout_sessions ws
      JOIN workout_plans wp ON ws.workout_plan_id = wp.id
      WHERE ws.user_id = $1 ORDER BY ws.completed_at DESC LIMIT 10
    `, [userId]),
    db.query(`
      SELECT exercise_name, weight_kg, reps, estimated_1rm, achieved_at
      FROM personal_records WHERE user_id = $1 ORDER BY achieved_at DESC LIMIT 20
    `, [userId]),
    db.query(`
      SELECT weight_kg, body_fat_pct, muscle_mass_kg, recorded_at
      FROM biometric_logs WHERE user_id = $1 ORDER BY recorded_at DESC LIMIT 5
    `, [userId]),
    db.query(`
      SELECT SUM(volume_load) as weekly_volume, AVG(perceived_exertion) as avg_rpe,
             COUNT(*) as sessions_count
      FROM workout_sessions WHERE user_id = $1
        AND completed_at > NOW() - INTERVAL '7 days'
    `, [userId]),
  ]);

  return {
    profile: profile.rows[0] || {},
    history: history.rows,
    prs: prs.rows,
    biometrics: biometrics.rows,
    weeklyStats: recentSessions.rows[0] || {},
  };
};

const streamAIResponse = async (res, messages, systemPrompt, model = 'gpt-4o') => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = await openai.chat.completions.create({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    stream: true,
    max_tokens: 4000,
    temperature: 0.7,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
};

// Fallback workout plan generator (preserved for compatibility)
const getFallbackWorkoutPlan = (goal, experience, days_per_week, session_duration, equipment) => {
  const plans = {
    weight_loss: {
      name: `${experience === 'beginner' ? 'Beginner' : experience === 'intermediate' ? 'Intermediate' : 'Advanced'} Weight Loss Workout`,
      exercises: [
        {
          name: 'Jumping Jacks',
          muscle_group: 'Full Body',
          sets: 3,
          reps: '30-45 seconds',
          rest_seconds: 30,
          instructions: 'Stand with feet together, jump while spreading legs and raising arms overhead. Return to starting position.',
          order_index: 1
        },
        {
          name: 'Bodyweight Squats',
          muscle_group: 'Legs',
          sets: 3,
          reps: '12-15',
          rest_seconds: 45,
          instructions: 'Stand with feet shoulder-width apart, lower body by bending knees, keep back straight.',
          order_index: 2
        },
        {
          name: 'Push-ups',
          muscle_group: 'Chest',
          sets: 3,
          reps: experience === 'beginner' ? '5-10' : experience === 'intermediate' ? '10-15' : '15-20',
          rest_seconds: 45,
          instructions: 'Start in plank position, lower body until chest nearly touches floor, push back up.',
          order_index: 3
        },
        {
          name: 'Plank',
          muscle_group: 'Core',
          sets: 3,
          reps: '30-60 seconds',
          rest_seconds: 30,
          instructions: 'Hold push-up position with straight body, engage core muscles.',
          order_index: 4
        },
        {
          name: 'Mountain Climbers',
          muscle_group: 'Full Body',
          sets: 3,
          reps: '20-30',
          rest_seconds: 45,
          instructions: 'Start in push-up position, alternate bringing knees toward chest rapidly.',
          order_index: 5
        }
      ]
    },
    muscle_gain: {
      name: `${experience === 'beginner' ? 'Beginner' : experience === 'intermediate' ? 'Intermediate' : 'Advanced'} Muscle Building Workout`,
      exercises: [
        {
          name: 'Warm-up Jog',
          muscle_group: 'Cardio',
          sets: 1,
          reps: '5 minutes',
          rest_seconds: 0,
          instructions: 'Light jogging to warm up muscles and increase heart rate.',
          order_index: 1
        },
        {
          name: 'Push-ups',
          muscle_group: 'Chest',
          sets: 4,
          reps: experience === 'beginner' ? '8-12' : experience === 'intermediate' ? '12-15' : '15-20',
          rest_seconds: 60,
          instructions: 'Start in plank position, lower body until chest nearly touches floor, push back up.',
          order_index: 2
        },
        {
          name: 'Bodyweight Squats',
          muscle_group: 'Legs',
          sets: 4,
          reps: '15-20',
          rest_seconds: 60,
          instructions: 'Stand with feet shoulder-width apart, lower body by bending knees, keep back straight.',
          order_index: 3
        },
        {
          name: 'Lunges',
          muscle_group: 'Legs',
          sets: 3,
          reps: '10-12 each leg',
          rest_seconds: 60,
          instructions: 'Step forward with one leg, lower hips until both knees are bent at 90 degrees.',
          order_index: 4
        },
        {
          name: 'Plank',
          muscle_group: 'Core',
          sets: 3,
          reps: '45-90 seconds',
          rest_seconds: 45,
          instructions: 'Hold push-up position with straight body, engage core muscles.',
          order_index: 5
        }
      ]
    },
    general_fitness: {
      name: `${experience === 'beginner' ? 'Beginner' : experience === 'intermediate' ? 'Intermediate' : 'Advanced'} General Fitness Workout`,
      exercises: [
        {
          name: 'Warm-up',
          muscle_group: 'Full Body',
          sets: 1,
          reps: '5 minutes',
          rest_seconds: 0,
          instructions: 'Light cardio and dynamic stretching to warm up.',
          order_index: 1
        },
        {
          name: 'Bodyweight Squats',
          muscle_group: 'Legs',
          sets: 3,
          reps: '12-15',
          rest_seconds: 45,
          instructions: 'Stand with feet shoulder-width apart, lower body by bending knees, keep back straight.',
          order_index: 2
        },
        {
          name: 'Push-ups',
          muscle_group: 'Upper Body',
          sets: 3,
          reps: experience === 'beginner' ? '5-10' : experience === 'intermediate' ? '10-15' : '15-20',
          rest_seconds: 45,
          instructions: 'Start in plank position, lower body until chest nearly touches floor, push back up.',
          order_index: 3
        },
        {
          name: 'Plank',
          muscle_group: 'Core',
          sets: 3,
          reps: '30-60 seconds',
          rest_seconds: 30,
          instructions: 'Hold push-up position with straight body, engage core muscles.',
          order_index: 4
        },
        {
          name: 'Jumping Jacks',
          muscle_group: 'Cardio',
          sets: 3,
          reps: '30-45 seconds',
          rest_seconds: 30,
          instructions: 'Jump while spreading legs and raising arms overhead, return to starting position.',
          order_index: 5
        }
      ]
    }
  };

  return plans[goal] || plans.general_fitness;
};

// Get workout plans
router.get('/plans', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const query = `
      SELECT id, name, goal, experience_level, days_per_week, session_duration, 
             equipment, created_at, updated_at
      FROM workout_plans 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `;
    
    const result = await db.query(query, [userId]);
    
    // Get exercises for each plan
    const plans = await Promise.all(result.rows.map(async (plan) => {
      const exercisesQuery = `
        SELECT id, name, muscle_group, sets, reps, rest_seconds, instructions, order_index
        FROM workout_exercises 
        WHERE workout_plan_id = $1 
        ORDER BY order_index
      `;
      const exercisesResult = await db.query(exercisesQuery, [plan.id]);
      
      return {
        ...plan,
        exercises: exercisesResult.rows
      };
    }));
    
    res.json(plans);
  } catch (error) {
    console.error('Error fetching workout plans:', error);
    res.status(500).json({ error: 'Failed to fetch workout plans' });
  }
});

// Create AI workout plan
router.post('/plans', async (req, res) => {
  try {
    const userId = req.user.id;
    const { goal, experience, days_per_week, session_duration, equipment } = req.body;

    // Get user profile for context
    const userQuery = `
      SELECT u.name, up.age, up.sex, up.height_cm, up.weight_kg, 
             up.activity_level, up.goal
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      WHERE u.id = $1
    `;
    const userResult = await db.query(userQuery, [userId]);
    const userProfile = userResult.rows[0];

    // Build prompt for OpenAI
    const prompt = `Create a personalized workout plan with the following specifications:

User Profile:
- Name: ${userProfile?.name || 'User'}
- Age: ${userProfile?.age || 'Not specified'}
- Gender: ${userProfile?.sex || 'Not specified'}
- Height: ${userProfile?.height_cm || 'Not specified'} cm
- Weight: ${userProfile?.weight_kg || 'Not specified'} kg
- Activity Level: ${userProfile?.activity_level || 'Not specified'}
- Current Goal: ${userProfile?.goal || 'Not specified'}

Workout Requirements:
- Goal: ${goal}
- Experience Level: ${experience}
- Days per week: ${days_per_week}
- Session duration: ${session_duration} minutes
- Available equipment: ${equipment}

Please create a workout plan and respond with a JSON object in this format:
{
  "name": "Descriptive workout plan name",
  "description": "Brief description of the plan",
  "exercises": [
    {
      "name": "Exercise name",
      "muscle_group": "Primary muscle group",
      "sets": 3,
      "reps": "12-15",
      "rest_seconds": 60,
      "instructions": "Detailed instructions for proper form",
      "order_index": 1
    }
  ]
}

Make sure to:
1. Include 5-8 exercises appropriate for the goal and experience level
2. Balance different muscle groups
3. Provide clear, concise instructions
4. Use proper rep ranges (e.g., "8-12", "12-15", "15-20")
5. Set appropriate rest times (30-90 seconds)
6. Order exercises logically (warmup -> main -> cooldown)`;

    // Call OpenAI API with timeout
    let workoutPlan;
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: 'You are a certified personal trainer. Create safe, effective workout plans based on user specifications. Always respond with valid JSON only.' 
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 2000,
        temperature: 0.7,
      });

      const aiResponse = completion.choices[0].message.content;
      
      try {
        workoutPlan = JSON.parse(aiResponse);
      } catch (parseError) {
        console.error('Failed to parse AI response:', aiResponse);
        workoutPlan = getFallbackWorkoutPlan(goal, experience, days_per_week, session_duration, equipment);
      }
    } catch (openaiError) {
      console.error('OpenAI API error:', openaiError);
      workoutPlan = getFallbackWorkoutPlan(goal, experience, days_per_week, session_duration, equipment);
    }

    // Save workout plan to database
    console.log('Saving workout plan to database...');
    let planId;
    
    const savePlanQuery = `
      INSERT INTO workout_plans 
      (user_id, name, goal, experience_level, days_per_week, session_duration, equipment, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id
    `;
    
    try {
      const planResult = await db.query(savePlanQuery, [
        userId,
        workoutPlan.name,
        goal,
        experience,
        days_per_week,
        session_duration,
        equipment
      ]);
      
      planId = planResult.rows[0].id;
      console.log('Workout plan saved with ID:', planId);

      // Save exercises
      for (const exercise of workoutPlan.exercises) {
        console.log('Saving exercise:', exercise.name);
        const saveExerciseQuery = `
          INSERT INTO workout_exercises 
          (workout_plan_id, name, muscle_group, sets, reps, rest_seconds, instructions, order_index, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        `;
        await db.query(saveExerciseQuery, [
          planId,
          exercise.name,
          exercise.muscle_group,
          exercise.sets,
          exercise.reps,
          exercise.rest_seconds,
          exercise.instructions,
          exercise.order_index
        ]);
      }
      
      console.log('All exercises saved successfully');
    } catch (dbError) {
      console.error('Database error:', dbError);
      throw dbError;
    }

    // Return the complete plan with exercises
    const completePlan = {
      id: planId,
      name: workoutPlan.name,
      goal,
      experience_level: experience,
      days_per_week,
      session_duration,
      equipment,
      created_at: new Date().toISOString(),
      exercises: workoutPlan.exercises.map((ex, index) => ({
        id: index + 1, // Temporary ID for frontend
        ...ex
      }))
    };

    res.json(completePlan);

  } catch (error) {
    console.error('Error creating workout plan:', error);
    res.status(500).json({ error: 'Failed to create workout plan' });
  }
});

// Delete workout plan
router.delete('/plans/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const planId = req.params.id;

    // Verify plan belongs to user
    const verifyQuery = 'SELECT user_id FROM workout_plans WHERE id = $1';
    const verifyResult = await db.query(verifyQuery, [planId]);
    
    if (verifyResult.rows.length === 0 || verifyResult.rows[0].user_id !== userId) {
      return res.status(404).json({ error: 'Workout plan not found' });
    }

    // Delete exercises first (foreign key constraint)
    const deleteExercisesQuery = 'DELETE FROM workout_exercises WHERE workout_plan_id = $1';
    await db.query(deleteExercisesQuery, [planId]);

    // Delete plan
    const deletePlanQuery = 'DELETE FROM workout_plans WHERE id = $1';
    await db.query(deletePlanQuery, [planId]);

    res.json({ success: true });

  } catch (error) {
    console.error('Error deleting workout plan:', error);
    res.status(500).json({ error: 'Failed to delete workout plan' });
  }
});

// Log workout session
router.post('/sessions', async (req, res) => {
  try {
    const userId = req.user.id;
    const { workout_plan_id, exercises_completed, duration_minutes, notes } = req.body;

    const query = `
      INSERT INTO workout_sessions 
      (user_id, workout_plan_id, exercises_completed, duration_minutes, notes, completed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id, completed_at
    `;
    
    const result = await db.query(query, [
      userId,
      workout_plan_id,
      exercises_completed,
      duration_minutes,
      notes
    ]);

    res.json({
      success: true,
      session: result.rows[0]
    });

  } catch (error) {
    console.error('Error logging workout session:', error);
    res.status(500).json({ error: 'Failed to log workout session' });
  }
});

// Get workout history
router.get('/sessions', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20 } = req.query;

    const query = `
      SELECT ws.*, wp.name as workout_name
      FROM workout_sessions ws
      LEFT JOIN workout_plans wp ON ws.workout_plan_id = wp.id
      WHERE ws.user_id = $1
      ORDER BY ws.completed_at DESC
      LIMIT $2
    `;
    
    const result = await db.query(query, [userId, limit]);
    
    res.json(result.rows);

  } catch (error) {
    console.error('Error fetching workout history:', error);
    res.status(500).json({ error: 'Failed to fetch workout history' });
  }
});

module.exports = router;
