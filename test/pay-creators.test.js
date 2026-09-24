#!/usr/bin/env node
'use strict';

// scripts/pay-creators.js - the command that actually sends creators money.
//
//   npm test
//
// Everything this guards fails in one of two directions, and both are money:
// somebody is paid twice, or somebody owed money is quietly left out. So:
//
//   - running it twice for the same week pays nobody twice, including when
//     the first run died between Stripe taking the transfer and us writing
//     it down
//   - it pays exactly what the Saturday report says, at the report's rates,
//     because it IS the report's calculation
//   - the total cap stops the whole run, dry run included, unless --force
//   - the per-creator cap skips that one creator and pays everyone else
//   - anybody owed and not set up is listed as skipped, not dropped
//   - nothing is sent without --send
//
// Stripe is a stub. Nothing here moves money.

delete process.env.DATABASE_URL;   // exercise the in-memory store

const db = require('../db.js');
const pay = require('../scripts/pay-creators.js');
const { computeOwed, saturdayArgs } = require('../scripts/affiliate-report.js');

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

// Saturday 22 Aug 2026, 9am in New York: the week just closed is
// Sat 15 Aug 00:00 to Fri 21 Aug 23:59 Eastern.
const NOW = new Date('2026-08-22T13:00:00Z');

// The promotion codes and the week's sales. Every sale is $15 paid.
const CODES = [
  { id: 'promo_ready', code: 'READY', active: true, coupon: { id: 'creatortrack' } },
  { id: 'promo_jerrell', code: 'JERRELL', active: true, coupon: { id: 'creatortrack' } },
  { id: 'promo_new', code: 'NEWBIE', active: true, coupon: { id: 'creatortrack' } },
  { id: 'promo_big', code: 'BIGWEEK', active: true, coupon: { id: 'creatortrack' } },
  { id: 'promo_hand', code: 'HANDMADE', active: true, coupon: { id: 'creatortrack' } },
  { id: 'promo_broke', code: 'BROKE', active: true, coupon: { id: 'creatortrack' } },
  { id: 'promo_quiet', code: 'QUIET', active: true, coupon: { id: 'creatortrack' } }
];
const SALES = { promo_ready: 2, promo_jerrell: 4, promo_new: 1, promo_big: 20, promo_hand: 1, promo_broke: 1 };
const SESSIONS = [];
for (const [promo, n] of Object.entries(SALES)) {
  for (let i = 0; i < n; i++) {
    SESSIONS.push({ id: `cs_${promo}_${i}`, payment_status: 'paid', currency: 'usd',
      amount_total: 1500, amount_subtotal: 1500, discounts: [{ promotion_code: promo }] });
  }
}

// Stripe's transfers, as far as this script can see them.
const transfers = [];          // what Stripe holds
const posts = [];             // every POST /v1/transfers, with its idempotency key
let refuse = new Set();       // destinations Stripe says no to
let dropAnswer = new Set();   // destinations where Stripe takes it and the reply is lost

async function stripe(url, opts = {}) {
  const at = new URL(url);
  const path = at.pathname;
  const list = (data) => ({ ok: true, json: async () => ({ data, has_more: false }) });
  if (path === '/v1/promotion_codes') return list(CODES);
  if (path === '/v1/checkout/sessions') {
    // The report's "earned before this week" sweep has only created[lt].
    const history = at.searchParams.has('created[lt]') && !at.searchParams.has('created[gte]');
    return list(history ? [] : SESSIONS);
  }
  if (path === '/v1/transfers' && (opts.method || 'GET') === 'GET') {
    const group = at.searchParams.get('transfer_group');
    const dest = at.searchParams.get('destination');
    return list(transfers.filter((t) => t.transfer_group === group && t.destination === dest));
  }
  if (path === '/v1/transfers' && opts.method === 'POST') {
    const form = new URLSearchParams(opts.body.toString());
    const key = opts.headers['Idempotency-Key'];
    posts.push({ key, dest: form.get('destination'), amount: Number(form.get('amount')) });
    const dest = form.get('destination');
    if (refuse.has(dest)) {
      return { ok: false, json: async () => ({ error: { message: 'Insufficient funds in Stripe balance.' } }) };
    }
    // Stripe's idempotency: the same key hands back the same transfer.
    let t = transfers.find((x) => x.key === key);
    if (!t) {
      t = { id: 'tr_' + (transfers.length + 1), key, amount: Number(form.get('amount')),
        currency: form.get('currency'), destination: dest,
        transfer_group: form.get('transfer_group'), reversed: false };
      transfers.push(t);
    }
    if (dropAnswer.has(dest)) throw new Error('socket hang up');
    return { ok: true, json: async () => ({ id: t.id }) };
  }
  throw new Error('test stub asked for an unexpected path: ' + path);
}

const ENV = { STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
  PAYOUT_MAX_PER_CREATOR_CENTS: '2000', PAYOUT_MAX_TOTAL_CENTS: '10000' };

async function run(argv, env = ENV, now = NOW) {
  const out = [];
  const result = await pay.main({ argv, db, fetch: stripe, env, now, print: (l) => out.push(String(l)) });
  return { ...result, out, text: out.join('\n') };
}
const lineFor = (r, code) => r.out.find((l) => l.trim().startsWith(code + ' ')) || '';

async function creator(code, promoId, { account, ready, invited } = {}) {
  const c = await db.saveCreator({ code, name: code + ' Person', email: code.toLowerCase() + '@example.com',
    handle: '@' + code, ratePercent: 20, promoId });
  if (account) await db.setCreatorStripeAccount(c.id, account, 'f'.repeat(48));
  if (invited || ready) await db.markPayoutLinkSent(c.id);
  if (ready) await db.markPayoutReady(account);
  return c;
}

async function main() {
  const ready = await creator('READY', 'promo_ready', { account: 'acct_ready', ready: true });
  const jerrell = await creator('JERRELL', 'promo_jerrell', { account: 'acct_jerrell', ready: true });
  await creator('NEWBIE', 'promo_new', { account: 'acct_new', invited: true });   // invited, not finished
  await creator('BIGWEEK', 'promo_big', { account: 'acct_big', ready: true });
  const broke = await creator('BROKE', 'promo_broke', { account: 'acct_broke', ready: true });
  await creator('QUIET', 'promo_quiet', { account: 'acct_quiet', ready: true });
  // HANDMADE has sales and no sign-up at all.

  console.log('\nThe limits');
  check('conservative defaults with nothing set',
    [pay.limits({}).perCreator, pay.limits({}).total], [25000, 100000]);
  let bad = null;
  try { pay.limits({ PAYOUT_MAX_TOTAL_CENTS: '$500' }); } catch (err) { bad = err.message; }
  check('a limit that does not parse is an error, never "no limit"', /whole number of cents/.test(bad || ''), true);

  console.log('\nOne calculation, not two');
  const owed = await computeOwed({ argv: saturdayArgs({}), key: 'sk_test', fetch: stripe, now: NOW, warn: () => {} });
  const owedBy = Object.fromEntries(owed.rows.map((r) => [r.code, r.owed]));
  check('the report pays JERRELL his negotiated 25%', owedBy.JERRELL, 1500);
  check('and everybody else the standard 20%', owedBy.READY, 600);

  console.log('\nA dry run, which is what happens with no flags');
  const dry = await run([]);
  check('sends nothing', posts.length, 0);
  check('records nothing', (await db.listCreatorPayouts(owed.since, owed.until)).length, 0);
  check('says it is a dry run', /DRY RUN/.test(dry.text), true);
  check('names the week it is paying', /Pay week  Sat, Aug 15 00:00 to Fri, Aug 21 23:59/.test(dry.text), true);
  check('would pay the creator who is set up', /would pay/.test(lineFor(dry, 'READY')), true);
  check('at the report\'s amount', lineFor(dry, 'READY').includes('$6.00'), true);
  check('and Jerrell at his rate', lineFor(dry, 'JERRELL').includes('$15.00'), true);
  check('flags the one who has not finished setup',
    /SKIPPED - not set up to be paid yet: invite sent, setup not finished/.test(lineFor(dry, 'NEWBIE')), true);
  check('flags the code nobody signed up for, rather than dropping it',
    /SKIPPED - no creator sign-up/.test(lineFor(dry, 'HANDMADE')), true);
  check('skips just the creator over the per-creator cap',
    /SKIPPED - over the per-creator cap of \$20\.00/.test(lineFor(dry, 'BIGWEEK')), true);
  check('leaves off anybody owed nothing', lineFor(dry, 'QUIET'), '');
  check('and totals what it would send', /Would send: \$24\.00 to 3 creator\(s\)\./.test(dry.text), true);

  console.log('\nSending in time for Friday');
  // Payday is Friday in the creator's bank, and a direct deposit takes about
  // two business days, so the transfer has to leave by Wednesday.
  check('no warning on the Saturday the week closes', /won't reach creators' banks/.test(dry.text), false);
  const wed = await run([], ENV, new Date('2026-08-26T20:00:00Z'));   // Wed 4pm New York
  check('none on the Wednesday, the last on-time day', /won't reach creators' banks/.test(wed.text), false);
  const thu = await run([], ENV, new Date('2026-08-27T13:00:00Z'));   // Thu 9am New York
  check('a plain warning from Thursday', /Warning: transfers sent today likely won't reach creators' banks by Friday/
    .test(thu.text), true);
  check('that says when to send instead', /Send by Wednesday for an on-time Friday payday/.test(thu.text), true);
  check('and it is still the same week, not a later one', /Pay week  Sat, Aug 15/.test(thu.text), true);
  check('Friday warns too', /won't reach creators' banks/.test(
    (await run([], ENV, new Date('2026-08-28T13:00:00Z'))).text), true);
  // The warning is in New York's day, not the server's: 1am UTC on Thursday
  // is still Wednesday evening there.
  check('counted in the pay week\'s time zone, not UTC',
    pay.tooLateForFriday(new Date('2026-08-27T01:00:00Z'), 'America/New_York'), false);
  check('a warning, not a stop - it still plans the payments', /Would send: \$24\.00/.test(thu.text), true);
  check('and none of that sent anything', posts.length, 0);

  let conflicted = null;
  try { await run(['--send', '--dry-run']); } catch (err) { conflicted = err.message; }
  check('--send with --dry-run is refused', /Pick one/.test(conflicted || ''), true);
  check('and sent nothing', posts.length, 0);

  console.log('\nThe total cap');
  const tight = { ...ENV, PAYOUT_MAX_TOTAL_CENTS: '2000' };
  const refusedDry = await run([], tight);
  check('the dry run shows the refusal', [refusedDry.refused, /REFUSED/.test(refusedDry.text)], [true, true]);
  const refusedLive = await run(['--send'], tight);
  check('and --send refuses the whole run', refusedLive.refused, true);
  check('sending nothing to anybody', posts.length, 0);
  check('and says --force is the way past it', /run again with --force/.test(refusedLive.text), true);

  console.log('\nPaying past the total cap with --force, with one transfer that fails');
  refuse = new Set(['acct_broke']);
  const first = await run(['--send', '--force'], tight);
  check('--force says it is going past the limit', /--force: paying \$24\.00, over the \$20\.00 limit/.test(first.text), true);
  check('pays the creator who is set up', /PAID  tr_/.test(lineFor(first, 'READY')), true);
  const readyPost = posts.find((p) => p.dest === 'acct_ready');
  check('the amount the report showed', readyPost.amount, owedBy.READY);
  check('with an idempotency key named for the creator and week',
    readyPost.key, `creator-payout-${ready.id}-${owed.since}-${owed.until}-a0`);
  check('pays Jerrell too', posts.find((p) => p.dest === 'acct_jerrell').amount, 1500);
  check('reports the one Stripe refused', /FAILED - Insufficient funds/.test(lineFor(first, 'BROKE')), true);
  check('without stopping anybody else', first.sent, 2);
  check('never sends to the not-ready, the over-cap or the hand-made code',
    posts.some((p) => ['acct_new', 'acct_big'].includes(p.dest)), false);
  check('and totals what was actually sent', /Sent: \$21\.00 to 2 creator\(s\)\./.test(first.text), true);
  check('and counts the rest', /Not paid: 1 not set up yet, 1 over the per-creator cap, 1 no creator sign-up, 1 FAILED\./
    .test(first.text), true);
  const recorded = await db.listCreatorPayouts(owed.since, owed.until);
  check('writes each payment down with its transfer',
    recorded.filter((p) => p.stripeTransferId).map((p) => p.creatorId).sort(), [ready.id, jerrell.id].sort());

  console.log('\nRunning it again for the same week');
  const postsBefore = posts.length;
  refuse = new Set();
  const second = await run(['--send']);
  check('pays nobody twice', posts.filter((p) => p.dest === 'acct_ready').length, 1);
  check('says they were already paid', /already paid tr_/.test(lineFor(second, 'READY')), true);
  check('retries the one that failed, under a fresh idempotency key',
    posts.slice(postsBefore).map((p) => [p.dest, p.key.endsWith('-a1')]), [['acct_broke', true]]);
  check('and pays them this time', /PAID  tr_/.test(lineFor(second, 'BROKE')), true);
  const third = await run(['--send']);
  check('a third run sends nothing at all', [third.sent, posts.length], [0, postsBefore + 1]);

  console.log('\nA run that died after Stripe took the transfer');
  // A creator who finishes setup mid-week-of-paying, and whose transfer goes
  // through at Stripe while the reply is lost on the way back.
  await db.markPayoutReady('acct_new');
  dropAnswer = new Set(['acct_new']);
  const lost = await run(['--send']);
  check('the lost reply is reported, not taken as success or as a refusal',
    /FAILED - no clear answer from Stripe/.test(lineFor(lost, 'NEWBIE')), true);
  dropAnswer = new Set();
  const newbiePosts = posts.filter((p) => p.dest === 'acct_new').length;
  const recover = await run(['--send']);
  check('the next run finds it in Stripe', /found in Stripe from an earlier run/.test(lineFor(recover, 'NEWBIE')), true);
  check('and does not send it again', posts.filter((p) => p.dest === 'acct_new').length, newbiePosts);
  check('Stripe holds exactly one transfer to them', transfers.filter((t) => t.destination === 'acct_new').length, 1);

  console.log('\nThe per-creator cap, raised for one run');
  const raised = await run(['--send'], { ...ENV, PAYOUT_MAX_PER_CREATOR_CENTS: '10000' });
  check('pays the big week once somebody has checked it', posts.filter((p) => p.dest === 'acct_big').length, 1);
  check('at the full amount', posts.find((p) => p.dest === 'acct_big').amount, 6000);
  check('and still nobody else twice', [raised.sent, posts.filter((p) => p.dest === 'acct_ready').length], [1, 1]);
  void broke;

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
