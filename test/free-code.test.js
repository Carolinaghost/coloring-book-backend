#!/usr/bin/env node
'use strict';

// Tests for what happens when a promotion code takes a checkout to $0
// (server.js: POST /checkout, POST /stripe/webhook, renderBook; db.js:
// markPaid).
//
//   npm test
//
// Influencer codes live in the Stripe dashboard, and handing one out at 100%
// off is how a reviewer or a giveaway winner gets a book. Stripe shapes that
// order differently from a paid one, and every difference is a place where
// fulfilment can quietly stop:
//
//   amount_total       0            not the price we quoted
//   payment_status     no_payment_required     not 'paid'
//   payment_intent     null         no money moved, so none was ever created
//
// (https://docs.stripe.com/payments/checkout/no-cost-orders and
// https://docs.stripe.com/api/checkout/sessions/object. Stripe's own
// fulfilment guide says to fulfil unless payment_status is 'unpaid', and its
// no-cost-orders page says in as many words: handle checkout.session.completed
// rather than PaymentIntent events, because a free session has no
// PaymentIntent.)
//
// The failure this guards against is silent on every side. The customer redeems
// the code, Stripe says thank you, the webhook arrives, and if anything in the
// order-marking path asks for a payment_intent or for payment_status === 'paid'
// the order is never marked paid, no book is ever drawn, and nothing anywhere
// raises an error - we would only find out from the person who never got their
// book. So the test plays the whole thing through: a real order, a real
// session, a signed $0 completion event, and an assertion that pages actually
// start being drawn.
//
// The other half is the one that costs money rather than goodwill. A free order
// must be as un-replayable as a paid one: a redelivered event must not draw a
// second book, and a paid order must not be able to open another checkout.

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.error(
    'DATABASE_URL is set, but this test writes orders and draws pages.\n'
    + 'Re-run with ALLOW_DB_TESTS=1 against a scratch database, or unset\n'
    + 'DATABASE_URL to test the in-memory store.'
  );
  process.exit(1);
}

// Both have to be set before server.js is required: it reads them once, at
// load. The OpenAI key is never used - every call is intercepted below - but
// without one the renderer refuses to draw at all, and then "no pages appeared"
// would mean nothing.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-a-real-key';

const http = require('http');
const crypto = require('crypto');

let pass = 0;
const failures = [];

function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
    console.log(`         got  ${JSON.stringify(got)}`);
    console.log(`         want ${JSON.stringify(want)}`);
  }
}

// A 1x1 PNG. Stands in both for the customer's photo and for every page the
// renderer thinks it drew, so nothing here needs a real image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQ'
  + 'DwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SESSION_ID = 'cs_test_free_code';

// Stands in for both APIs this path talks to.
//
// Stripe hands back a session, exactly as it would for a session created at
// full price - the discount is applied later, by the customer, on Stripe's own
// page, so nothing about the creation call says "free".
//
// OpenAI hands back a page, but only when the test lets it: `images.release`
// is what unblocks the drawing. Holding it shut keeps the render in flight for
// as long as the test needs, which is what makes the replay assertion below a
// measurement rather than a race.
function stubApis() {
  const realFetch = global.fetch;
  const images = { calls: 0, gate: null, release: null };
  images.gate = new Promise((resolve) => { images.release = resolve; });
  const stripeBodies = [];

  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes('api.stripe.com')) {
      const body = opts.body instanceof URLSearchParams ? opts.body.toString() : String(opts.body);
      stripeBodies.push(new URLSearchParams(body));
      return {
        ok: true,
        json: async () => ({ id: SESSION_ID, url: `https://checkout.stripe.test/c/pay/${SESSION_ID}` })
      };
    }
    if (target.includes('api.openai.com')) {
      images.calls++;
      await images.gate;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG }] }) };
    }
    return realFetch(url, opts);
  };

  return { images, stripeBodies };
}

const { images, stripeBodies } = stubApis();

const db = require('../db.js');
const { app } = require('../server.js');

function request(server, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const sent = Object.assign({}, headers);
    if (body && !sent['Content-Type']) sent['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// The same signature Stripe puts on a delivery, so the event goes in through
// the front door - verification included - rather than past it.
function stripeSignature(raw) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${t}.${raw}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

// checkout.session.completed for an order a 100% off promotion code has taken
// to zero. Field for field the shape Stripe documents for a no-cost order: the
// session is complete, the subtotal is the price we quoted, the discount is the
// whole of it, the total is zero, there is no PaymentIntent, and the payment
// status is no_payment_required rather than paid.
function freeCompletionEvent(orderId) {
  return {
    id: 'evt_test_free_code',
    object: 'event',
    api_version: '2023-08-16',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: SESSION_ID,
        object: 'checkout.session',
        mode: 'payment',
        status: 'complete',
        payment_status: 'no_payment_required',
        payment_intent: null,
        invoice: null,
        currency: 'usd',
        amount_subtotal: 1500,
        amount_total: 0,
        total_details: { amount_discount: 1500, amount_shipping: 0, amount_tax: 0 },
        allow_promotion_codes: true,
        client_reference_id: String(orderId),
        customer: 'cus_test_free_code',
        customer_email: 'ada@example.com',
        livemode: false
      }
    }
  };
}

function deliver(server, event) {
  const raw = JSON.stringify(event);
  return request(server, '/stripe/webhook', {
    method: 'POST',
    body: raw,
    headers: { 'Content-Type': 'application/json', 'stripe-signature': stripeSignature(raw) }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for something the render does on its way past, rather than for a fixed
// delay: renderBook is started deliberately un-awaited (Stripe times webhooks
// out in seconds and a book takes minutes), so there is nothing to await here.
async function waitFor(what, predicate, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > until) {
      console.log(`         gave up waiting for ${what}`);
      return false;
    }
    await sleep(25);
  }
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  // -------------------------------------------------------------------------
  console.log('\na free code still produces a real book');
  // -------------------------------------------------------------------------
  const created = await request(server, '/orders', {
    method: 'POST',
    body: JSON.stringify({
      childName: 'Ada',
      childCount: 1,
      email: 'ada@example.com',
      theme: 'Portrait',
      pageCount: 15,
      photo: `data:image/png;base64,${PNG}`,
      visitor: 'v-free-code',
      source: 'influencer'
    })
  });
  const { order, accessToken } = JSON.parse(created.body);
  check('the order was taken', created.status, 200);

  const checkout = await request(server, '/checkout', {
    method: 'POST',
    body: JSON.stringify({ orderId: order.id, token: accessToken })
  });
  check('checkout opened', checkout.status, 200);
  // The code box is what makes a free order possible at all. checkout.test.js
  // owns that parameter in detail; this is only the link in the chain.
  check('the session offers the promotion code box',
    stripeBodies.every((b) => b.get('allow_promotion_codes') === 'true'), true);

  const hook = await deliver(server, freeCompletionEvent(order.id));
  check('the $0 completion is accepted', hook.status, 200);
  check('the $0 completion is acknowledged', JSON.parse(hook.body), { received: true });

  const afterPaid = await db.getOrder(order.id);
  check('a $0 order is marked paid', afterPaid.paid, true);
  check('a $0 order moves off new', afterPaid.status, 'in_progress');
  // The bug this line exists for: amount_total is 0, which is an answer, not a
  // missing one. Read as missing it fell back to the price quoted at checkout,
  // and every free book counted as a full-price sale in /stats and in the CSV.
  check('a $0 order records $0, not the price we quoted', afterPaid.amountCents, 0);

  // The whole point. Marked paid is worth nothing if nobody starts drawing.
  check('the book starts being drawn',
    await waitFor('the first page to be requested', async () => images.calls > 0), true);
  check('the render is logged as an attempt',
    (await db.getOrder(order.id)).renderAttempts, 1);
  check('the order is generating', (await db.getOrder(order.id)).generationStatus, 'running');

  // -------------------------------------------------------------------------
  console.log('\na free order is no more replayable than a paid one');
  // -------------------------------------------------------------------------
  // Stripe redelivers events - on a timeout, on a 500, or at the press of a
  // button in the dashboard - and a free order is the one worth replaying,
  // because a second book costs the replayer nothing. The first render is still
  // in flight here (the image gate is shut), which is exactly the window a
  // retry lands in.
  const drawnSoFar = images.calls;
  const replay = await deliver(server, freeCompletionEvent(order.id));
  check('the replay is accepted', replay.status, 200);
  await sleep(300);
  check('the replay starts no second render',
    (await db.getOrder(order.id)).renderAttempts, 1);
  check('the replay draws no extra pages', images.calls, drawnSoFar);

  // And the other door into a second free book: opening a fresh checkout on an
  // order that has already been redeemed, which would hand the code a second
  // session to be spent on.
  const second = await request(server, '/checkout', {
    method: 'POST',
    body: JSON.stringify({ orderId: order.id, token: accessToken })
  });
  check('a redeemed order cannot open another checkout', second.status, 409);

  // -------------------------------------------------------------------------
  // Let the held pages go, so the process is not left sitting on promises.
  images.release();
  await sleep(50);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailed:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  // The renderer is still running in the background and has nothing to stop it,
  // so the result has to be reported by leaving.
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\ntest run crashed:', err);
  process.exit(1);
});
