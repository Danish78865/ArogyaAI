const jwt = require('jsonwebtoken');
const { query } = require('../models/db');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await query('SELECT id, email, name FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = { authenticate };
