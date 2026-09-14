#!/usr/bin/env node
'use strict';

// Tests for what /checkout sends Stripe (server.js).
//
//   npm test
//
// Chiefly one thing: the promotion code box. Influencer codes are created in
// the Stripe dashboard and the code someone types is the attribution, so if
// allow_promotion_codes goes missing there is no code box, no discount, and no
// way to tell whose audience bought - and nothing fails loudly enough to
// notice. It is one line in a long form body, easy to lose in a merge.
//
// It also has to survive the fallback. /checkout tries a session that collects
// consent first, and retries without it if Stripe refuses. The consent body is
// a copy of the form taken partway through, so anything appended after that
// copy reaches only one of the two. Both are checked here.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';

const http = require('http');
const { app } = require('../server.js');

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

function request(server, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Stand in for Stripe and keep every body it is sent. The first call is
// refused so the fallback runs too, which is the path that would otherwise
// never be looked at.
function captureStripe(sent) {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.stripe.com')) {
      const body = opts.body instanceof URLSearchParams ? opts.body.toString() : String(opts.body);
      sent.push(new URLSearchParams(body));
      if (sent.length === 1) {
        return {
          ok: false,
          json: async () => ({ error: { message: 'no terms of service url set (pretend)' } })
        };
      }
      return { ok: true, json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.test/c/pay/cs_test_123' }) };
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
    console.log('\nStarting a checkout');

    const made = await request(server, '/orders', {
      method: 'POST',
      body: JSON.stringify({ childName: 'Ava', email: 'a@b.test', theme: 'Portrait', pageCount: 15 })
    });
    const order = JSON.parse(made.body);
    check('an order can be created', made.status, 200);

    const res = await request(server, '/checkout', {
      method: 'POST',
      body: JSON.stringify({ orderId: order.order.id, token: order.accessToken, product: 'digital' })
    });
    check('checkout answers', res.status, 200);
    check('Stripe was asked twice - consent, then the fallback', sent.length, 2);

    console.log('\nThe promotion code box');

    const [consentBody, fallbackBody] = sent;
    check('the consent session offers it', consentBody.get('allow_promotion_codes'), 'true');
    check('and so does the fallback', fallbackBody.get('allow_promotion_codes'), 'true');

    // Stripe refuses a session that sets both, and the failure would only show
    // up when somebody tried to pay.
    check('no discounts[] alongside it',
      [...consentBody.keys(), ...fallbackBody.keys()].filter((k) => k.startsWith('discounts')), []);

    console.log('\nThe rest of the session is unchanged');
    check('consent is still collected', consentBody.get('consent_collection[terms_of_service]'), 'required');
    check('the fallback drops only the consent',
      fallbackBody.get('consent_collection[terms_of_service]'), null);
    check('the order is still referenced', consentBody.get('client_reference_id'), String(order.order.id));
    check('and it is still charged', consentBody.get('line_items[0][price_data][unit_amount]'), '1500');

    console.log('\nA family book costs more');

    // The number here and the number the site shows come from the same place
    // (GET /options). If they ever disagree, a customer is quoted one price and
    // charged another.
    sent.length = 0;
    const familyOrder = JSON.parse((await request(server, '/orders', {
      method: 'POST',
      body: JSON.stringify({
        childName: 'Leo', email: 'a@b.test', theme: 'Portrait', pageCount: 15,
        people: [
          { name: 'Leo', subjectType: 'kid', star: true, photo: 'data:image/png;base64,iVBORw0KGgo=' },
          { name: 'Mum', subjectType: 'adult', photo: 'data:image/png;base64,iVBORw0KGgo=' }
        ]
      })
    })).body);
    await request(server, '/checkout', {
      method: 'POST',
      body: JSON.stringify({ orderId: familyOrder.order.id, token: familyOrder.accessToken, product: 'digital' })
    });
    const familyBody = sent[sent.length - 1];
    check('a family book is charged the family price',
      familyBody.get('line_items[0][price_data][unit_amount]'), '2500');
    check('and Stripe names it as one',
      /family/i.test(familyBody.get('line_items[0][price_data][product_data][name]') || ''), true);

    const options = JSON.parse((await request(server, '/options')).body);
    check('the site is told the same family price', String(options.family.priceCents), '2500');
    check('and the same single price', String(options.priceCents), '1500');
    check('a family book still offers the code box', familyBody.get('allow_promotion_codes'), 'true');
  } finally {
    restore();
    server.close();
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailed:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\ntest run crashed:', err);
  process.exit(1);
});
