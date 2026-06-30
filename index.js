// --- Imports ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

// --- Config ---
const app = express();
const PORT = process.env.PORT || 8000;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_DB_URI;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

if (!MONGODB_URI) {
  console.error('Error: MONGODB_URI/MONGO_DB_URI environment variable is missing.');
  process.exit(1);
}

// --- Middleware ---
app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));
app.use(express.json());

// --- Database Connection ---
let client;
let db;

async function connectDB() {
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    // Uses database name from URI if present, otherwise default is used by driver
    db = client.db();
    console.log(`Successfully connected to MongoDB: ${db.databaseName}`);
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

// Helper to access the db instance from routes
function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB first.');
  }
  return db;
}

// --- Health Check ---
app.get('/api/health', async (req, res) => {
  try {
    const currentDb = getDb();
    // Ping database to confirm live connection
    await currentDb.command({ ping: 1 });
    res.status(200).json({
      data: {
        status: 'ok',
        db: 'connected',
        database: currentDb.databaseName
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Database connection failed: ' + error.message
    });
  }
});

// --- Server Startup ---
async function startServer() {
  await connectDB();
  
  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down server gracefully...');
    server.close(async () => {
      if (client) {
        await client.close();
        console.log('MongoDB connection closed.');
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer();

module.exports = { app, getDb };
