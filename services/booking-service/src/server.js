const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const bookingRoutes = require('./routes/bookings');

const app = express();

const PORT = process.env.PORT || 4003;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/eventsphere-bookings';
const defaultAllowedOrigins = [
  'http://localhost:3000',
  'https://wonderful-water-07646600f.3.azurestaticapps.net',
  'https://wonderful-water-07646600f-preview.eastus2.3.azurestaticapps.net'
];
const envAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/api/bookings', bookingRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Booking service is running', timestamp: new Date() });
});

// MongoDB connection
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`🚀 Booking service running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

module.exports = app;
