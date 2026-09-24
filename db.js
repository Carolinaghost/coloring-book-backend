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
const { encodeForStorage } = require('./page-encode');

const DATABASE_URL = process.env.DATABASE_URL;
const usingPostgres = Boolean(DATABASE_URL);

let pool = null;
let memoryOrders = [];
const memoryPreviewQuota = new Map();
const memorySignupQuota = new Map();
const memoryJobRuns = new Set();
const memoryCreators = [];
let memoryEvents = [];
let nextMemoryId = 1;
let nextMemoryEventId = 1;

if (usingPostgres) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Hosted Postgres (Render, Neon, Supabase) requires SSL. Their certs are
    // signed by roots Node doesn't always carry, hence rejectUnauthorized.
    // A URL that says sslmode=disable outright means somebody is pointing this
    // at a scratch database on their own machine, which has no certificate at
    // all - no hosted URL carries that, so production is unaffected.
    ssl: /[?&]sslmode=disable\b/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
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
    -- how busy the pages are: simple, standard or detailed
    detail_level      TEXT        NOT NULL DEFAULT 'standard',
    -- when the last render attempt started, so a failed one can back off
    last_attempt_at   TIMESTAMPTZ,
    generation_status TEXT        NOT NULL DEFAULT 'idle'
  );
`;

// Generated artwork, one row per scene. Kept so a customer can re-download
// their book without us paying OpenAI to redraw it.
const CREATE_PAGES_SQL = `
  -- What the watchdog has already told Jonathan about. One row per condition,
  -- so a problem that lasts all afternoon is one email and not eighty.
  CREATE TABLE IF NOT EXISTS watchdog_alerts (
    key           TEXT        PRIMARY KEY,
    level         TEXT        NOT NULL,
    detail        TEXT        NOT NULL DEFAULT '',
    first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    told_level    TEXT,
    told_at       TIMESTAMPTZ
  );

  -- Every automatic fix, so there is always an answer to "what did it do at 3am".
  CREATE TABLE IF NOT EXISTS watchdog_actions (
    id         SERIAL      PRIMARY KEY,
    order_id   INTEGER,
    action     TEXT        NOT NULL,
    reason     TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS watchdog_actions_at_idx ON watchdog_actions (created_at DESC);

  CREATE TABLE IF NOT EXISTS order_pdfs (
    order_id   INTEGER     PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    pdf        BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

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
  CREATE TABLE IF NOT EXISTS preview_quota (
    ip TEXT NOT NULL,
    day DATE NOT NULL,
    -- Which allowance this row counts. 'step3' is the free preview attached to
    -- a real order; 'strip' is the four styles drawn automatically on upload.
    -- They are separate rows so heavy use of one can never starve the other -
    -- and it is step3 that leads to somebody paying.
    kind TEXT NOT NULL DEFAULT 'step3',
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, day, kind)
  );

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

// Creators. One row per person who signed up through the "become a creator"
// page, keyed on the Stripe promotion code they were given, so the code the
// customer types and the person we owe money to are never two separate lists
// that can drift apart.
//
// Email is UNIQUE on purpose. Somebody who fills the form twice - and they
// will, because nothing about a form stops them - must come back with the code
// they already have, not a second code splitting their own sales in half.
// The creators table already exists on the live database without these, so
// CREATE TABLE IF NOT EXISTS would silently skip them. Kept separate from
// MIGRATIONS because that array runs before the creators table is made.
const CREATOR_MIGRATIONS = [
  "ALTER TABLE creators ADD COLUMN IF NOT EXISTS free_code TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE creators ADD COLUMN IF NOT EXISTS free_promo_id TEXT NOT NULL DEFAULT ''",
  // How a creator gets paid. The Stripe Connect Express account holds their
  // bank details and tax form - we never see either - and the token is the
  // only thing standing between a stranger and that creator's onboarding
  // page, so it is read back by exactly one function and nowhere else.
  "ALTER TABLE creators ADD COLUMN IF NOT EXISTS stripe_account_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE creators ADD COLUMN IF NOT EXISTS payout_link_token TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS payout_link_sent_at TIMESTAMPTZ',
  'ALTER TABLE creators ADD COLUMN IF NOT EXISTS payout_ready_at TIMESTAMPTZ',
  // Not unique: every creator who has no link yet shares the empty string.
  'CREATE INDEX IF NOT EXISTS creators_payout_link_token_idx ON creators (payout_link_token)'
];

// One row per job per occasion it was supposed to run. The primary key is the
// whole mechanism: two web processes, or one process that redeployed inside
// the same hour, both try to insert and exactly one of them wins. The loser
// gets no row back and sends nothing.
//
// A timer plus a variable in memory - which is how the daily digest does it -
// forgets everything on redeploy, and Render redeploys whenever main moves.
// For a digest that means a duplicate. For the payout report it would mean
// Jonathan reading two different totals on a morning he is paying people.
const CREATE_JOB_RUNS_SQL = `
  CREATE TABLE IF NOT EXISTS job_runs (
    job     TEXT        NOT NULL,
    ran_for TEXT        NOT NULL,
    ran_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job, ran_for)
  );
`;

const CREATE_CREATORS_SQL = `
  CREATE TABLE IF NOT EXISTS creators (
    id           SERIAL      PRIMARY KEY,
    code         TEXT        NOT NULL UNIQUE,
    name         TEXT        NOT NULL,
    email        TEXT        NOT NULL UNIQUE,
    platform     TEXT        NOT NULL DEFAULT '',
    handle       TEXT        NOT NULL DEFAULT '',
    followers    TEXT        NOT NULL DEFAULT '',
    rate_percent INTEGER     NOT NULL DEFAULT 25,
    promo_id     TEXT        NOT NULL DEFAULT '',
    -- The single-use 100%-off code that makes good on the free book the
    -- proposal promises. Empty means they never got one, which is a thing
    -- somebody has to fix by hand rather than a thing to leave unnoticed.
    free_code    TEXT        NOT NULL DEFAULT '',
    free_promo_id TEXT       NOT NULL DEFAULT '',
    signed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    welcomed_at  TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS signup_quota (
    ip   TEXT    NOT NULL,
    day  DATE    NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, day)
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
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS access_token TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo TEXT",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS generation_status TEXT NOT NULL DEFAULT 'idle'",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'kid'",
  // Orders taken before the customer could choose read as 'standard', which is
  // the middle band - the same thing they were most likely already getting.
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS detail_level TEXT NOT NULL DEFAULT 'standard'",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS render_attempts INTEGER NOT NULL DEFAULT 0",
  // A preview that failed to draw. Null on every other order, which is the
  // point: only an order whose free preview actually came back empty gets
  // picked up again, never the far larger number of people who simply left.
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS preview_rescue_at TIMESTAMPTZ",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS preview_attempts INTEGER NOT NULL DEFAULT 0",
  // Set once, and checked before sending. Two web processes sweeping at the
  // same moment must not both post the same pages to the same person.
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS preview_emailed_at TIMESTAMPTZ",
  // Null on every existing row, which reads as "never tried" and lets the
  // sweep pick it up at once - the right answer for anything stuck today.
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ",
  // Existing rows are all Step 3 previews, which is what the default says.
  "ALTER TABLE preview_quota ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'step3'",
  // And the key has to grow with it, or the two allowances collide on (ip, day)
  // and the separation is decorative. Rebuilt only when it is not already three
  // columns wide, so running this twice costs nothing.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        WHERE c.relname = 'preview_quota' AND i.indisprimary AND i.indnatts = 3
     ) THEN
       ALTER TABLE preview_quota DROP CONSTRAINT IF EXISTS preview_quota_pkey;
       ALTER TABLE preview_quota ADD PRIMARY KEY (ip, day, kind);
     END IF;
   END $$;`,
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS visitor TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS campaign TEXT NOT NULL DEFAULT ''",
  // A family book: one entry per person, each with their own photo, in the
  // order the pages should introduce them. Null for a single-subject book,
  // which still uses child_count, subject_type and the one photo column.
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS people TEXT",
  // Whether the "your book is ready" email actually went. Without these the
  // watchdog cannot tell a customer who was told from one who was not, which is
  // the difference between a finished order and a silent failure.
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_email_at TIMESTAMPTZ",
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_email_fails INTEGER NOT NULL DEFAULT 0"
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
    await pool.query(CREATE_CREATORS_SQL);
    await pool.query(CREATE_JOB_RUNS_SQL);
    for (const sql of CREATOR_MIGRATIONS) await pool.query(sql);
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
// Bad JSON in this column must not take down a whole order listing, so a row
// that cannot be read comes back as a plain book rather than an exception.
//
// Photos are left out unless asked for, the same way the single photo column is:
// a listing wants to know who is in the book, not to carry a megabyte of
// someone's family around with it.
function parsePeopleColumn(value, withPhotos) {
  if (!value) return [];
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (err) {
    console.error('Could not read the people column on an order:', err.message);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((person) => (withPhotos ? person : {
    name: person && person.name,
    subjectType: person && person.subjectType
  }));
}

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
    detailLevel: row.detail_level || 'standard',
    renderAttempts: row.render_attempts || 0,
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
    previewRescueAt: row.preview_rescue_at ? new Date(row.preview_rescue_at).toISOString() : null,
    previewAttempts: row.preview_attempts || 0,
    previewEmailedAt: row.preview_emailed_at ? new Date(row.preview_emailed_at).toISOString() : null,
    visitor: row.visitor || '',
    source: row.source || '',
    campaign: row.campaign || '',
    // Stored as JSON text. A row written before family books existed has none,
    // and every caller treats an empty list as "not a family book".
    people: parsePeopleColumn(row.people, false),
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
      // Spelled out rather than left undefined: Postgres hands these back as 0
      // and null, and the two stores disagreeing is how a rule that holds in a
      // test stops holding in production.
      renderAttempts: 0,
      lastAttemptAt: null,
      previewRescueAt: null,
      previewAttempts: 0,
      previewEmailedAt: null,
      ...order
    };
    memoryOrders.push(saved);
    // A copy, not the stored record. The caller hands this to the browser and
    // strips the access token off it first; handing back the stored object let
    // that delete reach the store, and the order could never be authorised
    // again - no checkout, no pages. Postgres has always returned a fresh
    // object, so this only ever bit the in-memory path: local runs and CI.
    return { ...saved };
  }

  const { rows } = await pool.query(
    `INSERT INTO orders (child_name, child_count, email, theme, notes, thumb, page_count, access_token, photo, subject_type, detail_level, visitor, source, campaign, people)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      order.detailLevel || 'standard',
      order.visitor || '',
      order.source || '',
      order.campaign || '',
      order.people && order.people.length ? JSON.stringify(order.people) : null
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

// What Stripe actually charged, which is not always what we quoted. A 100% off
// promotion code settles at zero, and zero is a number we have to keep rather
// than a value we can treat as "not told" - `amountCents || null` read a free
// book as no answer, fell through to COALESCE, and left the order carrying the
// full price attachCheckoutSession wrote when checkout began. Every free code
// then showed up in /stats revenue and in the admin CSV as a real sale.
// Undefined and null still mean "no answer"; 0 means zero.
function amountOrNull(amountCents) {
  // Number(null) is 0, so "no answer" has to be spotted before the conversion
  // rather than after it.
  if (amountCents === null || amountCents === undefined || amountCents === '') return null;
  const n = Number(amountCents);
  return Number.isFinite(n) ? n : null;
}

async function markPaid(sessionId, amountCents) {
  const amount = amountOrNull(amountCents);
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.stripeSessionId === sessionId);
    if (!o) return null;
    o.paid = true;
    o.status = 'in_progress';
    if (amount !== null) o.amountCents = amount;
    return o;
  }
  const { rows } = await pool.query(
    `UPDATE orders
        SET paid = TRUE, paid_at = NOW(), amount_cents = COALESCE($2, amount_cents),
            status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END
      WHERE stripe_session_id = $1
      RETURNING *`,
    [sessionId, amount]
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

// Pages are shrunk on the way in - see page-encode.js. Doing it here rather
// than at the call sites means there is one door into order_pages and nothing
// can slip past it storing a full-colour photograph of a line drawing.
async function savePage(orderId, sceneIndex, rawImage) {
  const image = await encodeForStorage(rawImage);
  if (!usingPostgres) return;
  await pool.query(
    `INSERT INTO order_pages (order_id, scene_index, image)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id, scene_index) DO UPDATE SET image = EXCLUDED.image`,
    [Number(orderId), Number(sceneIndex), image]
  );
}

// The finished PDF, in its own table so that it is never dragged along by the
// SELECT * reads of the orders row - one of which is the access poll the
// waiting page runs every five seconds. Nothing but the download and the email
// ever wants these bytes.
async function saveBookPdf(orderId, buffer) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(orderId));
    if (o) o.pdf = buffer;
    return;
  }
  await pool.query(
    `INSERT INTO order_pdfs (order_id, pdf) VALUES ($1, $2)
     ON CONFLICT (order_id) DO UPDATE SET pdf = EXCLUDED.pdf, created_at = NOW()`,
    [Number(orderId), buffer]
  );
}

async function getBookPdf(orderId) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(orderId));
    return (o && o.pdf) || null;
  }
  const { rows } = await pool.query('SELECT pdf FROM order_pdfs WHERE order_id = $1', [Number(orderId)]);
  return (rows[0] && rows[0].pdf) || null;
}

// ---------------------------------------------------------------------------
// Watchdog storage. Kept here so the checks can be tested against a real shape
// without a server running.
// ---------------------------------------------------------------------------

let memoryAlerts = new Map();
let memoryActions = [];

async function getAlerts() {
  if (!usingPostgres) return [...memoryAlerts.values()].map((a) => ({ ...a }));
  const { rows } = await pool.query('SELECT * FROM watchdog_alerts');
  return rows.map((r) => ({
    key: r.key, level: r.level, detail: r.detail,
    firstSeen: r.first_seen, lastSeen: r.last_seen,
    toldLevel: r.told_level, toldAt: r.told_at
  }));
}

async function saveAlert(a) {
  if (!usingPostgres) { memoryAlerts.set(a.key, { ...a }); return; }
  await pool.query(
    `INSERT INTO watchdog_alerts (key, level, detail, first_seen, last_seen, told_level, told_at)
     VALUES ($1, $2, $3, COALESCE($4, NOW()), NOW(), $5, $6)
     ON CONFLICT (key) DO UPDATE SET
       level = EXCLUDED.level, detail = EXCLUDED.detail, last_seen = NOW(),
       told_level = EXCLUDED.told_level, told_at = EXCLUDED.told_at`,
    [a.key, a.level, a.detail || '', a.firstSeen || null, a.toldLevel || null, a.toldAt || null]
  );
}

async function clearAlert(key) {
  if (!usingPostgres) { memoryAlerts.delete(key); return; }
  await pool.query('DELETE FROM watchdog_alerts WHERE key = $1', [key]);
}

async function recordAction(orderId, action, reason) {
  const row = { orderId: orderId === null ? null : Number(orderId), action, reason: reason || '', createdAt: new Date() };
  if (!usingPostgres) { memoryActions.push(row); return row; }
  await pool.query(
    'INSERT INTO watchdog_actions (order_id, action, reason) VALUES ($1, $2, $3)',
    [row.orderId, action, row.reason]
  );
  return row;
}

// How many automatic fixes have fired in the last `minutes`. This is what stops
// a retry loop against a paid image API, so it counts everything, not per-order.
async function countActionsSince(minutes) {
  if (!usingPostgres) {
    const cutoff = Date.now() - minutes * 60000;
    return memoryActions.filter((a) => a.createdAt.getTime() >= cutoff).length;
  }
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM watchdog_actions WHERE created_at > NOW() - ($1 * INTERVAL '1 minute')",
    [minutes]
  );
  return rows[0].n;
}

async function countActionsForOrder(orderId, action) {
  if (!usingPostgres) {
    return memoryActions.filter((a) => a.orderId === Number(orderId) && a.action === action).length;
  }
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM watchdog_actions WHERE order_id = $1 AND action = $2',
    [Number(orderId), action]
  );
  return rows[0].n;
}

async function recentActions(minutes) {
  if (!usingPostgres) {
    const cutoff = Date.now() - minutes * 60000;
    return memoryActions.filter((a) => a.createdAt.getTime() >= cutoff).map((a) => ({ ...a }));
  }
  const { rows } = await pool.query(
    "SELECT order_id, action, reason, created_at FROM watchdog_actions "
    + "WHERE created_at > NOW() - ($1 * INTERVAL '1 minute') ORDER BY created_at",
    [minutes]
  );
  return rows.map((r) => ({ orderId: r.order_id, action: r.action, reason: r.reason, createdAt: r.created_at }));
}

// Bytes the database is using. The number the plan's ceiling is measured against.
async function databaseSizeBytes() {
  if (!usingPostgres) return null;
  const { rows } = await pool.query('SELECT pg_database_size(current_database())::bigint AS n');
  return Number(rows[0].n);
}

// Paid orders the watchdog needs to look at: anything not finished, plus
// anything finished that nobody was told about.
async function ordersNeedingAttention(minutesOld) {
  if (!usingPostgres) {
    return memoryOrders
      .filter((o) => o.paid)
      .map((o) => ({
        id: o.id, paidAt: o.paidAt, pageCount: o.pageCount,
        generationStatus: o.generationStatus || 'idle',
        pagesReady: 0, renderAttempts: o.renderAttempts || 0,
        readyEmailAt: o.readyEmailAt || null, readyEmailFails: o.readyEmailFails || 0,
        email: o.email, hasPhoto: Boolean(o.photo) || Boolean((o.people || []).length)
      }));
  }
  const { rows } = await pool.query(
    `SELECT o.id, o.paid_at, o.page_count, o.generation_status, o.render_attempts,
            o.ready_email_at, o.ready_email_fails, o.email,
            (o.photo IS NOT NULL OR o.people IS NOT NULL) AS has_photo,
            (SELECT COUNT(*)::int FROM order_pages p WHERE p.order_id = o.id) AS pages_ready
       FROM orders o
      WHERE o.paid = TRUE
        AND o.paid_at > NOW() - INTERVAL '2 days'
        AND o.paid_at < NOW() - ($1 * INTERVAL '1 minute')`,
    [minutesOld]
  );
  return rows.map((r) => ({
    id: r.id, paidAt: r.paid_at, pageCount: r.page_count,
    generationStatus: r.generation_status, pagesReady: r.pages_ready,
    renderAttempts: r.render_attempts, readyEmailAt: r.ready_email_at,
    readyEmailFails: r.ready_email_fails, email: r.email, hasPhoto: r.has_photo
  }));
}

// The moment we started recording whether a ready-email went out. Orders paid
// before this have ready_email_at NULL because the column did not exist yet,
// not because nobody was told - and "assume nobody was told" means emailing
// customers their book a second time. Null here means we have no recorded email
// at all, so nothing can be judged.
async function emailRecordingSince() {
  if (!usingPostgres) {
    const stamps = memoryOrders.map((o) => o.readyEmailAt).filter(Boolean);
    return stamps.length ? new Date(Math.min(...stamps.map((d) => new Date(d).getTime()))) : null;
  }
  const { rows } = await pool.query(
    'SELECT MIN(ready_email_at) AS since FROM orders WHERE ready_email_at IS NOT NULL');
  return rows[0].since || null;
}

async function markReadyEmailSent(orderId) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(orderId));
    if (o) o.readyEmailAt = new Date();
    return;
  }
  await pool.query('UPDATE orders SET ready_email_at = NOW() WHERE id = $1', [Number(orderId)]);
}

async function markReadyEmailFailed(orderId) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(orderId));
    if (o) o.readyEmailFails = (o.readyEmailFails || 0) + 1;
    return;
  }
  await pool.query(
    'UPDATE orders SET ready_email_fails = ready_email_fails + 1 WHERE id = $1', [Number(orderId)]);
}

// Yesterday's trade, for the daily digest.
async function dayTotals(days) {
  if (!usingPostgres) return { orders: 0, revenueCents: 0, pages: 0 };
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS orders,
            COALESCE(SUM(amount_cents), 0)::int AS revenue_cents,
            COALESCE(SUM((SELECT COUNT(*) FROM order_pages p WHERE p.order_id = o.id)), 0)::int AS pages
       FROM orders o
      WHERE o.paid = TRUE AND o.paid_at > NOW() - ($1 * INTERVAL '1 day')`,
    [days]
  );
  return { orders: rows[0].orders, revenueCents: rows[0].revenue_cents, pages: rows[0].pages };
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
  // Drawing is the one place that needs the faces, so this is the one place
  // they are handed over.
  order.people = parsePeopleColumn(rows[0].people, true);
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
      if (!o.photo && !o.thumb && !o.childName && !o.email && !o.accessToken && !o.pdf) return;
      o.pdf = null;
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
    // The finished book too. It IS the drawings - leaving it behind would keep
    // a copy of the child after the pages it was built from are gone, which is
    // not what the privacy policy promises, and it would grow forever.
    await client.query(
      'DELETE FROM order_pdfs WHERE order_id IN ('
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
//
// "Has a photo" means the single photo column OR a cast in people, each person
// carrying their own. A family book stores nothing in photo - the images live
// in people - so for a long time this query could not see one at all. They were
// started once by the Stripe webhook and, if that attempt failed, never retried
// by anything, ever. Not capped at five: one.
//
// Attempts are also spaced out. Counting five tries a minute apart is not five
// chances, it is one bad minute: an OpenAI outage of a quarter of an hour used
// to burn through every attempt an order had and leave it stranded after the
// outage cleared. Each attempt now waits twice as long as the last, so five of
// them span about half an hour and an order is still alive at the end of a
// wobble rather than written off during it.
async function resumableOrders(maxAttempts, backoffMinutes) {
  const cap = Number(maxAttempts) > 0 ? Number(maxAttempts) : 5;
  const base = Number(backoffMinutes) > 0 ? Number(backoffMinutes) : 2;
  const hasImages = (o) => Boolean(o.photo) || Boolean(o.people && o.people.length);
  const dueAt = (o) => {
    const attempts = o.renderAttempts || 0;
    if (!attempts || !o.lastAttemptAt) return 0;
    return new Date(o.lastAttemptAt).getTime() + base * Math.pow(2, attempts) * 60000;
  };
  if (!usingPostgres) {
    const now = Date.now();
    return memoryOrders
      .filter((o) => o.paid && o.generationStatus !== 'done' && hasImages(o)
        && (o.renderAttempts || 0) < cap && dueAt(o) <= now)
      .map((o) => o.id);
  }
  const { rows } = await pool.query(
    'SELECT id FROM orders '
    + "WHERE paid = TRUE AND generation_status <> 'done' "
    + 'AND (photo IS NOT NULL OR people IS NOT NULL) '
    + 'AND render_attempts < $1 '
    + 'AND (last_attempt_at IS NULL OR render_attempts = 0 '
    + "     OR last_attempt_at < NOW() - ($2 * INTERVAL '1 minute' * POWER(2, render_attempts))) "
    + 'ORDER BY id',
    [cap, base]);
  return rows.map((r) => r.id);
}

// A free preview that came back empty. Marked at the moment the draw failed,
// and only then - an order nobody ever managed to draw is a different thing
// from the many orders where somebody simply wandered off, and only the first
// is worth paying OpenAI to try again.
//
// Already emailed means already finished, so it is left alone. Otherwise the
// clock starts now: the sweep waits out the schedule from this moment.
async function markPreviewRescue(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => String(x.id) === String(id));
    if (o && !o.previewEmailedAt) o.previewRescueAt = new Date().toISOString();
    return;
  }
  await pool.query(
    'UPDATE orders SET preview_rescue_at = NOW() '
    + 'WHERE id = $1 AND preview_emailed_at IS NULL', [Number(id)]);
}

// Which failed previews are due another go. The delays are passed in rather
// than doubled from a base, because the windows being waited out are not
// shaped like a doubling: OpenAI's safety refusals came in clumps of seven and
// nine minutes, so the third try has to land past ten and the first has to be
// soon enough that the email still feels like part of what they just did.
async function rescuablePreviews(maxAttempts, delaysMinutes) {
  const cap = Number(maxAttempts) > 0 ? Number(maxAttempts) : 3;
  const d = Array.isArray(delaysMinutes) && delaysMinutes.length === 3
    ? delaysMinutes.map(Number) : [1, 4, 10];
  const hasImages = (o) => Boolean(o.photo) || Boolean(o.people && o.people.length);
  if (!usingPostgres) {
    const now = Date.now();
    return memoryOrders
      .filter((o) => o.previewRescueAt && !o.previewEmailedAt && !o.paid && hasImages(o)
        && (o.previewAttempts || 0) < cap
        && new Date(o.previewRescueAt).getTime()
             + d[Math.min(o.previewAttempts || 0, 2)] * 60000 <= now)
      .map((o) => o.id);
  }
  const { rows } = await pool.query(
    'SELECT id FROM orders '
    + 'WHERE preview_rescue_at IS NOT NULL AND preview_emailed_at IS NULL '
    + 'AND paid = FALSE '
    + 'AND (photo IS NOT NULL OR people IS NOT NULL) '
    + 'AND preview_attempts < $1 '
    // The casts are load-bearing. Without them Postgres types the CASE as
    // text - the driver sends numbers as text and nothing in the branches
    // says otherwise - and refuses with "operator does not exist: text *
    // interval". The in-memory store has no opinion about types, so the
    // whole suite passed and it failed on the first sweep in production.
    + "AND preview_rescue_at < NOW() - (CASE preview_attempts "
    + "     WHEN 0 THEN $2::numeric WHEN 1 THEN $3::numeric ELSE $4::numeric "
    + "     END) * INTERVAL '1 minute' "
    + 'ORDER BY id',
    [cap, d[0], d[1], d[2]]);
  return rows.map((r) => r.id);
}

// One go used up. The clock restarts from now, so the next delay is measured
// from this attempt and not from the original failure.
async function notePreviewAttempt(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => String(x.id) === String(id));
    if (o) { o.previewAttempts = (o.previewAttempts || 0) + 1; o.previewRescueAt = new Date().toISOString(); }
    return;
  }
  await pool.query(
    'UPDATE orders SET preview_attempts = preview_attempts + 1, preview_rescue_at = NOW() '
    + 'WHERE id = $1', [Number(id)]);
}

// Claims the send. Returns true for exactly one caller, so two processes
// sweeping together cannot both email the same person the same pages.
async function claimPreviewEmail(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => String(x.id) === String(id));
    if (!o || o.previewEmailedAt) return false;
    o.previewEmailedAt = new Date().toISOString();
    return true;
  }
  const { rows } = await pool.query(
    'UPDATE orders SET preview_emailed_at = NOW() '
    + 'WHERE id = $1 AND preview_emailed_at IS NULL RETURNING id', [Number(id)]);
  return rows.length > 0;
}

// Handing the send back when it did not go. Without this a bounced or refused
// email would look exactly like a delivered one and never be tried again.
async function releasePreviewEmail(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => String(x.id) === String(id));
    if (o) o.previewEmailedAt = null;
    return;
  }
  await pool.query('UPDATE orders SET preview_emailed_at = NULL WHERE id = $1', [Number(id)]);
}

// Pulls a waiting order forward by moving its last attempt into the past, so
// the sweep stops backing off and takes it on the next pass. Written for the
// tests, which cannot wait half an hour to watch a back-off expire, and equally
// the thing to reach for when an order is sitting out a wait it does not
// deserve - after a provider outage clears, say.
async function backdateLastAttempt(id, minutes) {
  const mins = Number(minutes) || 0;
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(id));
    if (o) o.lastAttemptAt = new Date(Date.now() - mins * 60000).toISOString();
    return;
  }
  await pool.query(
    "UPDATE orders SET last_attempt_at = NOW() - ($2 * INTERVAL '1 minute') WHERE id = $1",
    [Number(id), mins]);
}

// Counted before each attempt, not after, so an order that crashes the process
// every time still runs out of attempts instead of looping forever. The time is
// stamped in the same write, because it is what resumableOrders backs off from.
async function bumpRenderAttempts(id) {
  if (!usingPostgres) {
    const o = memoryOrders.find((x) => x.id === Number(id));
    if (o) {
      o.renderAttempts = (o.renderAttempts || 0) + 1;
      o.lastAttemptAt = new Date().toISOString();
    }
    return;
  }
  await pool.query(
    'UPDATE orders SET render_attempts = render_attempts + 1, last_attempt_at = NOW() WHERE id = $1',
    [Number(id)]);
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
// The visitor id is the best key we have. The site's own page always sets one,
// so in ordinary traffic it is there - but the server cannot assume that. A page
// cached from before the counters existed, and anything reaching the API that is
// not that page, sends an empty visitor. Counting those DISTINCT folded every one
// of them into a single person: several real sales from one channel reporting as
// one, which is the number used to decide whether that channel is worth paying
// for.
//
// So fall back to the order, and then to the event itself. That keeps separate
// buyers separate, and it also folds Stripe's webhook retries together, because a
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


// Free previews, counted per visitor per day, and counted HERE rather than in
// a Map in the web process. The Map version reset on every restart, and this
// service redeploys whenever main moves - so a daily cap kept in memory is a
// cap that quietly lifts itself several times a week.
//
// One statement, so two requests arriving together cannot both read "7 used"
// and both be allowed. The WHERE is what enforces the limit: on the row that
// is already at the limit the update matches nothing, nothing is returned, and
// the caller is over.
//
// `day` is passed in rather than taken from now() so the boundary is the
// customer's midnight, not the database server's.
// count is how many IMAGES this one request will draw. The style grid draws
// four at once, and it has to take all four or none: taking them one at a time
// lets a visitor with three left start a four-tile grid, watch three tiles
// arrive and the fourth fail, and be charged for the lot. All-or-nothing is
// also what makes the arithmetic in the spec true - eight allowance, four a
// run, two runs.
async function takePreviewQuota(ip, day, limit, count = 1, kind = 'step3') {
  const want = Math.max(1, Number(count) || 1);
  if (!usingPostgres) {
    const key = `${ip}|${day}|${kind}`;
    const already = memoryPreviewQuota.get(key) || 0;
    if (already + want > limit) return { allowed: false, used: already, left: Math.max(0, limit - already) };
    memoryPreviewQuota.set(key, already + want);
    return { allowed: true, used: already + want, left: limit - (already + want) };
  }
  const { rows } = await pool.query(
    `INSERT INTO preview_quota (ip, day, kind, used) VALUES ($1, $2, $5, $4)
       ON CONFLICT (ip, day, kind) DO UPDATE SET used = preview_quota.used + $4
       WHERE preview_quota.used + $4 <= $3
     RETURNING used`,
    [ip, day, limit, want, kind]
  );
  if (rows.length) return { allowed: true, used: rows[0].used, left: limit - rows[0].used };
  // Refused. Say how many are actually left, because the difference between
  // "none at all" and "two, but you asked for four" is what the site needs to
  // decide whether to send the visitor on to step 3.
  const { rows: seen } = await pool.query(
    'SELECT used FROM preview_quota WHERE ip = $1 AND day = $2 AND kind = $3', [ip, day, kind]);
  const used = seen.length ? seen[0].used : 0;
  return { allowed: false, used, left: Math.max(0, limit - used) };
}

// Handing one back. A preview is charged for before OpenAI is asked, because
// the alternative is asking first and letting somebody loop the endpoint for
// free - so when the drawing fails the visitor has paid for nothing and the
// count has to come back down.
//
// Never below zero, and never above the limit it was counted against: a refund
// is undoing something that happened, not a credit to spend later.
//
// This cannot be gamed into free previews. A refunded attempt produced no
// image - there is nothing to harvest by forcing failures - and the site-wide
// hourly cap is not refunded at all, so what OpenAI can be made to spend in an
// hour is unchanged.
async function refundPreviewQuota(ip, day, count = 1, kind = 'step3') {
  const back = Math.max(1, Number(count) || 1);
  if (!usingPostgres) {
    const key = `${ip}|${day}|${kind}`;
    const used = memoryPreviewQuota.get(key) || 0;
    const now = Math.max(0, used - back);
    memoryPreviewQuota.set(key, now);
    return now;
  }
  // GREATEST keeps a refund from going below zero even if it is called more
  // times than the images were taken.
  const { rows } = await pool.query(
    `UPDATE preview_quota SET used = GREATEST(used - $3, 0)
      WHERE ip = $1 AND day = $2 AND kind = $4
     RETURNING used`,
    [ip, day, back, kind]
  );
  return rows.length ? rows[0].used : 0;
}

// Yesterday's rows are of no further use. Kept for a few days only so a
// question like "was that visitor throttled on Tuesday" can still be answered.
async function purgeOldPreviewQuota(days = 7) {
  if (!usingPostgres) { memoryPreviewQuota.clear(); return 0; }
  const { rowCount } = await pool.query(
    "DELETE FROM preview_quota WHERE day < CURRENT_DATE - ($1 || ' days')::interval", [days]);
  return rowCount;
}

// The same one-statement trick preview_quota uses, for the creator form. The
// codes it hands out carry no discount, so somebody spamming the form gains
// nothing - but they could still fill Stripe with junk promotion codes, and a
// list of promotion codes nobody recognises is a list nobody can audit.
async function takeSignupQuota(ip, day, limit) {
  if (!usingPostgres) {
    const key = `${ip}|${day}`;
    const used = (memorySignupQuota.get(key) || 0) + 1;
    if (used > limit) return { allowed: false, used: limit };
    memorySignupQuota.set(key, used);
    return { allowed: true, used };
  }
  const { rows } = await pool.query(
    `INSERT INTO signup_quota (ip, day, used) VALUES ($1, $2, 1)
       ON CONFLICT (ip, day) DO UPDATE SET used = signup_quota.used + 1
       WHERE signup_quota.used < $3
     RETURNING used`,
    [ip, day, limit]
  );
  return rows.length ? { allowed: true, used: rows[0].used } : { allowed: false, used: limit };
}

function rowToCreator(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email,
    platform: row.platform || '',
    handle: row.handle || '',
    followers: row.followers || '',
    ratePercent: row.rate_percent,
    promoId: row.promo_id || '',
    freeCode: row.free_code || '',
    freePromoId: row.free_promo_id || '',
    signedUpAt: row.signed_up_at,
    welcomedAt: row.welcomed_at || null,
    // payout_link_token is deliberately not here. This shape is what the admin
    // /creators page returns, and the token is a credential, not a detail.
    stripeAccountId: row.stripe_account_id || '',
    payoutLinkSentAt: row.payout_link_sent_at || null,
    payoutReadyAt: row.payout_ready_at || null
  };
}

async function getCreatorByEmail(email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  if (!usingPostgres) {
    return rowToCreator(memoryCreators.find((c) => c.email === wanted) || null);
  }
  const { rows } = await pool.query('SELECT * FROM creators WHERE email = $1', [wanted]);
  return rows[0] ? rowToCreator(rows[0]) : null;
}

async function codeTaken(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return true;
  if (!usingPostgres) return memoryCreators.some((c) => c.code === wanted);
  const { rows } = await pool.query('SELECT 1 FROM creators WHERE code = $1', [wanted]);
  return rows.length > 0;
}

// Written only after Stripe has said yes, so a row here always has a real
// promotion code behind it. The reverse - a Stripe code with no row - is the
// safe direction to fail in: it costs an orphaned code, not a creator who
// thinks they are signed up and is not.
async function saveCreator(c) {
  const row = {
    free_code: String(c.freeCode || '').toUpperCase(),
    free_promo_id: c.freePromoId || '',
    code: String(c.code).toUpperCase(),
    name: String(c.name),
    email: String(c.email).trim().toLowerCase(),
    platform: c.platform || '',
    handle: c.handle || '',
    followers: c.followers || '',
    rate_percent: Number(c.ratePercent) || 25,
    promo_id: c.promoId || ''
  };
  if (!usingPostgres) {
    const saved = {
      id: memoryCreators.length + 1, signed_up_at: new Date(), welcomed_at: null,
      stripe_account_id: '', payout_link_token: '', payout_link_sent_at: null, payout_ready_at: null,
      ...row
    };
    memoryCreators.push({ ...saved, email: row.email, code: row.code });
    return rowToCreator(saved);
  }
  const { rows } = await pool.query(
    `INSERT INTO creators (code, name, email, platform, handle, followers, rate_percent,
                           promo_id, free_code, free_promo_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [row.code, row.name, row.email, row.platform, row.handle, row.followers, row.rate_percent,
     row.promo_id, row.free_code, row.free_promo_id]
  );
  return rowToCreator(rows[0]);
}

async function markCreatorWelcomed(id) {
  if (!usingPostgres) {
    const c = memoryCreators.find((x) => x.id === Number(id));
    if (c) c.welcomed_at = new Date();
    return;
  }
  await pool.query('UPDATE creators SET welcomed_at = NOW() WHERE id = $1', [Number(id)]);
}

async function setCreatorStripeAccount(id, stripeAccountId, payoutLinkToken) {
  if (!usingPostgres) {
    const c = memoryCreators.find((x) => x.id === Number(id));
    if (c) { c.stripe_account_id = String(stripeAccountId); c.payout_link_token = String(payoutLinkToken); }
    return;
  }
  await pool.query(
    'UPDATE creators SET stripe_account_id = $2, payout_link_token = $3 WHERE id = $1',
    [Number(id), String(stripeAccountId), String(payoutLinkToken)]
  );
}

async function markPayoutLinkSent(id) {
  if (!usingPostgres) {
    const c = memoryCreators.find((x) => x.id === Number(id));
    if (c) c.payout_link_sent_at = new Date();
    return;
  }
  await pool.query('UPDATE creators SET payout_link_sent_at = NOW() WHERE id = $1', [Number(id)]);
}

// Stripe sends account.updated for every change to an account, and retries
// any it thinks we missed, so this sees the same account many times. COALESCE
// keeps the first moment it was ready rather than the latest echo of it.
// True if the account is one of ours.
async function markPayoutReady(stripeAccountId) {
  const wanted = String(stripeAccountId || '');
  if (!wanted) return false;
  if (!usingPostgres) {
    const c = memoryCreators.find((x) => x.stripe_account_id === wanted);
    if (c && !c.payout_ready_at) c.payout_ready_at = new Date();
    return Boolean(c);
  }
  const { rowCount } = await pool.query(
    'UPDATE creators SET payout_ready_at = COALESCE(payout_ready_at, NOW()) WHERE stripe_account_id = $1',
    [wanted]
  );
  return rowCount > 0;
}

// The one read that hands back the token, because it is the one that is
// looked up BY it. The empty string is refused before it reaches the query:
// every creator without a link has '' in that column, and '' matching one of
// them at random would open somebody's payout page to anybody.
async function getCreatorByPayoutToken(token) {
  const wanted = String(token || '');
  if (!/^[0-9a-f]{48}$/.test(wanted)) return null;
  const row = usingPostgres
    ? (await pool.query('SELECT * FROM creators WHERE payout_link_token = $1', [wanted])).rows[0]
    : memoryCreators.find((c) => c.payout_link_token === wanted);
  if (!row) return null;
  return { ...rowToCreator(row), payoutLinkToken: row.payout_link_token };
}

async function listCreators() {
  if (!usingPostgres) return memoryCreators.map(rowToCreator);
  const { rows } = await pool.query('SELECT * FROM creators ORDER BY id DESC');
  return rows.map(rowToCreator);
}

// True for whoever gets there first, false for everybody else, forever. The
// caller only sends when it is true.
async function claimJobRun(job, ranFor) {
  if (!usingPostgres) {
    const key = `${job}|${ranFor}`;
    if (memoryJobRuns.has(key)) return false;
    memoryJobRuns.add(key);
    return true;
  }
  const { rows } = await pool.query(
    `INSERT INTO job_runs (job, ran_for) VALUES ($1, $2)
       ON CONFLICT (job, ran_for) DO NOTHING
     RETURNING ran_at`,
    [job, ranFor]
  );
  return rows.length > 0;
}

module.exports = {
  // Scripts that need raw SQL (scripts/reencode-pages.js) reach the pool here.
  // Null when running on the in-memory store, which those scripts check for.
  get pool() { return pool; },
  usingPostgres,
  takePreviewQuota,
  refundPreviewQuota,
  purgeOldPreviewQuota,
  takeSignupQuota,
  claimJobRun,
  getCreatorByEmail,
  codeTaken,
  saveCreator,
  markCreatorWelcomed,
  listCreators,
  setCreatorStripeAccount,
  markPayoutLinkSent,
  markPayoutReady,
  getCreatorByPayoutToken,
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
  markPreviewRescue,
  rescuablePreviews,
  notePreviewAttempt,
  claimPreviewEmail,
  releasePreviewEmail,
  bumpRenderAttempts,
  backdateLastAttempt,
  savePage,
  listPages,
  saveBookPdf,
  getBookPdf,
  getAlerts,
  saveAlert,
  clearAlert,
  recordAction,
  countActionsSince,
  countActionsForOrder,
  recentActions,
  databaseSizeBytes,
  ordersNeedingAttention,
  markReadyEmailSent,
  markReadyEmailFailed,
  emailRecordingSince,
  dayTotals,
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
