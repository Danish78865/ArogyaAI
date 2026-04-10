require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const mealRoutes = require('./routes/meals');
const analyticsRoutes = require('./routes/analytics');
const userRoutes = require('./routes/users');
const waterRoutes = require('./routes/water');
const coachRoutes = require('./routes/coach');
const gymRoutes = require('./routes/gym');
const dnaRoutes = require('./routes/dna');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3001;

// Create uploads directory
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware
app.use(compression());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(uploadsDir));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/meals', mealRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/users', userRoutes);
app.use('/api/water', waterRoutes);
app.use('/api/coach', coachRoutes);
app.use('/api/gym', gymRoutes);
app.use('/api/dna', dnaRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 CalAI Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(`📱 Network: http://192.168.1.3:${PORT}`);
});

module.exports = app;
