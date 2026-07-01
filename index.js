// --- Imports ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

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

// --- Auth Helper Middleware ---
function getSessionToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, cookie) => {
      const [key, val] = cookie.trim().split('=');
      acc[key] = val;
      return acc;
    }, {});
    return cookies['better-auth.session_token'] || cookies['better-auth.session-token'];
  }
  return null;
}

async function getAuthUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const currentDb = getDb();
  
  // Find active session
  const session = await currentDb.collection('session').findOne({ token });
  if (!session || new Date() > new Date(session.expiresAt)) {
    return null;
  }
  
  // Find associated user
  let user = await currentDb.collection('user').findOne({ _id: session.userId });
  if (!user) {
    // Try casting to ObjectId if stored as ObjectId
    try {
      user = await currentDb.collection('user').findOne({ _id: new ObjectId(session.userId) });
    } catch (e) {
      return null;
    }
  }
  return user;
}

function requireRole(roles) {
  return async (req, res, next) => {
    try {
      const user = await getAuthUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
      }
      if (!roles.includes(user.role)) {
        return res.status(403).json({ error: 'Forbidden. Insufficient permissions.' });
      }
      req.user = user;
      next();
    } catch (error) {
      res.status(500).json({ error: 'Auth check failed: ' + error.message });
    }
  };
}

// --- Health Check ---
app.get('/api/health', async (req, res) => {
  try {
    const currentDb = getDb();
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

// --- Products Routes ---

// GET /api/products — Search and filter catalog
app.get('/api/products', async (req, res) => {
  try {
    const currentDb = getDb();
    const { search, category } = req.query;
    let query = {};
    
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }
    if (category && category !== 'All') {
      query.category = category;
    }
    
    const products = await currentDb.collection('products').find(query).toArray();
    res.status(200).json({ data: products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/:id — Retrieve single product details
app.get('/api/products/:id', async (req, res) => {
  try {
    const currentDb = getDb();
    let productId;
    try {
      productId = new ObjectId(req.params.id);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid product ID format' });
    }
    
    const product = await currentDb.collection('products').findOne({ _id: productId });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(200).json({ data: product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products — Create product (Staff/Manager/Admin)
app.post('/api/products', requireRole(['staff', 'manager', 'admin']), async (req, res) => {
  try {
    const currentDb = getDb();
    const { name, description, price, stock, category, specs, images } = req.body;
    
    if (!name || price === undefined || stock === undefined || !category) {
      return res.status(400).json({ error: 'Missing required fields: name, price, stock, category' });
    }
    
    const newProduct = {
      name,
      description: description || '',
      price: parseFloat(price),
      stock: parseInt(stock),
      category,
      specs: specs || {},
      images: images || [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    const result = await currentDb.collection('products').insertOne(newProduct);
    res.status(201).json({ data: { id: result.insertedId, ...newProduct } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/products/:id — Update product details (Staff/Manager/Admin)
app.patch('/api/products/:id', requireRole(['staff', 'manager', 'admin']), async (req, res) => {
  try {
    const currentDb = getDb();
    let productId;
    try {
      productId = new ObjectId(req.params.id);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid product ID format' });
    }
    
    const updates = req.body;
    const allowedUpdates = ['name', 'description', 'price', 'stock', 'category', 'specs', 'images'];
    const updateFields = {};
    
    for (const key of allowedUpdates) {
      if (updates[key] !== undefined) {
        if (key === 'price') updateFields[key] = parseFloat(updates[key]);
        else if (key === 'stock') updateFields[key] = parseInt(updates[key]);
        else updateFields[key] = updates[key];
      }
    }
    updateFields.updatedAt = new Date();
    
    const result = await currentDb.collection('products').findOneAndUpdate(
      { _id: productId },
      { $set: updateFields },
      { returnDocument: 'after' }
    );
    
    if (!result) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.status(200).json({ data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/products/:id — Delete product (Staff/Manager/Admin)
app.delete('/api/products/:id', requireRole(['staff', 'manager', 'admin']), async (req, res) => {
  try {
    const currentDb = getDb();
    let productId;
    try {
      productId = new ObjectId(req.params.id);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid product ID format' });
    }
    
    const result = await currentDb.collection('products').deleteOne({ _id: productId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(200).json({ data: { message: 'Product deleted successfully' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
