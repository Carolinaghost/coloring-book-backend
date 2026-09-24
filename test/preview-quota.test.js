#!/usr/bin/env node
'use strict';

// Free previews are rationed per visitor per day.
//
//   npm test
//
// Why this has its own file: the old limiter was eight per hour, held in a Map
// in the web process. Two things were wrong with that and both were invisible.
//
// An hourly window that rolls forever is not a limit, it is a queue. Wait an
// hour, take eight more, repeat all day. Nobody steals a book that way - only
// the first two scenes are ever free - but every one of those is an image we
// pay OpenAI to draw.
//
// And a counter in memory dies with the process. This service redeploys
// whenever main moves, so a "daily" cap kept in a Map would lift itself
// several times a week without anyone noticing.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-not-a-real-key';
delete process.env.DATABASE_URL;   // exercise the in-memory store

const db = require('../db.js');
const { app, previewDay, quotaWindow, clientIp } = require('../server.js');

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

async function take(ip, day, limit = 8) {
  return db.takePreviewQuota(ip, day, limit);
}

async function main() {
  console.log('\nCounting to the limit');

  const day = '2026-09-20';
  const allowed = [];
  for (let i = 0; i < 8; i++) allowed.push((await take('1.1.1.1', day)).allowed);
  check('the first eight are allowed', allowed, Array(8).fill(true));
  check('and they are counted, not just waved through',
    (await take('1.1.1.1', day, 99)).used, 9);

  const ninth = await take('2.2.2.2', day);
  for (let i = 0; i < 7; i++) await take('2.2.2.2', day);
  check('the ninth is refused', (await take('2.2.2.2', day)).allowed, false);
  check('and the first of that run was fine', ninth.allowed, true);

  console.log('\nWhat resets it, and what does not');

  check('tomorrow starts again', (await take('2.2.2.2', '2026-09-21')).allowed, true);
  check('a different visitor is unaffected', (await take('3.3.3.3', day)).allowed, true);
  // The old bug: sixty minutes was all it took. Nothing inside a day resets it
  // now, which is the entire point of the change.
  const sameDayAgain = await take('2.2.2.2', day);
  check('the same visitor on the same day is still refused', sameDayAgain.allowed, false);

  console.log('\nWhose midnight');

  // 03:00 UTC is still yesterday evening in New York. Counting in UTC would
  // hand every visitor a fresh eight at 8pm.
  check('late evening in New York is still the same local day',
    previewDay(new Date('2026-09-21T03:00:00Z')), '2026-09-20');
  check('and just after local midnight it has rolled',
    previewDay(new Date('2026-09-21T04:30:00Z')), '2026-09-21');
  check('the shape is what a DATE column wants',
    /^\d{4}-\d{2}-\d{2}$/.test(previewDay(new Date())), true);

  console.log('\nWho the visitor actually is');

  // The bug this caught in production: two proxies sit in front of the app and
  // trust proxy is 1, so req.ip is the Cloudflare edge. The first row ever
  // written to preview_quota was 172.71.190.90 - a Cloudflare address, not a
  // person. Everyone behind that edge would have shared one daily allowance.
  const req = (headers, ip) => ({ headers, ip });

  check('Cloudflare tells us the real visitor, and we believe it',
    clientIp(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9, 172.71.190.90' },
      '172.71.190.90')), '203.0.113.9');
  check('without Cloudflare, the leftmost forwarded address is the client',
    clientIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' }, '10.0.0.2')), '203.0.113.9');
  check('spaces around the entries do not become part of the key',
    clientIp(req({ 'x-forwarded-for': '  203.0.113.9 , 10.0.0.1' }, '10.0.0.2')), '203.0.113.9');
  check('an empty header is not treated as an address',
    clientIp(req({ 'cf-connecting-ip': '   ', 'x-forwarded-for': '' }, '10.0.0.2')), '10.0.0.2');
  check('with no proxy headers at all it falls back to the socket',
    clientIp(req({}, '10.0.0.2')), '10.0.0.2');
  check('and with nothing at all it still returns a usable key',
    clientIp(req({}, undefined)), 'unknown');
  // The specific failure mode, stated as a test so it cannot come back.
  check('the Cloudflare edge is never what gets counted',
    clientIp(req({ 'cf-connecting-ip': '198.51.100.4' }, '172.71.190.90')) === '172.71.190.90', false);

  console.log('\nGiving one back');

  // A preview is charged for before OpenAI is asked - it has to be, or the
  // endpoint can be looped for free - so a draw that fails has taken something
  // and given nothing back. Cheryl spent eight in ten minutes, five of them
  // refused by OpenAI, and finished with one book out of four and no allowance
  // left to try again.
  const refundDay = '2026-09-25';
  await take('4.4.4.4', refundDay);
  await take('4.4.4.4', refundDay);
  check('two taken', (await take('4.4.4.4', refundDay, 99)).used, 3);
  check('one given back leaves the count where it was',
    await db.refundPreviewQuota('4.4.4.4', refundDay), 2);

  // A refund undoes something that happened. It is not a credit.
  const freshDay = '2026-09-26';
  check('a visitor who took nothing cannot be refunded below zero',
    await db.refundPreviewQuota('5.5.5.5', freshDay), 0);
  const afterBogusRefund = [];
  for (let i = 0; i < 9; i++) afterBogusRefund.push((await take('5.5.5.5', freshDay)).allowed);
  check('and still gets exactly the eight they were owed',
    afterBogusRefund, Array(8).fill(true).concat([false]));

  // The one that would have saved her: spend the lot, have them all fail, and
  // the allowance is whole again.
  const spentDay = '2026-09-27';
  for (let i = 0; i < 8; i++) await take('6.6.6.6', spentDay);
  check('eight spent means the ninth is refused',
    (await take('6.6.6.6', spentDay)).allowed, false);
  for (let i = 0; i < 8; i++) await db.refundPreviewQuota('6.6.6.6', spentDay);
  check('eight given back means they can try again',
    (await take('6.6.6.6', spentDay)).allowed, true);

  console.log('\nWhen the drawing actually fails');

  // End to end, through the real endpoint, because the refund is only worth
  // anything if the failure path reaches it.
  const realFetch = global.fetch;
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    const visitor = '203.0.113.77';
    // The key the ROUTE writes under, which is the window the allowance runs
    // in - no longer the calendar day. Probing previewDay() here read a row the
    // route never touches, and the count came back one short.
    const today = quotaWindow();

    const convert = async () => {
      const form = new FormData();
      form.append('photo', new Blob([Buffer.from('not really a jpeg')], { type: 'image/jpeg' }), 'kid.jpg');
      form.append('theme', 'Superhero');
      form.append('sceneIndex', '0');
      const r = await realFetch(`http://127.0.0.1:${port}/convert`, {
        method: 'POST', body: form, headers: { 'x-forwarded-for': visitor }
      });
      return { status: r.status, body: await r.json() };
    };

    // What OpenAI did to her: refused, five times, with no page to show for it.
    global.fetch = async (url) => {
      const href = typeof url === 'string' ? url : url.href || String(url);
      if (href.includes('api.openai.com')) {
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: 'Your request was rejected by the safety system.' } }),
          json: async () => ({ error: { message: 'Your request was rejected by the safety system.' } })
        };
      }
      return realFetch(url);
    };

    const refused = await convert();
    check('a refused draw is reported as a failure', refused.status, 502);
    check('and costs the visitor nothing',
      (await db.takePreviewQuota(visitor, today, 99)).used, 1);
    await db.refundPreviewQuota(visitor, today);   // undo the probe above

    // And a real page still counts, or the ration means nothing.
    const onePngPixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    global.fetch = async (url) => {
      const href = typeof url === 'string' ? url : url.href || String(url);
      if (href.includes('api.openai.com')) {
        return { ok: true, json: async () => ({ data: [{ b64_json: onePngPixel }] }) };
      }
      return realFetch(url);
    };

    const drawn = await convert();
    check('a page that was actually drawn comes back', drawn.status, 200);
    check('and that one is charged for',
      (await db.takePreviewQuota(visitor, today, 99)).used, 2);
  } finally {
    global.fetch = realFetch;
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
