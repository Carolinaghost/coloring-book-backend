// Order storage.
//
// If DATABASE_URL is set, orders are written to Postgres and survive restarts,
// redeploys, and crashes. If it is NOT set, we fall back to an in-memory array
// so the server still boots for local testing — but that data is throwaway.
//
// The rest of the app only talks to the functions exported at the bottom, so
// swapping the storage engine later means touching this file only.

const { Pool } = require('pg');

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
    idleTimeoutMillis: 30000
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
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS orders_submitted_at_idx ON orders (submitted_at DESC);
`;

async function initDb() {
  if (!usingPostgres) {
    console.warn(
      'WARNING: DATABASE_URL is not set. Orders are being kept in memory and ' +
      'will be lost on restart. Set DATABASE_URL before taking real orders.'
    );
    return;
  }
  await pool.query(CREATE_TABLE_SQL);
  await pool.query(CREATE_INDEX_SQL);
  console.log('Connected to Postgres. Orders table is ready.');
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
    submittedAt: new Date(row.submitted_at).toISOString()
  };
}

async function saveOrder(order) {
  if (!usingPostgres) {
    const saved = {
      id: nextMemoryId++,
      status: 'new',
      submittedAt: new Date().toISOString(),
      ...order
    };
    memoryOrders.push(saved);
    return saved;
  }

  const { rows } = await pool.query(
    `INSERT INTO orders (child_name, child_count, email, theme, notes, thumb, page_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      order.childName,
      order.childCount,
      order.email,
      order.theme,
      order.notes,
      order.thumb,
      order.pageCount
    ]
  );
  return rowToOrder(rows[0]);
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
  initDb,
  saveOrder,
  listOrders,
  getOrder,
  updateOrderStatus,
  countOrders
};
