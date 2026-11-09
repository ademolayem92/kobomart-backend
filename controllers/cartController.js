const Cart = require('../models/Cart'); // Mongoose Model
// const Product = require('../models/Product'); // Mongoose Model (fallback/reference)
const { pool } = require('../config/db'); // PostgreSQL connection pool (pg client)

const cartController = {
  // Retrieve the buyer's cart and populate data
  getCart: async (req, res) => {
    try {
      let cart = await Cart.findOne({ buyerId: req.user.userId }).populate('items.productId');
      if (!cart) {
        cart = new Cart({ buyerId: req.user.userId, items: [] });
        await cart.save();
      }
      return res.status(200).json(cart);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  // Add an item to the cart (Queries PostgreSQL to verify current price, status, and multi-vendor compatibility)
  addItem: async (req, res) => {
    try {
      const { productId, variantId, quantity } = req.body;
      if (!quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Quantity must be greater than zero' });
      }

      // 1. Fetch real-time data from PostgreSQL (pg) to ensure product validation
      const pgProductQuery = 'SELECT id, is_active, list_price FROM products WHERE id = $1';
      const pgProductResult = await pool.query(pgProductQuery, [productId]);
      
      if (pgProductResult.rows.length === 0) {
        return res.status(404).json({ error: 'Product not found in system record' });
      }

      const activeProduct = pgProductResult.rows[0];
      if (!activeProduct.is_active) {
        return res.status(400).json({ error: 'Product is currently unavailable' });
      }

      // 2. Manipulate/Update the Document Store in MongoDB via Mongoose
      let cart = await Cart.findOne({ buyerId: req.user.userId });
      if (!cart) cart = new Cart({ buyerId: req.user.userId, items: [] });

      const existingIndex = cart.items.findIndex(item => 
        item.productId.toString() === productId && 
        (!variantId || (item.variantId && item.variantId.toString() === variantId))
      );

      if (existingIndex > -1) {
        cart.items[existingIndex].quantity += quantity;
      } else {
        // Multi-vendor products are added fluidly; attributes persist on Postgres queries
        cart.items.push({ productId, variantId, quantity });
      }

      await cart.save();
      const updatedCart = await cart.populate('items.productId');
      return res.status(200).json(updatedCart);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  // Update line item quantity within Mongoose document
  updateItemQuantity: async (req, res) => {
    try {
      const { productId, variantId, quantity } = req.body;
      
      let cart = await Cart.findOne({ buyerId: req.user.userId });
      if (!cart) return res.status(404).json({ error: 'Cart not found' });

      const existingIndex = cart.items.findIndex(item => 
        item.productId.toString() === productId && 
        (!variantId || (item.variantId && item.variantId.toString() === variantId))
      );

      if (existingIndex === -1) {
        return res.status(404).json({ error: 'Item not found in cart' });
      }

      if (quantity <= 0) {
        cart.items.splice(existingIndex, 1);
      } else {
        cart.items[existingIndex].quantity = quantity;
      }

      await cart.save();
      const updatedCart = await cart.populate('items.productId');
      return res.status(200).json(updatedCart);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  // Completely erase items from MongoDB array
  removeItem: async (req, res) => {
    try {
      const { productId, variantId } = req.body;

      let cart = await Cart.findOne({ buyerId: req.user.userId });
      if (!cart) return res.status(404).json({ error: 'Cart not found' });

      cart.items = cart.items.filter(item => !(
        item.productId.toString() === productId && 
        (!variantId || (item.variantId && item.variantId.toString() === variantId))
      ));

      await cart.save();
      const updatedCart = await cart.populate('items.productId');
      return res.status(200).json(updatedCart);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
};

module.exports = cartController;
