const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Client
const client = new MongoClient(process.env.MONGO_DB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  await client.connect();

  const db = client.db('techmart');
  const productCollection = db.collection('products');

  // Root Route
  app.get('/', (req, res) => {
    res.send('TechMart Server Running');
  });

  // Get All Products
  app.get('/products', async (req, res) => {
    const products = await productCollection.find({}).toArray();
    res.send(products);
  });

  // Get Product By ID
  app.get('/products/:id', async (req, res) => {
    const id = req.params.id;

    const product = await productCollection.findOne({
      _id: new ObjectId(id),
    });

    res.send(product);
  });

  // Create Product
  app.post('/products', async (req, res) => {
    const product = req.body;

    const result = await productCollection.insertOne(product);

    res.send(result);
  });

  // Update Product By ID
  app.put('/products/:id', async (req, res) => {
    const id = req.params.id;
    const updatedProduct = req.body;

    const result = await productCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: updatedProduct,
      },
    );

    res.send(result);
  });

  // Delete Product By ID
  app.delete('/products/:id', async (req, res) => {
    const id = req.params.id;

    const result = await productCollection.deleteOne({
      _id: new ObjectId(id),
    });

    res.send(result);
  });

  console.log('✅ Connected to MongoDB');
}

run().catch(console.error);

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
