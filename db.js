// Order storage.
//
// If DATABASE_URL is set, orders are written to Postgres and survive restarts,
// redeploys, and crashes. If it is NOT set, we fall back to an in-memory array
// so the server still boots for local testing — but that data is throwaway.
//
// The rest of the app only talks to the functions exported at the bottom, so
// swapping the storage engine later means touching this file only.

const { Pool } = require('pg');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const usingPostgres = Boolean(DATABASE_URL);

let pool = null;
let memoryOrders = [];
let nextMemoryId = 1;

if (usingPostgres) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Hosted Postgres (Render, Neon, Supabase) requires SSL. Their certs are
    // signed by roots Node doesn't always carry, hence rejectUnauthorized.
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    // Neon's free compute sleeps when idle; give the first connection room to
    // wake it, but never hang forever.
    connectionTimeoutMillis: 15000
  });

  pool.on('error', (err) => {
    console.error('Unexpected Postgres pool error:', err.message);
  });
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS orders (
    id            SERIAL PRIMARY KEY,
    child_name    TEXT        NOT NULL,
    child_count   INTEGER     NOT NULL DEFAULT 1,
    email         TEXT        NOT NULL,
    theme         TEXT        NOT NULL DEFAULT 'Portrait',
    notes         TEXT        NOT NULL DEFAULT '',
    thumb         TEXT,
    page_count    INTEGER     NOT NULL DEFAULT 0,
    status        TEXT        NOT NULL DEFAULT 'new',
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- payment
    paid              BOOLEAN     NOT NULL DEFAULT FALSE,
    paid_at           TIMESTAMPTZ,
    amount_cents      INTEGER,
    product           TEXT        NOT NULL DEFAULT 'digital',
    stripe_session_id TEXT,
    -- random secret handed to the browser so it can claim this order later
    access_token      TEXT        NOT NULL
  );
`;

// Generated artwork, one row per scene. Kept so a customer can re-download
// their book without us paying OpenAI to redraw it.
const CREATE_PAGES_SQL = `
  CREATE TABLE IF NOT EXISTS order_pages (
    order_id    INTEGER     NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    scene_index INTEGER     NOT NULL,
    image       TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (order_id, scene_index)
  );
`;

// Columns added after the first release. Existing deployments already have an
// orders table, so CREATE TABLE IF NOT EXISTS alone would silently skip these.
const MIGRATIONS = [
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_cents INTEGER",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'digital'",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session_id TEXT",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS access_token TEXT NOT NULL DEFAULT ''"
];

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS orders_submitted_at_idx ON orders (submitted_at DESC);
`;

let ready = false;
let lastError = null;

// Runs in the background AFTER the server is already listening, so a sleeping
// database can never stop the service from starting. Retries a few times to
// ride out a cold Neon compute or a brief network blip.
async function initDb(attempt = 1) {
  if (!usingPostgres) {
    console.warn(
      'WARNING: DATABASE_URL is not set. Orders are being kept in memory and ' +
      'will be lost on restart. Set DATABASE_URL before taking real orders.'
    );
    return;
  }
  try {
    await pool.query(CREATE_TABLE_SQL);
    await pool.query(CREATE_INDEX_SQL);
    for (const sql of MIGRATIONS) await pool.query(sql);
    await pool.query(CREATE_PAGES_SQL);
    ready = true;
    lastError = null;
    console.log('Connected to Postgres. Orders table is ready.');
  } catch (err) {
    lastError = err.message;
    console.error('Postgres init attempt ' + attempt + ' failed: ' + err.message);
    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, attempt * 3000));
      return initDb(attempt + 1);
    }
    console.error('Giving up on Postgres init for now. /health will show the error.');
  }
}

function status() {
  return {
    storage: usingPostgres ? 'postgres' : 'memory',
    ready: usingPostgres ? ready : true,
    error: lastError
  };
}

// Convert a database row into the shape the front end already expects.
function rowToOrder(row) {
  return {
    id: row.id,
    childName: row.child_name,
    childCount: row.child_count,
    email: row.email,
    theme: row.theme,
    notes: row.notes,
    thumb: row.thumb,
    pageCount: row.page_count,
    status: row.status,
    paid: row.paid === true,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    amountCents: row.amount_cents,
    product: row.product,
    submittedAt: new Date(row.submitted_at).toISOString()
  };
}

async function saveOrder(order) {
  // Secret the browser keeps so it can later prove this order is its own.
  const accessToken = crypto.randomBytes(24).toString('hex');

  if (!usingPostgres) {
    const saved = {
      id: nextMemoryId++,
      status: 'new',
      paid: false,
      accessToken,
      submittedAt: new Date().toISOString(),
      ...order
    };
    memoryOrders.push(saved);
    return saved;
  }

  const { rows } = await pool.query(
    `INSERT INTO orders (child_name, child_count, email, theme, notes, thumb, page_count, access_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      order.childName,
      order.childCount,
      order.email,
      order.theme,
      order.notes,
      order.thumb,
      order.pageCount,
      accessToken
    ]
  );
  const saved = rowToOrder(rows[0]);
  // Returned once, on creation only — never included in any listing.
  saved.accessToken = accessToken;
  return saved;
}

// Constant-time check that the caller owns this order. Returns the order, or
// null if the id is unknown or the token doesn't match.
async function authorizeOrder(id, token) {
  if (!token) return null;

  let row;
  if (!usingPostgres) {
    row = memoryOrders.find((o) => o.id === Number(id));
    if (!row) return null;
    return safeEqual(row.accessToken, token) ? row : null;
  }

  const res = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(id)]);
  row = res.rows[0];
  if (!row) return null;
  return safeEqual(row.access_token, token) ? rowToOrder(row) : null;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function markPaid(sessionId, amountCents) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.stripeSessionId === sessionId);
    if (!o) return null;
    o.paid = true;
    o.status = 'in_progress';
    return o;
  }
  const { rows } = await pool.query(
    `UPDATE orders
        SET paid = TRUE, paid_at = NOW(), amount_cents = COALESCE($2, amount_cents),
            status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END
      WHERE stripe_session_id = $1
      RETURNING *`,
    [sessionId, amountCents || null]
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

async function attachCheckoutSession(id, sessionId, amountCents) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(id));
    if (o) { o.stripeSessionId = sessionId; o.amountCents = amountCents; }
    return o || null;
  }
  const { rows } = await pool.query(
    'UPDATE orders SET stripe_session_id = $2, amount_cents = $3 WHERE id = $1 RETURNING *',
    [Number(id), sessionId, amountCents]
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

async function savePage(orderId, sceneIndex, image) {
  if (!usingPostgres) return;
  await pool.query(
    `INSERT INTO order_pages (order_id, scene_index, image)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id, scene_index) DO UPDATE SET image = EXCLUDED.image`,
    [Number(orderId), Number(sceneIndex), image]
  );
}

async function listPages(orderId) {
  if (!usingPostgres) return [];
  const { rows } = await pool.query(
    'SELECT scene_index, image FROM order_pages WHERE order_id = $1 ORDER BY scene_index',
    [Number(orderId)]
  );
  return rows.map((r) => ({ sceneIndex: r.scene_index, image: r.image }));
}

// Newest first. thumb images are large data URLs, so the list view skips them
// unless includeThumbs is true.
async function listOrders({ limit = 200, includeThumbs = false } = {}) {
  if (!usingPostgres) {
    const list = memoryOrders.slice().reverse().slice(0, limit);
    return includeThumbs ? list : list.map(({ thumb, ...rest }) => rest);
  }

  const columns = includeThumbs
    ? '*'
    : 'id, child_name, child_count, email, theme, notes, NULL AS thumb, page_count, status, submitted_at';

  const { rows } = await pool.query(
    `SELECT ${columns} FROM orders ORDER BY submitted_at DESC, id DESC LIMIT $1`,
    [limit]
  );

  return rows.map(rowToOrder).map((order) => {
    if (!includeThumbs) delete order.thumb;
    return order;
  });
}

async function getOrder(id) {
  if (!usingPostgres) {
    return memoryOrders.find((o) => o.id === Number(id)) || null;
  }
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(id)]);
  return rows[0] ? rowToOrder(rows[0]) : null;
}

async function updateOrderStatus(id, status) {
  if (!usingPostgres) {
    const order = memoryOrders.find((o) => o.id === Number(id));
    if (!order) return null;
    order.status = status;
    return order;
  }
  const { rows } = await pool.query(
    'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
    [status, Number(id)]
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

async function countOrders() {
  if (!usingPostgres) return memoryOrders.length;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM orders');
  return rows[0].count;
}

module.exports = {
  usingPostgres,
  status,
  initDb,
  saveOrder,
  authorizeOrder,
  attachCheckoutSession,
  markPaid,
  savePage,
  listPages,
  listOrders,
  getOrder,
  updateOrderStatus,
  countOrders
};
