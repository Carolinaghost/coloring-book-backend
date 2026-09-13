#!/usr/bin/env node
'use strict';

// Tests for the funnel counters (db.js: recordEvent / funnelStats / sourceStats
// / purgeOldEvents).
//
//   npm test                            runs against the in-memory store
//   ALLOW_DB_TESTS=1 DATABASE_URL=...   runs against a real Postgres
//
// Running against Postgres needs the opt-in because one of these tests deletes
// rows. Point it at a scratch database, never at production.
//
// Every assertion is a delta - measured before, measured after, compared - so a
// database that already holds counters does not change the result. Each run
// tags its rows with a unique id so two runs cannot see each other's.

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.error(
    'DATABASE_URL is set, but these tests write and delete event rows.\n'
    + 'Re-run with ALLOW_DB_TESTS=1 against a scratch database, or unset\n'
    + 'DATABASE_URL to test the in-memory store.'
  );
  process.exit(1);
}

const db = require('../db.js');
const usingPostgres = db.usingPostgres;
const RUN = Math.random().toString(36).slice(2, 10);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A full order, shaped the way POST /orders shapes one. The columns below are
// NOT NULL with defaults, but saveOrder passes explicit values, and an explicit
// NULL beats a column default - so the caller has to supply them.
function orderFields(extra) {
  return Object.assign({
    childName: 'Ada',
    childCount: 1,
    email: 'ada@example.com',
    theme: 'Portrait',
    notes: '',
    thumb: null,
    pageCount: 8,
    photo: null,
    subjectType: 'kid',
    visitor: '',
    source: '',
    campaign: ''
  }, extra);
}

async function funnelRow(type, days = 7) {
  return (await db.funnelStats(days)).find((r) => r.type === type);
}

async function sourceRow(source, days = 7) {
  return (await db.sourceStats(days)).find((r) => r.source === source)
    || { source, visitors: 0, paid: 0 };
}

async function main() {
  await db.initDb();
  console.log(`\nfunnel counters - ${usingPostgres ? 'postgres' : 'memory'} store (run ${RUN})\n`);

  // -------------------------------------------------------------------------
  console.log('recordEvent rejects what it should');
  // -------------------------------------------------------------------------
  check('unknown type rejected', await db.recordEvent({ type: 'hacked', visitor: 'x' }), false);
  check('empty type rejected', await db.recordEvent({ type: '', visitor: 'x' }), false);
  check('missing type rejected', await db.recordEvent({ visitor: 'x' }), false);
  check('known type accepted', await db.recordEvent({ type: 'landed', visitor: `${RUN}-ok`, source: RUN }), true);

  // -------------------------------------------------------------------------
  console.log('\nfields are normalised and capped');
  // -------------------------------------------------------------------------
  const longSource = `${RUN}-` + 's'.repeat(200);
  await db.recordEvent({ type: 'landed', visitor: 'v'.repeat(500), source: longSource, campaign: 'c'.repeat(500) });
  const capped = (await db.sourceStats(7)).find((r) => r.source.startsWith(`${RUN}-s`));
  check('source capped at 80 chars', capped && capped.source.length, 80);

  await db.recordEvent({ type: 'landed', visitor: `${RUN}-case`, source: `  ${RUN.toUpperCase()}-MiXeD  ` });
  check('source trimmed and lowercased',
    (await sourceRow(`${RUN}-mixed`)).visitors, 1);

  await db.recordEvent({ type: 'landed', visitor: `${RUN}-direct` });
  check('blank source bucketed as direct', (await sourceRow('direct')).visitors > 0, true);

  // -------------------------------------------------------------------------
  console.log('\nfunnel shape');
  // -------------------------------------------------------------------------
  check('rows are in flow order', (await db.funnelStats(7)).map((r) => r.type),
    ['landed', 'uploaded', 'preview_started', 'preview_shown', 'unlock_clicked', 'paid']);
  check('a rejected type never appears',
    (await db.funnelStats(7)).some((r) => r.type === 'hacked'), false);

  // -------------------------------------------------------------------------
  console.log('\na sale is credited to the channel that brought it');
  // -------------------------------------------------------------------------
  const src = `${RUN}-tiktok`;
  const before = await sourceRow(src);

  await db.recordEvent({ type: 'landed', visitor: `${RUN}-buyer`, source: src.toUpperCase(), campaign: 'Sept' });
  const order = await db.saveOrder(orderFields({ visitor: `${RUN}-buyer`, source: src, campaign: 'sept' }));
  await db.attachCheckoutSession(order.id, `cs_${RUN}`, 1999);
  const paidOrder = await db.markPaid(`cs_${RUN}`, 1999);

  check('markPaid returns the order', paidOrder && paidOrder.id, order.id);
  check('paid order keeps its visitor', paidOrder && paidOrder.visitor, `${RUN}-buyer`);
  check('paid order keeps its source', paidOrder && paidOrder.source, src);

  // What the Stripe webhook does with it.
  check('paid event accepted server-side', await db.recordEvent({
    type: 'paid', visitor: paidOrder.visitor, source: paidOrder.source,
    campaign: paidOrder.campaign, orderId: paidOrder.id
  }), true);

  const after = await sourceRow(src);
  check('channel gained one visitor', after.visitors - before.visitors, 1);
  check('channel gained one sale', after.paid - before.paid, 1);

  // -------------------------------------------------------------------------
  console.log('\nStripe retries do not inflate the sale count');
  // -------------------------------------------------------------------------
  // markPaid has no "already paid" guard on purpose: a retry is how a render
  // that stalled at capacity gets picked back up. So the same paid event can be
  // written more than once, and the counting has to tolerate it.
  const beforeRetry = await sourceRow(src);
  for (let i = 0; i < 2; i++) {
    await db.recordEvent({
      type: 'paid', visitor: paidOrder.visitor, source: paidOrder.source,
      campaign: paidOrder.campaign, orderId: paidOrder.id
    });
  }
  check('two retries add no extra sales', (await sourceRow(src)).paid - beforeRetry.paid, 0);

  // -------------------------------------------------------------------------
  console.log('\nbuyers with no visitor id are counted separately');
  // -------------------------------------------------------------------------
  // The regression this suite exists for. The site's page always sets a visitor
  // id, but a stale cached page - or anything hitting the API that is not that
  // page - leaves it empty. Counting those DISTINCT made every anonymous buyer
  // look like the same person.
  const anon = `${RUN}-facebook`;
  const beforeAnon = await sourceRow(anon);
  for (let i = 0; i < 3; i++) {
    const o = await db.saveOrder(orderFields({ source: anon }));
    await db.attachCheckoutSession(o.id, `cs_${RUN}_anon${i}`, 1999);
    const p = await db.markPaid(`cs_${RUN}_anon${i}`, 1999);
    await db.recordEvent({ type: 'landed', visitor: '', source: anon });
    await db.recordEvent({ type: 'paid', visitor: '', source: anon, orderId: p.id });
  }
  const afterAnon = await sourceRow(anon);
  check('three anonymous sales count as three', afterAnon.paid - beforeAnon.paid, 3);
  check('three anonymous landings count as three', afterAnon.visitors - beforeAnon.visitors, 3);

  // Retries of an anonymous sale still fold together, because the order does it.
  const beforeAnonRetry = await sourceRow(anon);
  const dupe = await db.saveOrder(orderFields({ source: anon }));
  await db.recordEvent({ type: 'paid', visitor: '', source: anon, orderId: dupe.id });
  await db.recordEvent({ type: 'paid', visitor: '', source: anon, orderId: dupe.id });
  check('a retried anonymous sale counts once',
    (await sourceRow(anon)).paid - beforeAnonRetry.paid, 1);

  // -------------------------------------------------------------------------
  console.log('\nwindows are clamped');
  // -------------------------------------------------------------------------
  check('funnelStats(0) still returns every row', (await db.funnelStats(0)).length, 6);
  check('funnelStats(-1) still returns every row', (await db.funnelStats(-1)).length, 6);
  check('funnelStats(99999) still returns every row', (await db.funnelStats(99999)).length, 6);
  check('a 1-day window sees what we just wrote', (await funnelRow('landed', 1)).hits > 0, true);
  check('sourceStats returns at most 25 channels', (await db.sourceStats(365)).length <= 25, true);

  // -------------------------------------------------------------------------
  console.log('\nretention purge refuses to wipe the table');
  // -------------------------------------------------------------------------
  // A zero or negative window must fall back to the 180-day default rather than
  // deleting everything.
  check('purgeOldEvents(0) deletes nothing', await db.purgeOldEvents(0), 0);
  check('purgeOldEvents(-5) deletes nothing', await db.purgeOldEvents(-5), 0);
  check('purgeOldEvents(undefined) deletes nothing', await db.purgeOldEvents(), 0);
  check('fresh events survived', (await funnelRow('landed', 7)).hits > 0, true);

  if (!usingPostgres) {
    // Destructive, so memory store only.
    const total = (await db.funnelStats(365)).reduce((n, r) => n + r.hits, 0);
    await sleep(1100);
    check('purge removes events past the window', await db.purgeOldEvents(1 / 86400), total);
    check('nothing left afterwards', (await db.funnelStats(365)).reduce((n, r) => n + r.hits, 0), 0);
  } else {
    console.log('  skip purge-deletes-aged-rows (would delete rows in a shared database)');
  }

  // -------------------------------------------------------------------------
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
