#!/usr/bin/env node
'use strict';

// Tests for the free preview coming before the name and email (server.js).
//
//   npm test
//
// The site draws the two free pages as soon as there is a photo and a style,
// and only asks for a name and an email at Unlock. So:
//
//   - /orders has to accept an order with neither, or the preview pages have
//     no order to be kept on and the paid book draws them all over again -
//     different pages from the ones the customer liked, at our cost.
//   - /checkout has to take the name and email, keep them on the order (the
//     book is emailed there), and refuse to start a payment without them.
//   - An order started the old way, with both, still checks out untouched.
//   - A paid order's email is not something a browser can change.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';

const http = require('http');
const { app } = require('../server.js');
const db = require('../db.js');

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

function request(server, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Stand in for Stripe and keep every session body it is sent.
function captureStripe(sent) {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/v1/promotion_codes')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (String(url).includes('api.stripe.com')) {
      sent.push(new URLSearchParams(String(opts.body)));
      return { ok: true, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1' }) };
    }
    return realFetch(url, opts);
  };
  return () => { global.fetch = realFetch; };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sent = [];
  const restore = captureStripe(sent);
  try {
    console.log('\nAn order started for the free preview, before any name or email');
    const made = await request(server, '/orders', { theme: 'Superhero', pageCount: 15, photo: 'data:image/png;base64,AAAA' });
    check('is accepted', made.status, 200);
    check('and comes back with its access token', typeof (made.json && made.json.accessToken), 'string');
    const id = made.json.order.id;
    const token = made.json.accessToken;
    check('with no email on it yet', made.json.order.email, '');

    console.log('\nUnlock without a name or email');
    let res = await request(server, '/checkout', { orderId: id, token, product: 'digital' });
    check('is refused', res.status, 400);
    check('with a sentence for the customer', res.json && res.json.error, 'Add a name and an email first.');
    check('and Stripe is never asked', sent.length, 0);

    console.log('\nUnlock with a bad email');
    res = await request(server, '/checkout', { orderId: id, token, product: 'digital', childName: 'Ava', email: 'not-an-email' });
    check('is refused', res.status, 400);
    check('and Stripe is still never asked', sent.length, 0);

    console.log('\nUnlock with only a name');
    res = await request(server, '/checkout', { orderId: id, token, product: 'digital', childName: 'Ava' });
    check('is refused - the book is emailed', res.status, 400);

    console.log('\nUnlock with a name and an email');
    res = await request(server, '/checkout', { orderId: id, token, product: 'digital', childName: 'Ava', email: 'parent@example.test' });
    check('goes to Stripe', res.status, 200);
    check('with the checkout link', res.json && res.json.url, 'https://checkout.stripe.test/c/pay/cs_test_1');
    const session = sent[sent.length - 1];
    check('Stripe is given the email', session.get('customer_email'), 'parent@example.test');
    check('and the name', session.get('line_items[0][price_data][product_data][description]'), '15 pages starring Ava');
    const stored = await db.getOrder(id);
    check('the order keeps the email the book will be sent to', stored.email, 'parent@example.test');
    check('and the name', stored.childName, 'Ava');

    console.log('\nAn order started the old way, with both');
    const old = await request(server, '/orders', { childName: 'Milo', email: 'old@example.test', theme: 'Portrait', pageCount: 15 });
    res = await request(server, '/checkout', { orderId: old.json.order.id, token: old.json.accessToken, product: 'digital' });
    check('still checks out', res.status, 200);
    check('with the email it was made with', sent[sent.length - 1].get('customer_email'), 'old@example.test');

    console.log('\nA paid order');
    const paid = await request(server, '/orders', { childName: 'Zoe', email: 'zoe@example.test', theme: 'Portrait' });
    const paidOrder = await db.getOrder(paid.json.order.id);
    paidOrder.paid = true;
    const changed = await db.setOrderContact(paidOrder.id, { childName: 'X', email: 'someone@else.test' });
    check('cannot have its email changed', changed, null);
    check('and keeps the one it was paid with', (await db.getOrder(paidOrder.id)).email, 'zoe@example.test');
  } finally {
    restore();
    server.close();
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
