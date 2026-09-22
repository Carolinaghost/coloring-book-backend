#!/usr/bin/env node
'use strict';

// Tests for which paid orders the resume sweep will pick up again
// (db.js: resumableOrders / bumpRenderAttempts).
//
//   npm test                                    the in-memory store
//   DATABASE_URL=... ALLOW_DB_TESTS=1 npm test  the real SQL as well
//
// This decides whether somebody who paid ever receives their book, and both
// failures it guards against were silent - the order sits there looking merely
// slow, forever.
//
// A family book stores nothing in the photo column: each person's image lives
// in people. The query used to require photo IS NOT NULL, so it could not see
// one at all. Family books were started once, by the Stripe webhook, and if
// that attempt failed nothing retried them. Not five attempts. One.
//
// And attempts used to be spent a minute apart, so five of them fitted inside
// five minutes. A fifteen-minute OpenAI outage burned through every attempt an
// order had, and the order stayed dead after the outage cleared. The same five
// attempts now span about half an hour.
//
// The same assertions run against whichever store is configured, because the
// in-memory filter and the SQL are two expressions of one rule and the way they
// go wrong is by disagreeing.

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

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.log('\nSKIPPED: DATABASE_URL is set, but this test writes orders.');
  console.log('Re-run with ALLOW_DB_TESTS=1 against a scratch database, or unset');
  console.log('DATABASE_URL to test the in-memory store.');
  process.exit(0);
}

const PHOTO = 'data:image/png;base64,iVBORw0KGgo=';

// Every order this file makes, so it can take them away again. They are paid
// and unrendered by design, which is exactly what the resume sweep goes looking
// for - leave them behind on a shared scratch database and the next test file's
// render slots are all full of them before it starts.
const made = [];

async function make({ family, attempts = 0, agoMinutes = null, status = 'idle', paid = true }) {
  const order = await db.saveOrder({
    childName: 'Ava', childCount: 1, email: 'a@b.com', theme: 'Portrait',
    notes: '', thumb: null, pageCount: 15, subjectType: 'kid',
    detailLevel: 'standard', visitor: '', source: '', campaign: '',
    photo: family ? null : PHOTO,
    people: family
      ? [{ name: 'Mum', subjectType: 'adult', star: true, photo: PHOTO },
         { name: 'Leo', subjectType: 'kid', star: false, photo: PHOTO }]
      : []
  });
  if (paid) {
    const session = `cs_test_${order.id}`;
    await db.attachCheckoutSession(order.id, session, 1900);
    await db.markPaid(session, 1900);
  }
  if (status !== 'idle') await db.setGenerationStatus(order.id, status);
  for (let i = 0; i < attempts; i++) await db.bumpRenderAttempts(order.id);
  if (attempts && agoMinutes !== null) await db.backdateLastAttempt(order.id, agoMinutes);
  made.push(order.id);
  return order.id;
}

async function main() {
  await db.initDb();
  console.log(`\nStore under test: ${db.usingPostgres ? 'postgres' : 'memory'}`);

  console.log('\nA family book is resumable at all');

  const fresh = await make({ family: false });
  const freshFamily = await make({ family: true });
  let ids = await db.resumableOrders(5, 2);
  check('a single-subject book waiting to start is picked up', ids.includes(fresh), true);
  // The bug. Before this, a family book was invisible here forever.
  check('and so is a family book, whose photos live in people', ids.includes(freshFamily), true);

  console.log('\nAn outage does not spend every attempt at once');

  const justTried = await make({ family: false, attempts: 1, agoMinutes: 0 });
  const triedAWhileAgo = await make({ family: false, attempts: 1, agoMinutes: 5 });
  ids = await db.resumableOrders(5, 2);
  check('an order tried a moment ago waits', ids.includes(justTried), false);
  check('the same order is tried again once the wait is up', ids.includes(triedAWhileAgo), true);

  // 2, 4, 8, 16, 32 minutes: the wait doubles, so five attempts cover about
  // half an hour rather than five minutes.
  const fourTries = await make({ family: false, attempts: 4, agoMinutes: 10 });
  check('after four attempts it waits longer than ten minutes',
    (await db.resumableOrders(5, 2)).includes(fourTries), false);
  const fourTriesOlder = await make({ family: false, attempts: 4, agoMinutes: 40 });
  check('and comes back after about half an hour',
    (await db.resumableOrders(5, 2)).includes(fourTriesOlder), true);

  console.log('\nWhat it still refuses to pick up');

  const spent = await make({ family: false, attempts: 5, agoMinutes: 600 });
  check('an order past the attempt cap is left alone however long it waits',
    (await db.resumableOrders(5, 2)).includes(spent), false);

  const done = await make({ family: false, status: 'done' });
  check('a finished book is not redrawn', (await db.resumableOrders(5, 2)).includes(done), false);

  const unpaid = await make({ family: false, paid: false });
  check('an unpaid order is not drawn', (await db.resumableOrders(5, 2)).includes(unpaid), false);

  console.log('\nAn attempt records when it happened');

  const stamped = await make({ family: false });
  const before = await db.getOrder(stamped);
  check('an order that has never run has no attempt time', before.lastAttemptAt, null);
  await db.bumpRenderAttempts(stamped);
  const after = await db.getOrder(stamped);
  check('counting an attempt stamps the time in the same write',
    Boolean(after.lastAttemptAt) && after.renderAttempts === 1, true);

  for (const id of made) await db.deleteOrder(id).catch(() => {});

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
