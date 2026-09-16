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
const FREE_PREVIEWS_PER_IP = parseInt(process.env.FREE_PREVIEWS_PER_IP, 10) || 8;
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
      const order = await db.markPaid(session.id, session.amount_total);
      console.log(order ? `Order ${order.id} marked paid.` : `No order for session ${session.id}.`);

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

// Creates a Stripe Checkout Session for an order and returns the URL to send
// the customer to. Called with the order id and the access token we handed the
// browser when the order was created.
app.post('/checkout', async (req, res) => {
  const { orderId, token, product } = req.body || {};
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
    form.append('success_url', `${SITE_URL}?paid=1&order=${order.id}`);
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

    // Influencer codes. Stripe hosts the box, the codes live in the Stripe
    // dashboard one per influencer, and the code someone types IS the
    // attribution - Stripe reports sales per promotion code, so there is no
    // affiliate software to run.
    //
    // This has to be appended before the consent copy below is taken, or only
    // one of the two sessions carries it and the box disappears on whichever
    // path was missed. Never add a discounts[] parameter alongside it: Stripe
    // rejects a session that sets both.
    form.append('allow_promotion_codes', 'true');

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

const BASE_STYLE = 'Black and white coloring book page, clean bold outlines only, no shading, no gray tones, no text or captions of any kind - every sign, label, jar, book, cushion, picture frame and gift tag is left blank, with no letters, words or numbers anywhere in the picture - simple line art suitable for a child to color in. Draw all hair as open white space with only a few clean curved outline strands - never fill hair with solid black, dense scribbles or crosshatching, no matter how dark or curly the hair is in the photo. Every part of the drawing must be left white so a child can color it in.';

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
function castLine(people) {
  const star = pickStar(people);
  const described = people.map((p) => {
    const kind = p.subjectType === 'adult' ? 'an adult' : 'a child';
    return `${p.name} (${kind})`;
  });
  const list = described.length > 1
    ? described.slice(0, -1).join(', ') + ' and ' + described[described.length - 1]
    : described[0];
  return `There is one reference photo per person, in this same order: ${list}. `
    + 'Each photo shows only that person; use it for their face, hair and features and nobody else\'s. '
    + 'Keep every one of them recognisable on every page they appear, and draw them at their own age - '
    + 'the adults as adults and the children as children, never all the same size. '
    + 'Recognisable means the same likeness, not the same pose: vary posture, expression and viewing '
    + 'angle from scene to scene. Show the family together, doing the scene as a group, '
    + `and keep ${star.name} at the centre of it: this is ${star.name}'s story and the rest of the `
    + `family are there with ${star.name}, never instead of ${star.name}.`;
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
    'the child walking hand in hand with a grandchild in the park',
    'the child sitting on a porch swing watching the sunset',
    'the child blowing out candles on a birthday cake',
    'the child waving warmly from a front porch, welcoming guests'
  ]
};

// people is optional: pass it for a family book, where each person has their own
// photo and their own name, and leave it out for the single-subject book, which
// still works off childCount and one photo exactly as it always did.
function buildPrompt(theme, sceneIndex, childCount, subjectType, notes, people) {
  const scenes = STORY_SCENES[theme] || STORY_SCENES['Portrait'];
  let scene = scenes[sceneIndex] || scenes[0];
  const cast = cleanPeople(people);
  const isFamily = cast.length > 1;

  // The scenes are written around "the child". A family does the same thing
  // together, so the subject becomes the family and the verb follows it.
  const subject = isFamily ? 'the family' : subjectPhrase(childCount, subjectType);
  if (isFamily || childCount > 1) {
    scene = scene.replace(/\bthe child\b(\s+)([a-z]+)/g, (match, gap, word) => subject + gap + (isFamily ? word : pluralizeVerb(word)));
  }
  scene = scene.replace(/\bthe child\b/g, subject);
  const who = isFamily ? castLine(cast) : consistencyLine(childCount, subjectType);
  let prompt = `${BASE_STYLE} ${who} ${isFamily ? PHOTO_USE_MANY : PHOTO_USE} Scene: ${scene}.`;
  prompt += ` Camera: ${SHOTS[sceneIndex % SHOTS.length]}.`;
  if (notes && notes.trim()) {
    prompt += ` Also incorporate this detail where it fits naturally: ${notes.trim()}.`;
  }
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
// Off by default, and that is a retreat.
//
// Flipping was done blind at first, on the grounds that BASE_STYLE rules out
// text so there would be no lettering to reverse. The model letters signs and
// jars anyway, and four pages in a sixty-page run shipped reading right to
// left. The fix was to read each page for words first - but the first reader
// missed all six real cases, and the replacement (mirror-guard.js) is only
// measured against those same six. Six pages is not enough to promise a
// seventh kind of lettering gets caught, and the thing being risked is a
// finished book someone paid for.
//
// So the lean-variety this buys is not worth the remaining doubt, and pages go
// out as drawn. Set MIRROR_CHANCE to put it back - 0.5 is what it used to run
// at - and the word check still gates every flip.
const MIRROR_CHANCE = process.env.MIRROR_CHANCE !== undefined
  ? Math.min(1, Math.max(0, parseFloat(process.env.MIRROR_CHANCE) || 0))
  : 0;

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
        const prompt = buildPrompt(order.theme, sceneIndex, order.childCount, subjectType, order.notes, cast);
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

    // Only now is the book real, so only now do we tell the customer.
    if (order.email && mailer.configured && done > 0) {
      try {
        const msg = mailer.orderReadyEmail({
          childName: order.childName,
          orderId: order.id,
          accessToken: order.accessToken,
          siteUrl: SITE_URL,
          pageCount: done
        });
        await mailer.sendMail({ to: order.email, subject: msg.subject, text: msg.text, html: msg.html });
        console.log(`Order ${orderId}: ready-email sent.`);
      } catch (mailErr) {
        console.error(`Order ${orderId}: could not email - ${mailErr.message}`);
      }
    }
  } catch (err) {
    console.error(`Order ${orderId}: render failed - ${err.message}`);
    try { await db.setGenerationStatus(orderId, 'failed'); } catch (e) {}
  } finally {
    rendering.delete(String(orderId));
    // A slot just opened; drain the queue rather than waiting for the timer.
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
    if (!takeEventSlot(req.ip || 'unknown')) return;
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

// A small rate limiter for free previews. No dependency, no store: a Map of
// visitor -> timestamps inside a rolling hour, plus a site-wide count. It
// resets when the process does, which is fine - it exists to blunt a spike and
// to stop one person looping the free endpoint, not to bill anyone.
const previewHits = new Map();
let sitePreviewWindow = { start: Date.now(), count: 0 };

function takeFreePreview(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;

  if (now - sitePreviewWindow.start > hour) sitePreviewWindow = { start: now, count: 0 };
  if (sitePreviewWindow.count >= FREE_PREVIEWS_PER_HOUR) return 'site';

  const seen = (previewHits.get(ip) || []).filter((t) => now - t < hour);
  if (seen.length >= FREE_PREVIEWS_PER_IP) {
    previewHits.set(ip, seen);
    return 'visitor';
  }

  seen.push(now);
  previewHits.set(ip, seen);
  sitePreviewWindow.count++;
  return null;
}

// Drop visitors we have not seen in an hour so the Map cannot grow forever.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [ip, times] of previewHits) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) previewHits.delete(ip);
    else previewHits.set(ip, live);
  }
}, 15 * 60 * 1000).unref();

// photo: the single-subject book, unchanged. photos: a family book, one file per
// person, in the same order as the people field that names them.
app.post('/convert', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'photos', maxCount: MAX_PEOPLE }
]), async (req, res) => {
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
      const blocked = takeFreePreview(req.ip || 'unknown');
      if (blocked === 'visitor') {
        return res.status(429).json({
          error: 'You have used up the free previews for now. Try again in an hour, or finish an order to get the whole book.'
        });
      }
      if (blocked === 'site') {
        return res.status(429).json({
          error: 'We are busier than usual and free previews are paused for a few minutes. Please try again shortly.'
        });
      }
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

    const prompt = buildPrompt(theme, sceneIndex, childCount, subjectType, notes, cast);

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
app.get('/health', async (req, res) => {
  const state = db.status();
  try {
    const count = await db.countOrders();
    res.json({ ok: true, storage: state.storage, dbReady: state.ready, orders: count, email: mailer.configured ? 'configured' : 'not configured' });
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

// A book is drawn in this process's memory, so a restart - a deploy, a crash,
// Render moving the instance - used to abandon whatever was mid-render, and
// nothing ever picked it up again. The customer had paid. This sweep finds
// those orders and finishes them. renderBook skips pages that already exist,
// so resuming costs only the pages that are actually missing.
const MAX_RENDER_ATTEMPTS = parseInt(process.env.MAX_RENDER_ATTEMPTS, 10) || 5;
let sweeping = false;
async function resumeUnfinished() {
  if (sweeping) return;
  sweeping = true;
  try {
    const free = MAX_CONCURRENT_BOOKS - rendering.size;
    if (free <= 0) return;
    const ids = await db.resumableOrders(MAX_RENDER_ATTEMPTS);
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
// Only when run as the server. Required as a module - by a test, or by
// scripts/render-test-book.js - this file hands back the prompt and render
// helpers without opening a port or starting the resume sweeps.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  // Once shortly after boot (the restart case), then periodically for anything
  // that dies while we are up.
  setTimeout(resumeUnfinished, 20 * 1000);
  setInterval(resumeUnfinished, 60 * 1000);
}

module.exports = { app, STATEMENT_DESCRIPTOR_SUFFIX, buildPrompt, renderScene, maybeMirror, canCallOpenAI: CAN_CALL_OPENAI, cleanPeople, MAX_PEOPLE, STORY_SCENES, SHOTS, BASE_STYLE, SAMPLE_PAGES };
