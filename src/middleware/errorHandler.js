const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
  }

  if (err.code === '23505') {
    return res.status(409).json({ error: 'Resource already exists' });
  }

  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced resource not found' });
  }

  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = { errorHandler };
