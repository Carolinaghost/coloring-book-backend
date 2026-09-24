#!/usr/bin/env node
'use strict';

// Sends the "set up how you get paid" invite to every creator still owed one.
//
//   node scripts/send-payout-setup.js              look, change nothing
//   node scripts/send-payout-setup.js --dry-run    the same, said out loud
//   node scripts/send-payout-setup.js --send       do it, for real
//
// NOTHING HAPPENS WITHOUT --send. That is the opposite of the affiliate
// report, on purpose: the report only reads, and this one creates Stripe
// Connect accounts and emails real people. A dry run is free; an email that
// went to forty creators by mistake cannot be called back.
//
// The welcome email has promised "a separate invite to set up how you get
// paid" since the first creator signed up, and until sign-up started sending
// it, nothing did. This is for everybody who signed up before that, and for
// anybody whose invite failed at sign-up - Stripe was down, the mail server
// said no - which the server logs and then leaves for this to pick up.
//
// For each creator, one of three things:
//
//   no Connect account   make one, then send the invite
//   account, no invite   send the invite
//   invite already sent  leave them alone
//
// It is safe to run twice. Anyone whose invite went out is skipped, and the
// invite is only recorded as sent once the mail server has taken it, so a
// run that dies halfway is finished by the next one rather than repeated.
//
// It uses the same setUpCreatorPayouts the sign-up form does, so a creator
// set up from here is set up exactly the way a new one is.

const db = require('../db');
const mailer = require('../mailer');
const { payoutPlan, setUpCreatorPayouts } = require('../creator-payouts');

const WHAT = {
  account: 'create Connect account + send setup email',
  email: 'send setup email',
  skip: 'skip - setup email already sent'
};

function parseArgs(argv) {
  return { send: argv.includes('--send'), dryRun: argv.includes('--dry-run') };
}

// `print`, `db`, `mailer` and `fetch` come in through deps so the test can run
// the whole thing against the in-memory store and a stubbed Stripe.
async function main(deps = {}) {
  const print = deps.print || console.log;
  const store = deps.db || db;
  const mail = deps.mailer || mailer;
  const args = parseArgs(deps.argv || process.argv.slice(2));
  if (args.send && args.dryRun) {
    throw new Error('--send and --dry-run say opposite things. Pick one.');
  }
  const live = args.send;
  const mode = live ? 'SEND' : 'DRY RUN';

  if (live) {
    if (!(deps.key || process.env.STRIPE_SECRET_KEY)) {
      throw new Error('STRIPE_SECRET_KEY is not set. Run this where the key lives.');
    }
    // An account made with no email behind it is a creator who still has no
    // way in, and a run that looks like it worked.
    if (!mail.configured) throw new Error('SMTP_USER / SMTP_PASS are not set, so nothing could be sent.');
  }

  if (!deps.db) await store.initDb();
  const creators = await store.listCreators();
  print(`\nPayout setup  (${mode}${live ? '' : ' - nothing is created or sent; add --send to do it'})\n`);

  const done = { account: 0, email: 0, skip: 0, failed: 0 };
  for (const c of creators) {
    const plan = payoutPlan(c);
    const who = `${c.code.padEnd(18)} ${c.email}`;
    if (plan === 'skip' || !live) {
      print(`  [${mode}] ${who}  ${plan === 'skip' ? WHAT.skip : 'would ' + WHAT[plan]}`);
      done[plan]++;
      continue;
    }
    try {
      const r = await setUpCreatorPayouts(c, { db: store, mailer: mail, fetch: deps.fetch, key: deps.key });
      print(`  [${mode}] ${who}  ${r.accountCreated ? 'created ' + r.accountId + ', ' : ''}setup email sent`);
      done[plan]++;
    } catch (err) {
      // One creator's refusal is not a reason to stop inviting the rest.
      print(`  [${mode}] ${who}  FAILED - ${err.message}`);
      done.failed++;
    }
  }

  const verb = live ? '' : 'would ';
  print(`\n${creators.length} creator(s): ${done.account} ${verb}get an account and an invite, `
    + `${done.email} ${verb}get an invite, ${done.skip} already invited`
    + (done.failed ? `, ${done.failed} FAILED - run again once the cause is fixed` : '') + '.\n');
  return done;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
}

module.exports = { parseArgs, main };
