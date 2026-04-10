require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('./db');

async function migrate() {
  console.log('🔄 Running database migrations...');

  try {
    // Users table
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        avatar_url TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // User profiles / goals
    await query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        age INTEGER,
        sex VARCHAR(10),
        height_cm DECIMAL(5,2),
        weight_kg DECIMAL(5,2),
        activity_level VARCHAR(20) DEFAULT 'moderate',
        goal VARCHAR(30) DEFAULT 'maintain_weight',
        daily_calorie_target INTEGER DEFAULT 2000,
        daily_protein_target INTEGER DEFAULT 150,
        daily_carbs_target INTEGER DEFAULT 250,
        daily_fat_target INTEGER DEFAULT 65,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      );
    `);

    // Meal logs
    await query(`
      CREATE TABLE IF NOT EXISTS meal_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        meal_type VARCHAR(20) DEFAULT 'snack',
        image_url TEXT,
        raw_ai_response TEXT,
        total_calories DECIMAL(8,2) DEFAULT 0,
        total_protein_g DECIMAL(8,2) DEFAULT 0,
        total_carbs_g DECIMAL(8,2) DEFAULT 0,
        total_fat_g DECIMAL(8,2) DEFAULT 0,
        total_fiber_g DECIMAL(8,2) DEFAULT 0,
        notes TEXT,
        logged_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Food items within a meal (detected items)
    await query(`
      CREATE TABLE IF NOT EXISTS meal_food_items (
        id SERIAL PRIMARY KEY,
        meal_log_id INTEGER REFERENCES meal_logs(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        quantity VARCHAR(100),
        calories DECIMAL(8,2) DEFAULT 0,
        protein_g DECIMAL(8,2) DEFAULT 0,
        carbs_g DECIMAL(8,2) DEFAULT 0,
        fat_g DECIMAL(8,2) DEFAULT 0,
        fiber_g DECIMAL(8,2) DEFAULT 0,
        confidence DECIMAL(3,2) DEFAULT 0.8,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Daily summaries (precomputed for analytics)
    await query(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        total_calories DECIMAL(8,2) DEFAULT 0,
        total_protein_g DECIMAL(8,2) DEFAULT 0,
        total_carbs_g DECIMAL(8,2) DEFAULT 0,
        total_fat_g DECIMAL(8,2) DEFAULT 0,
        total_fiber_g DECIMAL(8,2) DEFAULT 0,
        water_intake INTEGER DEFAULT 0,
        meals_count INTEGER DEFAULT 0,
        calorie_target INTEGER DEFAULT 2000,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, date)
      );
    `);

    // Weight tracking
    await query(`
      CREATE TABLE IF NOT EXISTS weight_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        weight_kg DECIMAL(5,2) NOT NULL,
        logged_at DATE DEFAULT CURRENT_DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Water tracking
    await query(`
      CREATE TABLE IF NOT EXISTS water_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL DEFAULT 250,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Coach messages
    await query(`
      CREATE TABLE IF NOT EXISTS coach_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
        context VARCHAR(20) DEFAULT 'general',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Workout plans
    await query(`
      CREATE TABLE IF NOT EXISTS workout_plans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        goal VARCHAR(100) NOT NULL,
        experience_level VARCHAR(50) NOT NULL,
        days_per_week INTEGER NOT NULL,
        session_duration INTEGER NOT NULL,
        equipment VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Workout exercises
    await query(`
      CREATE TABLE IF NOT EXISTS workout_exercises (
        id SERIAL PRIMARY KEY,
        workout_plan_id INTEGER REFERENCES workout_plans(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        muscle_group VARCHAR(100) NOT NULL,
        sets INTEGER NOT NULL,
        reps VARCHAR(20) NOT NULL,
        rest_seconds INTEGER NOT NULL,
        instructions TEXT,
        order_index INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Workout sessions
    await query(`
      CREATE TABLE IF NOT EXISTS workout_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        workout_plan_id INTEGER REFERENCES workout_plans(id) ON DELETE SET NULL,
        exercises_completed INTEGER DEFAULT 0,
        duration_minutes INTEGER,
        notes TEXT,
        completed_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Indexes for performance
    await query(`CREATE INDEX IF NOT EXISTS idx_meal_logs_user_date ON meal_logs(user_id, logged_at);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_daily_summaries_user_date ON daily_summaries(user_id, date);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_meal_food_items_meal ON meal_food_items(meal_log_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_water_logs_user_date ON water_logs(user_id, created_at);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_coach_messages_user_date ON coach_messages(user_id, created_at);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_workout_plans_user_id ON workout_plans(user_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_workout_exercises_plan_id ON workout_exercises(workout_plan_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_id ON workout_sessions(user_id);`);

    console.log('✅ All migrations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
