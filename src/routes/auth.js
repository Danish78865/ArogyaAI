const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../models/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    console.log('Registration request:', { email, password: '***', name });
    
    if (!email || !password) {
      console.log('Validation failed: Missing email or password');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      console.log('Validation failed: Password too short');
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.log('Validation failed: Invalid email format');
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check existing user
    console.log('Checking for existing user with email:', email.toLowerCase());
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    console.log('Existing user result:', existing.rows);
    
    if (existing.rows.length > 0) {
      console.log('User already exists with ID:', existing.rows[0].id);
      return res.status(409).json({ error: 'Email already registered' });
    }

    console.log('Starting password hashing...');
    const passwordHash = await bcrypt.hash(password, 12);
    console.log('Password hashed successfully');

    console.log('Starting user insertion...');
    const result = await query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email.toLowerCase(), passwordHash, name || null]
    );
    console.log('Insert result:', result.rows);

    const user = result.rows[0];
    console.log('New user created:', { id: user.id, email: user.email, name: user.name });

    // Create default profile
    console.log('Creating user profile...');
    await query(
      'INSERT INTO user_profiles (user_id) VALUES ($1)',
      [user.id]
    );
    console.log('User profile created');

    console.log('Creating JWT token...');
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '30d'
    });
    console.log('JWT token created');

    const response = {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    };
    console.log('Registration successful, sending response:', response);

    res.status(201).json(response);
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await query(
      'SELECT id, email, name, password_hash, avatar_url FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '30d'
    });

    // Get user profile
    const profileResult = await query(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [user.id]
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatar_url,
        profile: profileResult.rows[0] || null
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const profileResult = await query(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );

    const userResult = await query(
      'SELECT id, email, name, avatar_url, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    res.json({
      user: {
        ...userResult.rows[0],
        profile: profileResult.rows[0] || null
      }
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/auth/profile - Update profile & goals
router.put('/profile', authenticate, async (req, res, next) => {
  try {
    const {
      name, age, sex, height_cm, weight_kg, activity_level, goal,
      daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target
    } = req.body;

    // Update user name
    if (name !== undefined) {
      await query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [name, req.user.id]);
    }

    // Upsert profile
    await query(`
      INSERT INTO user_profiles (user_id, age, sex, height_cm, weight_kg, activity_level, goal,
        daily_calorie_target, daily_protein_target, daily_carbs_target, daily_fat_target, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        age = EXCLUDED.age,
        sex = EXCLUDED.sex,
        height_cm = EXCLUDED.height_cm,
        weight_kg = EXCLUDED.weight_kg,
        activity_level = EXCLUDED.activity_level,
        goal = EXCLUDED.goal,
        daily_calorie_target = EXCLUDED.daily_calorie_target,
        daily_protein_target = EXCLUDED.daily_protein_target,
        daily_carbs_target = EXCLUDED.daily_carbs_target,
        daily_fat_target = EXCLUDED.daily_fat_target,
        updated_at = NOW()
    `, [
      req.user.id, age, sex, height_cm, weight_kg, activity_level, goal,
      daily_calorie_target || 2000, daily_protein_target || 150,
      daily_carbs_target || 250, daily_fat_target || 65
    ]);

    const updated = await query(
      'SELECT up.*, u.name, u.email FROM user_profiles up JOIN users u ON u.id = up.user_id WHERE up.user_id = $1',
      [req.user.id]
    );

    res.json({ profile: updated.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
