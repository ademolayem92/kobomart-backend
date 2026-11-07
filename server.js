const express = require('express');
const mongoose = require('mongoose');
const { Pool } = require('pg');
const apiRoutes = require('./routes/api');
const { autoReleaseEscrowWorker } = require('./services/autocompleteWorker');

const app = express();
app.use(express.json());

// Initialize PostgreSQL Connection Pool
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/kobomart'
});

// Inject PostgreSQL pool into the express request ecosystem safely
app.use((req, res, next) => {
  req.pgPool = pgPool;
  next();
});

// Bind Central API Domain Router Linkages
app.use('/api/v1', apiRoutes);

// Establish database connection loops simultaneously
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/kobomart');
    console.log('MongoDB connection initialized successfully.');

    // Run the background escrow release job every 15 minutes
    setInterval(() => autoReleaseEscrowWorker(pgPool), 15 * 60 * 1000);

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`KoboMart Engine running on port: ${PORT}`));
  } catch (err) {
    console.error(`Initialization failure event triggered: ${err.message}`);
  }
};

startServer();
