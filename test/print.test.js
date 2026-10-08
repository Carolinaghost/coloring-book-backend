#!/usr/bin/env node
'use strict';

// Printed copies: the print files, the Lulu client, the order flow, and what
// /checkout and the Stripe webhook do for a printed copy.
//   npm test
//
// What would go wrong quietly without these:
//   - a book Lulu refuses (wrong page size, wrong page count, drawings on both
//     sides of a sheet) - found only when a customer's book never arrives;
//   - shipping charged as a line item, where a 100%-off code wipes it out and
//     we pay for the post;
//   - a Stripe retry resetting a copy already sent to Lulu, printing it twice;
//   - a book printed for a code that took it below what printing costs.

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') { console.error('unset DATABASE_URL'); process.exit(1); }
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
process.env.PRINT_ENABLED = 'true';
process.env.LULU_CLIENT_KEY = 'test-key';
process.env.LULU_CLIENT_SECRET = 'test-secret';

const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const sharp = require('sharp');
const db = require('../db');
const { buildPrintInterior, buildPrintCover, interiorPageCount, POD_PACKAGE_ID } = require('../print-pdf');
const { createLulu, describe } = require('../lulu');
const { createPrintOrders } = require('../print-orders');

let pass = 0;
const fail = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + label); } else { fail.push(label); console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); }
}

const quiet = { log() {}, error() {} };

async function drawing(seed) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/>`
    + `<circle cx="128" cy="128" r="${60 + seed}" fill="none" stroke="black" stroke-width="6"/></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

// Page boxes and image sizes, read straight out of the PDF bytes.
function pdfFacts(buf) {
  const s = buf.toString('latin1');
  const pages = [...s.matchAll(/\/Type \/Page \/Parent \d+ 0 R \/MediaBox \[([^\]]+)\][^]*?\/Contents (\d+) 0 R/g)];
  const images = [...s.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const count = /\/Type \/Pages \/Count (\d+)/.exec(s);
  return { boxes: pages.map((m) => m[1].trim()), contents: pages.map((m) => Number(m[2])), images, count: count && Number(count[1]), text: s };
}

function request(server, path, { method = 'GET', body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: headers || (body ? { 'Content-Type': 'application/json' } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function stripeSignature(raw) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nThe print files');
  check('15 drawings is 32 pages (one drawing per sheet)', interiorPageCount(15) === 32);
  check('1 drawing is the 4-page minimum', interiorPageCount(1) === 4);
  check('23 drawings is 48 pages, the most Lulu takes', interiorPageCount(23) === 48);

  const pages = [];
  for (let i = 14; i >= 0; i--) pages.push({ sceneIndex: i, image: await drawing(i) });
  const { pdf, pageCount } = await buildPrintInterior({ childName: 'Owen', pages });
  const f = pdfFacts(pdf);
  check('interior reports 32 pages', pageCount === 32 && f.count === 32, [pageCount, f.count]);
  check('every page is 8.75in square (8.5in + bleed)', f.boxes.length === 32 && f.boxes.every((b) => b === '0 0 630.00 630.00'), f.boxes[0]);
  check('trim box is 0.125in in', /\/TrimBox \[9\.00 9\.00 621\.00 621\.00\]/.test(f.text));
  check('15 drawings at 300 PPI over 7.5in', f.images.length === 15 && f.images.every(([w, h]) => w === 2250 && h === 2250), f.images.slice(0, 2));
  // Drawings on odd pages (3, 5, ... 31); every back is empty.
  const s = f.text;
  const contentOf = (objNum) => {
    const m = new RegExp(`\\n${objNum} 0 obj\\n<< /Length (\\d+) >>\\nstream\\n`).exec(s);
    return m ? s.substr(m.index + m[0].length, Number(m[1])) : null;
  };
  const kinds = f.contents.map((c) => { const t = contentOf(c); return t === '' ? 'blank' : /Do/.test(t) ? 'drawing' : 'text'; });
  check('page 1 is the title page, page 2 blank', kinds[0] === 'text' && kinds[1] === 'blank', kinds.slice(0, 3));
  check('drawings only on right-hand pages, every back blank',
    kinds.slice(2, 32).every((k, i) => (i % 2 === 0 ? k === 'drawing' : k === 'blank')), kinds);
  check('font embedded', /\/FontFile2 \d+ 0 R/.test(s) && /\/BaseFont \/Baloo2-ExtraBold/.test(s));
  let threw = false;
  try { await buildPrintInterior({ childName: 'X', pages: Array.from({ length: 24 }, (_, i) => ({ sceneIndex: i, image: pages[0].image })) }); } catch (e) { threw = /48/.test(e.message); }
  check('more than Lulu can bind is refused, not sent', threw);

  const cover = await buildPrintCover({ childName: 'Owen', lineImage: pages[0].image, colorImage: pages[1].image, widthPt: 1242, heightPt: 630 });
  const cf = pdfFacts(cover);
  check('cover is one spread at the size Lulu gave', cf.count === 1 && cf.boxes[0] === '0 0 1242.00 630.00', cf.boxes);
  check('cover title is real text in the embedded font', /\(OWEN'S\) Tj/.test(cf.text) && /\/FontFile2/.test(cf.text));
  check('cover has the colour picture as JPEG', /\/DCTDecode/.test(cf.text));
  threw = false;
  try { await buildPrintCover({ childName: 'Owen', lineImage: pages[0].image, colorImage: pages[1].image, widthPt: 1242, heightPt: 700 }); } catch (e) { threw = true; }
  check('a cover size that is not this book is refused', threw);
  threw = false;
  try { await buildPrintCover({ childName: 'Owen', lineImage: pages[0].image, colorImage: null, widthPt: 1242, heightPt: 630 }); } catch (e) { threw = true; }
  check('no coloured picture, no cover', threw);
  const odd = await buildPrintCover({ childName: 'Zoë (Jo)', lineImage: pages[0].image, colorImage: pages[1].image, widthPt: 1242, heightPt: 630 });
  check('accents and brackets in a name survive', /\(ZO\xcb \\\(JO\\\)'S\) Tj/.test(odd.toString('latin1')));

  // -------------------------------------------------------------------------
  console.log('\nThe Lulu client');
  const calls = [];
  let tokenCalls = 0;
  let clock = 1000000;
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/openid-connect/token')) {
      tokenCalls++;
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' + tokenCalls, expires_in: 3600 }) };
    }
    if (url.endsWith('/print-jobs/') && opts.method === 'POST') {
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 4242, status: { name: 'CREATED' } }) };
    }
    if (url.endsWith('/cover-dimensions/')) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ interior_page_count: ['must be a multiple of 4'] }) };
    }
    return { ok: false, status: 401, text: async () => '{"detail":"expired"}' };
  };
  const l = createLulu({ clientKey: 'k', clientSecret: 's', fetchImpl: fakeFetch, now: () => clock });
  const job = await l.createPrintJob({ a: 1 });
  const tok = calls[0];
  check('token: client credentials with Basic auth', tok.opts.body === 'grant_type=client_credentials'
    && tok.opts.headers.Authorization === 'Basic ' + Buffer.from('k:s').toString('base64'));
  check('production by default', tok.url.startsWith('https://api.lulu.com/'));
  check('job posted as JSON with the bearer token', calls[1].opts.headers.Authorization === 'Bearer tok1' && calls[1].opts.body === '{"a":1}' && job.id === 4242);
  await l.createPrintJob({ a: 2 });
  check('token reused while fresh', tokenCalls === 1);
  clock += 3600 * 1000;
  await l.createPrintJob({ a: 3 });
  check('token renewed once it expires', tokenCalls === 2);
  let msg = '';
  try { await l.coverDimensions(POD_PACKAGE_ID, 30); } catch (e) { msg = e.message; }
  check("Lulu's field errors come through readable", /interior_page_count: must be a multiple of 4/.test(msg), msg);
  try { await l.getPrintJob(1); } catch (e) { msg = e.message; }
  check('a 401 is reported', /401/.test(msg));
  const sb = createLulu({ clientKey: 'k', clientSecret: 's', sandbox: true, fetchImpl: fakeFetch });
  check('sandbox uses the sandbox host', sb.base === 'https://api.sandbox.lulu.com');
  check('no keys, not configured', createLulu({}).configured === false);
  check('describe flattens nested errors', describe({ a: { b: ['x', 'y'] } }) === 'a.b: x; a.b: y');

  // -------------------------------------------------------------------------
  console.log('\nThe order flow');
  const alerts = [];
  const mails = [];
  const fakeMailer = {
    configured: true,
    sendMail: async (m) => { mails.push(m); return true; },
    printShippedEmail: require('../mailer').printShippedEmail
  };
  const jobs = [];
  let jobState = { name: 'CREATED' };
  let failCreate = false;
  const fakeLulu = {
    configured: true, sandbox: false,
    coverDimensions: async (pod, n) => ({ width: '1242.000', height: '630.000', unit: 'pt', pod, n }),
    createPrintJob: async (p) => { if (failCreate) throw new Error('Lulu said no'); jobs.push(p); return { id: 777, status: { name: 'CREATED' } }; },
    getPrintJob: async () => ({ id: 777, status: jobState, line_items: [{ status: { messages: { tracking_urls: ['https://track.example/777'] } } }] })
  };
  let colorCalls = 0;
  // The in-memory store does not keep pages (only Postgres does), so the
  // pages this flow reads are kept here instead.
  const pageStore = new Map();
  const tdb = Object.create(db);
  tdb.listPages = async (id) => pageStore.get(Number(id)) || [];
  const po = createPrintOrders({
    db: tdb, lulu: fakeLulu, mailer: fakeMailer, log: quiet,
    colorize: async (img) => { colorCalls++; return img; },
    alert: async (a) => { alerts.push(a); },
    filesBaseUrl: 'https://api.example.test/', contactEmail: 'accounts@example.test', maxAttempts: 2
  });

  const order = await db.saveOrder({ childName: 'Owen', email: 'mum@example.test', theme: 'Adventure', pageCount: 15 });
  const oid = order.id;
  pageStore.set(oid, pages.slice());
  await db.setOrderProduct(oid, 'print');

  const newShape = {
    id: 'cs_1', metadata: { product: 'print' }, amount_subtotal: 1500, amount_total: 1999,
    total_details: { amount_discount: 0, amount_shipping: 499 },
    collected_information: { shipping_details: { name: 'Ann Smith', address: { line1: '1 Main St', line2: '', city: 'Columbia', state: 'SC', postal_code: '29201', country: 'US' } } },
    customer_details: { email: 'mum@example.test', phone: '+18035550100' }
  };
  const rec = await po.recordPaidSession(newShape, await db.getOrderWithToken(oid));
  check('printed copy recorded as waiting', rec && rec.status === 'waiting', rec);
  check('address read from collected_information', rec.ship.street1 === '1 Main St' && rec.ship.state_code === 'SC' && rec.ship.phone_number === '+18035550100');
  check('shipping paid is kept', rec.shippingCents === 499);
  check('a files token is made', /^[0-9a-f]{36}$/.test(rec.filesToken));
  const again = await po.recordPaidSession(Object.assign({}, newShape, { customer_details: { email: 'x@y', phone: '1' } }), await db.getOrderWithToken(oid));
  check('a Stripe retry changes nothing', again.ship.phone_number === '+18035550100');
  const oldShape = { shipping_details: { name: 'B', address: { line1: '2 Oak', city: 'X', state: 'GA', postal_code: '30301', country: 'US' } }, customer_details: { phone: '1', email: 'e@f' } };
  check('older Stripe shape read too', po.shipFromSession(oldShape, {}).street1 === '2 Oak');
  check('a digital order makes no print row', await po.recordPaidSession({ metadata: { product: 'digital' } }, { id: 99999, product: 'digital' }) === null);

  // Not yet: the book is still drawing.
  await db.setGenerationStatus(oid, 'rendering');
  await po.prepareAndSend(oid);
  check('nothing sent before the book is finished', jobs.length === 0 && (await db.getPrintOrder(oid)).status === 'waiting');

  await db.setGenerationStatus(oid, 'done');
  const sent = await po.prepareAndSend(oid);
  check('sent to Lulu', sent.status === 'sent' && sent.luluJobId === '777', sent);
  check('cover coloured once', colorCalls === 1 && Boolean(sent.coverColor));
  const pj = jobs[0];
  const li = pj.line_items[0];
  check('right product', li.printable_normalization.pod_package_id === '0850X0850.BW.STD.SS.060UW444.MXX');
  check('file links carry the token', li.printable_normalization.interior.source_url === `https://api.example.test/print-files/${oid}/${sent.filesToken}/interior.pdf`
    && li.printable_normalization.cover.source_url.endsWith(`/${sent.filesToken}/cover.pdf`), li.printable_normalization);
  check('mail shipping, our contact email, our order number', pj.shipping_level === 'MAIL' && pj.contact_email === 'accounts@example.test' && pj.external_id === 'crayonauts-' + oid);
  check('address and phone go to Lulu', pj.shipping_address.name === 'Ann Smith' && pj.shipping_address.postcode === '29201'
    && pj.shipping_address.phone_number === '+18035550100' && pj.shipping_address.email === 'mum@example.test' && !('street2' in pj.shipping_address));
  check('title names the child', li.title === "Owen's Coloring Adventure" && li.quantity === 1);
  check('Jonathan told it went', alerts.some((a) => /sent to Lulu/.test(a.subject)));
  await po.prepareAndSend(oid);
  check('never sent twice', jobs.length === 1);

  check('wrong token gets nothing', await po.getFile(oid, 'nope', 'interior') === null);
  check('unknown file gets nothing', await po.getFile(oid, sent.filesToken, 'secrets') === null);
  const inside = await po.getFile(oid, sent.filesToken, 'interior');
  check('right token gets the interior', inside && pdfFacts(inside).count === 32);
  const outside = await po.getFile(oid, sent.filesToken, 'cover');
  check('and the cover', outside && pdfFacts(outside).count === 1);

  // Lulu progress.
  await po.checkJob(await db.getPrintOrder(oid));
  check('still printing: no email', mails.length === 0);
  jobState = { name: 'SHIPPED' };
  const shipped = await po.checkJob(await db.getPrintOrder(oid));
  check('shipped recorded with tracking', shipped.status === 'shipped' && shipped.trackingUrl === 'https://track.example/777');
  check('customer emailed the tracking link', mails.length === 1 && mails[0].to === 'mum@example.test' && /track\.example\/777/.test(mails[0].text));
  await po.checkJob(await db.getPrintOrder(oid));
  check('only once', mails.length === 1);
  await po.sweep();
  check('sweep leaves shipped jobs alone', mails.length === 1);

  // A code that took the book to nearly nothing is held.
  const o2 = await db.saveOrder({ childName: 'Mia', email: 'm@example.test', theme: 'Adventure', pageCount: 15 });
  const held = await po.recordPaidSession(Object.assign({}, newShape, { amount_subtotal: 1500, total_details: { amount_discount: 1500, amount_shipping: 499 } }),
    Object.assign(await db.getOrderWithToken(o2.id), { product: 'print' }));
  check('100%-off code: held, not printed', held.status === 'held' && /discount/.test((await db.getPrintOrder(o2.id)).lastError));
  check('and Jonathan is told', alerts.some((a) => /on hold/.test(a.subject)));
  const released = await po.release(o2.id);
  check('release puts it back in the queue', released.status === 'waiting');

  // Missing phone.
  const o3 = await db.saveOrder({ childName: 'Lu', email: 'l@example.test', theme: 'Adventure', pageCount: 15 });
  const nophone = await po.recordPaidSession(Object.assign({}, newShape, { customer_details: { email: 'l@example.test' } }),
    Object.assign(await db.getOrderWithToken(o3.id), { product: 'print' }));
  check('no phone number: held (Lulu needs one)', nophone.status === 'held');
  check('and cannot be released without one', (await po.release(o3.id)).status === 'held');

  // Failures retry, then stop and say so.
  const o4 = await db.saveOrder({ childName: 'Kai', email: 'k@example.test', theme: 'Adventure', pageCount: 15 });
  pageStore.set(o4.id, pages.slice());
  await db.setGenerationStatus(o4.id, 'done');
  await po.recordPaidSession(newShape, Object.assign(await db.getOrderWithToken(o4.id), { product: 'print' }));
  failCreate = true;
  const t1 = await po.prepareAndSend(o4.id);
  check('first failure: back to waiting', t1.status === 'waiting' && t1.attempts === 1 && /Lulu said no/.test(t1.lastError));
  const t2 = await po.prepareAndSend(o4.id);
  check('last attempt: failed, and Jonathan told', t2.status === 'failed' && alerts.some((a) => a.level === 'ALERT' && /could not be sent/.test(a.subject)));
  failCreate = false;

  // Lulu rejects one.
  const o5 = await db.saveOrder({ childName: 'Rae', email: 'r@example.test', theme: 'Adventure', pageCount: 15 });
  await db.savePrintOrder({ orderId: o5.id, ship: {}, status: 'sent' });
  await db.updatePrintOrder(o5.id, { luluJobId: '888' });
  jobState = { name: 'REJECTED', message: 'Interior file has wrong page size' };
  const rj = await po.checkJob(await db.getPrintOrder(o5.id));
  check('rejected by Lulu: failed with the reason, and an alert', rj.status === 'failed' && /wrong page size/.test(rj.lastError)
    && alerts.some((a) => /rejected/.test(a.subject)));

  // -------------------------------------------------------------------------
  console.log('\n/checkout and the webhook');
  const server = require('../server');
  const http2 = server.app.listen(0);
  await new Promise((r) => http2.once('listening', r));
  const stripeBodies = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/v1/promotion_codes')) return { ok: true, json: async () => ({ data: [] }) };
    if (String(url).includes('api.stripe.com')) {
      stripeBodies.push(new URLSearchParams(String(opts.body)));
      return { ok: true, json: async () => ({ id: 'cs_print_1', url: 'https://checkout.stripe.test/x' }) };
    }
    if (String(url).includes('openai.com')) return { ok: false, status: 500, json: async () => ({ error: { message: 'not in tests' } }) };
    return realFetch(url, opts);
  };
  try {
    const made = JSON.parse((await request(http2, '/orders', { method: 'POST',
      body: JSON.stringify({ childName: 'Ava', email: 'a@b.test', theme: 'Portrait', pageCount: 15 }) })).body.toString());
    const res = await request(http2, '/checkout', { method: 'POST',
      body: JSON.stringify({ orderId: made.order.id, token: made.accessToken, product: 'print' }) });
    const out = JSON.parse(res.body.toString());
    const b = stripeBodies[stripeBodies.length - 1];
    check('checkout answers', res.status === 200, out);
    check('book stays $15', b.get('line_items[0][price_data][unit_amount]') === '1500');
    check('only one line item - the printed copy is free', !b.has('line_items[1][price_data][unit_amount]'));
    check('label says the printed copy is free', /free printed copy/.test(b.get('line_items[0][price_data][product_data][name]')));
    check('shipping is a $4.99 shipping rate (codes cannot discount it)', b.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]') === '499'
      && b.get('shipping_options[0][shipping_rate_data][type]') === 'fixed_amount');
    check('US address and a phone number are collected', b.get('shipping_address_collection[allowed_countries][0]') === 'US' && b.get('phone_number_collection[enabled]') === 'true');
    check('marked as a print order', b.get('metadata[product]') === 'print');
    check('total reported to the page is $19.99', out.amountCents === 1999 && /amt=19\.99/.test(b.get('success_url')));
    check('order remembers it is a printed copy', (await db.getOrderWithToken(made.order.id)).product === 'print');

    const resD = await request(http2, '/checkout', { method: 'POST',
      body: JSON.stringify({ orderId: made.order.id, token: made.accessToken, product: 'digital' }) });
    const bd = stripeBodies[stripeBodies.length - 1];
    check('digital checkout has no shipping and no address', resD.status === 200 && !bd.has('shipping_options[0][shipping_rate_data][type]')
      && !bd.has('shipping_address_collection[allowed_countries][0]') && bd.get('metadata[product]') === 'digital');
    await db.setOrderProduct(made.order.id, 'print');
    await db.attachCheckoutSession(made.order.id, 'cs_print_1', 1999);

    const event = { id: 'evt_print', type: 'checkout.session.completed', data: { object: Object.assign({}, newShape, { id: 'cs_print_1', client_reference_id: String(made.order.id), payment_status: 'paid' }) } };
    const raw = JSON.stringify(event);
    const wh = await request(http2, '/stripe/webhook', { method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'stripe-signature': stripeSignature(raw) } });
    const row = await db.getPrintOrder(made.order.id);
    check('webhook answers', wh.status === 200);
    check('webhook keeps the address for the printed copy', row && row.status === 'waiting' && row.ship.city === 'Columbia', row);

    const cfg = JSON.parse((await request(http2, '/options')).body.toString());
    check('/options tells the site printed copies are on, at $4.99', cfg.print && cfg.print.enabled === true && cfg.print.shippingCents === 499, cfg.print);
    const nf = await request(http2, `/print-files/${made.order.id}/wrongtoken/interior.pdf`);
    check('print files need the token', nf.status === 404);
  } finally {
    global.fetch = realFetch;
    http2.close();
  }

  console.log('\n' + pass + ' passed' + (fail.length ? ', FAILED: ' + fail.join('; ') : ''));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
