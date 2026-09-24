#!/usr/bin/env node
'use strict';

// The Saturday payout report, emailed by the backend.
//
//   npm test
//
// This replaced a scheduled task on Jonathan's own computer, which only ran if
// the laptop happened to be awake at 8am on a Saturday. He drives a truck. A
// payout report that quietly does not run on the morning people are owed money
// is worse than no report at all, because nothing tells you it did not run.
//
// So the two things that matter here are: it fires on the right morning in the
// creators' timezone, including through daylight saving; and it fires exactly
// once, however many times the hourly timer comes round or the service
// redeploys.

process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.ALERT_EMAIL = 'accounts@crayonauts.com';
delete process.env.DATABASE_URL;   // exercise the in-memory store

const db = require('../db.js');
const { localNow, maybeSendPayoutReport } = require('../server.js');
const mailer = require('../mailer.js');

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

const sent = [];
mailer.sendMail = async (m) => { sent.push(m); return true; };
Object.defineProperty(mailer, 'configured', { get: () => true });

// Stripe, as far as the report cares: one creator with one $15 sale.
const realFetch = global.fetch;
global.fetch = async (url) => {
  const at = new URL(typeof url === 'string' ? url : url.href);
  const data = at.pathname === '/v1/promotion_codes'
    ? (at.searchParams.get('coupon') ? [] : [{
      id: 'promo_x', code: 'SAMR', active: true,
      coupon: { id: 'creatortrack', name: 'Creator tracking' },
      metadata: { creator_name: 'Sam Rivers', creator_email: 'sam@example.com' }
    }])
    : at.pathname === '/v1/checkout/sessions'
      // The history sweep asks with created[lt] and no created[gte]; answer it
      // empty so this reads as Sam's first ever sale.
      ? (at.searchParams.has('created[gte]') ? [{
        payment_status: 'paid', amount_total: 1500, amount_subtotal: 1500,
        currency: 'usd', discounts: [{ promotion_code: 'promo_x' }]
      }] : [])
      : at.pathname === '/v1/coupons' ? [] : null;
  if (data === null) throw new Error('unexpected Stripe path ' + at.pathname);
  return { ok: true, json: async () => ({ data, has_more: false }) };
};

// Saturdays at 8am in New York, one inside daylight saving and one outside.
const SAT_AUG = new Date('2026-08-22T12:00:00Z');   // 08:00 EDT
const SAT_DEC = new Date('2026-12-19T13:00:00Z');   // 08:00 EST

async function main() {
  console.log('\nKnowing what day it is where the creators are');
  check('summer: noon UTC is 8am Saturday in New York',
    localNow(SAT_AUG, 'America/New_York'), { date: '2026-08-22', hour: 8, dow: 6 });
  // The whole reason this is not a fixed UTC hour. In December the same 12:00
  // UTC is 7am in New York, and the report would go out an hour early all
  // winter - or, worse, on a cron pinned to 13:00 UTC, an hour late all summer.
  check('winter: it takes 1pm UTC to be 8am Saturday',
    localNow(SAT_DEC, 'America/New_York'), { date: '2026-12-19', hour: 8, dow: 6 });
  check('and noon UTC in December is only 7am',
    localNow(new Date('2026-12-19T12:00:00Z'), 'America/New_York').hour, 7);

  console.log('\nWhen it fires');
  // Friday is payday, and the last day of the week being reported on. Firing
  // then would pay out on a week that has not closed yet.
  check('not on the Friday',
    await maybeSendPayoutReport(new Date('2026-08-21T12:00:00Z')), 'not now');
  // The old run-day. Nothing should still be listening for it.
  check('not on a Thursday either',
    await maybeSendPayoutReport(new Date('2026-08-20T12:00:00Z')), 'not now');
  check('not at 9am on the Saturday',
    await maybeSendPayoutReport(new Date('2026-08-22T13:00:00Z')), 'not now');
  check('nothing has been emailed yet', sent.length, 0);

  console.log('\nSaturday, 8am');
  check('it sends', await maybeSendPayoutReport(SAT_AUG), 'sent');
  check('one email', sent.length, 1);
  check('to the accounts mailbox', sent[0].to, 'accounts@crayonauts.com');
  check('and the subject says what to do with it',
    /pay these today/.test(sent[0].subject), true);
  check('the creator and their money are in it',
    /SAMR/.test(sent[0].text) && /\$3\.00/.test(sent[0].text), true);
  // The report is what decides what people are paid, so the email has to carry
  // the same warning the command line would have printed - not a summary of it.
  check('and so is the note that Sam needs setting up in QuickBooks',
    /FIRST time/.test(sent[0].text) && /sam@example\.com/.test(sent[0].text), true);

  console.log('\nRunning again the same morning');
  // The hourly timer comes round inside the same 8am hour, and Render
  // redeploys whenever main moves. Either one must not produce a second email
  // with a second total on it.
  check('the second run stands down', await maybeSendPayoutReport(SAT_AUG), 'already sent');
  check('still one email', sent.length, 1);
  const laterSameHour = new Date('2026-08-22T12:59:00Z');
  check('and so does one later in the same hour',
    await maybeSendPayoutReport(laterSameHour), 'already sent');
  check('still one email', sent.length, 1);

  console.log('\nNext week');
  check('a new Saturday sends again',
    await maybeSendPayoutReport(new Date('2026-08-29T12:00:00Z')), 'sent');
  check('two emails now', sent.length, 2);

  console.log('\nWhen Stripe will not answer');
  const failing = global.fetch;
  global.fetch = async () => { throw new Error('Stripe is down'); };
  const before = sent.length;
  check('the failure is reported, not swallowed',
    await maybeSendPayoutReport(SAT_DEC), 'failed');
  check('and it still emails - a report that did not run is the news',
    sent.length, before + 1);
  check('saying plainly that nobody has been paid off it',
    /Nobody has been paid off this/.test(sent[sent.length - 1].text), true);
  global.fetch = failing;

  console.log(`\n${pass} passed, ${failures.length} failed`);
  global.fetch = realFetch;
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); global.fetch = realFetch; process.exit(1); });
