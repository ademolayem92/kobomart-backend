# KoboMarket Backend

## Dual-Database Strategy & Architectural Synergy

KoboMarket separates data concerns across two modern storage layers to optimize scalability, resilience, and strict transactional auditability:

1. **MongoDB (Read-Heavy / Unstructured Data)**: Handles users, authentication details, profiles, vendor stores, the product catalog, reviews, notifications, and temporary shopping carts. These domains undergo rapid schema mutations, benefit from nested structures (like product variations, tags, and reviews), and operate in a read-heavy capacity without tracking financial state.
2. **PostgreSQL (ACID-Compliant / Ledger Data)**: Handles user wallets, the core multi-party double-entry ledger system, orders, payouts, sub-order splits, and disputes. Financial data requires strict consistency, multi-row ACID guarantees, relational integrity via foreign keys, and row-level locking (`SELECT ... FOR UPDATE`) to prevent double-spending or race conditions.

### Architectural Synchronization & Concurrency Challenges

* **Distributed State Synchronization**: Creating an object in MongoDB (such as registering a user or checking out a cart) requires a synchronized mutation in PostgreSQL (such as provisioning an accounting ledger wallet or locking escrow balances). If a network boundary partition occurs halfway through, the platform faces an inconsistent split-brain state.
* **The Solution**: We enforce strict cross-database atomicity using a **Compensating Transaction Pattern**. For example, during checkout, the state is validated against MongoDB, and money is shifted inside a tight PostgreSQL transaction. If MongoDB downstream stock decrement fails post-ledger allocation, an automated rollback routine intercepts the catch block, executing a reversing double-entry ledger adjustment to seamlessly credit the buyer's balance back while marking the order status as cancelled.
* **Kobo-Only Rule**: To eliminate IEEE 754 floating-point rounding hazards inherent to JavaScript number precision, all monetary values are stored strictly as integers in **kobo** (₦1 = 100 kobo).

---

## Technical Stack & Execution Architecture
* **Runtime Environment**: Node.js (Express Framework)
* **Databases**: MongoDB (Mongoose ODM) & PostgreSQL (`pg` Client Pool)
* **Single-Export Pattern**: In compliance with technical constraints, individual files refrain from scattering inline `exports.*` or `export class` directives. Instead, each module scopes operations locally and exposes them using a **single aggregated `module.exports` object**.

# KoboMarket Backend — Dual-Database Escrow Ledger System

KoboMarket is an online multi-vendor marketplace engine built on Node.js and Express. It utilizes a synchronized **dual-database architecture** (MongoDB + PostgreSQL) to guarantee financial isolation, high read performance, and strict double-entry ledger security with zero-float precision (all values in kobo).

---

## 🏗️ The Dual-Database Split & Rationales

| Data Layer | Database Target | Core Architectural Purpose |
| :--- | :--- | :--- |
| **Catalog & Profiles** | **MongoDB** | Stores read-heavy, highly flexible data models without monetary precision dependencies (Users, Profiles, Products, Carts, Reviews, Notifications). |
| **Financial Ledger** | **PostgreSQL** | Stores mission-critical transaction entries requiring strict ACID compliance, relational safety, checking constraints, and row-level locking (Accounts, Double-Entry Ledgers, Orders, Escrow, Payouts, Disputes). |

### Financial Safety Rules
1. **Source of Truth Rule:** No wallet balance or transaction value is ever kept or modified inside MongoDB. Financial mutations occur strictly within PostgreSQL.
2. **Zero Floating-Point Rule:** All monetary sums are processed and captured as 64-bit BigInt integers representing subunits (**kobo** where ₦1 = 100 kobo). JavaScript float operations are explicitly forbidden to prevent IEEE 754 precision rounding issues.
3. **Append-Only Ledger Rule:** Rows inside `ledger_entries` are immutable. Modifications are restricted to reversing entries to maintain complete cryptographic audit transparency.

---

## 📁 Repository Structure

```text
kobomarket-backend/
├── .env                  # Local Environment configuration (Git-ignored)
├── .env.example          # Baseline deployment structure template
├── package.json          # Node dependencies and execution vectors
├── server.js             # Core cluster engine & DB bootstrapping initialization
├── config/
│   └── schema.sql        # Relational PostgreSQL structural layout
├── middleware/
│   └── auth.js           # RBAC Authorization / Signature processing
├── models/               # MongoDB Document Schemas (Mongoose)
│   ├── Cart.js
│   └── Product.js
├── controllers/          # Business Logic Engine Layer (Strict single-export)
│   ├── authController.js
│   ├── cartController.js
│   ├── checkoutController.js
│   ├── disputeController.js
│   ├── payoutController.js
│   ├── productController.js
│   └── webhookController.js
├── routes/
│   └── api.js            # Standard centralized gateway routes
└── services/
    └── autocompleteWorker.js # Background cron worker (Escrow aging tracker)
```

---

## 🔒 Coding Standard: Single-Export Architecture
To maximize predictability and prevent fragmented module structures, all controller files group exported methods into a singular explicit container object bound at the file root. 

**Example Structural Form:**
```javascript
const exampleController = {
  actionOne: async (req, res) => { /* logic */ },
  actionTwo: async (req, res) => { /* logic */ }
};

module.exports = exampleController; // Single explicit export entrypoint
```

---

## 🛡️ Escrow Implementation Map

The escrow lifecycle safely segregates buyer capital during order processing via the following specific technical vectors:

### 1. Initial Funding (Checkout Pipeline)
* **File Location:** `controllers/checkoutController.js` (`processCheckout`)
* **Logic Flow:** 
  1. Opens an explicit PostgreSQL transaction pipeline (`BEGIN`).
  2. Executes a row-level pessimistic write lock on the buyer account (`SELECT ... FOR UPDATE`).
  3. Formulates complementary balancing ledger rows debiting the buyer account and crediting the system's `PLATFORM_ESCROW` row tracking balance.
  4. Reduces stock balances in MongoDB. (If this operation fails, a total transaction rollback is invoked via the **Compensating Transaction Pattern**).

### 2. Resolution Realignment (Disputes Management)
* **File Location:** `controllers/disputeController.js` (`resolveDispute`)
* **Logic Flow:**
  * **FULL_REFUND:** Debits the `PLATFORM_ESCROW` wallet and credits the matching buyer's ledger directly inside PostgreSQL.
  * **REJECT:** Debits the `PLATFORM_ESCROW` balance, extracts the 5% system fee into `PLATFORM_REVENUE`, and deposits the remaining net balance to the vendor's wallet balance.

### 3. Aging Auto-Release (Background Daemon Process)
* **File Location:** `services/autocompleteWorker.js` (`autoReleaseEscrowWorker`)
* **Logic Flow:**
  * Runs sequentially on a preset execution polling matrix (`setInterval` within `server.js`).
  * Isolates sub-orders holding a `SHIPPED` status flag whose timestamp duration matches or exceeds 72 hours (`shipped_at <= NOW() - INTERVAL '72 hours' FOR UPDATE`).
  * Programmatically triggers a balance release operation out of `PLATFORM_ESCROW` into the associated vendor balance, bypassing further manual customer delivery updates if un-disputed.

---

## 🚀 Getting Started

### 1. Establish Configuration Parameters
Duplicate the configuration map from the deployment root:
```bash
cp .env.example .env
```
Open `.env` and provide your target PostgreSQL credentials, MongoDB target URLs, and Paystack cryptographic keys.

### 2. Prepare the Database Architecture
Ensure your local PostgreSQL cluster contains an active database matching your `.env` settings, then run the schema structure file to compile the double-entry table frameworks:
```bash
psql -U postgres -d kobomarket -f config/schema.sql
```

### 3. Deploy Local Services
Install dependencies and run the server node application:
```bash
npm install
npm start
```
