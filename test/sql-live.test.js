#!/usr/bin/env node
'use strict';

// The queries, run against a real Postgres.
//
//   DATABASE_URL=... node test/sql-live.test.js
//
// Skipped without DATABASE_URL, which is how the rest of the suite runs: every
// other test uses the in-memory store, and the in-memory store has no opinion
// about types.
//
// That gap has bitten once already. rescuablePreviews passed eighteen checks
// in memory and failed on its first sweep in production with "operator does
// not exist: text * interval" - the driver sends numbers as text, nothing in
// the CASE said otherwise, and Postgres would not multiply text by an
// interval. No amount of in-memory testing could have found it.
//
// So this file exists to send each query at a real database once and see it
// come back. It asserts nothing about the rows - what they contain depends on
// whichever database it is pointed at - only that the statement is one
// Postgres will accept. Every query here is a SELECT; nothing is written.

// Checked before the require, not after: db.js pulls in the Postgres driver,
// and a machine with no database configured may not have it installed either.
if (!process.env.DATABASE_URL) {
  console.log('SQL shapes: skipped (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../db.js');

let pass = 0;
const failures = [];

async function accepts(label, run) {
  try {
    await run();
    pass++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err.message}`);
    console.log(`  FAIL ${label}`);
    console.log(`         ${err.message}`);
  }
}

(async () => {
  console.log('SQL shapes, against the real database');

  await accepts('failed previews due another go',
    () => db.rescuablePreviews(3, [1, 4, 10]));
  await accepts('the same query with the delays as strings, which is how env vars arrive',
    () => db.rescuablePreviews('3', ['1', '4', '10']));
  await accepts('unfinished paid orders',
    () => db.resumableOrders(5, 2));
  await accepts('the creator list',
    () => db.listCreators());
  await accepts('a creator looked up by payout setup link',
    () => db.getCreatorByPayoutToken(require('crypto').randomBytes(24).toString('hex')));
  await accepts('the order list',
    () => db.listOrders({ limit: 1 }));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})();
