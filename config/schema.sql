-- KoboMarket Core Ledger Schema (PostgreSQL)
-- All financial data represented exclusively in Kobo (Integers)

CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    owner_type VARCHAR(50) NOT NULL, -- 'USER', 'SYSTEM'
    owner_id VARCHAR(100) NOT NULL,   -- MongoDB User ID or Constant String
    currency VARCHAR(10) DEFAULT 'NGN',
    balance_kobo BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(50) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_balance CHECK (balance_kobo >= 0)
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    reference VARCHAR(100) UNIQUE NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'WALLET_FUNDING', 'ORDER_ESCROW', 'ESCROW_RELEASE', 'DISPUTE_REFUND', 'PAYOUT'
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    idempotency_key VARCHAR(100) UNIQUE NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id SERIAL PRIMARY KEY,
    transaction_id INT REFERENCES transactions(id) ON DELETE CASCADE,
    account_id INT REFERENCES accounts(id),
    direction VARCHAR(10) NOT NULL, -- 'DEBIT', 'CREDIT'
    amount_kobo BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_amount CHECK (amount_kobo > 0),
    CONSTRAINT chk_direction CHECK (direction IN ('DEBIT', 'CREDIT'))
);

CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    parent_order_id VARCHAR(100) UNIQUE NOT NULL, -- Linked to transaction tracking
    buyer_id VARCHAR(100) NOT NULL,
    total_amount_kobo BIGINT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING_PAYMENT',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sub_orders (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id),
    vendor_id VARCHAR(100) NOT NULL,
    amount_kobo BIGINT NOT NULL,
    commission_kobo BIGINT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING_PAYMENT',
    shipped_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payouts (
    id SERIAL PRIMARY KEY,
    vendor_id VARCHAR(100) NOT NULL,
    account_id INT REFERENCES accounts(id),
    amount_kobo BIGINT NOT NULL,
    reference VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS disputes (
    id SERIAL PRIMARY KEY,
    sub_order_id INT REFERENCES sub_orders(id),
    buyer_id VARCHAR(100) NOT NULL,
    reason TEXT NOT NULL,
    evidence_url TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    resolved_by VARCHAR(100),
    resolution_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed System Accounts
-- Done conditionally or inside setup scripts.