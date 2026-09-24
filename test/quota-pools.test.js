#!/usr/bin/env node
'use strict';

// Tests that the style strip and the Step 3 preview ration from SEPARATE pools,
// and that a visitor is told apart by their own address rather than the proxy's
// (server.js: takeFreePreview / clientIp, db.js: takePreviewQuota).
//
//   npm test                                      the in-memory store
//   DATABASE_URL=... ALLOW_DB_TESTS=1 npm test    the real SQL as well
//
// Both allowances ration free images, but they are not worth the same. The
// Step 3 preview belongs to an order somebody is part way through placing. The
// strip is drawn automatically for anyone who drops a photo on the page. While
// they shared one pool, two automatic strips spent six of eight and a real
// customer could not see the preview attached to their own order: the person
// who never asked for anything starved the person about to pay.
//
// The address matters for the same reason. Every visitor behind one proxy looks
// like one visitor unless the real address is read off the forwarding headers,
// and a per-visitor limit that cannot tell visitors apart is a limit on the
// whole site.

const http = require('http');
const express = require('express');
const db = require('../db.js');
const { clientIp, takeFreePreview, FREE_PREVIEWS_PER_IP, FREE_STRIP_IMAGES_PER_IP, previewDay, quotaWindow, QUOTA_WINDOW_DAYS } = require('../server.js');

let pass = 0;
const failures = [];
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
  else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
    console.log(`         got  ${JSON.stringify(got)}`);
    console.log(`         want ${JSON.stringify(want)}`);
  }
}

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.log('\nSKIPPED: DATABASE_URL is set without ALLOW_DB_TESTS=1.');
  process.exit(0);
}

// A real server, configured exactly as server.js is, answering with whoever it
// decided the caller was. Real sockets and real headers: a unit test on
// clientIp alone would not exercise Express's own proxy handling.
function probeServer() {
  const app = express();
  app.set('trust proxy', 1);            // the same line server.js sets
  app.get('/who', (req, res) => res.json({ ip: clientIp(req) }));
  return app.listen(0);
}
function ask(server, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/who', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body).ip));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  await db.initDb();
  const store = db.usingPostgres ? 'postgres' : 'memory';
  console.log(`\nStore under test: ${store}`);
  const day = quotaWindow();

  console.log('\nTwo visitors behind the proxy are two visitors');

  const server = probeServer();
  try {
    const a = await ask(server, { 'x-forwarded-for': '203.0.113.7' });
    const b = await ask(server, { 'x-forwarded-for': '198.51.100.22' });
    check('a forwarded address is read, not the socket', a, '203.0.113.7');
    check('and a different one gives a different answer', b, '198.51.100.22');
    check('the two are not the same visitor', a === b, false);

    // A chain: the client is the FIRST entry, the rest are proxies it passed.
    check('the client is taken from the front of the chain',
      await ask(server, { 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 10.0.0.1' }), '203.0.113.9');
    // Cloudflare names the visitor outright, and it wins.
    check('cloudflare\'s own header wins when present',
      await ask(server, { 'cf-connecting-ip': '203.0.113.40', 'x-forwarded-for': '10.0.0.1' }), '203.0.113.40');
    // Nothing forwarded at all: the socket, which is the honest answer direct.
    const bare = await ask(server, {});
    check('with no headers it falls back to the socket', /127\.0\.0\.1|::1|::ffff:127/.test(bare), true);
  } finally { server.close(); }

  console.log('\nSeparate addresses get separate buckets');

  const one = 'ip-one-' + Math.random().toString(36).slice(2);
  const two = 'ip-two-' + Math.random().toString(36).slice(2);
  await db.takePreviewQuota(one, day, 8, 8, 'step3');
  check('one address spends its whole allowance',
    (await db.takePreviewQuota(one, day, 8, 1, 'step3')).allowed, false);
  check('and the other still has all of it',
    (await db.takePreviewQuota(two, day, 8, 8, 'step3')).allowed, true);

  console.log('\nThe strip cannot starve a paying customer');

  const ip = 'both-' + Math.random().toString(36).slice(2);
  // Spend every image the strip is allowed - three runs of four.
  for (let run = 1; run <= 3; run++) {
    check(`strip run ${run} of 3 is allowed`,
      await takeFreePreview(ip, 4, 'strip'), null);
  }
  check('a fourth strip run is refused', await takeFreePreview(ip, 4, 'strip'), 'visitor');
  // The whole point: Step 3 is untouched by any of that.
  check('Step 3 still has every one of its previews',
    (await db.takePreviewQuota(ip, day, FREE_PREVIEWS_PER_IP, FREE_PREVIEWS_PER_IP, 'step3')).allowed, true);

  console.log('\nAnd the reverse: Step 3 running dry leaves the strip alone');

  const ip2 = 'both2-' + Math.random().toString(36).slice(2);
  for (let i = 0; i < FREE_PREVIEWS_PER_IP; i++) await takeFreePreview(ip2);
  check('Step 3 is spent', await takeFreePreview(ip2), 'visitor');
  check('the strip still has its full allowance', await takeFreePreview(ip2, 4, 'strip'), null);

  console.log('\nRefunds go back to the pool they came from');

  const ip3 = 'refund-' + Math.random().toString(36).slice(2);
  await db.takePreviewQuota(ip3, day, FREE_STRIP_IMAGES_PER_IP, 4, 'strip');
  await db.takePreviewQuota(ip3, day, FREE_PREVIEWS_PER_IP, 4, 'step3');
  await db.refundPreviewQuota(ip3, day, 4, 'strip');
  check('the strip got its four back',
    (await db.takePreviewQuota(ip3, day, FREE_STRIP_IMAGES_PER_IP, FREE_STRIP_IMAGES_PER_IP, 'strip')).allowed, true);
  check('and Step 3 still shows its four spent',
    (await db.takePreviewQuota(ip3, day, FREE_PREVIEWS_PER_IP, FREE_PREVIEWS_PER_IP - 3, 'step3')).allowed, false);

  console.log('\nThe allowance lasts three days, not one');

  check('the window is three days long', QUOTA_WINDOW_DAYS, 3);

  // Four consecutive days that straddle a boundary, so day 1 and day 4 are in
  // different blocks and days 2 and 3 are in day 1's.
  const d1 = new Date('2026-09-22T12:00:00Z');
  const d2 = new Date('2026-09-23T12:00:00Z');
  const d3 = new Date('2026-09-24T12:00:00Z');
  const d4 = new Date('2026-09-25T12:00:00Z');
  const w = (d) => quotaWindow(d);
  check('day 2 falls in the same window as day 1', w(d2), w(d1));
  check('day 3 falls in the same window as day 1', w(d3), w(d1));
  check('day 4 starts a new one', w(d4) !== w(d1), true);

  // Spend the lot on day 1, then ask again on each of the next three days.
  const traveller = 'days-' + Math.random().toString(36).slice(2);
  await db.takePreviewQuota(traveller, w(d1), FREE_PREVIEWS_PER_IP, FREE_PREVIEWS_PER_IP, 'step3');
  check('day 1: the allowance is spent',
    (await db.takePreviewQuota(traveller, w(d1), FREE_PREVIEWS_PER_IP, 1, 'step3')).allowed, false);
  check('day 2: still blocked',
    (await db.takePreviewQuota(traveller, w(d2), FREE_PREVIEWS_PER_IP, 1, 'step3')).allowed, false);
  check('day 3: still blocked',
    (await db.takePreviewQuota(traveller, w(d3), FREE_PREVIEWS_PER_IP, 1, 'step3')).allowed, false);
  check('day 4: a fresh allowance',
    (await db.takePreviewQuota(traveller, w(d4), FREE_PREVIEWS_PER_IP, FREE_PREVIEWS_PER_IP, 'step3')).allowed, true);

  // The strip is on the same clock.
  const tripper = 'days2-' + Math.random().toString(36).slice(2);
  await db.takePreviewQuota(tripper, w(d1), FREE_STRIP_IMAGES_PER_IP, FREE_STRIP_IMAGES_PER_IP, 'strip');
  check('the strip is blocked on day 2 as well',
    (await db.takePreviewQuota(tripper, w(d2), FREE_STRIP_IMAGES_PER_IP, 4, 'strip')).allowed, false);
  check('and comes back on day 4',
    (await db.takePreviewQuota(tripper, w(d4), FREE_STRIP_IMAGES_PER_IP, 4, 'strip')).allowed, true);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nfailed:'); for (const f of failures) console.log(`  - ${f}`); }
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error('\ntest run crashed:', err); process.exit(1); });
