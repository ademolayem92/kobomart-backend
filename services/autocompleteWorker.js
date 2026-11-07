// Background orchestration layer automating escrow releases for un-disputed shipments after 72 hours
const autoReleaseEscrowWorker = async (pgPool) => {
  const pgClient = await pgPool.connect();
  try {
    await pgClient.query('BEGIN');

    // Select sub-orders shipped over 72 hours ago that are still marked as 'SHIPPED'
    const expiredOrdersRes = await pgClient.query(
      `SELECT id, amount_kobo, commission_kobo, vendor_id FROM sub_orders 
       WHERE status = 'SHIPPED' AND shipped_at <= NOW() - INTERVAL '72 hours' FOR UPDATE`
    );

    for (const subOrder of expiredOrdersRes.rows) {
      const totalEscrowKobo = Number(subOrder.amount_kobo);
      const commission = Number(subOrder.commission_kobo);
      const netVendor = totalEscrowKobo - commission;

      const escrowAcc = (await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'system' AND owner_id = 'PLATFORM_ESCROW'")).rows[0];
      const vendorAcc = (await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'vendor' AND owner_id = $1", [subOrder.vendor_id])).rows[0];
      const revenueAcc = (await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'system' AND owner_id = 'PLATFORM_REVENUE'")).rows[0];

      const txRes = await pgClient.query(
        "INSERT INTO transactions (reference, type, status, idempotency_key) VALUES ($1, 'checkout', 'success', $2) RETURNING id",
        [`TX_AUTO_COMP_${subOrder.id}_${Date.now()}`, `IDEM_AUTO_${subOrder.id}`]
      );
      const transactionId = txRes.rows[0].id;

      // Transfer balances from Escrow out to Vendor and Platform Revenue wallets
      await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, escrowAcc.id, 'debit', totalEscrowKobo]);
      await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, vendorAcc.id, 'credit', netVendor]);
      await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, revenueAcc.id, 'credit', commission]);

      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo - $1 WHERE id = $2', [totalEscrowKobo, escrowAcc.id]);
      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [netVendor, vendorAcc.id]);
      await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [commission, revenueAcc.id]);

      await pgClient.query("UPDATE sub_orders SET status = 'COMPLETED' WHERE id = $1", [subOrder.id]);
      console.log(`[Auto-Complete Service] Handled sub-order instance ID: ${subOrder.id}`);
    }

    await pgClient.query('COMMIT');
  } catch (error) {
    await pgClient.query('ROLLBACK');
    console.error(`[Auto-Complete Service Error]: ${error.message}`);
  } finally {
    pgClient.release();
  }
};

module.exports = { autoReleaseEscrowWorker };
