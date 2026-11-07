const payoutController = {
  requestPayout: async (req, res) => {
    const pgClient = await req.pgPool.connect();
    try {
      const { amountKobo } = req.body;
      const vendorId = req.user.userId;

      if (!amountKobo || amountKobo < 100000) {
        return res.status(400).json({ error: 'Minimum payout limit is ₦1,000 (100,000 kobo)' });
      }

      await pgClient.query('BEGIN');

      const vendorAccountRes = await pgClient.query(
        'SELECT id, balance_kobo FROM accounts WHERE owner_type = $1 AND owner_id = $2 FOR UPDATE',
        ['vendor', vendorId]
      );
      if (vendorAccountRes.rows.length === 0) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Vendor account profile unavailable' });
      }

      const vendorAccount = vendorAccountRes.rows[0];
      if (Number(vendorAccount.balance_kobo) < amountKobo) {
        await pgClient.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient funds available for payout processing' });
      }

      const clearingAccountRes = await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'system' AND owner_id = 'PLATFORM_PAYOUT_CLEARING'");
      const clearingAccount = clearingAccountRes.rows[0];

      const reference = `PAYOUT_${Date.now()}`;
      const txRes = await pgClient.query(
        "INSERT INTO transactions (reference, type, status, idempotency_key) VALUES ($1, 'payout', 'pending', $2) RETURNING id",
        [reference, `IDEM_${reference}`]
      );
      const transactionId = txRes.rows[0].id;

      // Transfer funds safely into the platform's clearing account
      await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, vendorAccount.id, 'debit', amountKobo]);
      await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, clearingAccount.id, 'credit', amountKobo]);

      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo - $1 WHERE id = $2', [amountKobo, vendorAccount.id]);
      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [amountKobo, clearingAccount.id]);

      await pgClient.query(
        "INSERT INTO payouts (vendor_id, account_id, amount_kobo, status, reference) VALUES ($1, $2, $3, 'pending', $4)",
        [vendorId, vendorAccount.id, amountKobo, reference]
      );

      await pgClient.query('COMMIT');
      return res.status(200).json({ message: 'Payout requested successfully. Funds moved to clearing account.', reference });
    } catch (error) {
      await pgClient.query('ROLLBACK');
      return res.status(500).json({ error: error.message });
    } finally {
      pgClient.release();
    }
  }
};

module.exports = payoutController;
