-- Advanced Gym Features Migration
-- This migration adds comprehensive gym functionality for the advanced workout API

-- Update existing workout_plans table to add advanced fields
ALTER TABLE workout_plans 
ADD COLUMN IF NOT EXISTS description TEXT,
ADD COLUMN IF NOT EXISTS split_type VARCHAR(50),
ADD COLUMN IF NOT EXISTS periodization VARCHAR(50),
ADD COLUMN IF NOT EXISTS phase VARCHAR(50),
ADD COLUMN IF NOT EXISTS duration_weeks INTEGER DEFAULT 8,
ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT FALSE;

-- Update existing workout_exercises table with advanced fields
ALTER TABLE workout_exercises 
ADD COLUMN IF NOT EXISTS secondary_muscles JSONB,
ADD COLUMN IF NOT EXISTS movement_pattern VARCHAR(50),
ADD COLUMN IF NOT EXISTS day VARCHAR(20),
ADD COLUMN IF NOT EXISTS tempo VARCHAR(20),
ADD COLUMN IF NOT EXISTS rpe_target INTEGER,
ADD COLUMN IF NOT EXISTS percentage_1rm DECIMAL(5,2),
ADD COLUMN IF NOT EXISTS technique VARCHAR(50),
ADD COLUMN IF NOT EXISTS coaching_cues JSONB,
ADD COLUMN IF NOT EXISTS common_mistakes JSONB,
ADD COLUMN IF NOT EXISTS progression_rule TEXT,
ADD COLUMN IF NOT EXISTS regression TEXT,
ADD COLUMN IF NOT EXISTS progression_variation TEXT,
ADD COLUMN IF NOT EXISTS superset_with INTEGER REFERENCES workout_exercises(id);

-- Update existing workout_sessions table with advanced fields
ALTER TABLE workout_sessions 
ADD COLUMN IF NOT EXISTS exercises_completed JSONB,
DROP COLUMN IF EXISTS exercises_completed_old,
ADD COLUMN IF NOT EXISTS perceived_exertion INTEGER CHECK (perceived_exertion >= 1 AND perceived_exertion <= 10),
ADD COLUMN IF NOT EXISTS mood VARCHAR(20),
ADD COLUMN IF NOT EXISTS sleep_hours_prior DECIMAL(3,1),
ADD COLUMN IF NOT EXISTS body_weight_today DECIMAL(5,2),
ADD COLUMN IF NOT EXISTS volume_load DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS location VARCHAR(50),
ADD COLUMN IF NOT EXISTS environment_temp DECIMAL(5,2);

-- New tables for advanced gym features

-- Workout plan metadata table
CREATE TABLE IF NOT EXISTS workout_plan_metadata (
    id SERIAL PRIMARY KEY,
    plan_id INTEGER REFERENCES workout_plans(id) ON DELETE CASCADE,
    weekly_schedule JSONB,
    nutrition_timing JSONB,
    recovery_recommendations JSONB,
    progression_model JSONB,
    deload_indicators JSONB,
    injury_precautions JSONB,
    estimated_results JSONB,
    scientific_rationale TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(plan_id)
);

-- Personal records table
CREATE TABLE IF NOT EXISTS personal_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    exercise_name VARCHAR(255) NOT NULL,
    weight_kg DECIMAL(7,2) NOT NULL,
    reps INTEGER NOT NULL,
    estimated_1rm DECIMAL(7,2) NOT NULL,
    session_id INTEGER REFERENCES workout_sessions(id) ON DELETE SET NULL,
    achieved_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Coach conversations table
CREATE TABLE IF NOT EXISTS coach_conversations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    messages JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Progression recommendations table
CREATE TABLE IF NOT EXISTS progression_recommendations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES workout_plans(id) ON DELETE CASCADE,
    exercise_name VARCHAR(255) NOT NULL,
    current_weight DECIMAL(7,2),
    recommended_weight DECIMAL(7,2),
    reason TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, plan_id, exercise_name)
);

-- Biometric logs table
CREATE TABLE IF NOT EXISTS biometric_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    weight_kg DECIMAL(5,2),
    body_fat_pct DECIMAL(4,1),
    muscle_mass_kg DECIMAL(5,2),
    waist_cm DECIMAL(4,1),
    chest_cm DECIMAL(4,1),
    hip_cm DECIMAL(4,1),
    bicep_cm DECIMAL(4,1),
    thigh_cm DECIMAL(4,1),
    calf_cm DECIMAL(4,1),
    notes TEXT,
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- Form analyses table
CREATE TABLE IF NOT EXISTS form_analyses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    exercise_name VARCHAR(255) NOT NULL,
    description TEXT,
    analysis JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Exercise library table
CREATE TABLE IF NOT EXISTS exercise_library (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    muscle_group VARCHAR(100) NOT NULL,
    equipment VARCHAR(100),
    difficulty VARCHAR(20) CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
    instructions TEXT,
    tips JSONB,
    common_mistakes JSONB,
    variations JSONB,
    muscle_activation JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User goals table
CREATE TABLE IF NOT EXISTS user_goals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    goal_type VARCHAR(50) NOT NULL,
    target_value DECIMAL(10,2),
    target_date DATE,
    description TEXT,
    exercise_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
    ai_assessment JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Wellness logs table
CREATE TABLE IF NOT EXISTS wellness_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    sleep_hours DECIMAL(3,1),
    sleep_quality INTEGER CHECK (sleep_quality >= 1 AND sleep_quality <= 10),
    stress_level INTEGER CHECK (stress_level >= 1 AND stress_level <= 10),
    hrv INTEGER,
    resting_hr INTEGER,
    energy_level INTEGER CHECK (energy_level >= 1 AND energy_level <= 10),
    soreness_level INTEGER CHECK (soreness_level >= 1 AND soreness_level <= 10),
    notes TEXT,
    logged_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_personal_records_user_exercise ON personal_records(user_id, exercise_name);
CREATE INDEX IF NOT EXISTS idx_personal_records_achieved_at ON personal_records(achieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_biometric_logs_user_recorded ON biometric_logs(user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_wellness_logs_user_logged ON wellness_logs(user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_completed ON workout_sessions(user_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_coach_conversations_user_session ON coach_conversations(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_user_goals_user_status ON user_goals(user_id, status);

-- Update user_profiles to add gym-specific fields
ALTER TABLE user_profiles 
ADD COLUMN IF NOT EXISTS experience_years INTEGER,
ADD COLUMN IF NOT EXISTS sport VARCHAR(100),
ADD COLUMN IF NOT EXISTS injuries TEXT,
ADD COLUMN IF NOT EXISTS target_weight_kg DECIMAL(5,2);

-- Insert sample exercise library data
INSERT INTO exercise_library (name, muscle_group, equipment, difficulty, instructions) VALUES
('Squat', 'Legs', 'Barbell', 'intermediate', 'Stand with feet shoulder-width apart, bar across upper back. Lower hips back and down, keeping chest up and knees behind toes. Descend until thighs are parallel to floor, then drive through heels to return to start.'),
('Deadlift', 'Back', 'Barbell', 'advanced', 'Stand with feet hip-width, bar over mid-foot. Hinge at hips, bend knees, grasp bar. Keep back straight, drive through heels to lift bar to standing position. Lower with control.'),
('Bench Press', 'Chest', 'Barbell', 'intermediate', 'Lie on bench, feet flat on floor. Grip bar slightly wider than shoulders. Lower bar to chest, keeping elbows at 45-degree angle. Press up explosively to full extension.'),
('Pull-up', 'Back', 'Pull-up bar', 'intermediate', 'Hang from bar with overhand grip, slightly wider than shoulders. Pull body up until chin clears bar. Lower with control to full hang.'),
('Overhead Press', 'Shoulders', 'Barbell', 'intermediate', 'Stand with feet shoulder-width, bar at collarbone. Press bar overhead until arms are fully extended. Keep core tight and avoid excessive back arch.'),
('Barbell Row', 'Back', 'Barbell', 'intermediate', 'Bend at hips with flat back, knees slightly bent. Pull bar to lower chest, keeping elbows close to body. Lower with control.')
ON CONFLICT (name) DO NOTHING;

-- Create a function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_workout_plan_metadata_updated_at BEFORE UPDATE ON workout_plan_metadata FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_coach_conversations_updated_at BEFORE UPDATE ON coach_conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_progression_recommendations_updated_at BEFORE UPDATE ON progression_recommendations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
