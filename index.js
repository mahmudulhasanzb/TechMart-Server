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

// --- Orders Routes ---

// POST /api/orders — Create a new order
app.post('/api/orders', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
    }

    const { items, shippingAddress, paymentMethod } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty or invalid.' });
    }

    if (
      !shippingAddress || 
      !shippingAddress.fullName || 
      !shippingAddress.street || 
      !shippingAddress.city || 
      !shippingAddress.state || 
      !shippingAddress.zipCode || 
      !shippingAddress.country || 
      !shippingAddress.phoneNumber
    ) {
      return res.status(400).json({ error: 'Missing shipping address details.' });
    }

    if (!paymentMethod || !['cod', 'credit_card'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid or missing payment method.' });
    }

    const currentDb = getDb();
    
    // 1. Fetch current details of products and check stock
    const productIds = items.map(item => {
      try {
        return new ObjectId(item.productId);
      } catch (e) {
        throw new Error(`Invalid product ID format: ${item.productId}`);
      }
    });

    const products = await currentDb.collection('products').find({
      _id: { $in: productIds }
    }).toArray();

    const productMap = products.reduce((acc, p) => {
      acc[p._id.toString()] = p;
      return acc;
    }, {});

    // Validate all items exist and have sufficient stock
    for (const item of items) {
      const dbProduct = productMap[item.productId];
      if (!dbProduct) {
        return res.status(404).json({ error: `Product not found: ${item.name}` });
      }
      if (dbProduct.stock < item.quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${dbProduct.name}. Only ${dbProduct.stock} units available.`
        });
      }
    }

    // 2. Perform atomic decrements with rollback mechanism
    const updatedProducts = [];
    let updateFailed = false;
    let failedItemName = '';

    for (const item of items) {
      const dbProduct = productMap[item.productId];
      const result = await currentDb.collection('products').updateOne(
        { _id: dbProduct._id, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity }, $set: { updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        updateFailed = true;
        failedItemName = dbProduct.name;
        break;
      } else {
        updatedProducts.push({
          productId: dbProduct._id,
          quantity: item.quantity
        });
      }
    }

    // Rollback if any product stock update failed
    if (updateFailed) {
      for (const updated of updatedProducts) {
        await currentDb.collection('products').updateOne(
          { _id: updated.productId },
          { $inc: { stock: updated.quantity }, $set: { updatedAt: new Date() } }
        );
      }
      return res.status(400).json({
        error: `Order processing failed. Stock for "${failedItemName}" was taken by another order. Please try again.`
      });
    }

    // 3. Build order items with database prices (security measure)
    const orderItems = items.map(item => {
      const dbProduct = productMap[item.productId];
      return {
        productId: dbProduct._id,
        name: dbProduct.name,
        price: dbProduct.price,
        quantity: item.quantity,
        category: dbProduct.category,
        image: dbProduct.images?.[0] || ''
      };
    });

    const totalAmount = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // Create the order document
    const newOrder = {
      customerId: user._id.toString(),
      customerName: user.name,
      customerEmail: user.email,
      items: orderItems,
      totalAmount,
      status: 'pending',
      shippingAddress: {
        fullName: shippingAddress.fullName,
        street: shippingAddress.street,
        city: shippingAddress.city,
        state: shippingAddress.state,
        zipCode: shippingAddress.zipCode,
        country: shippingAddress.country,
        phoneNumber: shippingAddress.phoneNumber
      },
      payment: {
        method: paymentMethod,
        status: paymentMethod === 'credit_card' ? 'paid' : 'pending'
      },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const orderResult = await currentDb.collection('orders').insertOne(newOrder);
    res.status(201).json({
      data: {
        id: orderResult.insertedId.toString(),
        ...newOrder
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/:id — Retrieve order details by ID
app.get('/api/orders/:id', async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
    }

    const currentDb = getDb();
    let orderId;
    try {
      orderId = new ObjectId(req.params.id);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid order ID format' });
    }

    const order = await currentDb.collection('orders').findOne({ _id: orderId });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Security: Only allow the customer who placed the order or staff/manager/admin to view it
    const isCustomer = user.role === 'customer' || !user.role;
    if (isCustomer && order.customerId !== user._id.toString()) {
      return res.status(403).json({ error: 'Forbidden. You do not have permission to view this order.' });
    }

    res.status(200).json({ data: order });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders — Retrieve all orders (Staff/Manager/Admin)
app.get('/api/orders', requireRole(['staff', 'manager', 'admin']), async (req, res) => {
  try {
    const currentDb = getDb();
    const orders = await currentDb.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
    res.status(200).json({ data: orders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/orders/:id — Update order status (Staff/Manager/Admin)
app.patch('/api/orders/:id', requireRole(['staff', 'manager', 'admin']), async (req, res) => {
  try {
    const currentDb = getDb();
    let orderId;
    try {
      orderId = new ObjectId(req.params.id);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid order ID format' });
    }

    const { status } = req.body;
    const allowedStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!status || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid or missing status' });
    }

    const order = await currentDb.collection('orders').findOne({ _id: orderId });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Prevent modifying already cancelled orders
    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot update status of a cancelled order.' });
    }

    // Task 7.3: Stock restoral logic on order cancellation
    if (status === 'cancelled' && order.status !== 'cancelled') {
      for (const item of order.items) {
        await currentDb.collection('products').updateOne(
          { _id: new ObjectId(item.productId) },
          { $inc: { stock: parseInt(item.quantity, 10) }, $set: { updatedAt: new Date() } }
        );
      }
    }

    const result = await currentDb.collection('orders').findOneAndUpdate(
      { _id: orderId },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    res.status(200).json({ data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/reports/summary — Analytics reports summary (Manager/Admin)
app.get('/api/reports/summary', requireRole(['manager', 'admin']), async (req, res) => {
  try {
    const currentDb = getDb();

    // 1. Total Revenue (sum of totalAmount for non-cancelled orders)
    const revenueResult = await currentDb.collection('orders').aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } }
    ]).toArray();
    const totalRevenue = revenueResult[0]?.total || 0;

    // 2. Total Orders
    const totalOrders = await currentDb.collection('orders').countDocuments({});

    // 3. Active Shipments (shipped or processing)
    const activeShipments = await currentDb.collection('orders').countDocuments({
      status: { $in: ['processing', 'shipped'] }
    });

    // 4. Low Stock Items count
    const lowStockCount = await currentDb.collection('products').countDocuments({
      stock: { $lt: 5 }
    });

    // 5. Daily Sales Trend (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const dailyRevenueResult = await currentDb.collection('orders').aggregate([
      { $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$totalAmount" },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]).toArray();

    // 6. Category Performance
    const categoryRevenueResult = await currentDb.collection('orders').aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.category",
          revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
          quantity: { $sum: "$items.quantity" }
        }
      },
      { $sort: { revenue: -1 } }
    ]).toArray();

    res.status(200).json({
      data: {
        totalRevenue,
        totalOrders,
        activeShipments,
        lowStockCount,
        dailyRevenue: dailyRevenueResult,
        categoryRevenue: categoryRevenueResult
      }
    });
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
