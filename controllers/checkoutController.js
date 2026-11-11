const Product = require('../models/Product');
const Cart = require('../models/Cart');
const crypto = require('crypto'); 

const checkoutController = {
  processCheckout: async (req, res) => {
    const pgClient = await req.pgPool.connect();
    try {
      const { idempotencyKey } = req.body;
      const buyerId = req.user.userId;

      if (!idempotencyKey) return res.status(400).json({ error: 'Missing standard Idempotency-Key header reference' });

      // Fetch the buyer's current shopping cart state
      const cart = await Cart.findOne({ buyerId }).populate('items.productId');
      if (!cart || cart.items.length === 0) return res.status(400).json({ error: 'Empty cart infrastructure' });

      let calculatedTotalKobo = 0;
      const vendorSplits = {}; // Process multi-vendor item allocations

      // Validate prices and stock availability against MongoDB records
      for (const item of cart.items) {
        const product = item.productId;
        if (!product || !product.isActive) return res.status(400).json({ error: 'Stale catalog configuration encountered' });

        let currentPriceKobo = product.price_kobo;
        let availableStock = product.stockQuantity;

        if (item.variantId) {
          const variant = product.variants.id(item.variantId);
          if (!variant) return res.status(400).json({ error: 'Variant not found' });
          currentPriceKobo = variant.price_kobo;
          availableStock = variant.stock;
        }

        if (availableStock < item.quantity) {
          return res.status(400).json({ error: `Insufficient stock for product: ${product.name}` });
        }

        const lineCost = currentPriceKobo * item.quantity;
        calculatedTotalKobo += lineCost;

        if (!vendorSplits[product.vendorId]) {
          vendorSplits[product.vendorId] = 0;
        }
        vendorSplits[product.vendorId] += lineCost;
      }

      // Initialize PostgreSQL explicit ACID transaction execution phase
      await pgClient.query('BEGIN');

      // Enforce systemic verification mapping unique tracking keys to avoid double processing
      const uniqueTxCheck = await pgClient.query('SELECT id FROM transactions WHERE idempotency_key = $1', [idempotencyKey]);
      if (uniqueTxCheck.rows.length > 0) {
        await pgClient.query('ROLLBACK');
        return res.status(409).json({ error: 'Duplicate execution context detected' });
      }

      // Lock user balance rows using a pessimistic concurrency block
      const walletRes = await pgClient.query(
        'SELECT id, balance_kobo FROM accounts WHERE owner_type = $1 AND owner_id = $2 FOR UPDATE',
        ['user', buyerId]
      );
      if (walletRes.rows.length === 0) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Wallet not initialized' });
      }

      const buyerAccount = walletRes.rows[0];
      if (Number(buyerAccount.balance_kobo) < calculatedTotalKobo) {
        await pgClient.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient balance inside transaction wallet context' });
      }

      // Fetch escrow system tracking entity account nodes
      const escrowAccountRes = await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'system' AND owner_id = 'PLATFORM_ESCROW'");
      const escrowAccount = escrowAccountRes.rows[0];

      // Formulate sustainable transactional tracking events inside the ledger matrix
      const reference = `TX_${crypto.randomUUID().slice(0, 12)}`;

      const txRes = await pgClient.query(
        "INSERT INTO transactions (reference, type, status, idempotency_key) VALUES ($1, $2, 'success', $3) RETURNING id",
        [reference, 'checkout', idempotencyKey]
      );

      const transactionId = txRes.rows[0].id;

      // Double entry balance reduction
      await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)',
        [transactionId, buyerAccount.id, 'debit', calculatedTotalKobo]);
      await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)',
        [transactionId, escrowAccount.id, 'credit', calculatedTotalKobo]);

      // Deduct cached running balances synchronously
      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo - $1 WHERE id = $2', [calculatedTotalKobo, buyerAccount.id]);
      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [calculatedTotalKobo, escrowAccount.id]);

      // Map global parent entities alongside localized split-vendor architectures
      const parentOrderRes = await pgClient.query(
        "INSERT INTO orders (buyer_id, total_amount_kobo, status, idempotency_key) VALUES ($1, $2, 'PAID', $3) RETURNING id",
        [buyerId, calculatedTotalKobo, idempotencyKey]
      );
      const parentOrderId = parentOrderRes.rows[0].id;

      for (const [vendorId, amount] of Object.entries(vendorSplits)) {
        const calculatedCommission = Math.floor(amount * 0.05); // Fixed platform rate evaluation
        await pgClient.query(
          "INSERT INTO sub_orders (parent_order_id, vendor_id, amount_kobo, commission_kobo, status) VALUES ($1, $2, $3, $4, 'PAID')",
          [parentOrderId, vendorId, amount, calculatedCommission]
        );
      }

      // Update catalogs in MongoDB (Compensating Pattern Phase)
      try {
        for (const item of cart.items) {
          if (item.variantId) {
            await Product.updateOne(
              { _id: item.productId._id, 'variants._id': item.variantId },
              { $inc: { 'variants.$.stock': -item.quantity, stockQuantity: -item.quantity } }
            );
          } else {
            await Product.updateOne(
              { _id: item.productId._id },
              { $inc: { stockQuantity: -item.quantity } }
            );
          }
        }
        // Flush active cart items on success
        cart.items = [];
        await cart.save();
      } catch (mongoError) {
        // Execute financial fallback mapping reverse ledger allocations if MongoDB fails
        throw new Error(`Catalog decrement error triggered structural rollback sequence: ${mongoError.message}`);
      }

      await pgClient.query('COMMIT');
      return res.status(201).json({ message: 'Order created and escrow funded successfully.', parentOrderId });
    } catch (error) {
      await pgClient.query('ROLLBACK');
      return res.status(500).json({ error: error.message });
    } finally {
      pgClient.release();
    }
  }
};

module.exports = checkoutController;
