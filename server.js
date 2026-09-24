require('dotenv').config();
const sharp = require('sharp');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const db = require('./db');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mailer = require('./mailer');
const mirrorGuard = require('./mirror-guard');
const { buildBookPdf, pdfFileName } = require('./pdf');
const watchdog = require('./watchdog');
const { main: affiliateReport } = require('./scripts/affiliate-report.js');
const neon = require('./neon');
const textGuard = require('./text-guard');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors());
// Render sits behind a proxy. Without this every request looks like it comes
// from the same address and a per-visitor limit would lock out the whole world.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_CENTS = parseInt(process.env.PRICE_CENTS, 10) || 1500;
// A family book is the same fifteen pages but several photos and a harder job,
// so it carries its own price: $25 against $15 for a single subject.
// FAMILY_PRICE_CENTS overrides it without a deploy.
const FAMILY_PRICE_CENTS = parseInt(process.env.FAMILY_PRICE_CENTS, 10) || 2500;
// What the charge is called on the customer's card statement. A charge nobody
// recognises is a chargeback, and this Stripe account is managed under Bluevine
// and offers no descriptor field in its dashboard, so per-session is the only
// place it can be set at all.
//
// Stripe APPENDS this to the account's own descriptor prefix rather than
// replacing it, and prefix and suffix together must fit 22 characters. We
// cannot see this account's prefix, so a suffix that fits today may be refused
// after Bluevine changes theirs - hence the env override, and hence /checkout
// falling back to a session without it rather than failing the sale.
const STATEMENT_DESCRIPTOR_SUFFIX = process.env.STATEMENT_DESCRIPTOR_SUFFIX || 'STORYBOOKYOU';
// Above this, the finished book is emailed as a link only. Gmail refuses an
// attachment over 25MB and Outlook over 20, and base64 adds about a third on
// the wire, so 8MB of PDF (~10.7MB sent) clears both with room to spare. A
// 15-page book comes out under 1MB, so this is a guard, not a limit.
const MAX_ATTACHMENT_BYTES = parseInt(process.env.MAX_ATTACHMENT_BYTES, 10) || 8 * 1024 * 1024;
// How many pages to draw at the same time. One at a time meant ~37s x 15 pages,
// nearly ten minutes of waiting. Raise carefully: too many at once and OpenAI
// starts rate limiting, which shows up as failed pages.
const RENDER_CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY, 10) || 4;
// How many whole books may be drawn at the same time. Each one uses
// RENDER_CONCURRENCY lanes, so this is the real ceiling on memory and on calls
// to OpenAI. Orders past the limit are not lost - they wait, and the resume
// sweep starts them as slots free up. Busy should mean slow, never broken.
const MAX_CONCURRENT_BOOKS = parseInt(process.env.MAX_CONCURRENT_BOOKS, 10) || 7;
// OpenAI caps images per minute across the whole account (Tier 3 is 50/min).
// waitForImageSlot below is the single place that knows this, so no combination
// of the settings above can exceed it - they queue here instead of erroring.
const IMAGES_PER_MIN = parseInt(process.env.OPENAI_IMAGES_PER_MIN, 10) || 45;
// Free previews cost us real money and no one has paid yet, so they get a
// ceiling: per visitor, and across the whole site.
// Per visitor, per DAY - not per hour. An hourly window that rolls forever is
// not a limit, it is a queue: wait sixty minutes and take eight more, all day,
// for as long as you like. Nobody can steal a book that way (only scenes 1 and
// 2 are ever free) but every one of those is an image we pay OpenAI to draw.
const FREE_PREVIEWS_PER_IP = parseInt(process.env.FREE_PREVIEWS_PER_IP, 10) || 8;
// Whose midnight the day ends at. The customer's, not the server's.
const PREVIEW_DAY_TZ = process.env.PREVIEW_DAY_TZ || 'America/New_York';
const FREE_PREVIEWS_PER_HOUR = parseInt(process.env.FREE_PREVIEWS_PER_HOUR, 10) || 240;
// Where customers are sent back to after paying, and where the emailed link to
// a finished book points. Render sets SITE_URL; this default only matters if it
// ever goes missing, which is exactly when a stale one does the most damage -
// every success_url, cancel_url, terms link and book link at once.
const SITE_URL = process.env.SITE_URL || 'https://crayonauts.com';
// Scenes the visitor can generate for free before being asked to pay.
const FREE_PREVIEW_PAGES = parseInt(process.env.FREE_PREVIEW_PAGES, 10) || 2;

// Verify Stripe's signature header against the raw request body.
// Returns the parsed event, or throws. Never trust the body without this:
// anyone who learns the webhook URL could otherwise mark orders paid.
function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  if (!header) throw new Error('Missing Stripe-Signature header.');

  const parts = {};
  for (const piece of String(header).split(',')) {
    const idx = piece.indexOf('=');
    if (idx === -1) continue;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
    else parts[k] = v;
  }
  if (!parts.t || !parts.v1 || !parts.v1.length) throw new Error('Malformed Stripe-Signature header.');

  const age = Math.floor(Date.now() / 1000) - parseInt(parts.t, 10);
  if (!Number.isFinite(age) || Math.abs(age) > toleranceSeconds) {
    throw new Error('Stripe signature timestamp outside tolerance.');
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(parts.t + '.' + rawBody.toString('utf8'), 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected);

  const matched = parts.v1.some((candidate) => {
    const buf = Buffer.from(candidate);
    if (buf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(buf, expectedBuf);
  });
  if (!matched) throw new Error('Stripe signature mismatch.');

  return JSON.parse(rawBody.toString('utf8'));
}

// Mounted before express.json() on purpose — signature verification needs the
// exact bytes Stripe sent, not a re-serialised object.
app.post('/stripe/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = verifyStripeSignature(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Rejected webhook:', err.message);
    return res.status(400).send('Invalid signature.');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      // A 100% off influencer code settles the session at zero, and Stripe
      // shapes a no-cost order differently from a paid one: amount_total is 0,
      // payment_intent is null because no money moved and no PaymentIntent was
      // ever created, and payment_status reads 'no_payment_required' rather
      // than 'paid'. checkout.session.completed is the only event a free order
      // ever sends - there are no PaymentIntent events to fall back on - so
      // fulfilment has to hang off this event and must not start insisting on
      // a payment_intent or on payment_status === 'paid'. Either would hand
      // out codes that take the money to zero and then quietly deliver
      // nothing. test/free-code.test.js plays a real free order through this
      // handler and fails if that protection is lost.
      const order = await db.markPaid(session.id, session.amount_total);
      console.log(order ? `Order ${order.id} marked paid.` : `No order for session ${session.id}.`);
      // Somebody has paid. Whatever the pollers were doing, do it now.
      wakeUp();

      // Counted here rather than in the browser: this is the only place a sale
      // is certain, and it still lands even if the customer closes the tab
      // before Stripe redirects them back.
      if (order) {
        db.recordEvent({
          type: 'paid',
          visitor: order.visitor,
          source: order.source,
          campaign: order.campaign,
          orderId: order.id
        }).catch((err) => console.error('Could not record paid event:', err.message));
      }

      // Start drawing the book on the server, in the background. We deliberately
      // do NOT await it: Stripe times out webhooks in seconds, and a book takes
      // minutes. The email goes out from renderBook once pages actually exist,
      // so we never promise a book before it is real.
      if (order) {
        renderBook(order.id).catch((err) =>
          console.error(`Order ${order.id}: background render crashed -`, err.message));
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handling failed:', err);
    // 500 tells Stripe to retry, which is what we want for a transient DB error.
    res.status(500).send('Handler error.');
  }
});

app.use(express.json({ limit: '15mb' }));

// Orders are stored in Postgres (see db.js). Set DATABASE_URL and they survive
// restarts and redeploys; leave it unset and db.js falls back to memory for
// local testing only.

function requireAdmin(req, res) {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && req.query.key !== adminKey) {
    res.status(401).json({ error: 'Missing or incorrect admin key.' });
    return false;
  }
  return true;
}

app.post('/orders', async (req, res) => {
  wakeUp();
  const { childName, childCount, email, theme, notes, thumb, pageCount } = req.body || {};
  if (!childName || !email) {
    return res.status(400).json({ error: 'Missing childName or email.' });
  }
  try {
    const order = await db.saveOrder({
      childName: String(childName).slice(0, 200),
      childCount: Math.min(Math.max(parseInt(childCount, 10) || 1, 1), 3),
      email: String(email).slice(0, 320),
      theme: theme || 'Portrait',
      notes: String(notes || '').slice(0, 1000),
      thumb: thumb || null,
      pageCount: parseInt(pageCount, 10) || 0,
      // kept so the server can draw the book after payment without the browser
      photo: typeof req.body.photo === 'string' ? req.body.photo : null,
      subjectType: req.body.subjectType === 'adult' ? 'adult' : 'kid',
      // How busy the pages are. Stored with the order so a re-render months
      // later comes back the same book, not a different one.
      detailLevel: normalizeDetail(req.body.detailLevel),
      // A family book: one entry per person, each carrying their own photo.
      // Absent or a single entry and this stays an ordinary one-subject book.
      people: cleanPeople(req.body.people),
      // Remembered so the Stripe webhook can credit the sale to whatever
      // brought this person here, minutes later and on a different request.
      visitor: String(req.body.visitor || '').slice(0, 64),
      source: String(req.body.source || '').slice(0, 80),
      campaign: String(req.body.campaign || '').slice(0, 80)
    });
    // accessToken is returned exactly once, here. The browser must keep it;
    // it is what proves ownership when unlocking or re-downloading the book.
    const accessToken = order.accessToken;
    delete order.accessToken;
    res.json({ success: true, order, accessToken });
  } catch (err) {
    console.error('Failed to save order:', err);
    res.status(500).json({ error: 'Could not save the order. Please try again.' });
  }
});

app.get('/orders', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const includeThumbs = req.query.thumbs === '1';
    const orders = await db.listOrders({ limit, includeThumbs });
    res.json({ orders, count: await db.countOrders(), storage: db.usingPostgres ? 'postgres' : 'memory' });
  } catch (err) {
    console.error('Failed to list orders:', err);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// Single order, thumbnail included — for opening one order in the admin view.
app.get('/orders/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const order = await db.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order });
  } catch (err) {
    console.error('Failed to load order:', err);
    res.status(500).json({ error: 'Could not load the order.' });
  }
});

// Admin-only: proves the SMTP settings work, and shows the real SMTP error if
// they don't. Without this, a bad app password just looks like silence.
app.post('/email-test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const to = (req.body && req.body.to) || '';
  if (!to) return res.status(400).json({ error: 'Pass { "to": "you@example.com" }.' });
  if (!mailer.configured) {
    return res.status(500).json({ error: 'SMTP_USER / SMTP_PASS are not set on the server.' });
  }
  try {
    await mailer.sendMail({
      to,
      subject: 'Crayonauts test email',
      text: 'If you are reading this, order emails will work.',
      html: '<p>If you are reading this, order emails will work.</p>'
    });
    res.json({ sent: true, host: mailer.HOST, port: mailer.PORT, secure: mailer.SECURE, from: mailer.USER });
  } catch (err) {
    res.status(502).json({ sent: false, host: mailer.HOST, port: mailer.PORT, secure: mailer.SECURE, error: err.message });
  }
});

// Admin-only, irreversible. Refuses paid orders unless force=1, so a stray
// click can't wipe a record of money someone actually gave you.
app.delete('/orders/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const existing = await db.getOrder(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Order not found.' });
    if (existing.paid && req.query.force !== '1') {
      return res.status(409).json({
        error: 'That order is paid. Deleting it destroys your record of the sale. Re-send with force=1 if you are sure.'
      });
    }
    const gone = await db.deleteOrder(req.params.id);
    console.log(`Order ${req.params.id} deleted by admin (paid=${existing.paid}).`);
    res.json({ deleted: true, order: gone });
  } catch (err) {
    console.error('Delete failed:', err);
    res.status(500).json({ error: 'Could not delete that order.' });
  }
});

const ORDER_STATUSES = ['new', 'in_progress', 'delivered', 'cancelled'];

app.post('/orders/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const status = (req.body && req.body.status) || '';
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status must be one of: ' + ORDER_STATUSES.join(', ') });
  }
  try {
    const order = await db.updateOrderStatus(req.params.id, status);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ success: true, order });
  } catch (err) {
    console.error('Failed to update order:', err);
    res.status(500).json({ error: 'Could not update the order.' });
  }
});

// Turns the code from a creator's link ("JERRELL") into the promotion code id
// Stripe wants on a session ("promo_1ABC..."). Returns null for anything it
// cannot vouch for, which is the signal to fall back to the typing box.
//
// Deliberately forgiving about the code itself and unforgiving about the
// answer: codes get typed into ad captions by hand, so case and stray spaces
// are fixed here, but only an active code that came back from Stripe is used.
// Stripe matches `code` exactly, so the upper-casing matters - codes are
// created upper-case in the dashboard.
async function resolvePromotionCode(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted || wanted.length > 64 || !/^[A-Z0-9_-]+$/.test(wanted)) return null;
  if (!STRIPE_SECRET_KEY) return null;
  try {
    const url = new URL('https://api.stripe.com/v1/promotion_codes');
    url.searchParams.set('code', wanted);
    url.searchParams.set('active', 'true');
    url.searchParams.set('limit', '1');
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } });
    if (!resp.ok) return null;
    const body = await resp.json();
    const found = Array.isArray(body.data) ? body.data[0] : null;
    // active is checked again rather than trusted from the query: a filter that
    // silently stopped filtering would quietly start honouring dead codes.
    return found && found.active && found.id ? found.id : null;
  } catch (err) {
    // A creator losing attribution is bad. A checkout that will not open
    // because Stripe was slow answering a side question is worse.
    console.error('Could not resolve promotion code:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Creators
//
// A creator's code carries NO discount. It hangs off the `creatortrack`
// coupon, which is 0.01% off - small enough to round to nothing on any price
// we sell, and the smallest number Stripe will accept, because Stripe has no
// zero-discount coupon and a promotion code must hang off some coupon. The
// code exists to put the creator's name on the sale, not to cut the price.
//
// That is also why this endpoint can be open to the public. Somebody spamming
// the form gains nothing - there is no discount to harvest - so the only cost
// of abuse is junk promotion codes cluttering Stripe, which the per-visitor
// cap below keeps to a nuisance rather than a problem.
const CREATOR_COUPON = process.env.CREATOR_COUPON || 'creatortrack';
// 20, not 25. Jerrell negotiated 25 and is the only one on it; every creator
// who signs up through the form is on 20, which is what the payout report has
// always defaulted to. Setting this to 25 would quietly promise every new
// creator a rate the Thursday report does not pay them, and the first anyone
// would hear of it is a creator who counted.
const CREATOR_RATE_PERCENT = parseInt(process.env.CREATOR_RATE_PERCENT, 10) || 20;
// One a day per visitor, not three. That number was set when a creator code
// was worth nothing to steal - it carries no discount. The free book below
// changes that: every sign-up now mints a real 100%-off code, so a sign-up is
// worth an actual book, and the form has to be rationed like one.
const CREATOR_SIGNUPS_PER_IP = parseInt(process.env.CREATOR_SIGNUPS_PER_IP, 10) || 1;

// The free book the proposal leads with. Without this a creator's first
// experience is noticing that the thing they were promised did not arrive.
// One use, no expiry - "no strings" is what the proposal says, and a code
// that quietly dies is a string.
const CREATOR_FREE_COUPON = process.env.CREATOR_FREE_COUPON || 'freebook100';
// A ceiling across everybody, because the per-visitor cap is per visitor and
// addresses are cheap. This is the number of free books the form can give away
// in a day no matter who asks. Sign-ups past it still work and still get their
// tracking code; they just do not get a free book, and the log says who.
const CREATOR_FREE_BOOKS_PER_DAY = parseInt(process.env.CREATOR_FREE_BOOKS_PER_DAY, 10) || 10;
// The three mailboxes do three jobs and must not bleed into each other.
// support@ belongs to customers - a parent whose book has not arrived. admin@
// sets creators up. accounts@ is what they get paid. The welcome mail goes out
// as admin@ so a creator's reply lands with creator setup and not in the queue
// a worried parent is waiting in.
const CREATOR_MAIL_FROM = process.env.CREATOR_MAIL_FROM || 'admin@crayonauts.com';

// Stripe matches promotion codes exactly, and the site upper-cases whatever a
// customer types, so a code has to be A-Z and digits with nothing else in it.
// Accents, spaces and punctuation are stripped rather than rejected: somebody
// called "José Peña" should get JOSEPENA, not an error message.
function cleanCreatorCode(raw) {
  return String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
}

// Reserved so a creator can never be handed a code that means something else
// to the checkout - FREE- and OWNER- are the free-book codes.
function reservedCreatorCode(code) {
  return /^(FREE|OWNER|TEST|ADMIN|CRAYONAUTS)/.test(code);
}

// Picks a code nobody is using. Tries their choice first, because a creator
// who asked for one and got JERRELL2 will use JERRELL2 and mean JERRELL.
async function freeCreatorCode(wanted) {
  const base = cleanCreatorCode(wanted);
  if (base.length >= 3 && !reservedCreatorCode(base) && !(await db.codeTaken(base))
      && !(await resolvePromotionCode(base))) {
    return base;
  }
  const stem = (base.length >= 3 ? base : 'CREATOR').slice(0, 14);
  for (let i = 0; i < 12; i++) {
    const suffix = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase();
    const candidate = stem + suffix;
    if (candidate.length < 4 || reservedCreatorCode(candidate)) continue;
    if (await db.codeTaken(candidate)) continue;
    if (await resolvePromotionCode(candidate)) continue;
    return candidate;
  }
  return null;
}

// FREE-XXXXXX, matching the codes already in the dashboard so a free book code
// is recognisable at a glance as one. Six characters rather than the four the
// hand-made ones use: these are minted without anyone watching, and a
// collision here hands two people the same single-use code, where the first to
// spend it takes the other's book.
function freeBookCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return 'FREE-' + out;
}

// Best effort on purpose. If Stripe will not mint the free code, the creator
// still gets their tracking code and their link - the part that earns them
// money - and free_code stays empty, which is what tells somebody to send one
// by hand. Failing the whole sign-up over a free book would be the wrong way
// round.
async function mintFreeBookCode({ name, email }) {
  if (!STRIPE_SECRET_KEY) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = freeBookCode();
    if (await resolvePromotionCode(code)) continue;
    try {
      const form = new URLSearchParams();
      form.append('promotion[type]', 'coupon');
      form.append('promotion[coupon]', CREATOR_FREE_COUPON);
      form.append('code', code);
      form.append('max_redemptions', '1');
      form.append('metadata[purpose]', 'creator free book');
      form.append('metadata[creator_name]', name);
      form.append('metadata[creator_email]', email);
      const resp = await fetch('https://api.stripe.com/v1/promotion_codes', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form
      });
      const body = await resp.json();
      if (resp.ok && body.id) return { code, promoId: body.id };
      console.error('Stripe refused a free book code:', body && body.error && body.error.message);
      return null;
    } catch (err) {
      console.error('Could not mint a free book code:', err.message);
      return null;
    }
  }
  return null;
}

// Good enough to catch a typo, deliberately not RFC 5322. A creator who gets
// this wrong never receives their code, so the cost of being slightly strict
// is a form they retype and the cost of being loose is silence.
function looksLikeEmail(v) {
  const e = String(v || '').trim();
  return e.length >= 5 && e.length <= 254 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(e);
}

app.post('/creators', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const platform = String(req.body.platform || '').trim().slice(0, 40);
  const handle = String(req.body.handle || '').trim().slice(0, 80);
  const followers = String(req.body.followers || '').trim().slice(0, 40);

  if (name.length < 2) return res.status(400).json({ error: 'Tell us your name.' });
  if (!looksLikeEmail(email)) return res.status(400).json({ error: 'That email does not look right.' });
  if (handle.length < 2) return res.status(400).json({ error: 'Tell us where you post.' });

  // Signing up twice returns the code they already have. This is checked before
  // the quota so that somebody who fills the form again - the commonest reason
  // being that they lost the email - is helped rather than throttled.
  try {
    const existing = await db.getCreatorByEmail(email);
    if (existing) {
      return res.json({
        code: existing.code,
        link: SITE_URL + '?c=' + encodeURIComponent(existing.code.toLowerCase()),
        ratePercent: existing.ratePercent,
        // Their own free code, not a new one. Somebody back here because they
        // lost the email must not be handed a second free book.
        freeCode: existing.freeCode || '',
        alreadySignedUp: true
      });
    }
  } catch (err) {
    console.error('Could not look up creator:', err.message);
    return res.status(500).json({ error: 'Could not sign you up just now. Try again in a minute.' });
  }

  try {
    const quota = await db.takeSignupQuota(clientIp(req), previewDay(), CREATOR_SIGNUPS_PER_IP);
    if (!quota.allowed) {
      return res.status(429).json({ error: 'That is enough sign-ups from here today. Email support@crayonauts.com.' });
    }
  } catch (err) {
    // Fail closed, unlike the preview quota. A preview that is refused costs a
    // sale; a sign-up that is refused costs a minute. The asymmetry runs the
    // other way here, so when the counter is broken nobody gets a code.
    console.error('Could not count creator sign-ups:', err.message);
    return res.status(503).json({ error: 'Could not sign you up just now. Try again in a minute.' });
  }

  if (!STRIPE_SECRET_KEY) {
    console.error('Creator sign-up attempted with no Stripe key.');
    return res.status(503).json({ error: 'Could not sign you up just now. Try again in a minute.' });
  }

  const code = await freeCreatorCode(req.body.codeWord || name);
  if (!code) {
    console.error('Could not find a free creator code for', email);
    return res.status(503).json({ error: 'Could not sign you up just now. Try again in a minute.' });
  }

  // Stripe first, database second. A code that exists in Stripe with no row
  // here is an orphan somebody has to tidy up; a row here with no code in
  // Stripe is a creator whose link silently does nothing, which is worse.
  let promoId = '';
  try {
    const form = new URLSearchParams();
    // Stripe's current API nests this. The older, flatter `coupon=` is not
    // deprecated-but-working - it is rejected outright with "Received unknown
    // parameter: coupon", which reads like a permissions problem and is not.
    // The same move is why a promotion code now reports its coupon under
    // `promotion.coupon` and has `coupon: null` at the top level.
    form.append('promotion[type]', 'coupon');
    form.append('promotion[coupon]', CREATOR_COUPON);
    form.append('code', code);
    form.append('metadata[creator_name]', name);
    form.append('metadata[creator_email]', email);
    form.append('metadata[rate_percent]', String(CREATOR_RATE_PERCENT));
    const resp = await fetch('https://api.stripe.com/v1/promotion_codes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });
    const body = await resp.json();
    if (!resp.ok || !body.id) {
      console.error('Stripe refused the creator code:', body && body.error && body.error.message);
      return res.status(502).json({ error: 'Could not sign you up just now. Try again in a minute.' });
    }
    promoId = body.id;
  } catch (err) {
    console.error('Could not create the creator code:', err.message);
    return res.status(502).json({ error: 'Could not sign you up just now. Try again in a minute.' });
  }

  // The day's ceiling on free books, counted under a key no visitor can be.
  // A sign-up past it is still a sign-up - they keep their tracking code.
  let free = null;
  try {
    const room = await db.takeSignupQuota('*free-books*', previewDay(), CREATOR_FREE_BOOKS_PER_DAY);
    if (room.allowed) free = await mintFreeBookCode({ name, email });
    else console.warn('Free book ceiling reached for today; ' + code + ' signed up without one.');
  } catch (err) {
    console.error('Could not count free books, skipping this one -', err.message);
  }
  if (!free) console.warn('Creator ' + code + ' has no free book code. Send one by hand.');

  let creator;
  try {
    creator = await db.saveCreator({
      code, name, email, platform, handle, followers,
      ratePercent: CREATOR_RATE_PERCENT, promoId,
      freeCode: free ? free.code : '', freePromoId: free ? free.promoId : ''
    });
  } catch (err) {
    console.error('Could not save creator:', err.message);
    return res.status(500).json({ error: 'Could not sign you up just now. Try again in a minute.' });
  }

  const link = SITE_URL + '?c=' + encodeURIComponent(code.toLowerCase());

  // The reply does not wait on the email. They are looking at their code on
  // the page already; a slow mail server must not make the form look broken.
  res.json({
    code, link, ratePercent: CREATOR_RATE_PERCENT,
    freeCode: free ? free.code : '',
    alreadySignedUp: false
  });

  if (!mailer.configured) {
    console.warn('No mailer configured - creator ' + code + ' got no welcome email.');
    return;
  }
  try {
    const mail = mailer.creatorWelcomeEmail({
      name, code, siteUrl: SITE_URL, ratePercent: CREATOR_RATE_PERCENT,
      freeCode: free ? free.code : ''
    });
    await mailer.sendMail({
      to: email, subject: mail.subject, text: mail.text, html: mail.html,
      from: CREATOR_MAIL_FROM, replyTo: CREATOR_MAIL_FROM
    });
    await db.markCreatorWelcomed(creator.id);
    console.log('Creator ' + code + ' signed up and welcomed.');
  } catch (err) {
    // Not fatal: the code exists, the page showed it, and welcomed_at staying
    // null is the record that somebody needs to resend it.
    console.error('Creator ' + code + ' has no welcome email:', err.message);
  }
});

// How each creator's code has actually done. Signing somebody up and somebody
// selling for you are two different things, and until this existed the list
// could not tell them apart - four names, four codes, and no way to see that
// none of them had sold anything yet.
//
// Sales come from Stripe's own redemption counter on the promotion code, which
// is one request for every code we have and cannot drift out of step with a
// page limit. Revenue has to be added up from the sessions themselves, because
// Stripe counts redemptions but does not total them, so that part is paginated
// and says so when it gives up rather than quietly reporting a short number.
//
// This is the at-a-glance view, not the payroll. What is actually owed on a
// given week comes from scripts/affiliate-report.js, which knows about pay
// periods, per-creator rates and which Friday a sale belongs to. Two places
// computing money would eventually disagree, and the one that pays people has
// to be the one that is right.

// Five minutes. The admin page gets opened, read and left open, and every
// reload would otherwise walk every checkout session Stripe has. Set to 0
// to recompute every time, which is what the tests do.
const SALES_CACHE_MS = process.env.CREATOR_SALES_CACHE_MS !== undefined
  ? Math.max(0, parseInt(process.env.CREATOR_SALES_CACHE_MS, 10) || 0)
  : 5 * 60 * 1000;
const SESSION_PAGE_CAP = 10;          // 1000 sessions, then say it was capped
let salesCache = { at: 0, value: null };

async function stripeList(path, params) {
  const url = new URL('https://api.stripe.com/v1' + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` }
  });
  if (!resp.ok) throw new Error('Stripe said ' + resp.status + ' for ' + path);
  return resp.json();
}

async function creatorSales() {
  if (!STRIPE_SECRET_KEY) return { available: false, byPromoId: {}, complete: true };
  const now = Date.now();
  if (salesCache.value && now - salesCache.at < SALES_CACHE_MS) return salesCache.value;

  const byPromoId = {};
  const bump = (id) => (byPromoId[id] = byPromoId[id] || { sales: 0, revenueCents: 0 });

  // Every promotion code, with the count Stripe keeps itself.
  let startingAfter = null;
  for (let page = 0; page < SESSION_PAGE_CAP; page++) {
    const params = { limit: '100' };
    if (startingAfter) params.starting_after = startingAfter;
    const body = await stripeList('/promotion_codes', params);
    for (const code of body.data || []) bump(code.id).sales = code.times_redeemed || 0;
    if (!body.has_more || !body.data.length) break;
    startingAfter = body.data[body.data.length - 1].id;
  }

  // What those redemptions were worth. Only sessions that were actually paid
  // count: an abandoned checkout carries the code too, and paying a creator
  // for a browser tab somebody closed is not a mistake you find quickly.
  let complete = true;
  startingAfter = null;
  for (let page = 0; ; page++) {
    if (page >= SESSION_PAGE_CAP) { complete = false; break; }
    const params = { limit: '100', 'expand[]': 'data.discounts.promotion_code' };
    if (startingAfter) params.starting_after = startingAfter;
    const body = await stripeList('/checkout/sessions', params);
    for (const session of body.data || []) {
      if (session.payment_status !== 'paid') continue;
      for (const d of Array.isArray(session.discounts) ? session.discounts : []) {
        const id = typeof d.promotion_code === 'string'
          ? d.promotion_code
          : (d.promotion_code && d.promotion_code.id) || '';
        if (!id) continue;
        bump(id).revenueCents += session.amount_total || 0;
      }
    }
    if (!body.has_more || !body.data.length) break;
    startingAfter = body.data[body.data.length - 1].id;
  }

  const value = { available: true, byPromoId, complete };
  salesCache = { at: now, value };
  return value;
}

// Who has signed up, for Jonathan. Includes whether the welcome email went,
// because a creator who never got theirs looks identical to one who did until
// somebody checks - and now how much each of them has actually sold.
app.get('/creators', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const creators = await db.listCreators();
    let sales = { available: false, byPromoId: {}, complete: true };
    try {
      sales = await creatorSales();
    } catch (err) {
      // The list is the thing being asked for. Stripe being slow or cross must
      // not turn a page of names into an error page.
      console.error('Could not load creator sales:', err.message);
    }
    res.json({
      creators: creators.map((c) => {
        const paid = sales.byPromoId[c.promoId] || null;
        const free = sales.byPromoId[c.freePromoId] || null;
        return {
          ...c,
          sales: sales.available && paid ? paid.sales : (sales.available ? 0 : null),
          revenueCents: sales.available && paid ? paid.revenueCents : (sales.available ? 0 : null),
          freeBookUsed: sales.available ? Boolean(free && free.sales) : null
        };
      }),
      salesComplete: sales.available ? sales.complete : null
    });
  } catch (err) {
    console.error('Could not list creators:', err.message);
    res.status(500).json({ error: 'Could not load creators.' });
  }
});

// Creates a Stripe Checkout Session for an order and returns the URL to send
// the customer to. Called with the order id and the access token we handed the
// browser when the order was created.
app.post('/checkout', async (req, res) => {
  const { orderId, token, product, code } = req.body || {};
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Payments are not configured on the server.' });
  }

  try {
    const order = await db.authorizeOrder(orderId, token);
    if (!order) return res.status(403).json({ error: 'Unknown order or bad token.' });
    if (order.paid) return res.status(409).json({ error: 'This order is already paid.' });

    const isPrint = product === 'print';
    const isFamily = Array.isArray(order.people) && order.people.length > 1;
    const base = isFamily ? FAMILY_PRICE_CENTS : PRICE_CENTS;
    const amount = isPrint ? base + 2000 : base;
    const kind = isFamily ? 'Personalized family coloring book' : 'Personalized coloring book';
    const label = isPrint ? `${kind} - printed copy` : `${kind} - digital PDF`;

    // Stripe's API takes form-encoded bodies, not JSON.
    const form = new URLSearchParams();
    form.append('mode', 'payment');
    // The amount rides back on the return URL so the browser can report the
    // real value of the sale to the ad pixel. A discount code can make what
    // Stripe actually charges lower than this - the pixel is for measuring
    // which ads produce sales, not for the books, which are Stripe's number.
    form.append('success_url', `${SITE_URL}?paid=1&order=${order.id}&amt=${(amount / 100).toFixed(2)}`);
    form.append('cancel_url', `${SITE_URL}?canceled=1&order=${order.id}`);
    form.append('client_reference_id', String(order.id));
    if (order.email) form.append('customer_email', order.email);
    form.append('line_items[0][quantity]', '1');
    form.append('line_items[0][price_data][currency]', 'usd');
    form.append('line_items[0][price_data][unit_amount]', String(amount));
    form.append('line_items[0][price_data][product_data][name]', label);
    form.append('line_items[0][price_data][product_data][description]',
      `${order.pageCount || 15} pages starring ${order.childName}`);
    if (isPrint) form.append('shipping_address_collection[allowed_countries][0]', 'US');

    // Creator codes. The codes live in the Stripe dashboard, one per creator,
    // and the code on the session IS the attribution - Stripe reports sales per
    // promotion code, so there is no affiliate software to run.
    //
    // There are two ways one gets onto a session, and they are mutually
    // exclusive - Stripe rejects a session that sets both:
    //
    //   allow_promotion_codes  Stripe shows a box and the customer types it.
    //   discounts[]            we attach it, and there is no box.
    //
    // A creator posting a link is the whole reason for the second one. A
    // customer who followed jerrell's link has already "used" his code by
    // clicking it; asking them to also type it loses most of the attribution,
    // because most people will not.
    //
    // The lookup is what makes this safe to feed from a URL: an unknown,
    // expired or deactivated code resolves to nothing and the customer simply
    // gets the ordinary typing box. A bad link can cost a creator their
    // commission, but it can never stop a sale.
    //
    // This has to be settled before the consent copy below is taken, or only
    // one of the two sessions carries it and the box disappears on whichever
    // path was missed.
    const promoId = await resolvePromotionCode(code);
    if (promoId) form.append('discounts[0][promotion_code]', promoId);
    else form.append('allow_promotion_codes', 'true');

    // Make the customer tick a box agreeing to immediate delivery before paying.
    // Stripe records the acceptance against the payment, which is the evidence
    // that matters if anyone later disputes the charge. It needs a terms URL set
    // in Stripe's public business details, so if that is missing Stripe rejects
    // the whole session - see the retry below.
    const consent = new URLSearchParams(form);
    consent.append('consent_collection[terms_of_service]', 'required');
    consent.append('custom_text[terms_of_service_acceptance][message]',
      'Your book starts being drawn as soon as you pay. I agree to the '
      + '[terms](' + SITE_URL.replace(/\/+$/, '') + '/legal.html#terms)'
      + ' and to immediate delivery.');

    // Layered on rather than appended to `form`, so that there is still a body
    // without it to fall back to. Stripe refuses the suffix outright on an
    // account with no descriptor prefix set, and refuses it again if prefix and
    // suffix together run past 22 characters - neither of which we can see from
    // here, and neither of which is worth losing a sale over.
    const withDescriptor = (params) => {
      const copy = new URLSearchParams(params);
      copy.append('payment_intent_data[statement_descriptor_suffix]', STATEMENT_DESCRIPTOR_SUFFIX);
      return copy;
    };

    async function createSession(body) {
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      });
      return { ok: resp.ok, body: await resp.json() };
    }

    // Best first, dropping one refusable thing per rung. None of them changes
    // what the customer is charged or whether the promotion code box appears,
    // so falling down this ladder costs evidence or recognition, never money.
    // Consent outranks the descriptor: it is what settles a chargeback, where
    // the descriptor only makes one less likely.
    //
    // The extra calls only happen once a session has already been refused, so
    // an ordinary sale is still a single request.
    const attempts = [
      { what: 'the consent box and the card descriptor', has: ['consent', 'descriptor'], body: withDescriptor(consent) },
      { what: 'the consent box alone', has: ['consent'], body: consent },
      { what: 'the card descriptor alone', has: ['descriptor'], body: withDescriptor(form) },
      { what: 'neither', has: [], body: form }
    ];

    // Stripe names what it objected to, so a rung still carrying something it
    // has already refused is skipped rather than sent. Skipped, never stopped:
    // a refusal we cannot read the reason for walks the whole ladder down to a
    // plain session, because a wasted request costs nothing next to a customer
    // who cannot pay.
    const refused = new Set();
    let r;
    let used = '';
    for (const attempt of attempts) {
      if (attempt.has.some((feature) => refused.has(feature))) continue;
      r = await createSession(attempt.body);
      if (r.ok) { used = attempt.what; break; }
      const err = (r.body && r.body.error) || {};
      const blame = `${err.param || ''} ${err.message || ''}`.toLowerCase();
      if (blame.includes('consent') || blame.includes('terms')) refused.add('consent');
      if (blame.includes('descriptor')) refused.add('descriptor');
      // Logged in full. A descriptor quietly dropped from every sale is
      // invisible until someone disputes a charge they did not recognise.
      console.error(`Stripe refused a checkout session carrying ${attempt.what}:`,
        err.message || r.body);
    }
    if (r.ok && used !== attempts[0].what) {
      console.error(`Checkout fell back to ${used}. This is not meant to be the`
        + ' normal path - fix the cause above rather than leaving it here.');
    }
    const session = r.body;
    if (!r.ok) {
      console.error('Stripe error:', session);
      const msg = (session.error && session.error.message) || 'Stripe rejected the request.';
      return res.status(502).json({ error: 'Could not start checkout.', detail: msg });
    }

    await db.attachCheckoutSession(order.id, session.id, amount);
    res.json({ url: session.url, amountCents: amount });
  } catch (err) {
    console.error('Checkout failed:', err);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

// Lets the browser poll after returning from Stripe, and re-open a finished
// book later. Requires the access token, so one customer can't read another's.
app.get('/orders/:id/access', async (req, res) => {
  try {
    const order = await db.authorizeOrder(req.params.id, req.query.token);
    if (!order) return res.status(403).json({ error: 'Unknown order or bad token.' });
    // childName and theme are here so an emailed recovery link can rebuild the
    // PDF on a device that never had this order in local storage.
    //
    // email and peopleCount are for the waiting page: it tells the customer
    // they can close the tab, and people only believe that if it reads their
    // own address back to them. peopleCount picks the wait to quote, because a
    // family page takes about half as long again as a single one. Both come
    // from here rather than the browser so an emailed link on a different
    // device says the same thing. The access token was sent to this address,
    // so showing it back to whoever holds the token tells them nothing new.
    res.json({
      id: order.id,
      paid: order.paid,
      status: order.status,
      product: order.product,
      childName: order.childName,
      email: order.email,
      peopleCount: Array.isArray(order.people) ? order.people.length : 0,
      theme: order.theme,
      pageCount: order.pageCount,
      generationStatus: order.generationStatus,
      pagesReady: await db.countPages(order.id),
      freePreviewPages: FREE_PREVIEW_PAGES
    });
  } catch (err) {
    console.error('Access check failed:', err);
    res.status(500).json({ error: 'Could not load the order.' });
  }
});

// The finished book. Built once when the last page lands and kept, so the copy
// attached to the email and the copy behind the download link are the same
// file. Orders that finished before this existed have nothing stored, so the
// first download builds it and stores it then.
async function bookPdf(order) {
  const stored = await db.getBookPdf(order.id);
  if (stored && stored.length) return Buffer.from(stored);

  const pages = await db.listPages(order.id);
  if (!pages.length) throw new Error('that order has no pages to build a book from');

  const pdf = await buildBookPdf({
    childName: order.childName,
    theme: order.theme,
    pages
  });
  // Storing is a convenience, not the point: a book that cannot be cached is
  // still a book, so a failure here must not lose the file we just built.
  try {
    await db.saveBookPdf(order.id, pdf);
  } catch (err) {
    console.error(`Order ${order.id}: built the PDF but could not store it - ${err.message}`);
  }
  return pdf;
}

// The "your book is ready" email, with the book on it when it will fit.
//
// pdf may be null - the build can fail, and when it does the customer still
// gets the email and the link. Delivery is what matters; the attachment is a
// convenience on top of it.
async function emailBookReady({ order, pdf, pageCount }) {
  const msg = mailer.orderReadyEmail({
    childName: order.childName,
    orderId: order.id,
    accessToken: order.accessToken,
    siteUrl: SITE_URL,
    pageCount
  });

  // Attach the book unless it is big enough to bounce. Gmail refuses over 25MB
  // and Outlook over 20, and base64 adds about a third on the wire, so the cap
  // sits on the raw file with room to spare. An email that arrives carrying
  // only a link beats one that never arrives at all.
  const attachments = [];
  if (pdf && pdf.length <= MAX_ATTACHMENT_BYTES) {
    attachments.push({
      filename: pdfFileName(order.childName),
      contentType: 'application/pdf',
      content: pdf
    });
  } else if (pdf) {
    console.error(`Order ${order.id}: PDF is ${(pdf.length / 1048576).toFixed(2)}MB, over the `
      + `${(MAX_ATTACHMENT_BYTES / 1048576).toFixed(0)}MB cap - emailing the link only.`);
  }

  await mailer.sendMail({
    to: order.email, subject: msg.subject, text: msg.text, html: msg.html, attachments
  });
  await db.markReadyEmailSent(order.id);
  console.log(`Order ${order.id}: ready-email sent${attachments.length ? ' with the book attached' : ' (link only)'}.`);
  return { attached: attachments.length > 0 };
}

// The finished book as one file. Same PDF the email carries, so a customer who
// lost the attachment and a customer who never got one end up with the same
// thing.
app.get('/orders/:id/book.pdf', async (req, res) => {
  try {
    const order = await db.authorizeOrder(req.params.id, req.query.token);
    if (!order) return res.status(403).json({ error: 'Unknown order or bad token.' });
    if (!order.paid) return res.status(402).json({ error: 'This order has not been paid for.' });

    const pdf = await bookPdf(order);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Content-Disposition',
      'attachment; filename="' + pdfFileName(order.childName) + '"');
    res.send(pdf);
  } catch (err) {
    console.error('Could not serve the book PDF:', err);
    res.status(500).json({ error: 'Could not build the book.' });
  }
});

// Every page generated for a paid order, so the customer can rebuild the PDF
// without us paying OpenAI to redraw anything.
app.get('/orders/:id/pages', async (req, res) => {
  try {
    const order = await db.authorizeOrder(req.params.id, req.query.token);
    if (!order) return res.status(403).json({ error: 'Unknown order or bad token.' });
    if (!order.paid) return res.status(402).json({ error: 'This order has not been paid for.' });
    res.json({ pages: await db.listPages(order.id) });
  } catch (err) {
    console.error('Page fetch failed:', err);
    res.status(500).json({ error: 'Could not load the pages.' });
  }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Some places hand the key to the outbound proxy rather than to us: the
// credential is attached to requests for api.openai.com on the way out and
// never appears in the environment, so there is nothing here to read and
// nothing to check. A missing key is only a misconfiguration when there is no
// such proxy in front of us - on Render there is not, and it should still say
// so loudly rather than fail one page at a time.
const KEY_FROM_PROXY = !OPENAI_API_KEY && !!(process.env.HTTPS_PROXY || process.env.https_proxy);
const CAN_CALL_OPENAI = Boolean(OPENAI_API_KEY) || KEY_FROM_PROXY;
if (!CAN_CALL_OPENAI) {
  console.warn('Warning: OPENAI_API_KEY is not set. Add it as an environment variable before deploying.');
} else if (KEY_FROM_PROXY) {
  console.log('OpenAI key comes from the outbound proxy, not the environment.');
}

// Two failures this line has already met, and the wording of each is the scar.
//
// "stippling or any field of small dots" is in the hair clause and not only the
// beard one. The original banned solid black, scribbles and crosshatching -
// stippling is none of those. It is separate dots, it slipped past every word
// in that list, and it produced exactly the grey the sentence exists to
// prevent. Same gap wherever hair appears, so it is closed in both places.
//
// "a field of small dots", never "dots": freckles are dots, they are wanted,
// and they are all over the sample pages. This bans the mass, not the mark.
//
// "A dense curtain of many fine parallel strands" is the third failure this
// sentence has met, and it is named for the same reason stippling is: the list
// only stops what it can name. "A few strands" was already there and was being
// read as a few hundred, so the count is not what was missing - the spacing
// was. Hence "well separated, with plenty of white showing between them",
// which is a positive instruction; the ban alone would push toward a bald head,
// and a bald head is a worse page than a busy one.
//
// The strand COUNT lives in DETAIL_LEVELS, not here, because it is the one part
// of hair that should move with the rest of the page. Simple promises large
// open areas a small child can fill, and for a while it delivered that
// everywhere except the head - a scene of four big shapes, and a hairstyle of
// two hundred lines. This sentence sets the floor for every level; each level
// then says how many strands it wants above that floor.
//
// Whoever changes this next: the regression render has to be somebody with LONG
// hair, at the SIMPLE detail level. Owen is a close crop and his hair will look
// fine however this sentence is worded, so a page of him proves nothing either
// way. set1-mom is the reference that exposes it. Simple is where an
// over-correction shows first, because that is where the model is already being
// told to leave things out.
//
//   node scripts/render-family-book.js \
//     --photos "https://crayonauts.com/samples/examples/set1-mom.png,https://crayonauts.com/samples/examples/set1-dad.png" \
//     --names "Mum,Dad" --types "adult,adult" --detail simple --pages 2
//
// Curls are the fourth failure, and the same shape as the first three: the
// list only stops what it can name, and not one word in it named a curl.
// Solid black, scribbles, crosshatching, stippling, dots, a curtain of
// parallel strands - a tight coil is none of those. It is a small spiral,
// drawn correctly, hundreds of times, and every ban above walks past it.
// Jasmin's book came back with a head of ringlets on a page where every
// other rule held, so the ban now names the shape: spirals, coils,
// corkscrews, ringlets, loops, zigzags, repeated c- and s-shapes.
//
// The outline sentence is the guard rail on the ban. Curl texture is how
// the model was saying "this hair is curly", and taking the texture away
// without saying what to keep invites it to take the shape away too - a
// child with an afro handed back with flat straight hair is a worse page
// than a busy one, and a worse thing to sell. So the silhouette is stated
// as a positive: keep the hairstyle the photo shows, draw its inside open.
//
// Regression render for this one is a child with tightly coiled hair at
// STANDARD, which is where it was found. set1-mom exposes the strand
// version; she does not expose this one.
//
// Beards get their own sentence because "hair" did not reach them. A dad with a
// few days of stubble came back with a chin of hundreds of tiny dots - already
// grey, nothing left for a child to colour - while the hair on his head obeyed
// the rule perfectly.
// Trademark and copyright. A child's photo very often carries somebody else's
// property on it - a swoosh, a team crest, a cartoon character on a pyjama top -
// and drawing it reproduces that mark in something being sold. The text ban
// above does not cover this: a logo is a picture, not a word, and it walks
// straight past a rule about letters. It also walks past the OCR word check,
// which reads lettering and is blind to artwork by design.
//
// So prevention is the only control there is here, and it has to name the
// categories rather than gesture at them - the stippling lesson, again: a ban
// only stops what it can name.

const BASE_STYLE = 'Black and white coloring book page, clean bold outlines only, no shading, no gray tones, no text or captions of any kind - every sign, label, jar, book, cushion, picture frame and gift tag is left blank, with no letters, words or numbers anywhere in the picture - simple line art suitable for a child to color in. Draw all hair as open white space with only a few clean curved outline strands, well separated, with plenty of white showing between them - never fill hair with solid black, dense scribbles, crosshatching, stippling, any field of small dots, or a dense curtain of many fine parallel strands, no matter how dark or curly the hair is in the photo. Curly, coily and afro hair is where this breaks most often, and it breaks by drawing every single curl: never fill hair with small spirals, coils, corkscrews, ringlets, loops, zigzags or repeated c-shapes or s-shapes, however tightly curled the hair is in the photo. Keep the outline of the hairstyle exactly as the photo shows it - a big round afro stays a big round afro, two puffs stay two puffs - and draw what is inside that outline as a few large curved shapes with wide open white between them, never as the curls themselves. Draw a beard, moustache or stubble the same way: one clean outline around the shape of it and open white inside, never speckles, flecks or shaded texture, however short the hair is. Never reproduce any logo, emblem, team crest, badge, brand mark, wordmark, slogan, mascot, cartoon character or licensed artwork, even when one is clearly printed on clothing, a bag, a cap, a cup, a toy or anything else in the photo - draw that surface as plain blank fabric or plain blank material with nothing on it, keeping only the shape of the garment or object itself. Every part of the drawing must be left white so a child can color it in.';

// BASE_STYLE fixes the look - bold outlines, no shading, no text, open hair -
// but says nothing about how MUCH is in the picture. Left to itself the model
// picked a different busyness every time: one page came back with shelves,
// jars, curtains, a utensil pot and a cookie tray, the next with a bare wall
// and a fridge. Same input, same book, wildly different pages.
//
// So the amount of scenery is now chosen by the customer, on behalf of whoever
// is holding the crayon. This changes the PAGE, never the CHARACTER: the people
// still look like their photos at every level. And it is an addition to
// BASE_STYLE, not a replacement - no text, no shading and open hair hold at all
// three.
const DETAIL_LEVELS = {
  simple: {
    label: 'Simple',
    ages: '3-4',
    // "Nearly empty" is one word away from "empty", and an empty page with a
    // child floating on it is not a coloring page - hence the second sentence.
    prompt: 'Detail level: very simple, drawn for a three or four year old to colour. Use very thick outlines and only a handful of large, clearly separated shapes. Keep the background nearly bare - one or two big objects at most - but keep enough of it that the scene still reads as a real place. Every area to be coloured should be large and open enough for a small child to fill without going over the line. Hair follows the same rule as everything else here: one or two large open shapes with only three or four separate strands drawn inside them, and nothing finer.'
  },
  standard: {
    label: 'Standard',
    ages: '5-7',
    prompt: 'Detail level: moderate, drawn for a five to seven year old to colour. Use bold outlines. Give the scene a recognisable setting with a few background objects. Keep the areas to be coloured medium sized. Hair carries a small number of separate strands - enough to show which way it falls, few enough to leave large white areas inside it.'
  },
  detailed: {
    label: 'Detailed',
    ages: '8+',
    // More background objects means more jars, signs and books - exactly the
    // things that tempt the model into lettering them - and "finer outlines"
    // is how a drawing starts sliding into shading. Both are named here
    // rather than left to BASE_STYLE to carry alone.
    prompt: 'Detail level: busy, drawn for a child of eight or older to colour. Use finer outlines. Fill the scene out with background objects, decorative patterns and smaller enclosed areas to colour. Finer means thinner clean outlines, never shading, grey tones or crosshatching, and every one of those added objects stays blank - no letters, words or numbers anywhere in the picture. Hair may carry a few more strands than at the simpler levels, but they stay separate with clear white between them: more strands, never a denser curtain.'
  }
};
const DEFAULT_DETAIL = 'standard';

// Anything unrecognised - absent, misspelt, an old browser that does not know
// the field - lands on the middle band. Omitting the instruction is what
// produced the random swing in the first place, so there is no "no value".
function normalizeDetail(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DETAIL_LEVELS, key) ? key : DEFAULT_DETAIL;
}

// The photo goes to the model through /images/edits, which by default hands
// back something close to the photo it was given: same pose, same crop, same
// angle. Naming a camera is not enough on its own - the photo has to be
// demoted to a likeness reference explicitly, or page one comes back as the
// uploaded snapshot with outlines on it.
const PHOTO_USE = 'Use the reference photo only for the faces, hair and features. Do not copy its pose, framing, background or camera angle: this page is a new drawing of the same people somewhere else, not the photo traced over.';
// Same instruction for a family book, where several photos are sent and none of
// them is the page. Kept as its own string rather than patched at runtime: the
// single-subject wording is load-bearing and has been through enough already.
const PHOTO_USE_MANY = 'Use the reference photos only for faces, hair and features. Do not copy any of their poses, framing, backgrounds or camera angles: this page is a new drawing of the same people somewhere else, not a photo traced over.';

// Nothing in the prompt ever said what anybody was wearing. PHOTO_USE demotes
// the photo to "faces, hair and features", but a model given no wardrobe still
// has only one place to look, so it copied the clothes out of the snapshot:
// Owen's whole Adventure book is fifteen pages of the same t-shirt and shorts.
// The only costume that ever turned up was one a scene line happened to name -
// the cape on the four Superhero pages that mention a cape, the helmet on
// Firefighter page one - which is exactly what "only a couple of the pictures
// do it" looks like from the outside. The theme is what the book is sold on, so
// the outfit is stated on every page now rather than left to the scene text.
//
// Written as plain shapes a child can color: no logos, no emblems with anything
// inside them, no lettering. BASE_STYLE already forbids all three and the two
// instructions must not argue with each other.
//
// "from" is the first scene index that wears it. It is 1 for Superhero, whose
// page one is the child finding the cape - the story is the costume arriving,
// and it cannot arrive if it is already on. Every other theme wears it from
// page one. Portrait and Family Keepsake are deliberately absent: one is the
// child as themselves and the other is home life, and their own clothes are
// the right answer for both.
const THEME_OUTFITS = {
  'Superhero': {
    from: 1,
    outfit: 'a superhero costume - a close-fitting long-sleeved suit, a plain oval emblem '
      + 'shape on the chest with nothing at all drawn inside it, a long cape fastened at both '
      + 'shoulders, a wide belt, tall boots and a small eye mask'
  },
  'Adventure scene': {
    from: 0,
    outfit: 'an explorer outfit - a wide-brimmed safari hat, a short-sleeved shirt with two '
      + 'buttoned chest pockets, cargo shorts, long socks and sturdy lace-up hiking boots'
  },
  'Fairy tale': {
    from: 0,
    outfit: 'a storybook outfit - a hooded travelling cloak fastened at the throat, a simple '
      + 'belted tunic or dress, and soft ankle boots'
  },
  'Firefighter': {
    from: 0,
    outfit: 'a firefighter uniform - a helmet with a wide brim at the back, a heavy turnout '
      + 'coat with one broad plain band around the chest and one around each sleeve, matching '
      + 'trousers and tall rubber boots'
  },
  'Police Officer': {
    from: 0,
    outfit: 'a police uniform - a peaked cap, a buttoned shirt with shoulder straps and two '
      + 'chest pockets, a plain star-shaped badge with nothing written on it, a duty belt and '
      + 'long trousers'
  },
  'Doctor': {
    from: 0,
    outfit: 'a doctor\'s outfit - a knee-length white coat worn open over plain scrubs, a '
      + 'stethoscope hanging around the neck, and plain flat shoes'
  },
  'Grandparent Garden': {
    from: 0,
    outfit: 'gardening clothes - a wide-brimmed sun hat, a work apron with one big front '
      + 'pocket, sleeves rolled to the elbow, gardening gloves and rubber boots'
  }
};

// The line itself. Two jobs, and the second is the one that was missing: say
// what to wear, then say out loud that the photo does not get a vote on it.
// "on every page of this book" is there because each page is drawn by a
// separate call that cannot see the others, so consistency has to be asked for
// in every one of them.
function wardrobeLine(theme, sceneIndex, plural, subject) {
  const dressing = THEME_OUTFITS[theme];
  if (!dressing || sceneIndex < dressing.from) return '';
  return ` Wardrobe: ${subject} ${plural ? 'are' : 'is'} wearing ${dressing.outfit}.`
    + ' This is the same outfit on every page of this book.'
    + ' Ignore the clothing in the reference photo completely - the photo is for faces,'
    + ' hair and features only, never for what anybody is wearing.';
}

// Without a camera direction the image model falls back to the same head-on
// portrait every time, so a whole book came back looking like a page of
// passport photos. buildPrompt walks this list with sceneIndex, and every theme
// is 15 scenes long, so a book uses each entry once and never repeats a shot.
//
// Every entry moves two things: where the head is pointing (chin up, chin down,
// tilted, a three-quarter turn, looking back over the shoulder, a sideways
// glance) and how close the camera is (close-up, medium, full body, wide).
// Both axes verified against live output.
//
// NEVER add "from behind", a strict side profile, or "running away" to this
// list. Asked for any of those, the model draws a SECOND child facing away
// instead of turning the first one around, and the page comes back with a
// stranger in it. "Looking back over the shoulder toward the viewer" is the
// safe way to get the same feeling, because the face stays in frame.
const SHOTS = [
  'medium shot, waist up, head tilted slightly, face toward the viewer',
  'close-up, head and shoulders filling the frame, chin up',
  'full body, head to toe, three-quarter turn with the face toward the viewer',
  'wide shot with plenty of the setting around them, chin down, looking at what their hands are doing',
  'medium shot, waist up, glancing sideways without turning the body',
  'close-up, chin down and head tilted',
  'full body, head to toe, looking back over the shoulder toward the viewer',
  'wide shot with the setting around them, chin up, looking upward',
  'medium shot, three-quarter turn, glancing sideways',
  'close-up, looking back over the shoulder toward the viewer',
  'full body, head to toe, chin up',
  'medium shot, waist up, chin down with the head tilted',
  'wide shot, three-quarter turn, face toward the viewer',
  'close-up, chin up and glancing sideways',
  'medium-wide, face toward the viewer, head tilted'
];

// A family book: up to this many people, each with their own photo. Five covers
// two parents, two children and a grandparent, which is the shape most families
// asking for this have. Every extra face is another likeness the model has to
// hold steady across fifteen pages, so this is a quality ceiling as much as a
// technical one.
const MAX_PEOPLE = parseInt(process.env.MAX_PEOPLE, 10) || 5;

// Keep only what a person needs to be drawn, and only as many as we allow.
// Anything malformed is dropped rather than passed to the model as "undefined".
function cleanPeople(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      name: String(p.name || '').slice(0, 60).trim(),
      subjectType: p.subjectType === 'adult' ? 'adult' : 'kid',
      // The one the story follows. The book is for a child, so a child is who
      // it should be about even when the whole family is in it.
      star: p.star === true,
      photo: typeof p.photo === 'string' ? p.photo : null
    }))
    .filter((p) => p.name)
    .slice(0, MAX_PEOPLE);
}

// Whoever the order marked, otherwise the first child, otherwise the first
// person. A family book is bought for a child to colour, so without being told
// anything the story still follows a child rather than whoever was uploaded
// first.
function pickStar(people) {
  return people.find((p) => p.star)
    || people.find((p) => p.subjectType === 'kid')
    || people[0];
}

// Who the book is about, tied to the order the photos are sent in. The model
// gets one photo per person rather than one crowded group shot, so it has to be
// told which is which - "in the same order" is the whole hinge.
// "Malik and Jasmin", "Owen, Mum and Dad". Used both to name the cast to the
// model and as the subject of the scene line, so the two always agree.
function joinNames(list) {
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function nameList(people) {
  return joinNames(people.map((p) => p.name));
}

function castLine(people) {
  const star = pickStar(people);
  const described = people.map((p) => {
    const kind = p.subjectType === 'adult' ? 'an adult' : 'a child';
    return `${p.name} (${kind})`;
  });
  const list = joinNames(described);
  // The closed-cast sentence is the whole point of this block. Without it the
  // model treats a two-child book as "a family" and draws in a mother, a father
  // and a grandmother who were never uploaded - found on order 64, 20 Sep.
  // Scene-called extras (a cheering crowd, an elderly person at a crossing) are
  // written into the scene text, so they are allowed through by name.
  return `There is one reference photo per person, in this same order: ${list}. `
    + `These ${people.length} are the only people this story is about. `
    + 'Do not invent or add any other family members - no extra parents, brothers, sisters '
    + 'or grandparents, and no stand-in adults. Anyone else appears only if the scene below '
    + 'names them. '
    + 'Each photo shows only that person; use it for their face, hair and features and nobody else\'s. '
    + 'Keep every one of them recognisable on every page they appear, and draw them at their own age - '
    + 'the adults as adults and the children as children, never all the same size. '
    + 'Recognisable means the same likeness, not the same pose: vary posture, expression and viewing '
    + 'angle from scene to scene. Show them together, doing the scene as a group, '
    + `and keep ${star.name} at the centre of it: this is ${star.name}'s story and the others `
    + `are there with ${star.name}, never instead of ${star.name}.`;
}

function subjectPhrase(count, subjectType) {
  const noun = subjectType === 'adult' ? 'people' : 'children';
  const singularNoun = subjectType === 'adult' ? 'the person' : 'the child';
  if (count >= 3) return 'all three ' + noun;
  if (count === 2) return 'both ' + noun;
  return singularNoun;
}

// Scene lines are written with a singular subject ("the child climbs into the
// fire engine"). For a two- or three-subject book that subject becomes plural,
// so the verb after it has to drop its third-person -s or the prompt reads
// "both children climbs into the fire engine". Only the verb directly after the
// subject is touched: a later clause can belong to something else entirely
// ("meets a small talking fox who offers to be their guide").
const IRREGULAR_PLURAL_VERBS = { is: 'are', was: 'were', has: 'have', does: 'do', goes: 'go' };

function pluralizeVerb(word) {
  if (IRREGULAR_PLURAL_VERBS[word]) return IRREGULAR_PLURAL_VERBS[word];
  // Participles ("playing") and anything that is not a verb at all ("with",
  // "and", "mid-jump") carry no -s and need no help.
  if (!word.endsWith('s') || word.endsWith('ss')) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y'; // carries -> carry
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2); // washes -> wash
  return word.slice(0, -1); // climbs -> climb
}

function consistencyLine(count, subjectType) {
  const possessive = subjectType === 'adult' ? 'person\'s' : 'child\'s';
  if (count > 1) {
    return 'The reference photo shows ' + subjectPhrase(count, subjectType) + '. Keep each ' + possessive + ' face, hair and features recognisable across every scene. Recognisable means the same likeness, not the same pose: vary their posture, expression and viewing angle from scene to scene. Show them together, interacting, in every scene.';
  }
  return 'Keep the face, hair and features of ' + subjectPhrase(count, subjectType) + ' recognisable from the reference photo across the whole story. Recognisable means the same likeness, not the same pose: the posture, expression and viewing angle should change from scene to scene.';
}

// Every line is written for one subject: "the child" followed by a single
// simple-present verb. buildPrompt swaps in a plural subject and fixes that
// verb for multi-subject books, so keep new lines in the same shape and put any
// second action in a participial clause ("..., slowing it down") rather than
// "and slows it down".
const STORY_SCENES = {
  'Superhero': [
    'the child discovers a glowing cape in their bedroom',
    'the child puts on the cape and a mask for the first time, looking in a mirror',
    'the child leaps off a rooftop, cape flying, starting to fly',
    'the child soars above city skyscrapers for the first time',
    'the child rescues a kitten stuck in a tall tree',
    'the child races a speeding runaway train, slowing it down',
    'the child lifts a fallen tree off a road to clear the way',
    'the child faces down a cartoonish storm cloud villain in the sky',
    'the child uses super strength to hold up a collapsing bridge',
    'the child teams up with a friendly robot sidekick',
    'the child flies through a lightning storm, unafraid',
    'the child is cheered on by a crowd of grateful city people',
    'the child stands on a rooftop at sunset, cape blowing in the wind',
    'the child helps an elderly person cross a busy street',
    'the child flies home at night under a starry sky, mission complete'
  ],
  'Adventure scene': [
    'the child finds an old treasure map in a jungle clearing',
    'the child sets off into the jungle with a backpack and compass',
    'the child crosses a rope bridge over a river',
    'the child meets a friendly dinosaur for the first time',
    'the child rides on the dinosaur\'s back through tall ferns',
    'the child and the dinosaur discover a hidden waterfall',
    'the child climbs a rocky cliff beside the dinosaur',
    'the child and the dinosaur are caught in a sudden jungle rainstorm',
    'the child discovers ancient stone ruins covered in vines',
    'the child solves a puzzle carved into a stone door',
    'the child and the dinosaur enter a hidden cave full of crystals',
    'the child finds a treasure chest glowing with light',
    'the child and the dinosaur are chased by a friendly flock of birds',
    'the child says goodbye to the dinosaur at the edge of the jungle',
    'the child walks home at sunset holding the treasure, jungle behind them'
  ],
  'Fairy tale': [
    'the child finds a glowing door hidden in an old oak tree',
    'the child steps through the door into an enchanted forest',
    'the child meets a small talking fox who offers to be their guide',
    'the child and the fox follow a path of glowing mushrooms',
    'the child discovers a castle in the distance, towers glowing in mist',
    'the child crosses a bridge guarded by a friendly dragon',
    'the child and the dragon become friends and share a laugh',
    'the child is welcomed into the castle by kind fairy folk',
    'the child dances at a fairy tale ball in the castle hall',
    'the child helps break a spell on a sleeping garden',
    'the child watches the flowers and trees in the garden bloom back to life',
    'the child rides the dragon over the treetops of the enchanted forest',
    'the child and the fox watch the sunset from a castle tower',
    'the child is given a small glowing charm as a keepsake',
    'the child walks back through the glowing door, waving goodbye'
  ],
  'Portrait': [
    'a simple front-facing portrait of the child smiling',
    'a portrait of the child laughing, head tilted slightly',
    'a portrait of the child with their favorite toy',
    'a portrait of the child looking curiously to one side',
    'a portrait of the child mid-jump, joyful',
    'a portrait of the child reading a book',
    'a portrait of the child with arms stretched out wide',
    'a portrait of the child wearing a fun hat',
    'a portrait of the child giving a thumbs up',
    'a portrait of the child blowing a kiss',
    'a portrait of the child with a big surprised expression',
    'a portrait of the child mid-spin, twirling',
    'a portrait of the child waving hello',
    'a portrait of the child hugging a stuffed animal',
    'a portrait of the child taking a bow'
  ],
  'Firefighter': [
    'the child tries on a firefighter helmet for the first time, grinning',
    'the child slides down the fire station pole',
    'the child polishes the big red fire engine',
    'the child checks the hose, coiling it neatly',
    'the child climbs into the fire engine, taking the wheel',
    'the child rides the fire engine with the ladder raised high',
    'the child raises the ladder toward a tall building',
    'the child rescues a kitten from a rooftop',
    'the child carries a puppy to safety, wrapped in a blanket',
    'the child sprays water from the hose onto a cartoon fire',
    'the child teaches other kids the stop, drop and roll',
    'the child stands proudly beside a dalmatian dog',
    'the child receives a badge from the fire chief',
    'the child waves from the fire engine in a town parade',
    'the child rests at the station at sunset, helmet under one arm'
  ],
  'Police Officer': [
    'the child puts on a police hat and badge for the first time',
    'the child stands proudly next to a police car',
    'the child helps a lost puppy find its way home',
    'the child directs traffic at a busy crosswalk',
    'the child helps a family cross the street safely',
    'the child rides a police bicycle through a park',
    'the child meets a friendly police dog, shaking its paw',
    'the child returns a lost teddy bear to a smaller child',
    'the child helps an elderly person carry groceries',
    'the child talks with kids at a school assembly',
    'the child hands out sticker badges to a group of children',
    'the child leads a bike safety class in a parking lot',
    'the child helps at a community picnic',
    'the child receives a medal for helping others',
    'the child waves from the police car at the end of the day'
  ],
  'Doctor': [
    'the child puts on a white coat and a stethoscope',
    'the child listens to a teddy bear\'s heartbeat with a stethoscope',
    'the child checks a patient\'s temperature, smiling reassuringly',
    'the child wraps a bandage around a stuffed rabbit\'s paw',
    'the child looks into a microscope in a bright lab',
    'the child reads an X-ray on a light board',
    'the child comforts a nervous smaller child in the waiting room',
    'the child gives a brave patient a sticker',
    'the child washes hands carefully at a sink',
    'the child takes notes on a clipboard during rounds',
    'the child rides along in an ambulance, ready to help',
    'the child teaches other kids how to stay healthy',
    'the child helps a patient take their first steps again',
    'the child celebrates with a patient who is going home',
    'the child hangs up the white coat at the end of a long day, smiling'
  ],
  'Grandparent Garden': [
    'the child watering flowers in a backyard garden',
    'the child kneeling beside a row of vegetable plants, trowel in hand',
    'the child holding up a freshly picked tomato, smiling proudly',
    'the child planting a small tree together with a watering can nearby',
    'the child sitting on a porch swing surrounded by potted plants',
    'the child picking flowers for a bouquet',
    'the child feeding birds at a garden birdfeeder',
    'the child resting in a garden hammock under a shady tree',
    'the child arranging cut flowers into a vase at an outdoor table',
    'the child walking through a sunflower patch',
    'the child harvesting apples from a small tree',
    'the child sitting at a garden table having tea',
    'the child raking autumn leaves into a pile in the yard',
    'the child admiring a rainbow over the garden after rain',
    'the child waving from the garden gate at golden hour'
  ],
  'Family Keepsake': [
    'the child baking cookies in a cozy kitchen, apron on',
    'the child reading a storybook aloud in an armchair by a window',
    'the child stirring a pot of soup on the stove',
    'the child setting the table for a family dinner',
    'the child knitting or working on a craft at a table',
    'the child looking through an old photo album on a couch',
    'the child playing a board game at the kitchen table',
    'the child decorating a holiday tree with ornaments',
    'the child rocking gently in a rocking chair with a cup of tea',
    'the child tending a warm fireplace in a cozy living room',
    'the child wrapping a gift at a table covered in ribbon',
    // Was "hand in hand with a grandchild". A scene that names a person is
    // allowed to draw that person - so every Family Keepsake book put a fifth
    // child nobody uploaded on page 12 (order 67, 21 Sep). Family Keepsake is
    // for whoever is in the cast; only Grandparent Garden assumes grandparents.
    'the child walking hand in hand along a tree-lined park path',
    'the child sitting on a porch swing watching the sunset',
    'the child blowing out candles on a birthday cake',
    'the child waving warmly from a front porch, welcoming guests'
  ]
};

// people is optional: pass it for a family book, where each person has their own
// photo and their own name, and leave it out for the single-subject book, which
// still works off childCount and one photo exactly as it always did.
function buildPrompt(theme, sceneIndex, childCount, subjectType, notes, people, detail) {
  const scenes = STORY_SCENES[theme] || STORY_SCENES['Portrait'];
  let scene = scenes[sceneIndex] || scenes[0];
  const cast = cleanPeople(people);
  const isFamily = cast.length > 1;

  // The scenes are written around "the child". A family does the same thing
  // together, so the subject becomes the family and the verb follows it.
  // Named, not "the family". "The family discovers a glowing cape" told the
  // model to draw a whole family unit and it duly invented the missing halves
  // of one; "Malik and Jasmin discover a glowing cape" cannot be padded out.
  // A cast is always two or more, so the verb after it is always plural.
  const subject = isFamily ? nameList(cast) : subjectPhrase(childCount, subjectType);
  if (isFamily || childCount > 1) {
    scene = scene.replace(/\bthe child\b(\s+)([a-z]+)/g, (match, gap, word) => subject + gap + pluralizeVerb(word));
  }
  scene = scene.replace(/\bthe child\b/g, subject);
  const who = isFamily ? castLine(cast) : consistencyLine(childCount, subjectType);
  let prompt = `${BASE_STYLE} ${who} ${isFamily ? PHOTO_USE_MANY : PHOTO_USE} Scene: ${scene}.`;
  prompt += ` Camera: ${SHOTS[sceneIndex % SHOTS.length]}.`;
  prompt += wardrobeLine(theme, sceneIndex, isFamily || childCount > 1, subject);
  if (notes && notes.trim()) {
    prompt += ` Also incorporate this detail where it fits naturally: ${notes.trim()}.`;
  }
  // Last, and deliberately so. This is the instruction the model was ignoring
  // when nobody gave it one, and the end of the prompt is where it listens.
  prompt += ` ${DETAIL_LEVELS[normalizeDetail(detail)].prompt}`;
  return prompt;
}

// One scene, one OpenAI call. Shared by the free preview route and the
// background renderer so both produce identical artwork.
// Timestamps of the images sent in the last minute. Small and self-trimming:
// at 45 a minute this array never holds more than 45 numbers.
const imageStamps = [];
// Free previews may only use part of the budget. The rest is held back for
// people who have paid: when a rush of browsers arrives, the customer waiting
// on a book they bought should not end up behind a queue of window shoppers.
const FREE_PREVIEW_BUDGET = Math.max(1, Math.floor(IMAGES_PER_MIN * 0.6));

async function waitForImageSlot(paid) {
  const ceiling = paid ? IMAGES_PER_MIN : FREE_PREVIEW_BUDGET;
  for (;;) {
    const now = Date.now();
    while (imageStamps.length && now - imageStamps[0] >= 60000) imageStamps.shift();
    if (imageStamps.length < ceiling) {
      imageStamps.push(now);
      return;
    }
    // Full for now. Sleep until the oldest one ages out, then look again.
    await new Promise((r) => setTimeout(r, 60000 - (now - imageStamps[0]) + 50));
  }
}

// The model ignores left and right: four explicit direction prompts came back
// identical, so asking for it is wasted breath. Flipping the finished page is
// the only thing that reliably stops every page in a book leaning the same way.
// Roughly half, decided per page - a coin flip, which is what "roughly" means
// here; over fifteen pages it lands near enough to half.
//
// On by default. This paragraph used to say the opposite, and the reversal is
// worth reading before anybody turns it off again.
//
// Flipping was done blind at first, on the grounds that BASE_STYLE rules out
// text so there would be no lettering to reverse. The model letters signs and
// jars anyway, and four pages in a sixty-page run shipped reading right to
// left. A word check was put in front of every flip - and on 14 September this
// was set to 0 anyway, because that check (mirror-guard.js, pixels) had only
// ever been measured against six real lettered pages, and a book with
// backwards writing in it is one that gets sent back.
//
// text-guard.js closed that two days later: a vision check that reads the
// page, asked alongside the pixel one, flipping only when BOTH say the page is
// clean. Measured together over thirty pages, 30/30, and no clean page held
// back. The doubt the retreat was protecting against stopped existing on 16
// September and nobody moved this line, so it went on costing something real.
//
// What it costs: the model ignores left and right - four explicit direction
// prompts came back identical - so the finished flip is the ONLY control over
// which way a page faces. With this at 0, every book leans whichever way its
// photo leans. Found on a customer-facing book whose subject was angled in her
// photo: fifteen pages, every one of them facing the same way.
//
// Roughly half, decided per page - a coin flip, which is what "roughly" means
// here; over fifteen pages it lands near enough to half. If a book ever
// clusters one way anyway, make it alternate rather than tossing; that is a
// smaller change than switching this off.
const MIRROR_CHANCE = process.env.MIRROR_CHANCE !== undefined
  ? Math.min(1, Math.max(0, parseFloat(process.env.MIRROR_CHANCE) || 0))
  : 0.5;

async function maybeMirror(b64) {
  if (Math.random() >= MIRROR_CHANCE) return b64;
  const buffer = Buffer.from(b64, 'base64');
  try {
    if (await mirrorGuard.hasWords(buffer)) return b64;
    if (await textGuard.hasText(buffer)) return b64;
  } catch (err) {
    // Unreadable means unflippable. Leaning the same way is a page nobody
    // notices; backwards writing is a page that gets sent back.
    console.error('Could not check the page for words, leaving it as drawn -', err.message);
    return b64;
  }
  try {
    // flop is the horizontal mirror; flip is vertical.
    const mirrored = await sharp(buffer).flop().png().toBuffer();
    return mirrored.toString('base64');
  } catch (err) {
    // A page that came back fine is worth more than a page that leans the right
    // way, so a failed flip keeps the original rather than losing the drawing.
    console.error('Mirror failed, keeping the page as drawn -', err.message);
    return b64;
  }
}

// One scene. Takes either a single photo (buffer/mimetype/filename) or, for a
// family book, a photos array of those same three fields - one entry per
// person, in the order the prompt names them.
async function renderScene({ buffer, mimetype, filename, photos, prompt, paid }) {
  await waitForImageSlot(paid === true);
  if (!CAN_CALL_OPENAI) throw new Error('Server is missing its OpenAI API key.');

  const references = Array.isArray(photos) && photos.length
    ? photos
    : [{ buffer, mimetype, filename }];
  if (!references.length || !references[0].buffer) throw new Error('No reference photo to draw from.');

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  form.append('quality', 'medium');
  // A single photo keeps the field name it has always had. Several go as
  // image[], which the images API accepts and matches to the order the prompt
  // introduces people in.
  const field = references.length > 1 ? 'image[]' : 'image';
  references.forEach((ref, i) => {
    form.append(field, new Blob([ref.buffer], { type: ref.mimetype || 'image/jpeg' }),
      ref.filename || `photo-${i + 1}.png`);
  });

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: OPENAI_API_KEY ? { Authorization: `Bearer ${OPENAI_API_KEY}` } : {},
    body: form
  });
  const data = await response.json();
  if (!response.ok) {
    // Noted before it is thrown. A 429 means books are merely slow; anything
    // else repeated means they are probably not finishing at all, and the
    // watchdog tells those two apart.
    noteOpenAiTrouble(response.status === 429 ? 'rate-limited' : 'failed');
    throw new Error((data.error && data.error.message) || 'Unknown error from OpenAI.');
  }
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new Error('No image returned from OpenAI.');
  return `data:image/png;base64,${await maybeMirror(b64)}`;
}

function dataUrlToBuffer(dataUrl) {
  const parts = String(dataUrl || '').split(',');
  if (parts.length < 2) throw new Error('Stored photo is not a data URL.');
  const mimetype = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
  return { buffer: Buffer.from(parts[1], 'base64'), mimetype };
}

// Orders currently being rendered in this process, so a Stripe webhook retry
// or a second call can't start the same book twice.
const rendering = new Set();

// A rolling note of OpenAI trouble. Timestamps only - enough to answer "is it
// misbehaving right now", which is all the watchdog asks.
const openAiTrouble = [];
function noteOpenAiTrouble(kind) {
  openAiTrouble.push({ kind, at: Date.now() });
  if (openAiTrouble.length > 400) openAiTrouble.splice(0, openAiTrouble.length - 400);
}
function openAiTroubleIn(minutes) {
  const cutoff = Date.now() - minutes * 60000;
  const recent = openAiTrouble.filter((t) => t.at >= cutoff);
  return {
    windowMinutes: minutes,
    rateLimited: recent.filter((t) => t.kind === 'rate-limited').length,
    failed: recent.filter((t) => t.kind === 'failed').length
  };
}

// Draws the whole book on the SERVER after payment. The customer's browser
// plays no part: they can close the tab, switch devices, or never come back,
// and the book still gets made and emailed.
async function renderBook(orderId) {
  if (rendering.has(String(orderId))) {
    console.log(`Order ${orderId} is already rendering; skipping duplicate start.`);
    return;
  }
  // At capacity. Leave the order exactly as it is and walk away - it stays
  // paid, it keeps its photo, and resumeUnfinished picks it up when a slot
  // opens. This is the whole reason a rush makes us slow instead of dead.
  if (rendering.size >= MAX_CONCURRENT_BOOKS) {
    console.log(`Order ${orderId} is waiting: ${rendering.size} books already in progress.`);
    return;
  }
  rendering.add(String(orderId));
  wakeUp();
  try {
    const order = await db.getOrderForRender(orderId);
    if (!order) throw new Error('Order not found.');
    if (!order.paid) throw new Error('Order is not paid.');

    // Already finished - a late webhook retry must not re-run this and must not
    // knock a good book back to 'failed' just because the photo is gone now.
    if (order.generationStatus === 'done') {
      console.log(`Order ${orderId} is already done; nothing to render.`);
      return;
    }
    const cast = cleanPeople(order.people);
    const isFamily = cast.length > 1;
    if (!isFamily && !order.photo) throw new Error('No photo stored for this order.');
    if (isFamily && !cast.every((p) => p.photo)) throw new Error('A person in this family book has no photo stored.');

    await db.bumpRenderAttempts(orderId);
    await db.setGenerationStatus(orderId, 'running');

    const scenes = STORY_SCENES[order.theme] || STORY_SCENES['Portrait'];
    const total = scenes.length;
    // One photo per person for a family book, the single photo otherwise.
    const references = isFamily
      ? cast.map((person, i) => {
          const { buffer, mimetype } = dataUrlToBuffer(person.photo);
          return { buffer, mimetype, filename: `person-${i + 1}.png` };
        })
      : [(() => {
          const { buffer, mimetype } = dataUrlToBuffer(order.photo);
          return { buffer, mimetype, filename: 'photo.png' };
        })()];
    const already = new Set(await db.doneSceneIndexes(orderId));
    const subjectType = order.subjectType === 'adult' ? 'adult' : 'kid';

    // Pages that still need drawing, handed out to a small pool of workers so
    // several are in flight at once. Each page is independent, so a failure only
    // costs that page - the rest of the book carries on.
    const todo = [];
    for (let i = 0; i < total; i++) if (!already.has(i)) todo.push(i);

    let failures = 0;
    let nextUp = 0;
    async function drawWorker() {
      while (true) {
        const slot = nextUp++;
        if (slot >= todo.length) return;
        const sceneIndex = todo[slot];
        const prompt = buildPrompt(order.theme, sceneIndex, order.childCount, subjectType, order.notes, cast, order.detailLevel);
        try {
          const image = await renderScene({ photos: references, prompt, paid: true });
          await db.savePage(orderId, sceneIndex, image);
          console.log(`Order ${orderId}: page ${sceneIndex + 1}/${total} done.`);
        } catch (err) {
          failures++;
          console.error(`Order ${orderId}: page ${sceneIndex + 1} failed - ${err.message}`);
        }
      }
    }
    const lanes = Math.max(1, Math.min(RENDER_CONCURRENCY, todo.length));
    await Promise.all(Array.from({ length: lanes }, () => drawWorker()));

    const done = await db.countPages(orderId);
    await db.setGenerationStatus(orderId, done >= total ? 'done' : 'partial');
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(`Order ${orderId}: finished with ${done}/${total} pages (${failures} failures), memory ${rssMb}MB.`);

    // The book exists now, so the photo has done its job. Drop it. The pages we
    // keep are drawings; the original picture of the child does not stay on disk.
    if (done >= total) {
      try {
        await db.clearPhoto(orderId);
        console.log(`Order ${orderId}: source photo deleted.`);
      } catch (e) {
        console.error(`Order ${orderId}: could not delete source photo - ${e.message}`);
      }
    }

    // Build the book once, here, while everything is warm. If this throws, the
    // order is still finished and the customer is still emailed the link.
    let pdf = null;
    try {
      pdf = await bookPdf(order);
      console.log(`Order ${orderId}: PDF built, ${(pdf.length / 1048576).toFixed(2)}MB.`);
    } catch (pdfErr) {
      console.error(`Order ${orderId}: could not build the PDF - ${pdfErr.message}`);
    }

    // Only now is the book real, so only now do we tell the customer.
    if (order.email && mailer.configured && done > 0) {
      try {
        await emailBookReady({ order, pdf, pageCount: done });
      } catch (mailErr) {
        // Recorded, not just logged: the watchdog re-sends these, and it can
        // only do that if a failure leaves a mark.
        try { await db.markReadyEmailFailed(orderId); } catch (e) {}
        console.error(`Order ${orderId}: could not email - ${mailErr.message}`);
      }
    }
  } catch (err) {
    console.error(`Order ${orderId}: render failed - ${err.message}`);
    try { await db.setGenerationStatus(orderId, 'failed'); } catch (e) {}
  } finally {
    rendering.delete(String(orderId));
    // A slot just opened; drain the queue rather than waiting for the timer.
    wakeUp();
    setTimeout(resumeUnfinished, 1000);
  }
}

// ---------------------------------------------------------------------------
// Funnel counters
// ---------------------------------------------------------------------------
// The page posts one of these at each step so we can see where people stop.
// Nothing identifying is stored - see the notes on the events table in db.js.
// The browser is not trusted here: unknown event names are ignored, and a
// single address can only add so many before we stop listening.
const EVENTS_PER_IP_PER_MIN = parseInt(process.env.EVENTS_PER_IP_PER_MIN, 10) || 60;
const eventHits = new Map();

function takeEventSlot(ip) {
  const now = Date.now();
  const seen = (eventHits.get(ip) || []).filter((t) => now - t < 60000);
  if (seen.length >= EVENTS_PER_IP_PER_MIN) {
    eventHits.set(ip, seen);
    return false;
  }
  seen.push(now);
  eventHits.set(ip, seen);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, times] of eventHits) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) eventHits.delete(ip);
    else eventHits.set(ip, live);
  }
}, 5 * 60 * 1000).unref();

app.post('/event', async (req, res) => {
  // Analytics must never be able to break a sale, so this answers 204 whatever
  // happens and the page never waits on it.
  res.status(204).end();
  try {
    if (!takeEventSlot(clientIp(req))) return;
    // 'paid' is recorded by the Stripe webhook alone. Accepting it here would
    // let anyone inflate the only number that matters.
    if (req.body && req.body.type === 'paid') return;
    await db.recordEvent({
      type: String((req.body && req.body.type) || ''),
      visitor: (req.body && req.body.visitor) || '',
      source: (req.body && req.body.source) || '',
      campaign: (req.body && req.body.campaign) || ''
    });
  } catch (err) {
    console.error('Could not record event:', err.message);
  }
});

app.get('/stats', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 365);
    const [funnel, sources] = await Promise.all([db.funnelStats(days), db.sourceStats(days)]);
    res.json({ days, funnel, sources });
  } catch (err) {
    console.error('Failed to load stats:', err);
    res.status(500).json({ error: 'Could not load stats.' });
  }
});

// What the site is allowed to offer, so the order form does not have to keep
// its own copy of the limits and prices and drift out of step with them.
app.get('/options', (req, res) => {
  res.json({
    themes: Object.keys(STORY_SCENES),
    // The site builds its picker from this, so the bands and their labels are
    // defined in one place and cannot drift apart.
    detailLevels: Object.keys(DETAIL_LEVELS).map((key) => ({
      key, label: DETAIL_LEVELS[key].label, ages: DETAIL_LEVELS[key].ages
    })),
    defaultDetailLevel: DEFAULT_DETAIL,
    // The four styles drawn automatically after upload. The site builds its
    // strip from this so the tiles, their labels and the theme each one selects
    // in step 3 are defined in one place and cannot drift apart.
    styleGrid: {
      kid: STYLE_GRID.kid.map((t) => ({ theme: t.theme, label: t.label })),
      adult: STYLE_GRID.adult.map((t) => ({ theme: t.theme, label: t.label }))
    },
    freePreviewPages: FREE_PREVIEW_PAGES,
    priceCents: PRICE_CENTS,
    family: {
      maxPeople: MAX_PEOPLE,
      // Two or more people, each with their own photo, is what makes a book a
      // family book - and what makes it cost the family price.
      minPeople: 2,
      priceCents: FAMILY_PRICE_CENTS
    }
  });
});

app.get('/story-length', (req, res) => {
  const theme = req.query.theme || 'Portrait';
  const scenes = STORY_SCENES[theme] || STORY_SCENES['Portrait'];
  res.json({ theme, sceneCount: scenes.length });
});


// Who the visitor actually is.
//
// There are two proxies in front of this app - Cloudflare, then Render's load
// balancer - and `trust proxy` is set to 1, so Express peels off one hop and
// lands on the Cloudflare edge, not the person. Every visitor routed through
// the same edge looks like one visitor.
//
// That does not matter for logging. It matters enormously for anything that
// rations by visitor: a whole city shares one Cloudflare edge, so a per-visitor
// daily allowance becomes a per-city daily allowance, and real customers get
// turned away while the site looks fine.
//
// CF-Connecting-IP is set by Cloudflare itself and overwrites anything the
// client sent, so it is the trustworthy one as long as traffic arrives through
// Cloudflare. X-Forwarded-For is the fallback, leftmost entry being the
// original client. Both can be forged by anyone who reaches the origin
// directly, and that is accepted: the prize for forging is a few more free
// previews, which is exactly what the old limiter gave away for nothing.
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    const first = fwd.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || 'unknown';
}

// A small rate limiter for free previews. No dependency, no store: a Map of
// visitor -> timestamps inside a rolling hour, plus a site-wide count. It
// resets when the process does, which is fine - it exists to blunt a spike and
// to stop one person looping the free endpoint, not to bill anyone.
// The site-wide guard stays in memory and stays hourly, because it is a
// different job: it blunts a spike, and a spike is an hourly-shaped thing. It
// is also the one that must never outlive a restart - if a burst knocked the
// site into its cap, a redeploy should clear it, not carry it to midnight.
let sitePreviewWindow = { start: Date.now(), count: 0 };

// Which day it is where the visitor is. en-CA gives YYYY-MM-DD, which is what
// a DATE column wants.
function previewDay(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PREVIEW_DAY_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
}

async function takeFreePreview(ip, count = 1) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const want = Math.max(1, Number(count) || 1);

  if (now - sitePreviewWindow.start > hour) sitePreviewWindow = { start: now, count: 0 };
  if (sitePreviewWindow.count + want > FREE_PREVIEWS_PER_HOUR) return 'site';

  let quota;
  try {
    quota = await db.takePreviewQuota(ip, previewDay(), FREE_PREVIEWS_PER_IP, want);
  } catch (err) {
    // The database being unreachable must not stop a visitor seeing their own
    // child drawn. Fail open, loudly: the site-wide hourly cap above is still
    // standing, so the worst case is bounded rather than unlimited.
    console.error('Could not count free previews, letting this one through -', err.message);
    sitePreviewWindow.count += want;
    return null;
  }
  if (!quota.allowed) return 'visitor';

  sitePreviewWindow.count += want;
  return null;
}

// The other half of takeFreePreview. A preview is charged for before OpenAI is
// asked - it has to be, or the endpoint can be looped for free - so a draw that
// comes back empty has taken something from the visitor and given nothing back.
//
// Cheryl found this the hard way: eight previews spent in ten minutes, five of
// them refused by OpenAI's safety system, and she came away with one book out
// of four and no allowance left to try again. Nothing about that was her fault
// and all of it looked like ours.
//
// The site-wide hourly window is deliberately NOT refunded. That one exists to
// blunt a spike, and a spike of failing requests is still a spike.
async function giveBackFreePreview(ip, count = 1) {
  try {
    await db.refundPreviewQuota(ip, previewDay(), Math.max(1, Number(count) || 1));
  } catch (err) {
    // Worth knowing about, not worth turning one failure into two.
    console.error('Could not give back a free preview -', err.message);
  }
}

// Yesterday's counters are dead weight. Once a day, quietly.
setInterval(() => {
  db.purgeOldPreviewQuota().catch((err) =>
    console.error('Could not tidy old preview counters:', err.message));
}, 24 * 60 * 60 * 1000).unref();


// The four styles shown automatically the moment a photo is uploaded, before
// anybody has typed a name or picked a theme. This is an advert, so each tile
// names the scene it draws rather than taking scene 0 and hoping.
//
// That matters most for Superhero, whose scene 0 is "discovers a glowing cape
// in their bedroom" - and whose costume only starts at scene 1 (THEME_OUTFITS
// 'from'). A tile showing scene 0 would sell the superhero style with a picture
// of a child in a bedroom holding some cloth. Hence an explicit index per tile,
// and a test that reads the resolved scene back so a reordering of STORY_SCENES
// cannot quietly undo this.
//
// Superhero appears in both grids and is the one theme written for a kid. For a
// parent or grandparent it draws the rooftop at sunset instead of leaping off
// one: the same costume and cape, a scene that does not ask a grandmother to
// jump off a building.
const STYLE_GRID = {
  kid: [
    { theme: 'Portrait', sceneIndex: 0, label: 'Simple portrait' },
    { theme: 'Adventure scene', sceneIndex: 3, label: 'Adventure scene' },
    { theme: 'Superhero', sceneIndex: 2, label: 'Superhero' },
    { theme: 'Police Officer', sceneIndex: 1, label: 'Police officer' }
  ],
  adult: [
    { theme: 'Portrait', sceneIndex: 0, label: 'Simple portrait' },
    { theme: 'Grandparent Garden', sceneIndex: 0, label: 'Garden day' },
    { theme: 'Family Keepsake', sceneIndex: 0, label: 'Family keepsake' },
    { theme: 'Superhero', sceneIndex: 12, label: 'Superhero' }
  ]
};
const STYLE_GRID_SIZE = 4;

function styleGridFor(audience) {
  return STYLE_GRID[audience === 'adult' ? 'adult' : 'kid'];
}


// The style grid. Four pages of the visitor's own photo, one per style, drawn
// the moment the photo lands - before a name, a theme or an order exists.
//
// It is deliberately NOT part of /convert. /convert draws one scene of one
// theme and has grown a paywall, an order, a rescue queue and a detail level
// around that shape; this draws four themes for nobody in particular and has
// none of those. Sharing the route would mean a second set of branches through
// all of it.
app.post('/style-preview', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'photos', maxCount: MAX_PEOPLE }
]), async (req, res) => {
  let chargedTo = null;
  let charged = 0;
  try {
    const singlePhoto = (req.files && req.files.photo && req.files.photo[0]) || null;
    const familyPhotos = (req.files && req.files.photos) || [];
    if (!singlePhoto && !familyPhotos.length) {
      return res.status(400).json({ error: 'No photo uploaded.' });
    }
    // What was sent is checked before whether we can draw it. The other way
    // round, a request with its photos and names out of step comes back "server
    // is missing its OpenAI API key", which sends whoever is debugging it to
    // the wrong place entirely. /convert has always validated first; this now
    // matches it.
    let cast = [];
    if (req.body.people) {
      try { cast = cleanPeople(JSON.parse(req.body.people)); }
      catch (err) { return res.status(400).json({ error: 'Could not read the list of people.' }); }
    }
    if (familyPhotos.length && cast.length !== familyPhotos.length) {
      return res.status(400).json({
        error: `Send one name per photo: ${familyPhotos.length} photo(s) but ${cast.length} name(s).`
      });
    }
    if (!CAN_CALL_OPENAI) {
      return res.status(500).json({ error: 'Server is missing its OpenAI API key.' });
    }

    const audience = req.body.audience === 'adult' ? 'adult' : 'kid';
    const tiles = styleGridFor(audience);
    let childCount = parseInt(req.body.childCount, 10) || 1;
    childCount = Math.min(Math.max(childCount, 1), 3);

    // All four or none. Three tiles and a failure is worse than a clean stop,
    // and it is the stop that sends the visitor on to step 3.
    const visitorIp = clientIp(req);
    const blocked = await takeFreePreview(visitorIp, tiles.length);
    if (blocked === 'visitor') {
      // Not a generic error. The site reads this and moves the customer into
      // step 3 to name their child and choose a theme, which is where they were
      // always going - they have simply seen all the free drawing they get.
      return res.status(429).json({
        error: 'You have used up today\'s free previews.',
        quotaExhausted: true,
        advanceToNextStep: true,
        freePreviewsPerDay: FREE_PREVIEWS_PER_IP
      });
    }
    if (blocked === 'site') {
      return res.status(429).json({
        error: 'We are busier than usual and free previews are paused for a few minutes. Please try again shortly.',
        quotaExhausted: false
      });
    }
    chargedTo = visitorIp;
    charged = tiles.length;

    const references = (familyPhotos.length ? familyPhotos : [singlePhoto]).map((file, i) => ({
      buffer: file.buffer,
      mimetype: file.mimetype,
      filename: file.originalname || `photo-${i + 1}.png`
    }));

    // Four at once. Each tile stands alone, so one refusal by OpenAI costs that
    // tile and not the grid - the visitor still sees the other three.
    const drawn = await Promise.all(tiles.map(async (tile) => {
      const prompt = buildPrompt(tile.theme, tile.sceneIndex, childCount,
        audience === 'adult' ? 'adult' : 'kid', '', cast, DEFAULT_DETAIL);
      try {
        const image = await renderScene({ photos: references, prompt, paid: false });
        return { theme: tile.theme, label: tile.label, image };
      } catch (err) {
        console.error(`Style preview (${tile.theme}) failed -`, err.message);
        return { theme: tile.theme, label: tile.label, image: null, error: 'Could not draw this style.' };
      }
    }));

    // Give back what was taken and not used. A tile that drew nothing cost the
    // visitor an image and handed them no picture.
    const missed = drawn.filter((t) => !t.image).length;
    if (missed) {
      await giveBackFreePreview(chargedTo, missed);
      charged -= missed;
    }
    chargedTo = null;

    if (missed === tiles.length) {
      return res.status(502).json({ error: 'The preview could not be drawn. Please try again in a moment.' });
    }
    res.json({ audience, styles: drawn });
  } catch (err) {
    console.error('Style preview failed:', err);
    if (chargedTo && charged) await giveBackFreePreview(chargedTo, charged);
    res.status(500).json({ error: 'Could not draw the preview.' });
  }
});

// photo: the single-subject book, unchanged. photos: a family book, one file per
// person, in the same order as the people field that names them.
app.post('/convert', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'photos', maxCount: MAX_PEOPLE }
]), async (req, res) => {
  // Declared out here, not inside the try, because the catch at the bottom has
  // to be able to see whether a preview was charged for.
  let previewTakenFrom = null;
  try {
    const singlePhoto = (req.files && req.files.photo && req.files.photo[0]) || null;
    const familyPhotos = (req.files && req.files.photos) || [];
    if (!singlePhoto && !familyPhotos.length) {
      return res.status(400).json({ error: 'No photo uploaded.' });
    }

    // Sent as JSON text because this request is multipart, not JSON. A family
    // needs a name per photo; without them the model has no way to tell the
    // photos apart, so a mismatch is refused rather than guessed at.
    let cast = [];
    if (req.body.people) {
      try {
        cast = cleanPeople(JSON.parse(req.body.people));
      } catch (err) {
        return res.status(400).json({ error: 'Could not read the list of people.' });
      }
    }
    if (familyPhotos.length && cast.length !== familyPhotos.length) {
      return res.status(400).json({
        error: `Send one name per photo: ${familyPhotos.length} photo(s) but ${cast.length} name(s).`
      });
    }
    if (!CAN_CALL_OPENAI) {
      return res.status(500).json({ error: 'Server is missing its OpenAI API key.' });
    }

    const theme = req.body.theme || 'Portrait';
    const sceneIndex = parseInt(req.body.sceneIndex, 10) || 0;

    // The paywall. The first FREE_PREVIEW_PAGES scenes are open so a visitor
    // can see their own child as line art; everything past that needs a paid
    // order. Without this check anyone could just loop /convert and take the
    // whole book for free, at our OpenAI expense.
    let paidOrder = null;
    let previewOrder = null;
    if (sceneIndex < FREE_PREVIEW_PAGES) {
      // Nobody has paid for this one yet, so it has to be rationed.
      const visitorIp = clientIp(req);
      const blocked = await takeFreePreview(visitorIp);
      if (blocked === 'visitor') {
        return res.status(429).json({
          error: 'You have used up today\'s free previews. Finish an order to get the whole book now.'
        });
      }
      if (blocked === 'site') {
        return res.status(429).json({
          error: 'We are busier than usual and free previews are paused for a few minutes. Please try again shortly.'
        });
      }
      previewTakenFrom = visitorIp;
      // A preview still belongs to an order. Identify it - payment not required
      // - so the drawn page can be kept. Then a retry after a dropped phone
      // connection costs nothing instead of paying OpenAI to draw it twice.
      if (req.body.orderId && req.body.token) {
        previewOrder = await db.authorizeOrder(req.body.orderId, req.body.token);
      }
    } else {
      paidOrder = await db.authorizeOrder(req.body.orderId, req.body.token);
      if (!paidOrder) {
        return res.status(403).json({ error: 'Unknown order or bad token.' });
      }
      if (!paidOrder.paid) {
        return res.status(402).json({
          error: 'Payment required for the rest of the book.',
          freePreviewPages: FREE_PREVIEW_PAGES
        });
      }
    }
    let childCount = parseInt(req.body.childCount, 10) || 1;
    childCount = Math.min(Math.max(childCount, 1), 3);
    const subjectType = req.body.subjectType === 'adult' ? 'adult' : 'kid';
    const notes = (req.body.notes || '').slice(0, 300);
    // A paid order draws from what it was sold with; a free preview takes the
    // browser's word for it. Either way something is always chosen.
    const detailLevel = paidOrder ? paidOrder.detailLevel : normalizeDetail(req.body.detailLevel);

    const prompt = buildPrompt(theme, sceneIndex, childCount, subjectType, notes, cast, detailLevel);

    let image;
    try {
      const references = (familyPhotos.length ? familyPhotos : [singlePhoto]).map((file, i) => ({
        buffer: file.buffer,
        mimetype: file.mimetype,
        filename: file.originalname || `photo-${i + 1}.png`
      }));
      image = await renderScene({ photos: references, prompt, paid: paidOrder !== null });
    } catch (renderErr) {
      console.error('OpenAI error:', renderErr.message);
      // No image, so no preview was used. Give it back before answering.
      if (previewTakenFrom) await giveBackFreePreview(previewTakenFrom);
      // A free preview that would not draw is not a dead end any more. Mark it
      // and the sweep will finish it in the background and email the pages, so
      // a bad two minutes at OpenAI does not cost a customer who did nothing
      // wrong. Only previews: a paid order already has its own resume.
      if (previewOrder && !previewOrder.paid) {
        try {
          await db.markPreviewRescue(previewOrder.id);
          console.log(`Order ${previewOrder.id}: preview failed, queued to finish and email.`);
        } catch (markErr) {
          console.error('Could not queue a failed preview:', markErr.message);
        }
      }
      return res.status(502).json({ error: 'Image conversion failed.', detail: renderErr.message });
    }

    // Keep the artwork so it can be downloaded again later, and so a retry
    // never redraws something we already have. A failure here must not cost the
    // customer the page, so it only warns.
    const storeFor = paidOrder || previewOrder;
    if (storeFor) {
      try {
        await db.savePage(storeFor.id, sceneIndex, image);
      } catch (storeErr) {
        console.error('Could not store page:', storeErr.message);
      }
    }

    // Logged on success too. Without this a page that was drawn but never
    // reached the customer looks identical to one that was never drawn.
    console.log(`Converted scene ${sceneIndex + 1} (${paidOrder ? 'paid' : 'preview'})`
      + (storeFor ? ` for order ${storeFor.id}` : '') + '.');

    res.json({ image, sceneIndex });
  } catch (err) {
    console.error(err);
    // Same reasoning as the render failure: whatever went wrong in here, the
    // visitor is not getting a page out of it, so they keep their preview.
    if (previewTakenFrom) await giveBackFreePreview(previewTakenFrom);
    res.status(500).json({ error: 'Server error converting image.' });
  }
});

// ---------------------------------------------------------------------------
// Sample pages for the site
// ---------------------------------------------------------------------------
// Finished pages from books we rendered ourselves, served so the site can
// scatter them around its "this is what you get" block. They are AI-generated
// stand-ins, not customer work - keep it that way unless a customer puts it in
// writing.
//
// Read once at boot rather than per request: the folder only changes when we
// deploy, and this route is hit by every visitor.
const SAMPLES_DIR = path.join(__dirname, 'public', 'samples');
const SAMPLE_PAGES = (() => {
  try {
    return fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.webp')).sort();
  } catch (err) {
    // No folder is not a broken server - the site just shows its block bare.
    console.warn('No sample pages found:', err.message);
    return [];
  }
})();

app.get('/samples.json', (req, res) => {
  res.json({ base: '/samples/', pages: SAMPLE_PAGES });
});

// Content-hashed they are not, but the names are stable and the files only
// change on deploy, so a long cache is safe and saves the bandwidth.
app.use('/samples', express.static(SAMPLES_DIR, { maxAge: '30d', immutable: true }));
app.use('/embed', express.static(path.join(__dirname, 'public', 'embed'), { maxAge: '1h' }));

app.get('/', (req, res) => {
  res.send('Coloring book conversion server is running.');
});

// Simple health check — also reports which storage engine is live, so you can
// tell at a glance whether DATABASE_URL actually took effect on Render.
// Plain /health touches nothing: db.status() is in-memory. That matters because
// a platform health check hitting this every thirty seconds would hold the
// database awake on its own, which is the very thing being fixed below.
//
// The numbers worth having - order count, storage figures - are behind ?full=1,
// for when someone is actually looking.
app.get('/health', async (req, res) => {
  const state = db.status();
  if (!req.query.full) {
    return res.json({
      ok: true, storage: state.storage, dbReady: state.ready,
      email: mailer.configured ? 'configured' : 'not configured',
      note: 'add ?full=1 for order counts and storage sizes (wakes the database)'
    });
  }
  try {
    const count = await db.countOrders();
    // Both storage figures, side by side, because they are not the same number
    // and the difference is exactly what makes a ceiling easy to set wrongly.
    // Read the one the watchdog is using and set its ceiling from that.
    const src = storageSource();
    const sizes = { source: src.source, ceilingBytes: src.ceilingBytes || null };
    try { sizes.pgDatabaseBytes = await db.databaseSizeBytes(); } catch (e) { sizes.pgDatabaseBytes = null; }
    if (neon.configured()) {
      try { sizes.neonSyntheticBytes = await neon.storageBytes(); }
      catch (e) { sizes.neonSyntheticBytes = null; sizes.neonError = e.message; }
    }
    if (sizes.ceilingBytes) {
      const used = src.source === 'neon' ? sizes.neonSyntheticBytes : sizes.pgDatabaseBytes;
      if (used) sizes.percentOfCeiling = Math.round((used / sizes.ceilingBytes) * 100);
    }
    res.json({ ok: true, storage: state.storage, dbReady: state.ready, orders: count, email: mailer.configured ? 'configured' : 'not configured', sizes });
  } catch (err) {
    res.status(500).json({ ok: false, storage: state.storage, dbReady: state.ready, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

// Bind the port FIRST. If the database is asleep or unreachable, the service
// still starts and /health reports the problem, instead of the whole deploy
// failing because the host never saw a port open.

db.initDb().catch((err) => {
  console.error('Database init failed:', err.message);
});

// Customers get RETENTION_DAYS to re-download their book. After that the pages
// and everything personal are deleted, leaving only the sales record. The photo
// itself goes much sooner - as soon as the book is drawn - so this is the
// backstop for the rest, and for orders that never finished at all.
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || process.env.PHOTO_RETENTION_DAYS, 10) || 30;
// Counters hold no personal data, so they can outlive the orders they came
// from - long enough to compare this month against last.
const EVENT_RETENTION_DAYS = parseInt(process.env.EVENT_RETENTION_DAYS, 10) || 180;
async function purgeOldData() {
  try {
    const n = await db.purgeOldOrders(RETENTION_DAYS);
    if (n > 0) console.log(`Purged ${n} order(s) older than ${RETENTION_DAYS} days: pages and personal details deleted.`);
    const e = await db.purgeOldEvents(EVENT_RETENTION_DAYS);
    if (e > 0) console.log(`Purged ${e} funnel counter(s) older than ${EVENT_RETENTION_DAYS} days.`);
  } catch (err) {
    console.error('Retention purge failed:', err.message);
  }
}
// unref'd: janitorial, and must not keep a process alive on its own.
setTimeout(purgeOldData, 60 * 1000).unref();
setInterval(purgeOldData, 6 * 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// The watchdog. Jonathan is often driving, so this exists to say something
// before a customer does.
// ---------------------------------------------------------------------------

const ALERT_EMAIL = process.env.ALERT_EMAIL || '';
// The Render plan this runs on: 1 CPU, 2 GB. Overridable because the whole
// point of the memory warning is to prompt moving to a bigger one.
const INSTANCE_MEMORY_BYTES = parseInt(process.env.INSTANCE_MEMORY_BYTES, 10) || 2 * 1024 * 1024 * 1024;
// Storage has two possible sources and they measure different things, so each
// gets its own ceiling. Setting the wrong pair is the mistake worth designing
// out: a Neon plan limit compared against pg_database_size reads far lower than
// reality, and the warning never arrives.
//
//   NEON_STORAGE_LIMIT_BYTES  goes with Neon's synthetic size. This is the one
//                             the plan caps, so it is the one to prefer.
//   PG_CEILING_BYTES          goes with pg_database_size. Only meaningful if
//                             calibrated against that same number - read it off
//                             /health rather than guessing.
//
// Neither set means the check does nothing, which is better than measuring
// against a number nobody confirmed.
const NEON_STORAGE_LIMIT_BYTES = parseInt(process.env.NEON_STORAGE_LIMIT_BYTES, 10) || 0;
const PG_CEILING_BYTES = parseInt(process.env.PG_CEILING_BYTES, 10) || 0;

function storageSource() {
  if (neon.configured() && NEON_STORAGE_LIMIT_BYTES) {
    return { source: 'neon', ceilingBytes: NEON_STORAGE_LIMIT_BYTES, neonBytes: () => neon.storageBytes() };
  }
  return { source: 'postgres', ceilingBytes: PG_CEILING_BYTES, neonBytes: async () => null };
}

if (process.env.DB_CEILING_BYTES) {
  console.warn('DB_CEILING_BYTES is no longer read: it was ambiguous about which '
    + 'number it capped. Use NEON_STORAGE_LIMIT_BYTES (with NEON_API_KEY and '
    + 'NEON_PROJECT_ID) or PG_CEILING_BYTES. See /health for both figures.');
}
const WATCHDOG_MINUTES = parseInt(process.env.WATCHDOG_MINUTES, 10) || 5;

function watchdogRuntime() {
  return {
    memoryBytes: process.memoryUsage().rss,
    memoryLimitBytes: INSTANCE_MEMORY_BYTES,
    renderingNow: rendering.size,
    maxConcurrent: MAX_CONCURRENT_BOOKS,
    openAiErrors: openAiTroubleIn(WATCHDOG_MINUTES * 3),
    previewsThisHour: sitePreviewWindow.count,
    previewLimitPerHour: FREE_PREVIEWS_PER_HOUR,
    previewLimitPerVisitorPerDay: FREE_PREVIEWS_PER_IP,
    previewDayTimeZone: PREVIEW_DAY_TZ
  };
}

// Subject lines carry the state, so the phone screen alone is the message.
async function sendAlert({ level, subject, lines }) {
  const tag = level === 'CLEAR' ? 'RESOLVED' : level;
  const full = `[${tag}] ${subject}`;
  console.log(`Watchdog alert: ${full}`);
  if (!ALERT_EMAIL || !mailer.configured) return false;
  const text = lines.join('\n\n') + '\n\n-- \nCrayonauts watchdog';
  await mailer.sendMail({
    to: ALERT_EMAIL,
    subject: full,
    text,
    html: '<pre style="font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;white-space:pre-wrap">'
      + text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>'
  });
  return true;
}

// ---------------------------------------------------------------------------
// The Thursday payout report, emailed.
//
// This used to be a scheduled task on Jonathan's computer, because that is
// where the Stripe key lives. Which meant the report only ran if the laptop
// happened to be awake at 8am on a Thursday - and he drives a truck. A
// payout report that silently does not run on the morning people are owed
// money is worse than no report, because nothing tells you it did not run.
//
// Render has the Stripe key and is awake anyway, so it does it here and mails
// the result. Nothing has to be switched on, nobody has to be home, and he
// reads it on his phone.
const PAYOUT_REPORT_TZ = process.env.PAYOUT_REPORT_TZ || 'America/New_York';
const PAYOUT_REPORT_HOUR = parseInt(process.env.PAYOUT_REPORT_HOUR, 10) || 8;
// Thursday, with Sunday as 0 - the morning after the pay week closes.
const PAYOUT_REPORT_DOW = 4;
// Jerrell negotiated 25 and is the only exception. Anyone else is on the
// CREATOR_RATE_PERCENT default, which the sign-up form also writes into each
// code's metadata. Kept as an env var so a second exception does not need a
// deploy.
const PAYOUT_REPORT_RATES = process.env.PAYOUT_REPORT_RATES || 'JERRELL=25';

// What day and hour it is where the creators were promised their week runs.
function localNow(at, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(at);
  const get = (t) => (f.find((p) => p.type === t) || {}).value;
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    dow: days[get('weekday')]
  };
}

async function runPayoutReport(at = new Date()) {
  const lines = [];
  const warnings = [];
  await affiliateReport({
    argv: ['--period', '--tz', PAYOUT_REPORT_TZ, '--rates', PAYOUT_REPORT_RATES],
    key: STRIPE_SECRET_KEY,
    now: at,
    print: (...a) => lines.push(a.join(' ')),
    warn: (...a) => warnings.push(a.join(' '))
  });
  return { lines, warnings };
}

// Checked hourly rather than scheduled to the minute, so a redeploy cannot
// land on the one minute it would have fired in and skip the week.
async function maybeSendPayoutReport(at = new Date()) {
  const here = localNow(at, PAYOUT_REPORT_TZ);
  if (here.dow !== PAYOUT_REPORT_DOW || here.hour !== PAYOUT_REPORT_HOUR) return 'not now';
  if (!STRIPE_SECRET_KEY) { console.error('Payout report: no Stripe key.'); return 'no key'; }

  // Claimed before the work, not after. If Stripe is slow and the hourly timer
  // comes round again, the second run finds the row already there and stops
  // rather than sending a second, different-looking total.
  let claimed = false;
  try {
    claimed = await db.claimJobRun('payout-report', here.date);
  } catch (err) {
    console.error('Payout report: could not claim the run -', err.message);
    return 'claim failed';
  }
  if (!claimed) return 'already sent';

  let report;
  try {
    report = await runPayoutReport(at);
  } catch (err) {
    // Loud, and to the same inbox. A payout report that failed is itself the
    // thing he needs to know on a Thursday morning.
    console.error('Payout report failed:', err.message);
    await sendAlert({
      level: 'WARN',
      subject: 'Payout report did not run',
      lines: ['The weekly creator payout report could not be produced.',
        err.message,
        'Nobody has been paid off this. Run it by hand before paying anyone:',
        'node scripts/affiliate-report.js --period --rates ' + PAYOUT_REPORT_RATES]
    }).catch(() => {});
    return 'failed';
  }

  const body = report.warnings.length
    ? report.warnings.join('\n') + '\n' + report.lines.join('\n')
    : report.lines.join('\n');
  await sendAlert({
    level: 'PAYOUT',
    subject: 'Creator payouts - pay these today',
    lines: [body.trim()]
  });
  console.log('Payout report emailed for ' + here.date);
  return 'sent';
}

// The only two things it is allowed to do on its own.
async function rekickOrder(orderId) {
  if (rendering.has(String(orderId))) throw new Error('already rendering');
  await renderBook(orderId);
}

async function resendReadyEmail(orderId) {
  const order = await db.getOrderForRender(orderId);
  if (!order) throw new Error('order not found');
  if (!order.email) throw new Error('no email address on the order');
  const done = await db.countPages(orderId);
  if (done <= 0) throw new Error('no pages to send');
  let pdf = null;
  try { pdf = await bookPdf(order); } catch (e) { /* link-only is still an email */ }
  await emailBookReady({ order, pdf, pageCount: done });
}

function watchdogContext() {
  return {
    db,
    runtime: watchdogRuntime(),
    storage: storageSource(),
    send: sendAlert,
    rekickOrder,
    resendReadyEmail
  };
}

let watching = false;
async function runWatchdogOnce() {
  if (watching) return;
  watching = true;
  try {
    const out = await watchdog.runWatchdog(watchdogContext());
    // An open alert is a reason to keep looking: we want to notice it clearing
    // promptly, and to escalate it if it worsens.
    watchdogHasOpenAlerts = (out.findings || []).length > 0;
  } catch (err) {
    console.error('Watchdog run failed:', err.message);
  } finally {
    watching = false;
  }
}

if (process.env.NODE_ENV !== 'test') {
  // The watchdog is driven by the heartbeat below, not its own timer: two
  // timers would wake the database twice as often for no extra safety.

  // The daily digest, at 8am UTC-ish - checked hourly so a restart cannot skip
  // the one minute it would have fired in.
  let lastDigestDay = null;
  setInterval(async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== 8 || lastDigestDay === day) return;
    lastDigestDay = day;
    try {
      await watchdog.dailyDigest(watchdogContext());
    } catch (err) {
      console.error('Watchdog digest failed:', err.message);
    }
  }, 60 * 60 * 1000).unref();

  // Its own hourly timer, and deliberately not folded into the one above: the
  // digest returns early on 23 hours out of 24, and hanging the payout report
  // off that would mean one missed digest takes the payout report with it.
  setInterval(async () => {
    try {
      await maybeSendPayoutReport();
    } catch (err) {
      console.error('Payout report check failed:', err.message);
    }
  }, 60 * 60 * 1000).unref();
}

// ---------------------------------------------------------------------------
// Letting the database go to sleep.
//
// Neon bills compute by time awake, not by queries, and suspends after about
// five minutes with no activity. That makes the SHAPE of our polling the whole
// cost: a query costs nothing, but every query that arrives on an idle database
// buys another five minutes of awake time.
//
// Measured: 30.5 CU-hours over 5 days is 0.25 CU running continuously - it was
// never suspending at all. The resume sweep ran every 60 seconds whether or not
// there was anything to resume, so the five-minute timer never once ran out.
//
//   every 60s   the idle timer never expires          ~180 CU-h/month
//   every 5m    288 wakes x 5 min = awake all day     ~180 CU-h/month
//   every 30m    48 wakes x 5 min = ~4 h/day          ~30 CU-h/month
//   every 60m    24 wakes x 5 min = ~2 h/day          ~15 CU-h/month
//
// The free plan allows 191.9 CU-hours a month, which is why this mattered.
//
// Note the second row: the watchdog polling every five minutes would have kept
// the database awake by itself. Fixing the sweep alone would have achieved
// nothing, so both now share one idle schedule and wake it together.
//
// So: poll quickly while there is any reason to, and rarely when there is not.
// "Reason to" is a render in flight, something having happened recently, or an
// open alert we are waiting to see clear. Anything that could create work marks
// activity, which drops it straight back to the fast cadence.
// ---------------------------------------------------------------------------

const ACTIVE_WINDOW_MS = parseInt(process.env.ACTIVE_WINDOW_MINUTES, 10) * 60000 || 15 * 60 * 1000;
const IDLE_POLL_MS = (parseInt(process.env.IDLE_POLL_MINUTES, 10) || 30) * 60 * 1000;
const SWEEP_MS = 60 * 1000;

let lastActivityAt = Date.now();
let watchdogHasOpenAlerts = false;

// Called from anywhere that means work might exist: an order placed, a payment
// landing, a render starting or finishing. Cheap on purpose - it is only a
// timestamp, and it is what decides whether the database gets to sleep.
function noteActivity() { lastActivityAt = Date.now(); }

function busy() {
  return rendering.size > 0
    || (Date.now() - lastActivityAt) < ACTIVE_WINDOW_MS
    || watchdogHasOpenAlerts;
}

// The decision, pulled out so it can be tested without timers. Every argument
// is a reason to stay awake; none of them, and the database gets to sleep.
function pollDelayMs({ rendering = 0, sinceActivityMs = Infinity, openAlerts = false,
                       activeWindowMs = ACTIVE_WINDOW_MS, sweepMs = SWEEP_MS,
                       idleMs = IDLE_POLL_MS } = {}) {
  const awake = rendering > 0 || sinceActivityMs < activeWindowMs || openAlerts;
  return awake ? sweepMs : idleMs;
}

// A book is drawn in this process's memory, so a restart - a deploy, a crash,
// Render moving the instance - used to abandon whatever was mid-render, and
// nothing ever picked it up again. The customer had paid. This sweep finds
// those orders and finishes them. renderBook skips pages that already exist,
// so resuming costs only the pages that are actually missing.
const MAX_RENDER_ATTEMPTS = parseInt(process.env.MAX_RENDER_ATTEMPTS, 10) || 5;
// How long the first retry waits, doubling each time after that: 2, 4, 8, 16,
// 32 minutes. Five attempts a minute apart is not five chances, it is one bad
// minute - a fifteen-minute OpenAI outage used to spend every attempt an order
// had and strand it after the outage cleared.
const RENDER_BACKOFF_MINUTES = parseFloat(process.env.RENDER_BACKOFF_MINUTES) || 2;
let sweeping = false;
async function resumeUnfinished() {
  if (sweeping) return;
  sweeping = true;
  try {
    const free = MAX_CONCURRENT_BOOKS - rendering.size;
    if (free <= 0) return;
    const ids = await db.resumableOrders(MAX_RENDER_ATTEMPTS, RENDER_BACKOFF_MINUTES);
    const waiting = ids.filter((id) => !rendering.has(String(id)));
    if (waiting.length === 0) return;
    const starting = waiting.slice(0, free);
    console.log(`Starting ${starting.length} waiting order(s): ${starting.join(', ')}`
      + (waiting.length > starting.length ? ` (${waiting.length - starting.length} still queued)` : ''));
    // Started, not awaited: renderBook claims its slot synchronously, so the
    // cap holds, and this sweep does not sit here for the length of a book.
    starting.forEach((id) => {
      renderBook(id).catch((err) =>
        console.error(`Order ${id}: resume failed -`, err.message));
    });
  } catch (err) {
    console.error('Resume sweep failed:', err.message);
  } finally {
    sweeping = false;
  }
}
// Finishing a free preview that would not draw, and posting it.
//
// The case this exists for: on 21 September OpenAI's safety system refused five
// draws inside nine minutes. The browser retries three times, but all three
// land inside the first two minutes, so every one of them failed and four books
// came to nothing. The same photos drew without complaint an hour later.
//
// So the order is kept and tried again on a schedule shaped like those
// outages - a minute, then four, then ten - and when the pages come out they
// are emailed. Three goes and then it stops: past that the customer has moved
// on and we are paying OpenAI to talk to ourselves.
//
// Only unpaid orders, and only ones where a draw actually failed. Somebody who
// wandered off mid-flow is not a failure and must not be drawn for or emailed.
const PREVIEW_RESCUE_ATTEMPTS = parseInt(process.env.PREVIEW_RESCUE_ATTEMPTS, 10) || 3;
const PREVIEW_RESCUE_DELAYS = (process.env.PREVIEW_RESCUE_DELAYS || '1,4,10')
  .split(',').map((x) => parseFloat(x)).filter((x) => x > 0);
const rescuing = new Set();

async function rescuePreview(orderId) {
  if (rescuing.has(String(orderId))) return;
  rescuing.add(String(orderId));
  try {
    const order = await db.getOrderForRender(orderId);
    if (!order) return;
    // Paid in the meantime: the real render owns it now, and it will draw the
    // whole book rather than the two pages this was going to send.
    if (order.paid) return;
    if (order.previewEmailedAt) return;

    await db.notePreviewAttempt(orderId);

    const cast = cleanPeople(order.people);
    const isFamily = cast.length > 1;
    if (!isFamily && !order.photo) return;
    if (isFamily && !cast.every((p) => p.photo)) return;

    const references = isFamily
      ? cast.map((person, i) => {
          const { buffer, mimetype } = dataUrlToBuffer(person.photo);
          return { buffer, mimetype, filename: `person-${i + 1}.png` };
        })
      : [(() => {
          const { buffer, mimetype } = dataUrlToBuffer(order.photo);
          return { buffer, mimetype, filename: 'photo.png' };
        })()];

    const scenes = STORY_SCENES[order.theme] || STORY_SCENES['Portrait'];
    const wanted = Math.min(FREE_PREVIEW_PAGES, scenes.length);
    const already = new Set(await db.doneSceneIndexes(orderId));
    const subjectType = order.subjectType === 'adult' ? 'adult' : 'kid';
    // Held here as well as saved, because what gets attached has to be what we
    // actually have in hand. Reading them back is the better source when it
    // works - it is the stored, re-encoded copy - but a page drawn a second ago
    // and not readable yet is still a page the customer should be sent.
    const drawn = new Map();

    // One at a time. This is unpaid work being done to rescue a customer, and
    // it must never be the reason a paid book waits - renderScene queues it
    // behind paid pages, and a single lane keeps it out of the way besides.
    for (let sceneIndex = 0; sceneIndex < wanted; sceneIndex++) {
      if (already.has(sceneIndex)) continue;
      const prompt = buildPrompt(order.theme, sceneIndex, order.childCount,
        subjectType, order.notes, cast, order.detailLevel);
      try {
        const image = await renderScene({ photos: references, prompt, paid: false });
        await db.savePage(orderId, sceneIndex, image);
        drawn.set(sceneIndex, image);
        already.add(sceneIndex);
        console.log(`Order ${orderId}: rescued preview page ${sceneIndex + 1}.`);
      } catch (err) {
        console.error(`Order ${orderId}: preview page ${sceneIndex + 1} failed again - ${err.message}`);
      }
    }

    // Nothing drawn, nothing to say. It keeps its place in the queue for the
    // next attempt, and after the third it simply stops.
    if (!already.size) return;
    if (!order.email || !mailer.configured) return;

    // Claimed before sending, so two processes sweeping together cannot both
    // post the same pages to the same person.
    if (!(await db.claimPreviewEmail(orderId))) return;
    try {
      const stored = new Map();
      for (const page of await db.listPages(orderId)) stored.set(page.sceneIndex, page.image);
      const attachments = [];
      for (let i = 0; i < wanted; i++) {
        const image = stored.get(i) || drawn.get(i);
        if (!image) continue;
        const { buffer, mimetype } = dataUrlToBuffer(image);
        attachments.push({
          filename: `page-${i + 1}.png`,
          contentType: mimetype || 'image/png',
          content: buffer
        });
      }
      // Claimed but nothing to put in the envelope. Hand it back rather than
      // sending an apology with no pages in it, which is worse than silence.
      if (!attachments.length) {
        await db.releasePreviewEmail(orderId).catch(() => {});
        return;
      }
      const msg = mailer.previewReadyEmail({
        childName: order.childName,
        orderId: order.id,
        accessToken: order.accessToken,
        siteUrl: SITE_URL,
        pageCount: attachments.length,
        totalPages: scenes.length
      });
      await mailer.sendMail({
        to: order.email, subject: msg.subject, text: msg.text, html: msg.html, attachments
      });
      console.log(`Order ${orderId}: late preview emailed with ${attachments.length} page(s).`);
    } catch (mailErr) {
      // Hand the send back, or a bounced email looks exactly like a delivered
      // one and nobody ever tries again.
      await db.releasePreviewEmail(orderId).catch(() => {});
      console.error(`Order ${orderId}: could not email the late preview - ${mailErr.message}`);
    }
  } finally {
    rescuing.delete(String(orderId));
  }
}

async function rescueFailedPreviews() {
  try {
    const ids = await db.rescuablePreviews(PREVIEW_RESCUE_ATTEMPTS, PREVIEW_RESCUE_DELAYS);
    for (const id of ids) {
      if (rescuing.has(String(id))) continue;
      rescuePreview(id).catch((err) =>
        console.error(`Order ${id}: preview rescue failed -`, err.message));
    }
  } catch (err) {
    console.error('Preview rescue sweep failed:', err.message);
  }
}

// One timer for both the resume sweep and the watchdog. Separate timers would
// wake the database twice as often for no extra safety, and it is the number of
// wakes that costs, not the work done in them.
let heartbeatTimer = null;
let lastWatchdogAt = 0;

async function heartbeat() {
  try {
    await resumeUnfinished();
    await rescueFailedPreviews();
    // While busy the sweep runs every minute, but the watchdog has nothing new
    // to say that often. When idle they share the one wake.
    const due = Date.now() - lastWatchdogAt >= WATCHDOG_MINUTES * 60 * 1000;
    if (due || !busy()) {
      lastWatchdogAt = Date.now();
      await runWatchdogOnce();
    }
  } catch (err) {
    console.error('Heartbeat failed:', err.message);
  } finally {
    scheduleHeartbeat();
  }
}

function scheduleHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  const delay = busy() ? SWEEP_MS : IDLE_POLL_MS;
  heartbeatTimer = setTimeout(heartbeat, delay);
  heartbeatTimer.unref();
}

// Something happened, so stop dawdling: come back on the fast cadence rather
// than waiting out the rest of a half-hour idle sleep.
function wakeUp() {
  noteActivity();
  if (heartbeatTimer) scheduleHeartbeat();
}

// Only when run as the server. Required as a module - by a test, or by
// scripts/render-test-book.js - this file hands back the prompt and render
// helpers without opening a port or starting the resume sweeps.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  // Once shortly after boot: a deploy or a crash is exactly when an order gets
  // abandoned mid-render, and it is the one case polling cannot be lazy about.
  setTimeout(() => { heartbeat(); }, 20 * 1000);
}

module.exports = { app, previewDay, clientIp, localNow, maybeSendPayoutReport, runPayoutReport, cleanCreatorCode, reservedCreatorCode, looksLikeEmail, CREATOR_SIGNUPS_PER_IP, CREATOR_FREE_BOOKS_PER_DAY, CREATOR_RATE_PERCENT, STATEMENT_DESCRIPTOR_SUFFIX, MAX_ATTACHMENT_BYTES, bookPdf, emailBookReady,
  sendAlert, watchdogRuntime, pollDelayMs, buildPrompt, renderScene, maybeMirror,
  rescuePreview, rescueFailedPreviews, FREE_PREVIEW_PAGES, STYLE_GRID, STYLE_GRID_SIZE, styleGridFor, FREE_PREVIEWS_PER_IP, canCallOpenAI: CAN_CALL_OPENAI, cleanPeople, MAX_PEOPLE, STORY_SCENES, SHOTS, BASE_STYLE, THEME_OUTFITS, wardrobeLine, SAMPLE_PAGES, DETAIL_LEVELS, DEFAULT_DETAIL, normalizeDetail };
