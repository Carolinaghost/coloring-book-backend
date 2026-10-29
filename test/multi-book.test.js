#!/usr/bin/env node
'use strict';

// Several books in one checkout (cart.js; server.js POST /checkout `extra` and
// the Stripe webhook; print-orders.js packages).
//
//   npm test
//
// What has to hold:
//   - one Stripe session, one line per book, at each book's own price
//   - printed copies bought together: ONE $4.99 shipping charge, ONE box
//   - a single-use free-book code can never make a whole cart free
//   - after payment every book is marked paid, drawn, and reported to Meta
//     with its own share of the money - the shares add up to what was charged
//   - one book on its own works exactly as before

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.error('unset DATABASE_URL'); process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
process.env.META_CAPI_TOKEN = 'test-token-not-real';
process.env.PRINT_ENABLED = 'true';
process.env.LULU_CLIENT_KEY = 'test-key';
process.env.LULU_CLIENT_SECRET = 'test-secret';

const http = require('http');
const crypto = require('crypto');

let pass = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQ'
  + 'DwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Stripe, Meta and OpenAI, stood in for.
const stripeBodies = [];
const metaEvents = [];
let sessionN = 0;
const PROMOS = {
  FREE1: { id: 'promo_free', active: true, coupon: { id: 'freebook100', percent_off: 100 } },
  NEWAPI: { id: 'promo_new', active: true, promotion: { type: 'coupon', coupon: 'freebook100' } },
  JERRELL: { id: 'promo_creator', active: true, coupon: { id: 'creatortrack', percent_off: 0.01 } }
};
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const target = String(url);
  if (target.includes('api.stripe.com/v1/promotion_codes')) {
    const code = new URL(target).searchParams.get('code');
    const found = PROMOS[code];
    return { ok: true, json: async () => ({ data: found ? [found] : [] }) };
  }
  if (target.includes('api.stripe.com/v1/checkout/sessions')) {
    const body = opts.body instanceof URLSearchParams ? opts.body.toString() : String(opts.body);
    stripeBodies.push(new URLSearchParams(body));
    sessionN++;
    return { ok: true, json: async () => ({ id: 'cs_test_cart_' + sessionN, url: 'https://checkout.stripe.test/' + sessionN }) };
  }
  if (target.includes('graph.facebook.com')) {
    const b = JSON.parse(opts.body);
    metaEvents.push(...b.data);
    return { ok: true, json: async () => ({ events_received: b.data.length }) };
  }
  if (target.includes('api.openai.com')) {
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG }] }) };
  }
  return realFetch(url, opts);
};

const cart = require('../cart.js');
const db = require('../db.js');
const { app } = require('../server.js');
const { createPrintOrders } = require('../print-orders.js');

function request(server, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const sent = Object.assign({}, headers);
    if (body && !sent['Content-Type']) sent['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
function sign(raw) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}
function deliver(server, session) {
  const raw = JSON.stringify({ id: 'evt_' + session.id, object: 'event', type: 'checkout.session.completed', data: { object: session } });
  return request(server, '/stripe/webhook', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'stripe-signature': sign(raw) } });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newOrder(server, { name, family } = {}) {
  const body = family
    ? { childName: '', theme: 'Portrait', pageCount: 15, people: [
      { name: 'Mom', subjectType: 'adult', photo: `data:image/png;base64,${PNG}` },
      { name: 'Zoe', subjectType: 'kid', photo: `data:image/png;base64,${PNG}` }] }
    : { childName: name || '', theme: 'Portrait', pageCount: 15, photo: `data:image/png;base64,${PNG}` };
  const r = await request(server, '/orders', { method: 'POST', body });
  return { id: r.body.order.id, token: r.body.accessToken };
}

async function main() {
  // -------------------------------------------------------------------------
  console.log('\nsharing a session out');
  const P = { priceCents: 1500, familyPriceCents: 2500, shippingCents: 499 };
  check('shares always add up', [[100, [1, 1, 1]], [499, [499, 0, 499]], [7, [3, 3]], [0, [1, 2]]]
    .every(([t, w]) => cart.shareOut(t, w).reduce((a, b) => a + b, 0) === t));
  check('nothing shipped, no shipping share', cart.shareOut(0, [0, 0]).every((x) => x === 0));
  const s1 = { id: 'cs_x', amount_subtotal: 5500, amount_total: 5500 - 1100 + 499,
    total_details: { amount_discount: 1100, amount_shipping: 499 }, metadata: { product: 'cart', orders: '1,2,3' } };
  const parts = cart.splitSession(s1, [{ id: 1, product: 'print' }, { id: 2, product: 'digital' },
    { id: 3, product: 'print', people: [{}, {}] }], P);
  check('each book carries its own price', parts.map((p) => p.session.amount_subtotal).join() === '1500,1500,2500');
  check('the discount is shared by price', parts.map((p) => p.session.total_details.amount_discount).join() === '300,300,500');
  check('one box\'s shipping shared between the printed books only',
    parts.map((p) => p.session.total_details.amount_shipping).join() === '249,0,250');
  check('the books add back up to the charge exactly', parts.reduce((a, p) => a + p.amountCents, 0) === s1.amount_total);
  check('each copy says its own product', parts.map((p) => p.session.metadata.product).join() === 'print,digital,print');
  const free = cart.splitSession({ amount_subtotal: 3000, amount_total: 0, total_details: { amount_discount: 3000, amount_shipping: 0 } },
    [{ id: 1, product: 'digital' }, { id: 2, product: 'digital' }], P);
  check('a free session is free for every book', free.every((p) => p.amountCents === 0));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  // -------------------------------------------------------------------------
  console.log('\none book on its own is unchanged');
  const solo = await newOrder(server, { name: 'Ada' });
  let r = await request(server, '/checkout', { method: 'POST', body: {
    orderId: solo.id, token: solo.token, product: 'print', childName: 'Ada', email: 'ada@example.com' } });
  let b = stripeBodies[stripeBodies.length - 1];
  check('checkout opens', r.status === 200, r.body);
  check('one line, $15', b.get('line_items[0][price_data][unit_amount]') === '1500' && !b.has('line_items[1][quantity]'));
  check('product is print, as before', b.get('metadata[product]') === 'print' && !b.has('metadata[orders]'));
  check('$4.99 shipping', b.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]') === '499');
  check('the code box is still offered', b.get('allow_promotion_codes') === 'true');
  check('no "more" on the return link', !/more=/.test(b.get('success_url')));

  // -------------------------------------------------------------------------
  console.log('\nthree books in one checkout');
  const a = await newOrder(server, { name: 'Maya' });
  const c = await newOrder(server, { name: 'Leo' });
  const f = await newOrder(server, { family: true });
  const cartBody = {
    orderId: a.id, token: a.token, product: 'print', childName: 'Maya', email: 'mum@example.com',
    extra: [
      { orderId: c.id, token: c.token, product: 'digital', childName: 'Leo' },
      { orderId: f.id, token: f.token, product: 'print', childName: 'The Smiths' }
    ]
  };
  r = await request(server, '/checkout', { method: 'POST', body: cartBody });
  b = stripeBodies[stripeBodies.length - 1];
  const cartSession = r.body && r.body.url ? 'cs_test_cart_' + sessionN : '';
  check('checkout opens for the cart', r.status === 200 && r.body.books === 3, r.body);
  check('three lines at their own prices', ['1500', '1500', '2500'].every((v, i) => b.get(`line_items[${i}][price_data][unit_amount]`) === v));
  check('the lines say which books are printed',
    /printed copy/.test(b.get('line_items[0][price_data][product_data][name]'))
    && !/printed/.test(b.get('line_items[1][price_data][product_data][name]'))
    && /family/.test(b.get('line_items[2][price_data][product_data][name]')));
  check('ONE $4.99 shipping charge for two printed books',
    b.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]') === '499'
    && /2 printed copies in one box/.test(b.get('shipping_options[0][shipping_rate_data][display_name]')));
  check('the address is asked for', b.get('shipping_address_collection[allowed_countries][0]') === 'US');
  check('marked as a cart, with its orders', b.get('metadata[product]') === 'cart' && b.get('metadata[orders]') === [a.id, c.id, f.id].join(','));
  check('no typing box on a cart', !b.has('allow_promotion_codes'));
  check('the return link lists the other books', b.get('success_url').includes(`order=${a.id}`) && b.get('success_url').includes(`more=${c.id}-${f.id}`)
    && b.get('success_url').includes('amt=59.99'), b.get('success_url'));
  check('total quoted is books + one shipping', r.body.amountCents === 1500 + 1500 + 2500 + 499);
  const [oa, oc, of] = [await db.getOrder(a.id), await db.getOrder(c.id), await db.getOrder(f.id)];
  check('every order is tied to the session', [oa, oc, of].every((o) => o.stripeSessionId === cartSession), [oa.stripeSessionId, cartSession]);
  check('each takes the email and its own name', oc.email === 'mum@example.com' && oc.childName === 'Leo');
  check('each keeps its own product', oa.product === 'print' && oc.product === 'digital' && of.product === 'print');
  check('quoted amounts add up to the checkout', oa.amountCents + oc.amountCents + of.amountCents === 1500 + 1500 + 2500 + 499,
    [oa.amountCents, oc.amountCents, of.amountCents]);

  // -------------------------------------------------------------------------
  console.log('\nwhat a cart refuses');
  const d = await newOrder(server, { name: 'Ivy' });
  const e = await newOrder(server, { name: 'Max' });
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: d.id, token: d.token, childName: 'Ivy', email: 'x@example.com', code: 'FREE1',
    extra: [{ orderId: e.id, token: e.token, childName: 'Max' }] } });
  check('a free-book code on a cart is turned away', r.status === 400 && /covers one book/.test(r.body.error), r.body);
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: d.id, token: d.token, childName: 'Ivy', email: 'x@example.com', code: 'NEWAPI',
    extra: [{ orderId: e.id, token: e.token, childName: 'Max' }] } });
  check('also when Stripe files the coupon the newer way', r.status === 400, r.body);
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: d.id, token: d.token, childName: 'Ivy', email: 'x@example.com', code: 'FREE1' } });
  check('the same code still works on one book', r.status === 200 && stripeBodies[stripeBodies.length - 1].get('discounts[0][promotion_code]') === 'promo_free');
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: d.id, token: d.token, childName: 'Ivy', email: 'x@example.com', code: 'JERRELL',
    extra: [{ orderId: e.id, token: e.token, childName: 'Max' }] } });
  check('a creator code is fine on a cart', r.status === 200 && stripeBodies[stripeBodies.length - 1].get('discounts[0][promotion_code]') === 'promo_creator');
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: d.id, token: d.token, childName: 'Ivy', email: 'x@example.com',
    extra: [{ orderId: e.id, token: 'wrong', childName: 'Max' }] } });
  check('a book with the wrong token is refused', r.status === 403);
  const g = await newOrder(server, {});
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: d.id, token: d.token, childName: 'Ivy', email: 'x@example.com',
    extra: [{ orderId: g.id, token: g.token }] } });
  check('a book with no name is refused', r.status === 400 && /needs a name/.test(r.body.error));
  const many = [];
  for (let i = 0; i < 5; i++) many.push(await newOrder(server, { name: 'K' + i }));
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: d.id, token: d.token, childName: 'Ivy', email: 'x@example.com',
    extra: many.map((m, i) => ({ orderId: m.id, token: m.token, childName: 'K' + i })) } });
  check('no more than five books in one checkout', r.status === 400);

  // -------------------------------------------------------------------------
  console.log('\npaying for the cart');
  const paidSession = {
    id: cartSession, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
    currency: 'usd', amount_subtotal: 5500, amount_total: 5999,
    total_details: { amount_discount: 0, amount_shipping: 499, amount_tax: 0 },
    metadata: { product: 'cart', orders: [a.id, c.id, f.id].join(',') },
    collected_information: { shipping_details: { name: 'Ann Smith', address: { line1: '1 Main St', city: 'Columbia', state: 'SC', postal_code: '29201', country: 'US' } } },
    customer_details: { email: 'mum@example.com', phone: '+18035550100' },
    created: Math.floor(Date.now() / 1000)
  };
  r = await deliver(server, paidSession);
  check('the webhook accepts it', r.status === 200);
  await sleep(300);
  const [pa, pc, pf] = [await db.getOrder(a.id), await db.getOrder(c.id), await db.getOrder(f.id)];
  check('all three are paid', pa.paid && pc.paid && pf.paid);
  check('each records its own share', pa.amountCents === 1749 && pc.amountCents === 1500 && pf.amountCents === 2750,
    [pa.amountCents, pc.amountCents, pf.amountCents]);
  check('the shares add up to what Stripe charged', pa.amountCents + pc.amountCents + pf.amountCents === 5999);
  const [ra, rc, rf] = [await db.getPrintOrder(a.id), await db.getPrintOrder(c.id), await db.getPrintOrder(f.id)];
  check('printed copies recorded for the two printed books only', !!ra && !rc && !!rf);
  check('they share one box', ra.packageKey === cartSession && rf.packageKey === cartSession);
  check('the address is on both', ra.ship.street1 === '1 Main St' && rf.ship.street1 === '1 Main St');
  const purchases = metaEvents.filter((ev) => ev.event_name === 'Purchase');
  check('one Purchase per book', purchases.length === 3 && new Set(purchases.map((p) => p.event_id)).size === 3);
  check('Purchase values add up to the charge',
    Math.round(purchases.reduce((s, p) => s + p.custom_data.value, 0) * 100) === 5999, purchases.map((p) => p.custom_data.value));
  check('every book started drawing', [pa, pc, pf].every((o) => o.renderAttempts >= 1), [pa.renderAttempts, pc.renderAttempts, pf.renderAttempts]);
  const replay = await deliver(server, paidSession);
  await sleep(200);
  check('a replayed webhook draws nothing twice',
    replay.status === 200 && (await db.getOrder(a.id)).renderAttempts === pa.renderAttempts
    && metaEvents.filter((ev) => ev.event_name === 'Purchase').length >= 3);
  r = await request(server, '/checkout', { method: 'POST', body: { orderId: a.id, token: a.token, childName: 'Maya', email: 'mum@example.com' } });
  check('a paid book cannot be checked out again', r.status === 409);

  // -------------------------------------------------------------------------
  console.log('\none box at Lulu');
  const jobs = [];
  const mails = [];
  let jobState = { name: 'CREATED' };
  const fakeLulu = {
    configured: true, sandbox: false,
    coverDimensions: async () => ({ width: '1242.000', height: '630.000', unit: 'pt' }),
    createPrintJob: async (p) => { jobs.push(p); return { id: 900, status: { name: 'CREATED' } }; },
    getPrintJob: async () => ({ id: 900, status: jobState, line_items: [{ status: { messages: { tracking_urls: ['https://track.example/900'] } } }] })
  };
  const pagesFor = (id) => Array.from({ length: 15 }, (_, i) => ({ sceneIndex: i, image: `data:image/png;base64,${PNG}`, orderId: id }));
  const tdb = Object.create(db);
  tdb.listPages = async (id) => pagesFor(id);
  const po = createPrintOrders({
    db: tdb, lulu: fakeLulu, log: { log() {}, error() {} },
    mailer: { configured: true, sendMail: async (m) => { mails.push(m); return true; }, printShippedEmail: require('../mailer').printShippedEmail },
    colorize: async (img) => img, alert: async () => {},
    filesBaseUrl: 'https://api.example.test/', contactEmail: 'accounts@example.test'
  });
  await db.setGenerationStatus(a.id, 'done');
  await db.setGenerationStatus(f.id, 'rendering');
  await po.prepareAndSend(a.id);
  check('the box waits for the second book', jobs.length === 0 && (await db.getPrintOrder(a.id)).status === 'waiting');
  await db.setGenerationStatus(f.id, 'done');
  await po.sweep();
  check('then ONE print job is sent', jobs.length === 1, jobs.length);
  check('with both books in it', jobs[0] && jobs[0].line_items.length === 2
    && jobs[0].line_items.map((li) => li.external_id).join() === [a.id, f.id].join(), jobs[0] && jobs[0].line_items.map((li) => li.external_id));
  check('to the one address', jobs[0] && jobs[0].shipping_address.street1 === '1 Main St');
  const [sa, sf] = [await db.getPrintOrder(a.id), await db.getPrintOrder(f.id)];
  check('both marked sent on the same job', sa.status === 'sent' && sf.status === 'sent' && sa.luluJobId === '900' && sf.luluJobId === '900');
  await po.sweep();
  check('never sent twice', jobs.length === 1);
  jobState = { name: 'SHIPPED' };
  await po.sweep();
  check('one "on its way" email for the box', mails.length === 1, mails.length);
  check('naming both books', mails[0] && /Maya and The Smiths have shipped, together in one box/.test(mails[0].text), mails[0] && mails[0].text);
  await po.sweep();
  check('and only once', mails.length === 1);

  server.close();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nfailed:'); failures.forEach((x) => console.log('  - ' + x)); }
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error('\ntest run crashed:', err); process.exit(1); });
