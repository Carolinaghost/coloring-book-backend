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
delete process.env.DATABASE_URL;   // exercise the in-memory store

const db = require('../db.js');
const { previewDay } = require('../server.js');

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
