const crypto = require('crypto'); 



const disputeController = {
  openDispute: async (req, res) => {
    const pgClient = await req.pgPool.connect();
    try {
      const { subOrderId } = req.params;
      const { reason, evidenceUrls } = req.body;
      const buyerId = req.user.userId;

      await pgClient.query('BEGIN');

      const subOrderRes = await pgClient.query(
        'SELECT id, status FROM sub_orders WHERE id = $1 AND parent_order_id IN (SELECT id FROM orders WHERE buyer_id = $2)',
        [subOrderId, buyerId]
      );

      if (subOrderRes.rows.length === 0) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Sub-order record mismatch' });
      }

      const subOrder = subOrderRes.rows[0];
      if (subOrder.status !== 'SHIPPED' && subOrder.status !== 'DELIVERED') {
        await pgClient.query('ROLLBACK');
        return res.status(400).json({ error: 'Disputes can only be opened on shipped or delivered items' });
      }

      await pgClient.query("UPDATE sub_orders SET status = 'DISPUTED' WHERE id = $1", [subOrderId]);
      await pgClient.query(
        'INSERT INTO disputes (sub_order_id, buyer_id, reason, evidence_urls, status) VALUES ($1, $2, $3, $4, $5)',
        [subOrderId, buyerId, reason, evidenceUrls || [], 'open']
      );

      await pgClient.query('COMMIT');
      return res.status(201).json({ message: 'Dispute registered successfully. Escrow funds frozen.' });
    } catch (error) {
      await pgClient.query('ROLLBACK');
      return res.status(500).json({ error: error.message });
    } finally {
      pgClient.release();
    }
  },

  resolveDispute: async (req, res) => {
    const pgClient = await req.pgPool.connect();
    try {
      const { id } = req.params;
      const { resolutionStrategy, adminNotes, partialVendorAmountKobo } = req.body; 
      const adminId = req.user.userId;

      await pgClient.query('BEGIN');

      const disputeRes = await pgClient.query('SELECT * FROM disputes WHERE id = $1 AND status = \'open\' FOR UPDATE', [id]);
      if (disputeRes.rows.length === 0) {
        await pgClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Active dispute context missing' });
      }
      const dispute = disputeRes.rows[0];

      const subOrderRes = await pgClient.query('SELECT * FROM sub_orders WHERE id = $1', [dispute.sub_order_id]);
      const subOrder = subOrderRes.rows[0];

      const parentOrderRes = await pgClient.query('SELECT buyer_id FROM orders WHERE id = $1', [subOrder.parent_order_id]);
      const buyerId = parentOrderRes.rows[0].buyer_id;

      const escrowAcc = (await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'system' AND owner_id = 'PLATFORM_ESCROW'")).rows[0];
      const buyerAcc = (await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'user' AND owner_id = $1", [buyerId])).rows[0];
      const vendorAcc = (await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'vendor' AND owner_id = $1", [subOrder.vendor_id])).rows[0];
      const revenueAcc = (await pgClient.query("SELECT id FROM accounts WHERE owner_type = 'system' AND owner_id = 'PLATFORM_REVENUE'")).rows[0];


      const reference = `DISP_${id}_${crypto.randomUUID().slice(0, 12)}`;
      
      const txRes = await pgClient.query(
        "INSERT INTO transactions (reference, type, status, idempotency_key) VALUES ($1, 'dispute_resolution', 'success', $2) RETURNING id",
        [reference, `IDEM_DISP_${id}`]
      );
      const transactionId = txRes.rows[0].id;

      const totalEscrowKobo = Number(subOrder.amount_kobo);

      if (resolutionStrategy === 'FULL_REFUND') {
        // Refund full escrow balance directly back to the buyer
        await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, escrowAcc.id, 'debit', totalEscrowKobo]);
        await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, buyerAcc.id, 'credit', totalEscrowKobo]);
        
        await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo - $1 WHERE id = $2', [totalEscrowKobo, escrowAcc.id]);
        await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [totalEscrowKobo, buyerAcc.id]);
        
        await pgClient.query("UPDATE disputes SET status = 'resolved_full_refund', admin_id = $1, admin_notes = $2, resolved_at = NOW() WHERE id = $3", [adminId, adminNotes, id]);
      } 
      else if (resolutionStrategy === 'REJECT') {
        // Release original contract terms to the vendor minus platform commissions
        const commission = Number(subOrder.commission_kobo);
        const netVendor = totalEscrowKobo - commission;

        await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, escrowAcc.id, 'debit', totalEscrowKobo]);
        await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, vendorAcc.id, 'credit', netVendor]);
        await pgClient.query('INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_kobo) VALUES ($1, $2, $3, $4)', [transactionId, revenueAcc.id, 'credit', commission]);

        await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo - $1 WHERE id = $2', [totalEscrowKobo, escrowAcc.id]);
        await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [netVendor, vendorAcc.id]);
        await pgClient.query('UPDATE accounts SET balance_kobo = balance_kobo + $1 WHERE id = $2', [commission, revenueAcc.id]);

        await pgClient.query("UPDATE disputes SET status = 'resolved_rejected', admin_id = $1, admin_notes = $2, resolved_at = NOW() WHERE id = $3", [adminId, adminNotes, id]);
      }

      await pgClient.query("UPDATE sub_orders SET status = 'COMPLETED' WHERE id = $1", [subOrder.id]);
      await pgClient.query('COMMIT');
      return res.status(200).json({ message: 'Dispute resolved successfully.' });
    } catch (error) {
      await pgClient.query('ROLLBACK');
      return res.status(500).json({ error: error.message });
    } finally {
      pgClient.release();
    }
  }
};

module.exports = disputeController;
