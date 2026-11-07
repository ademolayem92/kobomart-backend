const Product = require('../models/Product');

const productController = {
  createProduct: async (req, res) => {
    try {
      const { name, description, price_kobo, category, stockQuantity, variants, tags } = req.body;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
      
      const product = new Product({
        name,
        slug,
        description,
        price_kobo: Math.floor(price_kobo),
        category,
        vendorId: req.user.userId,
        stockQuantity,
        variants,
        tags
      });

      await product.save();
      return res.status(201).json(product);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  searchProducts: async (req, res) => {
    try {
      const { search, category, minPrice, maxPrice, sortBy, nextCursor } = req.query;
      let query = { isActive: true };

      if (search) query.$text = { $search: search };
      if (category) query.category = category;
      if (minPrice || maxPrice) {
        query.price_kobo = {};
        if (minPrice) query.price_kobo.$gte = Number(minPrice);
        if (maxPrice) query.price_kobo.$lte = Number(maxPrice);
      }
      
      // Implement robust cursor-based pagination
      if (nextCursor) {
        query._id = { $gt: nextCursor };
      }

      let sortOptions = { _id: 1 };
      if (sortBy === 'price_asc') sortOptions = { price_kobo: 1, _id: 1 };
      if (sortBy === 'price_desc') sortOptions = { price_kobo: -1, _id: 1 };

      const products = await Product.find(query).sort(sortOptions).limit(20);
      const lastItem = products[products.length - 1];
      const cursor = lastItem ? lastItem._id : null;

      return res.status(200).json({ products, nextCursor: cursor });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  addReview: async (req, res) => {
    try {
      const { id } = req.params;
      const { rating, comment } = req.body;
      const buyerId = req.user.userId;

      const pgClient = req.pgPool;
      const orderCheck = await pgClient.query(
        `SELECT o.id FROM orders o 
         JOIN sub_orders s ON o.id = s.parent_order_id
         WHERE o.buyer_id = $1 AND s.status = 'COMPLETED'`,
         [buyerId]
      );

      if (orderCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Review rejected. Only buyers with completed orders can submit reviews.' });
      }

      const product = await Product.findById(id);
      if (!product) return res.status(404).json({ error: 'Product not found' });

      const absoluteDuplicate = product.reviews.some(r => r.buyerId === buyerId);
      if (absoluteDuplicate) return res.status(400).json({ error: 'Duplicate entity. One review allowed per product.' });

      product.reviews.push({ buyerId, rating, comment });
      product.reviewCount = product.reviews.length;
      product.avgRating = product.reviews.reduce((acc, r) => acc + r.rating, 0) / product.reviewCount;

      await product.save();
      return res.status(201).json({ message: 'Review committed successfully', avgRating: product.avgRating });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
};

module.exports = productController;
