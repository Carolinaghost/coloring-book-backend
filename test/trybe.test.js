#!/usr/bin/env node
'use strict';
// Trybe orders (trybe.js): when a book is paid, Trybe hears about it so a
// creator whose video brought the buyer is credited. Checked here:
//   - /checkout keeps the browser's Trybe visitor id on the Stripe session,
//     on every fallback rung, and drops anything that is not an id
//   - the order body is the shape Trybe's guide asks for, with no email
//   - nothing is sent without a key, without a visitor id, or for a free book
//   - a duplicate (409) counts as fine; errors never throw
//   npm test
if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') { console.error('unset DATABASE_URL'); process.exit(1); }
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';
delete process.env.TRYBE_API_KEY;

const http = require('http');
const trybe = require('../trybe');
const cart = require('../cart');
const { app } = require('../server.js');

let pass = 0; const failures = [];
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}
function request(server, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', reject); req.write(JSON.stringify(body)); req.end();
  });
}
const quiet = { log() {}, error() {} };
const VID = '712f518e-bb8a-4d7e-a902-524c990dc41e';

async function main() {
  console.log('\nThe visitor id');
  check('a uuid is kept', trybe.cleanVid(VID), VID);
  check('junk is dropped', trybe.cleanVid('<script>'), '');
  check('too long is dropped', trybe.cleanVid('a'.repeat(65)), '');
  check('not a string is dropped', trybe.cleanVid({ a: 1 }), '');

  console.log('\nWhat /checkout puts on the Stripe session');
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const realFetch = global.fetch;
  async function checkout(trybeField, refuseConsent) {
    const sent = [];
    global.fetch = async (url, opts) => {
      if (String(url).includes('/v1/promotion_codes')) return { ok: true, json: async () => ({ data: [] }) };
      if (String(url).includes('api.stripe.com')) {
        const p = new URLSearchParams(opts.body instanceof URLSearchParams ? opts.body.toString() : String(opts.body));
        sent.push(p);
        if (refuseConsent && p.get('consent_collection[terms_of_service]')) return { ok: false, json: async () => ({ error: { message: 'no terms of service url set (pretend)' } }) };
        return { ok: true, json: async () => ({ id: 'cs_test_t', url: 'https://checkout.stripe.test/x' }) };
      }
      return realFetch(url, opts);
    };
    try {
      const made = JSON.parse((await request(server, '/orders', { childName: 'Ava', email: 'a@b.test', theme: 'Portrait', pageCount: 15 })).body);
      const res = await request(server, '/checkout', { orderId: made.order.id, token: made.accessToken, product: 'digital', trybe: trybeField });
      return { res, sent };
    } finally { global.fetch = realFetch; }
  }
  try {
    const a = await checkout(VID);
    check('checkout answers', a.res.status, 200);
    check('the visitor id rides on the session', a.sent[a.sent.length - 1].get('metadata[trybe_vid]'), VID);
    const b = await checkout(VID, true);
    check('a fallback rung keeps it too', [b.sent.length, b.sent[b.sent.length - 1].get('metadata[trybe_vid]')], [2, VID]);
    const c = await checkout('"><img src=x>');
    check('junk never reaches Stripe', c.sent[c.sent.length - 1].get('metadata[trybe_vid]'), null);
    const d = await checkout(undefined);
    check('an old page without it still checks out', [d.res.status, d.sent[d.sent.length - 1].get('metadata[trybe_vid]')], [200, null]);
  } finally { server.close(); }

  console.log('\nThe order Trybe is sent');
  const order = { id: 531, email: 'buyer@example.com', people: [{ name: 'Ava' }] };
  const session = { id: 'cs_1', created: 1795480000, amount_total: 2495, metadata: { product: 'print', trybe_vid: VID } };
  const body = trybe.orderBody({ order, session, apiKey: 'sk_test' });
  check('the fields Trybe asks for', Object.keys(body).sort(), ['apiKey', 'currency', 'items', 'orderId', 'orderTime', 'value', 'vid']);
  check('order id, value, currency, vid', [body.orderId, body.value, body.currency, body.vid], ['531', 24.95, 'USD', VID]);
  check('the time is the payment time', body.orderTime, new Date(1795480000 * 1000).toISOString());
  check('one line item', body.items, [{ productId: 'personal-print', productName: 'Personalized coloring book (printed)', quantity: 1, price: 24.95 }]);
  check('the buyer email is not sent', JSON.stringify(body).includes('buyer@example.com'), false);
  const fam = trybe.orderBody({ order: { id: 9, people: [{}, {}] }, session: { amount_total: 2500, metadata: { product: 'digital', trybe_vid: VID } }, apiKey: 'k' });
  check('a family PDF is named as one', fam.items[0].productId, 'family-digital');
  check('no visitor id: nothing to send', trybe.orderBody({ order, session: { amount_total: 1500, metadata: {} }, apiKey: 'k' }), null);
  check('a free book: nothing to send', trybe.orderBody({ order, session: { amount_total: 0, metadata: { trybe_vid: VID } }, apiKey: 'k' }), null);

  console.log('\nA cart: each book is sent with its own share');
  const cartSession = { id: 'cs_c', amount_subtotal: 3000, amount_total: 3995, total_details: { amount_discount: 0, amount_shipping: 995 }, metadata: { product: 'cart', trybe_vid: VID } };
  const parts = cart.splitSession(cartSession, [{ id: 1, product: 'print' }, { id: 2, product: 'digital' }], { priceCents: 1500, familyPriceCents: 2500, shippingCents: 995 });
  const bodies = parts.map((p) => trybe.orderBody({ order: p.order, session: p.session, apiKey: 'k' }));
  check('two orders, values add up to what was paid', [bodies.map((x) => x.orderId), Math.round(bodies.reduce((s, x) => s + x.value, 0) * 100)], [['1', '2'], 3995]);
  check('each keeps the visitor id', bodies.map((x) => x.vid), [VID, VID]);

  console.log('\nSending');
  const calls = [];
  const fakeFetch = (status) => async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: status < 300, status }; };
  check('no key: nothing is sent', await trybe.sendOrder({ order, session, fetchImpl: fakeFetch(200), log: quiet }), { sent: false, reason: 'off' });
  check('...and nothing was called', calls.length, 0);
  process.env.TRYBE_API_KEY = 'sk_test_key';
  check('with a key it is sent', await trybe.sendOrder({ order, session, fetchImpl: fakeFetch(200), log: quiet }), { sent: true, status: 200 });
  check('to Trybe\'s orders address, carrying the key', [calls[0].url, calls[0].body.apiKey], ['https://jointrybe.com/attribution/v1/orders', 'sk_test_key']);
  check('a duplicate (Stripe retry) is fine', await trybe.sendOrder({ order, session, fetchImpl: fakeFetch(409), log: quiet }), { sent: true, status: 409 });
  check('a refusal is reported, not thrown', await trybe.sendOrder({ order, session, fetchImpl: fakeFetch(403), log: quiet }), { sent: false, status: 403 });
  check('a network error is swallowed', await trybe.sendOrder({ order, session, fetchImpl: async () => { throw new Error('down'); }, log: quiet }), { sent: false, reason: 'error' });
  process.env.TRYBE_ORDERS = 'off';
  check('TRYBE_ORDERS=off turns it off', (await trybe.sendOrder({ order, session, fetchImpl: fakeFetch(200), log: quiet })).reason, 'off');
  delete process.env.TRYBE_ORDERS; delete process.env.TRYBE_API_KEY;

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
