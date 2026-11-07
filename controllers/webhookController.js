const crypto = require('crypto');

const webhookController = {
  handlePaystackWebhook: async (req, res) => {
    const pgClient = await req.pgPool.connect();
    try {
      const paystackSignature = req.headers['x-paystack-signature'];
      if (!paystackSignature) return res.status(401).json({ error: 'Unsigned entity signature detected' });

      // Calculate the cryptographic signature for verification
      const computedHash = crypto
        .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || 'test_secret')
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (computedHash !== paystackSignature) {
        return res.status(401).json({ error: 'Signature mismatch verification failed' });
      }

      const event = req.body;
      if (event.event !== 'charge.success') {
        return res.status(200).json({ message: 'Event ignored' });
      }

      const { reference, metadata, amount } = event.data; 
      const userId = metadata ? metadata.userId : null;

      await pgClient.query('BEGIN');

      // Idempotency guard: Ensure the transaction reference has not been processed yet
      const duplicateCheck = await pgClient.query('SELECT id FROM transactions WHERE reference = $1', [reference]);
      if (duplicateCheck.rows.length > 0) {
        await pgClient.query('ROLLBACK');
        return res.status(200).json({ message: 'Transaction already processed' });
      }

      const walletRes = await pgClient.query(
        'SELECT id FROM accounts WHERE owner_type = $1 AND owner_id = $2 FOR UPDATE',
        ['user', userId]
      );
      if (walletRes.rows.length === 0) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Owner account reference missing inside ledger' });
      }

      const targetAccount = walletRes.rows[0];
      const amountKobo = Math.floor(amount * 100); // Standardizing input to currency subunits (kobo)

      const txInsert = await pgClient.query(
        "INSERT INTO transactions (reference, type, status, idempotency_key) VALUES ($1, 'funding', 'success', $2) RETURNING id",
        [reference, `IDEM_PAY_${reference}`]
      );
      const transactionId = txInsert.rows[0].id;

      // Double-entry record formulation
      await pgClient.query(
        'INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)',
        [transactionId, targetAccount.id, 'credit', amountKobo]
      );

      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [amountKobo, targetAccount.id]);

      await pgClient.query('COMMIT');
      return res.status(200).json({ status: 'success' });
    } catch (error) {
      await pgClient.query('ROLLBACK');
      return res.status(500).json({ error: error.message });
    } finally {
      pgClient.release();
    }
  }
};

module.exports = webhookController;
