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
          instructions: 'Hold plank position with straight body, engage core muscles.',
          order_index: 4
        }
      ]
    },
    muscle_gain: {
      name: `${experience === 'beginner' ? 'Beginner' : experience === 'intermediate' ? 'Intermediate' : 'Advanced'} Muscle Building Workout`,
      exercises: [
        {
          name: 'Squats',
          muscle_group: 'Legs',
          sets: 4,
          reps: experience === 'beginner' ? '8-12' : experience === 'intermediate' ? '6-10' : '4-8',
          rest_seconds: 60,
          instructions: 'Stand with feet shoulder-width apart, lower hips back and down, keep chest up.',
          order_index: 1
        },
        {
          name: 'Bench Press',
          muscle_group: 'Chest',
          sets: 4,
          reps: experience === 'beginner' ? '8-12' : experience === 'intermediate' ? '6-10' : '4-8',
          rest_seconds: 60,
          instructions: 'Lie on bench, lower bar to chest, press up explosively.',
          order_index: 2
        },
        {
          name: 'Deadlifts',
          muscle_group: 'Back',
          sets: 3,
          reps: experience === 'beginner' ? '6-8' : experience === 'intermediate' ? '4-6' : '3-5',
          rest_seconds: 90,
          instructions: 'Bend at hips, grasp bar, lift with straight back, drive through heels.',
          order_index: 3
        },
        {
          name: 'Pull-ups',
          muscle_group: 'Back',
          sets: 3,
          reps: experience === 'beginner' ? '5-8' : experience === 'intermediate' ? '8-12' : '12-15',
          rest_seconds: 60,
          instructions: 'Pull body up until chin clears bar, lower with control.',
          order_index: 4
        }
      ]
    },
    general_fitness: {
      name: `${experience === 'beginner' ? 'Beginner' : experience === 'intermediate' ? 'Intermediate' : 'Advanced'} General Fitness Workout`,
      exercises: [
        {
          name: 'Squats',
          muscle_group: 'Legs',
          sets: 3,
          reps: '12-15',
          rest_seconds: 45,
          instructions: 'Bodyweight squats with good form.',
          order_index: 1
        },
        {
          name: 'Push-ups',
          muscle_group: 'Chest',
          sets: 3,
          reps: experience === 'beginner' ? '5-10' : experience === 'intermediate' ? '10-15' : '15-20',
          rest_seconds: 45,
          instructions: 'Standard push-ups with proper form.',
          order_index: 2
        },
        {
          name: 'Lunges',
          muscle_group: 'Legs',
          sets: 3,
          reps: '10-12 per leg',
          rest_seconds: 45,
          instructions: 'Step forward into lunge, back knee near ground.',
          order_index: 3
        },
        {
          name: 'Plank',
          muscle_group: 'Core',
          sets: 3,
          reps: '30-60 seconds',
          rest_seconds: 30,
          instructions: 'Hold straight plank position.',
          order_index: 4
        }
      ]
    }
  };

  return plans[goal] || plans.general_fitness;
};

// 1. WORKOUT PLAN CRUD
router.get('/plans', async (req, res) => {
  try {
    const { page = 1, limit = 20, goal, sort = 'created_at' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT wp.*, 
             COUNT(we.id) as exercise_count,
             COUNT(ws.id) as session_count,
             MAX(ws.completed_at) as last_completed
      FROM workout_plans wp
      LEFT JOIN workout_exercises we ON we.workout_plan_id = wp.id
      LEFT JOIN workout_sessions ws ON ws.workout_plan_id = wp.id AND ws.user_id = $1
      WHERE wp.user_id = $1
    `;
    const params = [req.user.id];

    if (goal) { params.push(goal); query += ` AND wp.goal = $${params.length}`; }
    query += ` GROUP BY wp.id ORDER BY wp.${sort} DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    const plans = await Promise.all(result.rows.map(async (plan) => {
      const exercises = await db.query(
        `SELECT * FROM workout_exercises WHERE workout_plan_id = $1 ORDER BY order_index`,
        [plan.id]
      );
      return { ...plan, exercises: exercises.rows };
    }));

    const countResult = await db.query(
      `SELECT COUNT(*) FROM workout_plans WHERE user_id = $1`, [req.user.id]
    );

    res.json({ plans, total: parseInt(countResult.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// POST /plans - Basic workout plan creation (for compatibility)
router.post('/plans', async (req, res) => {
  try {
    const { goal, experience, days_per_week, session_duration, equipment } = req.body;
    const userId = req.user.id;

    // Use fallback plan generator for basic plans
    const workoutPlan = getFallbackWorkoutPlan(goal, experience, days_per_week, session_duration, equipment);

    // Save to database
    const planResult = await db.query(`
      INSERT INTO workout_plans (user_id, name, goal, experience_level, days_per_week,
        session_duration, equipment, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id
    `, [userId, workoutPlan.name, goal, experience, days_per_week, session_duration, equipment]);

    const planId = planResult.rows[0].id;

    // Save exercises
    for (const exercise of workoutPlan.exercises) {
      await db.query(`
        INSERT INTO workout_exercises (workout_plan_id, name, muscle_group, sets, reps, 
          rest_seconds, instructions, order_index, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      `, [planId, exercise.name, exercise.muscle_group, exercise.sets, exercise.reps, 
          exercise.rest_seconds, exercise.instructions, exercise.order_index]);
    }

    res.json({ id: planId, ...workoutPlan });
  } catch (error) {
    console.error('Error creating workout plan:', error);
    res.status(500).json({ error: 'Failed to create workout plan' });
  }
});

router.get('/plans/:id', async (req, res) => {
  try {
    const plan = await db.query(
      `SELECT * FROM workout_plans WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!plan.rows.length) return res.status(404).json({ error: 'Plan not found' });

    const [exercises, sessions, volumeHistory] = await Promise.all([
      db.query(`SELECT * FROM workout_exercises WHERE workout_plan_id = $1 ORDER BY order_index`, [req.params.id]),
      db.query(`SELECT * FROM workout_sessions WHERE workout_plan_id = $1 ORDER BY completed_at DESC LIMIT 30`, [req.params.id]),
      db.query(`
        SELECT DATE_TRUNC('week', completed_at) as week, SUM(volume_load) as volume
        FROM workout_sessions WHERE workout_plan_id = $1
        GROUP BY week ORDER BY week DESC LIMIT 12
      `, [req.params.id]),
    ]);

    res.json({
      ...plan.rows[0],
      exercises: exercises.rows,
      sessions: sessions.rows,
      volumeHistory: volumeHistory.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// 2. AI WORKOUT PLAN GENERATOR (GPT-4o - Full Context)
router.post('/plans/generate', async (req, res) => {
  try {
    const ctx = await getUserContext(req.user.id);
    const { goal, experience, days_per_week, session_duration, equipment,
            split_type, periodization, focus_muscles, avoid_exercises,
            training_style, competition_date } = req.body;

    const systemPrompt = `You are an elite-level certified strength and conditioning specialist (CSCS), 
sports nutritionist, and physical therapist with 20 years experience training Olympic athletes, 
powerlifters, bodybuilders, and everyday fitness enthusiasts. 
You create scientifically-backed, periodized training programs with biomechanical precision.
Always respond with valid JSON only. No markdown, no explanation outside JSON.`;

    const prompt = `Create an advanced, scientifically-structured workout program.

ATHLETE PROFILE:
${JSON.stringify(ctx.profile, null, 2)}

RECENT TRAINING HISTORY (last 10 sessions):
${JSON.stringify(ctx.history, null, 2)}

PERSONAL RECORDS:
${JSON.stringify(ctx.prs, null, 2)}

WEEKLY TRAINING STATS:
${JSON.stringify(ctx.weeklyStats, null, 2)}

PROGRAM REQUIREMENTS:
- Primary Goal: ${goal}
- Training Age/Experience: ${experience}
- Training Days/Week: ${days_per_week}
- Session Duration: ${session_duration} minutes
- Available Equipment: ${equipment}
- Split Type: ${split_type || 'auto-select best'}
- Periodization Model: ${periodization || 'linear'}
- Focus Muscles: ${focus_muscles || 'balanced'}
- Exercises to Avoid: ${avoid_exercises || 'none'}
- Training Style: ${training_style || 'hypertrophy'}
${competition_date ? `- Competition/Target Date: ${competition_date}` : ''}

Generate a complete program with this exact JSON structure:
{
  "name": "Program name",
  "description": "Detailed program description with scientific rationale",
  "split_type": "push_pull_legs|upper_lower|full_body|bro_split|ppl_x|etc",
  "periodization": "linear|undulating|block|conjugate|wave_loading",
  "phase": "hypertrophy|strength|power|peaking|deload",
  "duration_weeks": 8,
  "scientific_rationale": "Why this program design fits this athlete",
  "weekly_schedule": {
    "monday": "Push - Chest/Shoulders/Triceps",
    "tuesday": "Pull - Back/Biceps",
    "wednesday": "Rest/Active Recovery",
    "thursday": "Legs - Quads/Glutes",
    "friday": "Push - Variation",
    "saturday": "Pull + Arms",
    "sunday": "Rest"
  },
  "exercises": [
    {
      "name": "Exercise name",
      "muscle_group": "Primary muscle",
      "secondary_muscles": ["muscle1", "muscle2"],
      "movement_pattern": "push|pull|hinge|squat|carry|rotation",
      "day": "monday",
      "order_index": 1,
      "sets": 4,
      "reps": "6-8",
      "rest_seconds": 120,
      "tempo": "3-1-1-0",
      "rpe_target": 8,
      "percentage_1rm": 80,
      "superset_with": null,
      "technique": "straight_sets|drop_set|pause_reps|cluster_sets|rest_pause",
      "instructions": "Detailed form cues for this specific athlete",
      "coaching_cues": ["Cue 1", "Cue 2", "Cue 3"],
      "common_mistakes": ["Mistake 1", "Mistake 2"],
      "progression_rule": "Add 2.5kg when all sets completed at top of rep range",
      "regression": "Easier variation if needed",
      "progression_variation": "Harder variation when ready"
    }
  ],
  "warm_up_protocol": {
    "duration_minutes": 10,
    "exercises": ["Exercise 1", "Exercise 2"]
  },
  "cool_down_protocol": {
    "duration_minutes": 10,
    "stretches": ["Stretch 1", "Stretch 2"]
  },
  "nutrition_timing": {
    "pre_workout": "30-60min before: 30g protein + 40g carbs",
    "intra_workout": "If >60min: 25g fast carbs",
    "post_workout": "Within 30min: 40g whey + 60g carbs"
  },
  "recovery_recommendations": ["Recommendation 1", "Recommendation 2"],
  "progression_model": {
    "week_1_2": "Accumulation phase - higher volume, moderate intensity",
    "week_3_4": "Intensification - lower volume, higher intensity",
    "week_5_6": "Overreach - peak volume and intensity",
    "week_7_8": "Deload - 50% volume reduction"
  },
  "deload_indicators": ["Sign 1", "Sign 2"],
  "injury_precautions": ["Precaution 1"],
  "estimated_results": {
    "strength_gain_pct": 8,
    "muscle_gain_kg": 1.5,
    "fat_loss_kg": 0
  }
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      max_tokens: 6000,
      temperature: 0.6,
      response_format: { type: 'json_object' },
    });

    const workoutPlan = JSON.parse(completion.choices[0].message.content);

    // Save to DB
    const planResult = await db.query(`
      INSERT INTO workout_plans (user_id, name, goal, experience_level, days_per_week,
        session_duration, equipment, description, split_type, periodization, phase,
        duration_weeks, ai_generated, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,NOW()) RETURNING id
    `, [
      req.user.id, workoutPlan.name, goal, experience, days_per_week, session_duration,
      equipment, workoutPlan.description, workoutPlan.split_type, workoutPlan.periodization,
      workoutPlan.phase, workoutPlan.duration_weeks
    ]);

    const planId = planResult.rows[0].id;

    // Save all exercises
    for (const ex of workoutPlan.exercises) {
      await db.query(`
        INSERT INTO workout_exercises (workout_plan_id, name, muscle_group, secondary_muscles,
          movement_pattern, day, sets, reps, rest_seconds, tempo, rpe_target,
          percentage_1rm, technique, instructions, coaching_cues, common_mistakes,
          progression_rule, regression, progression_variation, superset_with, order_index, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
      `, [
        planId, ex.name, ex.muscle_group, JSON.stringify(ex.secondary_muscles || []),
        ex.movement_pattern, ex.day, ex.sets, ex.reps, ex.rest_seconds, ex.tempo,
        ex.rpe_target, ex.percentage_1rm, ex.technique, ex.instructions,
        JSON.stringify(ex.coaching_cues || []), JSON.stringify(ex.common_mistakes || []),
        ex.progression_rule, ex.regression, ex.progression_variation,
        ex.superset_with, ex.order_index
      ]);
    }

    // Save program metadata
    await db.query(`
      INSERT INTO workout_plan_metadata (plan_id, weekly_schedule, nutrition_timing,
        recovery_recommendations, progression_model, deload_indicators,
        injury_precautions, estimated_results, scientific_rationale, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (plan_id) DO UPDATE SET weekly_schedule=$2, updated_at=NOW()
    `, [
      planId, JSON.stringify(workoutPlan.weekly_schedule),
      JSON.stringify(workoutPlan.nutrition_timing),
      JSON.stringify(workoutPlan.recovery_recommendations),
      JSON.stringify(workoutPlan.progression_model),
      JSON.stringify(workoutPlan.deload_indicators),
      JSON.stringify(workoutPlan.injury_precautions),
      JSON.stringify(workoutPlan.estimated_results),
      workoutPlan.scientific_rationale,
    ]);

    res.json({ id: planId, ...workoutPlan });
  } catch (err) {
    console.error('Plan generation error:', err);
    res.status(500).json({ error: 'Failed to generate plan', details: err.message });
  }
});

// 3. AI PERSONAL COACH CHAT (Streaming, with memory)
router.post('/coach/chat', async (req, res) => {
  try {
    const { messages, session_id } = req.body;
    const ctx = await getUserContext(req.user.id);

    const systemPrompt = `You are TITAN, an elite AI personal fitness coach. You are intense, 
knowledgeable, motivating, and scientifically precise. You know this athlete deeply:

ATHLETE: ${ctx.profile.name}, Age ${ctx.profile.age}, ${ctx.profile.sex}
STATS: ${ctx.profile.weight_kg}kg, ${ctx.profile.height_cm}cm, ${ctx.profile.body_fat_pct || '?'}% body fat
EXPERIENCE: ${ctx.profile.experience_years || '?'} years training
GOAL: ${ctx.profile.goal}
INJURIES/LIMITATIONS: ${ctx.profile.injuries || 'None reported'}
RECENT PRs: ${ctx.prs.slice(0, 5).map(p => `${p.exercise_name}: ${p.weight_kg}kg × ${p.reps}`).join(', ') || 'None yet'}
WEEKLY VOLUME: ${ctx.weeklyStats.weekly_volume || 0} kg total load, ${ctx.weeklyStats.sessions_count || 0} sessions
AVG RPE LAST WEEK: ${ctx.weeklyStats.avg_rpe || 'N/A'}

You can:
- Analyze their training data and give specific recommendations
- Answer any fitness, nutrition, or recovery question
- Troubleshoot plateaus, injuries, and motivation issues
- Suggest exercise modifications, progressions, or regressions
- Calculate strength standards, 1RMs, macros, and volumes
- Provide science-backed explanations with studies and research

Be direct, authoritative, and deeply personal to their specific situation.
Use their actual data in your responses. Push them when needed, hold them back when they're overtraining.`;

    // Save conversation to DB
    if (session_id) {
      await db.query(`
        INSERT INTO coach_conversations (user_id, session_id, messages, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (session_id) DO UPDATE SET messages=$3, updated_at=NOW()
      `, [req.user.id, session_id, JSON.stringify(messages)]);
    }

    await streamAIResponse(res, messages, systemPrompt, 'gpt-4o');
  } catch (err) {
    console.error('Coach chat error:', err);
    res.status(500).json({ error: 'Coach unavailable' });
  }
});

router.get('/coach/history', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT session_id, messages, updated_at
      FROM coach_conversations WHERE user_id = $1
      ORDER BY updated_at DESC LIMIT 20
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// 4. WORKOUT SESSION LOGGING (Advanced)
router.post('/sessions', async (req, res) => {
  try {
    const {
      workout_plan_id, exercises_completed, duration_minutes, notes,
      perceived_exertion, mood, sleep_hours_prior, body_weight_today,
      location, environment_temp
    } = req.body;

    // Calculate total volume load
    let totalVolume = 0;
    for (const ex of (exercises_completed || [])) {
      if (ex.sets_data) {
        for (const set of ex.sets_data) {
          totalVolume += calcVolumeLoad(1, set.reps, set.weight_kg || 0);
        }
      }
    }

    const result = await db.query(`
      INSERT INTO workout_sessions (
        user_id, workout_plan_id, exercises_completed, duration_minutes,
        notes, perceived_exertion, mood, sleep_hours_prior, body_weight_today,
        volume_load, location, environment_temp, completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *
    `, [
      req.user.id, workout_plan_id,
      JSON.stringify(exercises_completed || []),
      duration_minutes, notes, perceived_exertion, mood,
      sleep_hours_prior, body_weight_today, totalVolume, location, environment_temp
    ]);

    const session = result.rows[0];

    // Check and update PRs
    const newPRs = [];
    for (const ex of (exercises_completed || [])) {
      if (!ex.sets_data) continue;
      const maxSet = ex.sets_data.reduce((best, s) =>
        calc1RM(s.weight_kg || 0, s.reps) > calc1RM(best.weight_kg || 0, best.reps) ? s : best,
        ex.sets_data[0] || { weight_kg: 0, reps: 1 }
      );
      const estimated1RM = calc1RM(maxSet.weight_kg || 0, maxSet.reps || 1);

      const existing = await db.query(`
        SELECT estimated_1rm FROM personal_records
        WHERE user_id = $1 AND exercise_name = $2
        ORDER BY estimated_1rm DESC LIMIT 1
      `, [req.user.id, ex.exercise_name]);

      if (!existing.rows.length || estimated1RM > existing.rows[0].estimated_1rm) {
        await db.query(`
          INSERT INTO personal_records (user_id, exercise_name, weight_kg, reps,
            estimated_1rm, session_id, achieved_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
        `, [req.user.id, ex.exercise_name, maxSet.weight_kg, maxSet.reps, estimated1RM, session.id]);
        newPRs.push({ exercise: ex.exercise_name, weight: maxSet.weight_kg, reps: maxSet.reps, estimated1RM });
      }
    }

    // Progressive overload: update next session recommendations
    if (workout_plan_id) {
      await applyProgressiveOverload(req.user.id, workout_plan_id, exercises_completed);
    }

    // Log body weight
    if (body_weight_today) {
      await db.query(`
        INSERT INTO biometric_logs (user_id, weight_kg, recorded_at)
        VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING
      `, [req.user.id, body_weight_today]);
    }

    // Generate AI post-workout summary
    const aiSummary = await generateWorkoutSummary(req.user.id, session, exercises_completed, newPRs, totalVolume);

    res.json({ success: true, session, newPRs, totalVolume, aiSummary });
  } catch (err) {
    console.error('Session log error:', err);
    res.status(500).json({ error: 'Failed to log session' });
  }
});

async function applyProgressiveOverload(userId, planId, completedExercises) {
  if (!completedExercises?.length) return;

  for (const ex of completedExercises) {
    if (!ex.sets_data || !ex.exercise_name) continue;

    const planExercise = await db.query(`
      SELECT * FROM workout_exercises WHERE workout_plan_id = $1 AND name = $2
    `, [planId, ex.exercise_name]);

    if (!planExercise.rows.length) continue;
    const planEx = planExercise.rows[0];
    const [minReps, maxReps] = planEx.reps.toString().split('-').map(Number);

    const allSetsCompleted = ex.sets_data.every(s => s.reps >= (maxReps || minReps));
    const completedAllSets = ex.sets_data.length >= planEx.sets;

    if (allSetsCompleted && completedAllSets) {
      const increment = ex.exercise_name.toLowerCase().includes('squat') ||
                        ex.exercise_name.toLowerCase().includes('deadlift') ||
                        ex.exercise_name.toLowerCase().includes('press') ? 2.5 : 1.25;

      await db.query(`
        INSERT INTO progression_recommendations (user_id, plan_id, exercise_name,
          current_weight, recommended_weight, reason, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (user_id, plan_id, exercise_name)
        DO UPDATE SET recommended_weight=$5, reason=$6, updated_at=NOW()
      `, [
        userId, planId, ex.exercise_name,
        ex.sets_data[0]?.weight_kg || 0,
        (ex.sets_data[0]?.weight_kg || 0) + increment,
        `Completed all ${planEx.sets} sets at ${maxReps} reps - ready to progress`
      ]);
    }
  }
}

router.get('/sessions', async (req, res) => {
  try {
    const { limit = 30, page = 1, plan_id, start_date, end_date } = req.query;
    const offset = (page - 1) * limit;
    const params = [req.user.id];
    let where = 'WHERE ws.user_id = $1';

    if (plan_id) { params.push(plan_id); where += ` AND ws.workout_plan_id = $${params.length}`; }
    if (start_date) { params.push(start_date); where += ` AND ws.completed_at >= $${params.length}`; }
    if (end_date) { params.push(end_date); where += ` AND ws.completed_at <= $${params.length}`; }

    const result = await db.query(`
      SELECT ws.*, wp.name as plan_name, wp.goal
      FROM workout_sessions ws
      LEFT JOIN workout_plans wp ON ws.workout_plan_id = wp.id
      ${where}
      ORDER BY ws.completed_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// 5. PERSONAL RECORDS (PRs)
router.get('/prs', async (req, res) => {
  try {
    const { exercise } = req.query;
    let query = `
      SELECT pr.*, 
             LAG(pr.estimated_1rm) OVER (PARTITION BY pr.exercise_name ORDER BY pr.achieved_at) as prev_1rm
      FROM personal_records pr
      WHERE pr.user_id = $1
    `;
    const params = [req.user.id];
    if (exercise) { params.push(exercise); query += ` AND pr.exercise_name ILIKE $${params.length}`; }
    query += ' ORDER BY pr.exercise_name, pr.achieved_at DESC';

    const result = await db.query(query, params);

    const grouped = result.rows.reduce((acc, row) => {
      if (!acc[row.exercise_name]) acc[row.exercise_name] = { best: row, history: [] };
      acc[row.exercise_name].history.push(row);
      if (row.estimated_1rm > acc[row.exercise_name].best.estimated_1rm)
        acc[row.exercise_name].best = row;
      return acc;
    }, {});

    res.json(grouped);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch PRs' });
  }
});

router.post('/prs/manual', async (req, res) => {
  try {
    const { exercise_name, weight_kg, reps, achieved_at } = req.body;
    const estimated1RM = calc1RM(weight_kg, reps);

    const result = await db.query(`
      INSERT INTO personal_records (user_id, exercise_name, weight_kg, reps, estimated_1rm, achieved_at)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.user.id, exercise_name, weight_kg, reps, estimated1RM, achieved_at || new Date()]);

    res.json({ ...result.rows[0], estimated_1rm: estimated1RM });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log PR' });
  }
});

// 6. STRENGTH CALCULATORS
router.post('/calculate/1rm', (req, res) => {
  const { weight, reps } = req.body;
  if (!weight || !reps) return res.status(400).json({ error: 'weight and reps required' });

  const epley = calc1RM(weight, reps);
  const brzycki = calc1RMBrzycki(weight, reps);

  const percentages = [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50].map(pct => ({
    percentage: pct,
    weight: Math.round(epley * pct / 100 * 4) / 4,
    reps_guideline: pct >= 95 ? '1-2' : pct >= 90 ? '2-3' : pct >= 85 ? '3-5' :
                    pct >= 80 ? '4-6' : pct >= 75 ? '6-8' : pct >= 70 ? '8-10' :
                    pct >= 65 ? '10-12' : pct >= 60 ? '12-15' : '15-20+',
  }));

  res.json({
    input: { weight, reps },
    estimated_1rm: { epley, brzycki, average: Math.round((epley + brzycki) / 2) },
    training_percentages: percentages,
    rpe_recommendations: Object.entries(rpeToPercentage).map(([rpe, pct]) => ({
      rpe: parseFloat(rpe),
      weight: rpeWeight(epley, parseFloat(rpe))
    })),
  });
});

router.post('/calculate/wilks', (req, res) => {
  const { total, bodyweight, sex } = req.body;
  const isMale = sex?.toLowerCase() !== 'female';
  const wilks = calcWilks(total, bodyweight, isMale);
  const dots = calcDOTS(total, bodyweight);

  const classification = wilks < 200 ? 'Untrained' : wilks < 300 ? 'Beginner' :
    wilks < 400 ? 'Intermediate' : wilks < 500 ? 'Advanced' :
    wilks < 600 ? 'Elite' : 'World Class';

  res.json({ wilks, dots, classification, total, bodyweight });
});

router.post('/calculate/ffmi', (req, res) => {
  const { weight_kg, height_cm, body_fat_pct } = req.body;
  const ffmi = calcFFMI(weight_kg, height_cm, body_fat_pct);
  const normalized = Math.round((ffmi + 6.1 * (1.8 - height_cm / 100)) * 100) / 100;

  const rating = ffmi < 17 ? 'Below Average' : ffmi < 18 ? 'Average' : ffmi < 20 ? 'Above Average' :
    ffmi < 22 ? 'Excellent' : ffmi < 23 ? 'Superior' : ffmi < 25 ? 'Suspiciously High' : 'Likely Enhanced';

  res.json({ ffmi, normalized_ffmi: normalized, rating,
    natural_ceiling: 25.0,
    lean_mass_kg: Math.round(weight_kg * (1 - body_fat_pct / 100) * 10) / 10 });
});

// 7. BIOMETRICS & BODY COMPOSITION TRACKING
router.post('/biometrics', async (req, res) => {
  try {
    const { weight_kg, body_fat_pct, muscle_mass_kg, waist_cm, chest_cm, hip_cm,
            bicep_cm, thigh_cm, calf_cm, notes } = req.body;

    const result = await db.query(`
      INSERT INTO biometric_logs (user_id, weight_kg, body_fat_pct, muscle_mass_kg,
        waist_cm, chest_cm, hip_cm, bicep_cm, thigh_cm, calf_cm, notes, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) RETURNING *
    `, [req.user.id, weight_kg, body_fat_pct, muscle_mass_kg,
        waist_cm, chest_cm, hip_cm, bicep_cm, thigh_cm, calf_cm, notes]);

    const log = result.rows[0];

    // Calculate body comp metrics
    const ffmi = (weight_kg && body_fat_pct) ?
      calcFFMI(weight_kg, (await db.query(`SELECT height_cm FROM user_profiles WHERE user_id=$1`, [req.user.id])).rows[0]?.height_cm || 175, body_fat_pct) : null;

    // Get previous reading for change
    const previous = await db.query(`
      SELECT * FROM biometric_logs WHERE user_id = $1
        AND id != $2 ORDER BY recorded_at DESC LIMIT 1
    `, [req.user.id, log.id]);

    const changes = previous.rows.length ? {
      weight: weight_kg - previous.rows[0].weight_kg,
      body_fat: body_fat_pct - (previous.rows[0].body_fat_pct || body_fat_pct),
      muscle_mass: (muscle_mass_kg || 0) - (previous.rows[0].muscle_mass_kg || 0),
    } : null;

    res.json({ ...log, ffmi, changes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log biometrics' });
  }
});

router.get('/biometrics', async (req, res) => {
  try {
    const { limit = 60 } = req.query;
    const result = await db.query(`
      SELECT * FROM biometric_logs WHERE user_id = $1
      ORDER BY recorded_at DESC LIMIT $2
    `, [req.user.id, limit]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch biometrics' });
  }
});

// 8. EXERCISE LIBRARY
router.get('/exercises', async (req, res) => {
  try {
    const { muscle_group, equipment, difficulty, search, limit = 50 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (muscle_group) { params.push(`%${muscle_group}%`); where += ` AND muscle_group ILIKE $${params.length}`; }
    if (equipment) { params.push(`%${equipment}%`); where += ` AND equipment ILIKE $${params.length}`; }
    if (difficulty) { params.push(difficulty); where += ` AND difficulty = $${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND name ILIKE $${params.length}`; }

    params.push(limit);
    const result = await db.query(
      `SELECT * FROM exercise_library ${where} ORDER BY name LIMIT $${params.length}`, params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch exercises' });
  }
});

// 9. ANALYTICS & MUSCLE HEAT MAP
router.get('/analytics/overview', async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const userId = req.user.id;

    const [volumeData, frequencyData, strengthTrend, bodyweightTrend, muscleVolume] = await Promise.all([
      db.query(`
        SELECT DATE_TRUNC('week', completed_at) as week,
               SUM(volume_load) as total_volume,
               AVG(perceived_exertion) as avg_rpe,
               COUNT(*) as sessions,
               SUM(duration_minutes) as total_minutes
        FROM workout_sessions WHERE user_id = $1
          AND completed_at > NOW() - ($2 || ' days')::INTERVAL
        GROUP BY week ORDER BY week
      `, [userId, period]),
      db.query(`
        SELECT EXTRACT(DOW FROM completed_at) as day_of_week, COUNT(*) as count
        FROM workout_sessions WHERE user_id = $1
          AND completed_at > NOW() - ($2 || ' days')::INTERVAL
        GROUP BY day_of_week ORDER BY day_of_week
      `, [userId, period]),
      db.query(`
        SELECT exercise_name, estimated_1rm, achieved_at
        FROM personal_records WHERE user_id = $1
        ORDER BY achieved_at ASC
      `, [userId]),
      db.query(`
        SELECT weight_kg, recorded_at FROM biometric_logs
        WHERE user_id = $1 ORDER BY recorded_at ASC LIMIT 60
      `, [userId]),
      db.query(`
        SELECT we.muscle_group, SUM(ws.volume_load) as volume
        FROM workout_sessions ws
        JOIN workout_plans wp ON ws.workout_plan_id = wp.id
        JOIN workout_exercises we ON we.workout_plan_id = wp.id
        WHERE ws.user_id = $1
          AND ws.completed_at > NOW() - INTERVAL '7 days'
        GROUP BY we.muscle_group
      `, [userId]),
    ]);

    const streak = await db.query(`
      WITH session_dates AS (
        SELECT DATE(completed_at) as d FROM workout_sessions WHERE user_id = $1
        GROUP BY DATE(completed_at) ORDER BY d DESC
      ),
      streaks AS (
        SELECT d, LAG(d) OVER (ORDER BY d DESC) as prev_d FROM session_dates
      )
      SELECT COUNT(*) as streak FROM streaks WHERE prev_d - d <= 2 OR prev_d IS NULL
    `, [userId]);

    const totals = await db.query(`
      SELECT COUNT(*) as total_sessions,
             SUM(duration_minutes) as total_minutes,
             SUM(volume_load) as lifetime_volume,
             COUNT(DISTINCT DATE_TRUNC('week', completed_at)) as active_weeks
      FROM workout_sessions WHERE user_id = $1
    `, [userId]);

    res.json({
      volume_trend: volumeData.rows,
      frequency_by_day: frequencyData.rows,
      strength_progress: strengthTrend.rows,
      bodyweight_trend: bodyweightTrend.rows,
      muscle_heatmap: muscleVolume.rows,
      current_streak: parseInt(streak.rows[0]?.streak || 0),
      totals: totals.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: 'Analytics failed' });
  }
});

// 10. MOTIVATIONAL AI MESSAGES
router.get('/motivation', async (req, res) => {
  try {
    const ctx = await getUserContext(req.user.id);
    const { type = 'general' } = req.query;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are TITAN, the most intense, knowledgeable personal trainer. 
Speak directly to the athlete. Be real, be raw, be motivating. 2-3 sentences max. No fluff.` },
        { role: 'user', content: `Generate a ${type} message for:
Name: ${ctx.profile.name}
Goal: ${ctx.profile.goal}
Sessions this week: ${ctx.weeklyStats.sessions_count || 0}
Recent PR: ${ctx.prs[0] ? `${ctx.prs[0].exercise_name} at ${ctx.prs[0].estimated_1rm}kg 1RM` : 'None recently'}
Context: ${type}` }
      ],
      max_tokens: 150,
      temperature: 0.9,
    });

    res.json({
      message: response.choices[0].message.content,
      type,
      athlete: ctx.profile.name
    });
  } catch (err) {
    res.status(500).json({ error: 'Motivation failed' });
  }
});

// 11. GOAL SETTING & TRACKING
router.post('/goals', async (req, res) => {
  try {
    const { goal_type, target_value, target_date, description, exercise_name } = req.body;

    const result = await db.query(`
      INSERT INTO user_goals (user_id, goal_type, target_value, target_date, description,
        exercise_name, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'active',NOW()) RETURNING *
    `, [req.user.id, goal_type, target_value, target_date, description, exercise_name]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Goal creation failed' });
  }
});

router.get('/goals', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM user_goals WHERE user_id = $1 ORDER BY created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch goals' });
  }
});

// 12. ADVANCED AI ANALYTICS REPORT
router.get('/analytics/ai-report', async (req, res) => {
  try {
    const ctx = await getUserContext(req.user.id);

    const prompt = `Analyze this athlete's training data and provide an advanced performance report.

ATHLETE: ${ctx.profile.name}, ${ctx.profile.age}yo, ${ctx.profile.sex}
GOAL: ${ctx.profile.goal}
WEEKLY VOLUME: ${ctx.weeklyStats.weekly_volume || 0} kg
SESSIONS THIS WEEK: ${ctx.weeklyStats.sessions_count || 0}
AVG RPE: ${ctx.weeklyStats.avg_rpe || 'N/A'}
TOP PRs: ${ctx.prs.slice(0, 5).map(p => `${p.exercise_name}: ${p.estimated_1rm}kg 1RM`).join(', ') || 'None yet'}
TRAINING HISTORY: ${ctx.history.length} sessions recorded

Generate a comprehensive performance report as JSON:
{
  "headline": "One impactful sentence about their current status",
  "performance_grade": "A+|A|B+|B|C|D",
  "key_wins": ["Win 1", "Win 2", "Win 3"],
  "areas_for_improvement": ["Area 1", "Area 2"],
  "volume_assessment": "Analysis of their training volume and intensity",
  "strength_trend": "upward|plateau|declining",
  "training_age_estimate": "Based on PRs and history",
  "next_30_day_focus": "Specific training focus recommendation",
  "pr_predictions": [
    {"exercise": "Squat", "current_1rm": 100, "predicted_1rm_in_90_days": 110, "confidence": 75}
  ],
  "weaknesses_detected": ["Weakness 1"],
  "periodization_recommendation": "What training block they should enter next",
  "motivation_message": "Personal, specific motivational message for this athlete"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an elite sports scientist and performance coach. Respond with JSON only.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ error: 'AI report failed' });
  }
});

// 13. RECOVERY SCORE WITH ACWR
router.get('/recovery/score', async (req, res) => {
  try {
    const ctx = await getUserContext(req.user.id);

    // Get recent session load data
    const recentLoad = await db.query(`
      SELECT completed_at, duration_minutes, volume_load, perceived_exertion,
             sleep_hours_prior, mood
      FROM workout_sessions WHERE user_id = $1
        AND completed_at > NOW() - INTERVAL '14 days'
      ORDER BY completed_at DESC
    `, [req.user.id]);

    const sessions = recentLoad.rows;
    if (!sessions.length) return res.json({ score: null, message: 'Insufficient data' });

    // Acute:Chronic Workload Ratio (ACWR)
    const lastWeekVolume = sessions
      .filter(s => new Date(s.completed_at) > new Date(Date.now() - 7 * 86400000))
      .reduce((sum, s) => sum + (parseFloat(s.volume_load) || 0), 0);

    const prevWeekVolume = sessions
      .filter(s => {
        const d = new Date(s.completed_at);
        return d < new Date(Date.now() - 7 * 86400000) && d > new Date(Date.now() - 14 * 86400000);
      })
      .reduce((sum, s) => sum + (parseFloat(s.volume_load) || 0), 0);

    const acwr = prevWeekVolume > 0 ? lastWeekVolume / prevWeekVolume : 1;
    const avgRPE = sessions.slice(0, 5).reduce((s, r) => s + (parseFloat(r.perceived_exertion) || 7), 0) / Math.min(sessions.length, 5);
    const avgSleep = sessions.slice(0, 5).reduce((s, r) => s + (parseFloat(r.sleep_hours_prior) || 7), 0) / Math.min(sessions.length, 5);

    // AI injury risk analysis
    const aiPrompt = `Analyze this athlete's recovery status:

ACWR (Acute:Chronic Workload Ratio): ${acwr.toFixed(2)} (safe zone: 0.8-1.3)
Average RPE last 5 sessions: ${avgRPE.toFixed(1)}/10
Average sleep: ${avgSleep.toFixed(1)} hours
Sessions in last 7 days: ${sessions.filter(s => new Date(s.completed_at) > new Date(Date.now() - 7 * 86400000)).length}
Reported injuries: ${ctx.profile.injuries || 'None'}
Training experience: ${ctx.profile.experience_years || '?'} years

Provide a JSON response:
{
  "recovery_score": 75,
  "injury_risk": "low|moderate|high|very_high",
  "status": "Ready to Train|Slight Fatigue|Accumulated Fatigue|Overreaching|Overtrained",
  "acwr_interpretation": "explanation",
  "recommendations": ["rec1", "rec2", "rec3"],
  "today_recommendation": "Train Hard|Train Light|Active Recovery|Full Rest",
  "warning_signs": ["sign1"],
  "deload_needed": false
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a sports scientist. Respond with JSON only.' },
        { role: 'user', content: aiPrompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 600,
    });

    const analysis = JSON.parse(aiResponse.choices[0].message.content);
    res.json({ ...analysis, acwr, avg_rpe: avgRPE, avg_sleep: avgSleep, data_points: sessions.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate recovery score' });
  }
});

// 14. FORM ANALYZER WITH AI GRADING
router.post('/form/analyze', async (req, res) => {
  try {
    const { exercise_name, description, pain_points, experience_level, weight_used } = req.body;

    const prompt = `Analyze this athlete's exercise form and provide expert coaching feedback.

Exercise: ${exercise_name}
Athlete Description of Their Form: ${description}
Pain Points/Discomfort: ${pain_points || 'None reported'}
Experience Level: ${experience_level}
Weight Used: ${weight_used || 'Not specified'}

Provide detailed form analysis as JSON:
{
  "overall_grade": "A|B|C|D|F",
  "score": 85,
  "strengths": ["what they're doing well"],
  "corrections": [
    {
      "issue": "Specific problem",
      "cause": "Root cause of the issue",
      "fix": "Exact correction cue",
      "drill": "Practice drill to fix this",
      "priority": "critical|high|medium|low"
    }
  ],
  "injury_risks": ["risk1", "risk2"],
  "muscle_activation_tips": ["tip1", "tip2"],
  "breathing_cues": "Exact breathing instructions",
  "warm_up_recommendation": "Specific warm-up exercises",
  "regression": "Easier version to build the pattern",
  "progression": "Next level variation when ready",
  "common_mistakes_to_avoid": ["mistake1", "mistake2"],
  "video_cues": ["what to look for when recording yourself"]
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a biomechanics expert and certified strength coach. Respond with JSON only.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
    });

    const analysis = JSON.parse(response.choices[0].message.content);

    // Log the form check
    await db.query(`
      INSERT INTO form_analyses (user_id, exercise_name, description, analysis, created_at)
      VALUES ($1,$2,$3,$4,NOW())
    `, [req.user.id, exercise_name, description, JSON.stringify(analysis)]);

    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: 'Form analysis failed' });
  }
});

// 15. AI EXERCISE SUBSTITUTION
router.post('/exercises/substitute', async (req, res) => {
  try {
    const { exercise_name, reason, available_equipment, limitations } = req.body;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a certified personal trainer. Respond with JSON only.' },
        { role: 'user', content: `Suggest substitutes for: ${exercise_name}
Reason for substitution: ${reason}
Available equipment: ${available_equipment}
Physical limitations: ${limitations || 'none'}

Respond with JSON:
{
  "substitutes": [
    {
      "name": "Exercise name",
      "similarity_score": 90,
      "muscle_match": "How well it matches the original muscles",
      "difficulty_comparison": "easier|same|harder",
      "setup": "How to set up",
      "why_this_works": "Why this is a good sub"
    }
  ],
  "notes": "Additional coaching notes"
}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 800,
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ error: 'Substitution failed' });
  }
});

// 16. DELOAD DETECTOR
router.get('/deload/check', async (req, res) => {
  try {
    const ctx = await getUserContext(req.user.id);
    const recentSessions = await db.query(`
      SELECT perceived_exertion, volume_load, sleep_hours_prior, mood, completed_at
      FROM workout_sessions WHERE user_id = $1
        AND completed_at > NOW() - INTERVAL '21 days'
      ORDER BY completed_at DESC
    `, [req.user.id]);

    const sessions = recentSessions.rows;
    const avgRPE = sessions.reduce((s, r) => s + (parseFloat(r.perceived_exertion) || 7), 0) / (sessions.length || 1);
    const volumeTrend = sessions.length >= 4
      ? sessions.slice(0, 2).reduce((s, r) => s + parseFloat(r.volume_load || 0), 0) /
        sessions.slice(2, 4).reduce((s, r) => s + parseFloat(r.volume_load || 0), 0)
      : 1;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a sports scientist. Respond with JSON only.' },
        { role: 'user', content: `Should this athlete deload?
Sessions in 3 weeks: ${sessions.length}
Average RPE: ${avgRPE.toFixed(1)}
Volume trend ratio (recent vs prior): ${volumeTrend.toFixed(2)}
Training experience: ${ctx.profile.experience_years || '?'} years
Current goal: ${ctx.profile.goal}

Respond: {"should_deload": true|false, "urgency": "immediate|soon|not_yet", "reason": "...", "deload_protocol": {"duration_days": 7, "volume_reduction": "50%", "intensity": "60-70% 1RM", "activities": ["Light lifting", "Walking", "Stretching"]}, "resume_date_recommendation": "After X days"}`}
      ],
      response_format: { type: 'json_object' },
      max_tokens: 400,
    });

    res.json({ ...JSON.parse(response.choices[0].message.content), avg_rpe: avgRPE, sessions_analyzed: sessions.length });
  } catch (err) {
    res.status(500).json({ error: 'Deload check failed' });
  }
});

// 17. WHISPER VOICE NOTES TRANSCRIPTION
router.post('/voice/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const transcription = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], req.file.originalname || 'audio.m4a', { type: req.file.mimetype }),
      model: 'whisper-1',
      language: 'en',
    });

    // Extract structured data from transcription
    const structured = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Extract workout data from transcription. Respond with JSON only.' },
        { role: 'user', content: `Transcription: "${transcription.text}"
        
Extract any workout data:
{
  "exercises": [{"name": "...", "sets": 3, "reps": 10, "weight_kg": 80}],
  "duration_minutes": null,
  "notes": "cleaned up note text",
  "perceived_exertion": null,
  "mood": null
}` }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
    });

    res.json({
      transcript: transcription.text,
      structured: JSON.parse(structured.choices[0].message.content)
    });
  } catch (err) {
    res.status(500).json({ error: 'Transcription failed', details: err.message });
  }
});

// 18. PERIODIZATION PLANNER
router.post('/periodization/plan', async (req, res) => {
  try {
    const { goal, competition_date, current_level, weeks_available, sport } = req.body;
    const ctx = await getUserContext(req.user.id);
    const weeksOut = Math.ceil((new Date(competition_date) - new Date()) / (7 * 86400000));

    const prompt = `Create a complete ${weeks_available}-week periodized training program.

Athlete: ${ctx.profile.name}, ${ctx.profile.experience_years || '?'} years experience
Goal: ${goal}
Sport/Focus: ${sport || 'general fitness'}
Competition/Target Date: ${competition_date || 'no competition'}
Weeks Available: ${weeks_available}
Current Level PRs: ${ctx.prs.slice(0, 5).map(p => `${p.exercise_name}: ${p.estimated_1rm}kg 1RM`).join(', ')}

Design the full periodization plan as JSON:
{
  "plan_name": "Program name",
  "model": "block|conjugate|linear|undulating|triphasic",
  "total_weeks": ${weeks_available},
  "phases": [
    {
      "phase_name": "Hypertrophy / Accumulation",
      "weeks": "1-4",
      "duration_weeks": 4,
      "primary_goal": "Build work capacity and muscle",
      "intensity_pct": "65-75",
      "volume": "high",
      "rep_ranges": "8-15",
      "key_exercises": ["Exercise 1", "Exercise 2"],
      "weekly_sessions": 4,
      "focus": "Increase muscle cross-sectional area",
      "deload_week": 4
    }
  ],
  "peaking_protocol": "How to peak for competition",
  "taper_strategy": "Last 2 weeks before competition",
  "expected_outcomes": {"strength_gain_pct": 15, "notes": "..."},
  "weekly_overview": "High-level view of each week"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a world-class strength and conditioning coach. Respond with JSON only.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 3000,
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ error: 'Periodization planning failed' });
  }
});

// 19. COMPETITION PREP PROTOCOLS
router.post('/competition/prep', async (req, res) => {
  try {
    const { competition_type, date, weight_class, current_total, sport } = req.body;
    const ctx = await getUserContext(req.user.id);
    const weeksOut = Math.ceil((new Date(date) - new Date()) / (7 * 86400000));

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are an elite competition prep coach. Respond with JSON only.' },
        { role: 'user', content: `Create a competition prep protocol.
Sport: ${sport || competition_type}
Weeks out: ${weeksOut}
Competition date: ${date}
Weight class: ${weight_class || 'open'}
Current total/best: ${current_total || 'not specified'}
Athlete PRs: ${ctx.prs.slice(0, 6).map(p => `${p.exercise_name}: ${p.estimated_1rm}kg`).join(', ')}

Generate:
{
  "weeks_out": ${weeksOut},
  "peak_week_protocol": {"monday": "...", "tuesday": "...", ...},
  "weight_cut_strategy": "if needed",
  "attempt_selections": [
    {"lift": "Squat", "opener": 140, "second": 150, "third": 157.5}
  ],
  "warm_up_attempts": ["40%", "60%", "75%", "85%", "opener"],
  "competition_day_timeline": {"wake": "7am", "weigh_in": "8am", ...},
  "nutrition_strategy": "Peak week carb loading protocol",
  "mental_prep": ["Strategy 1", "Strategy 2"],
  "week_by_week": [
    {"week": 8, "theme": "Final strength block", "volume": "high", "intensity": "85-90%"},
    ...
  ]
}` }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2500,
    });

    res.json(JSON.parse(response.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ error: 'Competition prep failed' });
  }
});

// 20. PROGRESSION RECOMMENDATIONS
router.get('/progression/:plan_id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM progression_recommendations
      WHERE user_id = $1 AND plan_id = $2
      ORDER BY updated_at DESC
    `, [req.user.id, req.params.plan_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progressions' });
  }
});

// 21. WELLNESS LOGGING WITH AI RECOMMENDATIONS
router.post('/wellness/log', async (req, res) => {
  try {
    const { sleep_hours, sleep_quality, stress_level, hrv, resting_hr,
            energy_level, soreness_level, notes } = req.body;

    const result = await db.query(`
      INSERT INTO wellness_logs (user_id, sleep_hours, sleep_quality, stress_level,
        hrv, resting_hr, energy_level, soreness_level, notes, logged_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *
    `, [req.user.id, sleep_hours, sleep_quality, stress_level,
        hrv, resting_hr, energy_level, soreness_level, notes]);

    // AI recommendation based on wellness
    const recommendation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a sports medicine specialist. Respond with JSON only.' },
        { role: 'user', content: `Wellness check: Sleep ${sleep_hours}h (quality: ${sleep_quality}/10), Stress: ${stress_level}/10, HRV: ${hrv || 'N/A'}, RHR: ${resting_hr || 'N/A'}, Energy: ${energy_level}/10, Soreness: ${soreness_level}/10.
Respond: {"training_recommendation": "Train Hard|Train Moderate|Active Recovery|Full Rest", "reason": "...", "adjustments": ["Adjustment 1"], "recovery_tips": ["Tip 1", "Tip 2"]}` }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 300,
    });

    res.json({ ...result.rows[0], ai_recommendation: JSON.parse(recommendation.choices[0].message.content) });
  } catch (err) {
    res.status(500).json({ error: 'Wellness log failed' });
  }
});

// 22. GOAL SETTING WITH AI ASSESSMENT
router.post('/goals', async (req, res) => {
  try {
    const { goal_type, target_value, target_date, description, exercise_name } = req.body;

    const result = await db.query(`
      INSERT INTO user_goals (user_id, goal_type, target_value, target_date, description,
        exercise_name, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'active',NOW()) RETURNING *
    `, [req.user.id, goal_type, target_value, target_date, description, exercise_name]);

    // AI goal assessment
    const ctx = await getUserContext(req.user.id);
    const assessment = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a performance coach. Respond with JSON only.' },
        { role: 'user', content: `Assess this goal: 
Goal: ${goal_type} - ${description}
Target: ${target_value} by ${target_date}
Athlete current PRs: ${ctx.prs.slice(0,3).map(p=>`${p.exercise_name}: ${p.estimated_1rm}kg`).join(', ')}
Respond: {"feasibility": "realistic|ambitious|very_ambitious|unrealistic", "probability_pct": 75, "timeline_adequate": true, "advice": "...", "milestones": ["Week 4: ...", "Week 8: ..."]}`}
      ],
      response_format: { type: 'json_object' },
      max_tokens: 400,
    });

    res.json({ ...result.rows[0], ai_assessment: JSON.parse(assessment.choices[0].message.content) });
  } catch (err) {
    res.status(500).json({ error: 'Goal creation failed' });
  }
});

// 23. POST-WORKOUT AI SUMMARY GENERATOR
async function generateWorkoutSummary(userId, session, exercises, newPRs, totalVolume) {
  try {
    const prompt = `Generate a brief (3-4 sentences), energetic post-workout analysis.
Session: ${session.duration_minutes} minutes, RPE ${session.perceived_exertion}/10
Volume: ${totalVolume.toFixed(0)} kg total load
Exercises: ${exercises?.map(e => e.exercise_name).join(', ') || 'various'}
New PRs: ${newPRs.length > 0 ? newPRs.map(p => `${p.exercise} ${p.weight}kg×${p.reps}`).join(', ') : 'none'}
Mood: ${session.mood || 'not recorded'}
Sleep prior: ${session.sleep_hours_prior || '?'} hours

Be motivating, specific, and mention one key coaching observation.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are TITAN, an elite personal trainer. Be brief, intense, and motivating.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 200,
      temperature: 0.8,
    });

    return response.choices[0].message.content;
  } catch { return null; }
}

module.exports = router;
