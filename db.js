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
let memoryEvents = [];
let nextMemoryId = 1;
let nextMemoryEventId = 1;

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
    access_token      TEXT        NOT NULL,
    -- the customer's photo, kept so the SERVER can draw the book after payment
    -- without needing their browser to stay open
    photo             TEXT,
    subject_type      TEXT        NOT NULL DEFAULT 'kid',
    generation_status TEXT        NOT NULL DEFAULT 'idle'
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

// Anonymous funnel counters. No IP address, no user agent, no name or email —
// just which step of the flow happened, a random per-page-load id so the same
// visitor is not counted twice, and where they came from. Nothing here can be
// traced back to a person, which is why it needs no cookie banner.
const CREATE_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    id         BIGSERIAL   PRIMARY KEY,
    type       TEXT        NOT NULL,
    visitor    TEXT        NOT NULL DEFAULT '',
    source     TEXT        NOT NULL DEFAULT '',
    campaign   TEXT        NOT NULL DEFAULT '',
    order_id   INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const CREATE_EVENTS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at DESC);
`;

// Columns added after the first release. Existing deployments already have an
// orders table, so CREATE TABLE IF NOT EXISTS alone would silently skip these.
const MIGRATIONS = [
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_cents INTEGER",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'digital'",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session_id TEXT",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS access_token TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo TEXT",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS generation_status TEXT NOT NULL DEFAULT 'idle'",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'kid'",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS render_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS visitor TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS campaign TEXT NOT NULL DEFAULT ''"
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
    await pool.query(CREATE_EVENTS_SQL);
    await pool.query(CREATE_EVENTS_INDEX_SQL);
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
    generationStatus: row.generation_status || 'idle',
    subjectType: row.subject_type || 'kid',
    visitor: row.visitor || '',
    source: row.source || '',
    campaign: row.campaign || '',
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
    `INSERT INTO orders (child_name, child_count, email, theme, notes, thumb, page_count, access_token, photo, subject_type, visitor, source, campaign)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      order.childName,
      order.childCount,
      order.email,
      order.theme,
      order.notes,
      order.thumb,
      order.pageCount,
      accessToken,
      order.photo || null,
      order.subjectType === 'adult' ? 'adult' : 'kid',
      order.visitor || '',
      order.source || '',
      order.campaign || ''
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

// Reads an order INCLUDING its access token. Only the webhook uses this, to
// build the customer's recovery link. Never expose this through a route.
async function getOrderWithToken(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(id));
    return o || null;
  }
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(id)]);
  if (!rows[0]) return null;
  const order = rowToOrder(rows[0]);
  order.accessToken = rows[0].access_token;
  return order;
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
    // Every field the admin view needs. access_token and stripe_session_id are
    // deliberately NOT selected - nothing that grants access leaves through a list.
    : 'id, child_name, child_count, email, theme, notes, NULL AS thumb, page_count, '
      + 'status, submitted_at, paid, paid_at, amount_cents, product';

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

// Removes an order and, via ON DELETE CASCADE, its stored pages.
// Admin-only at the route layer. There is no undo, so the caller confirms.
async function deleteOrder(id) {
  if (!usingPostgres) {
    const i = memoryOrders.findIndex((o) => o.id === Number(id));
    if (i === -1) return null;
    return memoryOrders.splice(i, 1)[0];
  }
  const { rows } = await pool.query(
    'DELETE FROM orders WHERE id = ' + String.fromCharCode(36) + '1 RETURNING id, child_name, paid',
    [Number(id)]
  );
  return rows[0] ? { id: rows[0].id, childName: rows[0].child_name, paid: rows[0].paid === true } : null;
}

// Full row for the background renderer: includes the photo and the token.
// Never reachable through a route.
async function getOrderForRender(id) {
  if (!usingPostgres) return memoryOrders.find((o) => o.id === Number(id)) || null;
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [Number(id)]);
  if (!rows[0]) return null;
  const order = rowToOrder(rows[0]);
  order.photo = rows[0].photo;
  order.accessToken = rows[0].access_token;
  return order;
}

async function setGenerationStatus(id, status) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(id));
    if (o) o.generationStatus = status;
    return;
  }
  await pool.query('UPDATE orders SET generation_status = $2 WHERE id = $1', [Number(id), status]);
}

// How many pages are already drawn - drives the progress display and lets a
// restarted render skip work it already did.
async function countPages(orderId) {
  if (!usingPostgres) return 0;
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM order_pages WHERE order_id = $1', [Number(orderId)]);
  return rows[0].n;
}

async function doneSceneIndexes(orderId) {
  if (!usingPostgres) return [];
  const { rows } = await pool.query(
    'SELECT scene_index FROM order_pages WHERE order_id = $1', [Number(orderId)]);
  return rows.map((r) => r.scene_index);
}

// A customer's photo is only needed until the book is drawn. Once it is, we
// throw the photo away - we are holding pictures of children, and the safest
// place for them is nowhere.
async function clearPhoto(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(id));
    if (o) o.photo = null;
    return;
  }
  await pool.query('UPDATE orders SET photo = NULL WHERE id = $1', [Number(id)]);
}

// The retention sweep. Customers get a window to re-download their book; after
// that the drawings and everything personal are deleted. What stays behind is a
// bare sales record - order number, date, amount, Stripe reference - with no
// name, no email and no images attached to it.
async function purgeOldOrders(days) {
  const cutoffDays = Number(days) > 0 ? Number(days) : 30;
  if (!usingPostgres) {
    const cutoff = Date.now() - cutoffDays * 86400000;
    let n = 0;
    memoryOrders.forEach((o) => {
      if (new Date(o.submittedAt).getTime() >= cutoff) return;
      if (!o.photo && !o.thumb && !o.childName && !o.email && !o.accessToken) return;
      o.photo = null;
      o.thumb = null;
      o.childName = '';
      o.email = '';
      o.notes = '';
      o.accessToken = '';
      n++;
    });
    return n;
  }

  // Both steps or neither: a half-purged order would keep its drawings while
  // losing the token that proves who they belong to.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM order_pages WHERE order_id IN ('
      + '  SELECT id FROM orders WHERE submitted_at < NOW() - ($1 * INTERVAL \'1 day\')'
      + ')',
      [cutoffDays]);
    const { rowCount } = await client.query(
      'UPDATE orders SET photo = NULL, thumb = NULL, child_name = \'\', '
      + "email = '', notes = '', access_token = '' "
      + "WHERE submitted_at < NOW() - ($1 * INTERVAL '1 day') "
      + "AND (photo IS NOT NULL OR thumb IS NOT NULL OR child_name <> '' "
      + "     OR email <> '' OR access_token <> '')",
      [cutoffDays]);
    await client.query('COMMIT');
    return rowCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Paid orders whose book never finished - the ones a restart, a crash or a
// deploy left behind. They still have their photo, so they can be picked up
// where they stopped. Orders that have already burned through maxAttempts are
// left alone: something about them is broken, and retrying forever would just
// spend money on the same failure.
async function resumableOrders(maxAttempts) {
  const cap = Number(maxAttempts) > 0 ? Number(maxAttempts) : 5;
  if (!usingPostgres) {
    return memoryOrders
      .filter((o) => o.paid && o.generationStatus !== 'done' && o.photo
        && (o.renderAttempts || 0) < cap)
      .map((o) => o.id);
  }
  const { rows } = await pool.query(
    'SELECT id FROM orders '
    + "WHERE paid = TRUE AND generation_status <> 'done' "
    + 'AND photo IS NOT NULL AND render_attempts < $1 ORDER BY id',
    [cap]);
  return rows.map((r) => r.id);
}

// Counted before each attempt, not after, so an order that crashes the process
// every time still runs out of attempts instead of looping forever.
async function bumpRenderAttempts(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(id));
    if (o) o.renderAttempts = (o.renderAttempts || 0) + 1;
    return;
  }
  await pool.query(
    'UPDATE orders SET render_attempts = render_attempts + 1 WHERE id = $1', [Number(id)]);
}

async function countOrders() {
  if (!usingPostgres) return memoryOrders.length;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM orders');
  return rows[0].count;
}


// ---------------------------------------------------------------------------
// Funnel counters
// ---------------------------------------------------------------------------
// Everything below deals in counts only. A "visitor" is a random id the page
// makes up on load and keeps in a variable — it is never written to the
// browser, never reused across visits, and cannot identify anyone. It exists
// so that one person clicking twice is not counted as two people.

// Event names the rest of the app is allowed to record. Anything else is
// dropped, so a stray call from the browser can never pollute the numbers.
const EVENT_TYPES = [
  'landed',          // the page opened
  'uploaded',        // a photo was chosen
  'preview_started', // "See my free preview" was clicked
  'preview_shown',   // at least one page actually came back
  'unlock_clicked',  // checkout was started
  'paid'             // Stripe confirmed the payment (recorded server-side only)
];

function cleanTag(value) {
  return String(value || '').trim().toLowerCase().slice(0, 80);
}

// Counts people, not rows.
//
// The visitor id is the best key we have, but it is not always there: an ad
// blocker can stop the snippet that makes it, and someone can reach checkout
// before it ever runs. Those rows arrive with an empty visitor, and counting
// them DISTINCT folded every anonymous buyer into a single person - three real
// sales from one channel showed up as one, which is exactly the number used to
// decide whether that channel is worth paying for.
//
// So fall back to the order, and then to the event itself. That keeps separate
// buyers separate, and still folds Stripe's webhook retries together, because a
// retry repeats the same order.
const COUNT_KEY_SQL = "COALESCE(NULLIF(visitor, ''), 'order:' || order_id, 'ev:' || id)";

function countKey(e) {
  return e.visitor || (e.orderId ? `order:${e.orderId}` : `ev:${e.id}`);
}

async function recordEvent({ type, visitor, source, campaign, orderId }) {
  if (!EVENT_TYPES.includes(type)) return false;
  const row = {
    type,
    visitor: String(visitor || '').slice(0, 64),
    source: cleanTag(source) || 'direct',
    campaign: cleanTag(campaign),
    orderId: orderId ? Number(orderId) : null
  };

  if (!usingPostgres) {
    memoryEvents.push({ ...row, id: nextMemoryEventId++, createdAt: new Date() });
    return true;
  }
  await pool.query(
    'INSERT INTO events (type, visitor, source, campaign, order_id) VALUES ($1, $2, $3, $4, $5)',
    [row.type, row.visitor, row.source, row.campaign, row.orderId]
  );
  return true;
}

function withinDays(rows, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return rows.filter((e) => e.createdAt.getTime() >= cutoff);
}

// One row per funnel step, in flow order, so the drop-off is readable top to
// bottom. `visitors` counts people; `hits` counts clicks, and a gap between
// the two usually means someone retried.
async function funnelStats(days = 7) {
  const window = Math.min(Math.max(Number(days) || 7, 1), 365);

  if (!usingPostgres) {
    const rows = withinDays(memoryEvents, window);
    return EVENT_TYPES.map((type) => {
      const of = rows.filter((e) => e.type === type);
      return { type, visitors: new Set(of.map(countKey)).size, hits: of.length };
    });
  }

  const { rows } = await pool.query(
    `SELECT type,
            COUNT(DISTINCT ${COUNT_KEY_SQL})::int AS visitors,
            COUNT(*)::int                         AS hits
       FROM events
      WHERE created_at > NOW() - ($1 * INTERVAL '1 day')
      GROUP BY type`,
    [window]
  );
  const byType = new Map(rows.map((r) => [r.type, r]));
  return EVENT_TYPES.map((type) => ({
    type,
    visitors: byType.get(type) ? byType.get(type).visitors : 0,
    hits: byType.get(type) ? byType.get(type).hits : 0
  }));
}

// Where the traffic came from, and how much of it actually bought. This is the
// number that decides whether a marketing channel is worth paying for.
async function sourceStats(days = 7) {
  const window = Math.min(Math.max(Number(days) || 7, 1), 365);

  if (!usingPostgres) {
    const rows = withinDays(memoryEvents, window);
    const map = new Map();
    for (const e of rows) {
      if (!map.has(e.source)) map.set(e.source, { source: e.source, landed: new Set(), paid: new Set() });
      const bucket = map.get(e.source);
      if (e.type === 'landed') bucket.landed.add(countKey(e));
      if (e.type === 'paid') bucket.paid.add(countKey(e));
    }
    return [...map.values()]
      .map((b) => ({ source: b.source, visitors: b.landed.size, paid: b.paid.size }))
      .sort((a, b) => b.visitors - a.visitors || b.paid - a.paid)
      .slice(0, 25);
  }

  const { rows } = await pool.query(
    `SELECT source,
            COUNT(DISTINCT ${COUNT_KEY_SQL}) FILTER (WHERE type = 'landed')::int AS visitors,
            COUNT(DISTINCT ${COUNT_KEY_SQL}) FILTER (WHERE type = 'paid')::int   AS paid
       FROM events
      WHERE created_at > NOW() - ($1 * INTERVAL '1 day')
      GROUP BY source
      ORDER BY visitors DESC, paid DESC
      LIMIT 25`,
    [window]
  );
  return rows;
}

// Counters are not worth keeping forever. Same idea as purgeOldOrders.
async function purgeOldEvents(days) {
  const window = Number(days) > 0 ? Number(days) : 180;
  if (!usingPostgres) {
    const before = memoryEvents.length;
    memoryEvents = withinDays(memoryEvents, window);
    return before - memoryEvents.length;
  }
  const { rowCount } = await pool.query(
    "DELETE FROM events WHERE created_at < NOW() - ($1 * INTERVAL '1 day')", [window]);
  return rowCount;
}

module.exports = {
  usingPostgres,
  status,
  initDb,
  saveOrder,
  authorizeOrder,
  attachCheckoutSession,
  markPaid,
  getOrderWithToken,
  getOrderForRender,
  setGenerationStatus,
  countPages,
  doneSceneIndexes,
  clearPhoto,
  purgeOldOrders,
  resumableOrders,
  bumpRenderAttempts,
  savePage,
  listPages,
  deleteOrder,
  listOrders,
  getOrder,
  updateOrderStatus,
  countOrders,
  recordEvent,
  funnelStats,
  sourceStats,
  purgeOldEvents
};
