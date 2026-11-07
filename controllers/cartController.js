const Cart = require('../models/Cart');
const Product = require('../models/Product');

const cartController = {
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

  addItem: async (req, res) => {
    try {
      const { productId, variantId, quantity } = req.body;
      const product = await Product.findById(productId);
      if (!product || !product.isActive) return res.status(404).json({ error: 'Product unavailable' });

      let cart = await Cart.findOne({ buyerId: req.user.userId });
      if (!cart) cart = new Cart({ buyerId: req.user.userId, items: [] });

      const existingIndex = cart.items.findIndex(item => 
        item.productId.toString() === productId && 
        (!variantId || (item.variantId && item.variantId.toString() === variantId))
      );

      if (existingIndex > -1) {
        cart.items[existingIndex].quantity += quantity;
      } else {
        cart.items.push({ productId, variantId, quantity });
      }

      await cart.save();
      return res.status(200).json(cart);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
};

module.exports = cartController;
