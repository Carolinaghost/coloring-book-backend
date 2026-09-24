#!/usr/bin/env node
'use strict';

// Sends each creator what the Saturday report says they are owed.
//
//   node scripts/pay-creators.js              look, send nothing
//   node scripts/pay-creators.js --dry-run    the same, said out loud
//   node scripts/pay-creators.js --send       pay them, for real
//   node scripts/pay-creators.js --send --force
//                                             pay them even though the week's
//                                             total is over PAYOUT_MAX_TOTAL_CENTS
//
// NOTHING IS SENT WITHOUT --send, and nothing runs this on a schedule. The
// Saturday email says who is owed; Jonathan reads it, and then this is the
// one command that moves the money. Review, then approve.
//
// It pays the pay week that most recently closed - the same week, at the same
// rates, that the Saturday report showed. Not by running the report and
// reading its numbers back, and not by working them out a second way: it
// calls the report's own computeOwed with the report's own saturdayArgs, so
// the two cannot disagree about a cent.
//
// Who gets paid:
//
//   owed more than $0, with a creator record, whose Stripe account says
//   payouts are enabled, and who has not already been paid for this week.
//
// Everybody else owed money is listed and says why they were skipped. Nobody
// owed money is ever left off the output.
//
// Two ceilings, because a bug in the numbers would otherwise be paid out
// before anyone noticed it:
//
//   PAYOUT_MAX_PER_CREATOR_CENTS  one creator over this is skipped and
//                                 flagged; everybody else is still paid.
//                                 To pay them after checking, run again with
//                                 it raised for that one run.
//   PAYOUT_MAX_TOTAL_CENTS        the week over this and nothing is paid at
//                                 all - the dry run says so too - unless
//                                 --force is given.
//
// Paying twice cannot happen, in two layers:
//
//   1. Before any money moves, the creator's week is claimed in
//      creator_payouts, which is unique on creator and week. Once the
//      transfer id is recorded there, the week is paid and every later run
//      says "already paid".
//   2. Every transfer carries a transfer_group named for the creator and week,
//      and an idempotency key built from the same thing. If a run dies after
//      Stripe took the transfer but before it was recorded, the next run finds
//      it in Stripe by that group and records it instead of sending another.
//
// One creator's transfer failing - an empty balance, a closed account - is
// reported and the rest are still paid. Run it again once the cause is fixed;
// everyone already paid is skipped.
//
// Transfers move money from the Crayonauts balance into the creator's Stripe
// account. Stripe pays it on to their bank on its own schedule.
//
// SEND BY WEDNESDAY. Creators are told they are paid on Friday, and that
// means the money is in their bank on Friday - not that it left here on
// Friday. A transfer lands in their Stripe balance at once, but Stripe's
// payout from there to their bank is a direct deposit, and a direct deposit
// takes about two business days to arrive. So the transfer has to go out by
// Wednesday for Friday to be true. Run it on Thursday or Friday and it still
// works - it only warns, because there can be a good reason to send late -
// but the creator will most likely see the money on Monday or Tuesday, and
// will reasonably think they were paid late, because they were.

const db = require('../db');
const {
  computeOwed, saturdayArgs, listAll, windowLabel, money
} = require('./affiliate-report');

const API = 'https://api.stripe.com/v1';

// Conservative on purpose: a book is $15-$25 and a creator earns a fifth of
// it, so $250 is a creator selling fifty-odd books in one week, and $1,000 is
// every creator together selling around two hundred. Raise them once real
// weeks show what normal looks like.
const DEFAULT_MAX_PER_CREATOR_CENTS = 25000;
const DEFAULT_MAX_TOTAL_CENTS = 100000;

function parseArgs(argv) {
  return {
    send: argv.includes('--send'),
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force')
  };
}

// Thursday and Friday, in the pay week's own time zone. Saturday through
// Wednesday leaves the two business days a direct deposit needs to reach a
// creator's bank by the Friday they were promised.
const LATE_DAYS = new Set(['Thu', 'Fri']);
const LATE_WARNING = "Warning: transfers sent today likely won't reach creators' banks by Friday - "
  + "Stripe's payout typically takes about 2 business days. Send by Wednesday for an on-time Friday payday.";
function tooLateForFriday(now, tz) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  return LATE_DAYS.has(day);
}

// A limit that does not parse must not quietly become no limit.
function centsSetting(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new Error(`${name} must be a whole number of cents; "${raw}" is not.`);
  }
  return Number(raw);
}

function limits(env = process.env) {
  return {
    perCreator: centsSetting(env, 'PAYOUT_MAX_PER_CREATOR_CENTS', DEFAULT_MAX_PER_CREATOR_CENTS),
    total: centsSetting(env, 'PAYOUT_MAX_TOTAL_CENTS', DEFAULT_MAX_TOTAL_CENTS)
  };
}

// The same name for the same creator and week, every time. It is both the
// Stripe transfer_group this is looked up by and the stem of the idempotency
// key, which is what makes a rerun find the earlier transfer.
function transferGroup(creatorId, period) {
  return `creator-payout-${creatorId}-${period.start}-${period.end}`;
}

// Who is owed, and what happens to each of them. Decides; does nothing.
//
//   pay         will be paid (or would be, on a dry run)
//   paid        already paid for this week
//   no-creator  a code with no sign-up behind it - made by hand in the dashboard
//   not-ready   has not finished Stripe's payout setup
//   over-cap    more than PAYOUT_MAX_PER_CREATOR_CENTS; somebody should look
function planPayouts({ rows, creators, payouts, limits: cap }) {
  const byPromo = new Map(creators.filter((c) => c.promoId).map((c) => [c.promoId, c]));
  const paidFor = new Map(payouts.filter((p) => p.stripeTransferId).map((p) => [p.creatorId, p]));
  const lines = rows.filter((r) => r.owed > 0).map((r) => {
    const creator = byPromo.get(r.id) || null;
    const line = { code: r.code, owed: r.owed, creator, status: 'pay' };
    if (!creator) line.status = 'no-creator';
    else if (paidFor.has(creator.id)) { line.status = 'paid'; line.earlier = paidFor.get(creator.id); }
    else if (!creator.stripeAccountId || !creator.payoutReadyAt) line.status = 'not-ready';
    else if (r.owed > cap.perCreator) line.status = 'over-cap';
    return line;
  });
  const total = lines.filter((l) => l.status === 'pay').reduce((sum, l) => sum + l.owed, 0);
  return { lines, total, overTotal: total > cap.total };
}

async function postTransfer(form, idempotencyKey, io) {
  const resp = await (io.fetch || fetch)(API + '/transfers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${io.key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey
    },
    body: form
  });
  let body = null;
  try { body = await resp.json(); } catch (err) { body = null; }
  return { ok: resp.ok, body };
}

// Pays one creator for one week, or finds that it already has been. Never
// throws: whatever happens comes back as the line's outcome, so the loop that
// calls this carries on to the next creator.
async function payOne(line, period, ctx) {
  const { store, io, currency, label } = ctx;
  const c = line.creator;
  let claim;
  try {
    claim = await store.claimCreatorPayout({
      creatorId: c.id, periodStart: period.start, periodEnd: period.end, amountCents: line.owed
    });
  } catch (err) {
    return { status: 'failed', note: 'could not record the payment before sending, so nothing was sent - ' + err.message };
  }
  // Another run got there first, between planning and now.
  if (!claim) return { status: 'paid', note: 'already paid' };

  const group = transferGroup(c.id, period);
  try {
    // Layer two. An earlier run may have reached Stripe and died before it
    // could write the transfer id down; if so, this is where it is found.
    const earlier = (await listAll('/transfers',
      { transfer_group: group, destination: c.stripeAccountId }, io)).find((t) => !t.reversed);
    if (earlier) {
      await store.recordCreatorTransfer(claim.id, earlier.id);
      return { status: 'paid', transferId: earlier.id, amount: earlier.amount,
        note: 'already paid - found in Stripe from an earlier run, now recorded' };
    }

    const form = new URLSearchParams();
    form.append('amount', String(line.owed));
    form.append('currency', currency);
    form.append('destination', c.stripeAccountId);
    form.append('transfer_group', group);
    form.append('description', `Crayonauts creator earnings, ${label}`);
    form.append('metadata[creator_id]', String(c.id));
    form.append('metadata[creator_code]', c.code);
    form.append('metadata[period_start]', String(period.start));
    form.append('metadata[period_end]', String(period.end));
    const { ok, body } = await postTransfer(form, `${group}-a${claim.attempts}`, io);
    if (ok && body && body.id) {
      await store.recordCreatorTransfer(claim.id, body.id);
      return { status: 'sent', transferId: body.id };
    }
    const why = (body && body.error && body.error.message) || 'Stripe refused it with no reason given';
    await store.failCreatorPayout(claim.id, why);
    return { status: 'failed', note: why };
  } catch (err) {
    // No answer at all. The transfer may or may not exist; the claim stays,
    // and the next run asks Stripe before it sends anything.
    return { status: 'failed',
      note: `no clear answer from Stripe (${err.message}). Run again - it checks Stripe before sending.` };
  }
}

function describe(line, live) {
  const c = line.creator;
  switch (line.status) {
    case 'pay': return live ? 'paying' : 'would pay';
    case 'sent': return `PAID  ${line.transferId}`;
    case 'paid': {
      const id = line.transferId || (line.earlier && line.earlier.stripeTransferId) || '';
      const was = line.earlier && line.earlier.amountCents !== line.owed
        ? ` - ${money(line.earlier.amountCents)} was sent; the report now says ${money(line.owed)}, check why` : '';
      return `already paid ${id}${line.note && line.note !== 'already paid' ? ' (' + line.note + ')' : ''}${was}`;
    }
    case 'no-creator':
      return 'SKIPPED - no creator sign-up for this code (made by hand?). Pay them yourself.';
    case 'not-ready':
      return 'SKIPPED - not set up to be paid yet: '
        + (!c.stripeAccountId ? 'no Stripe account (run scripts/send-payout-setup.js)'
          : c.payoutLinkSentAt ? 'invite sent, setup not finished' : 'invite never sent (run scripts/send-payout-setup.js)');
    case 'over-cap':
      return `SKIPPED - over the per-creator cap of ${money(line.cap)}. Check it, then run again with `
        + 'PAYOUT_MAX_PER_CREATOR_CENTS raised.';
    case 'failed': return 'FAILED - ' + line.note;
    default: return line.status;
  }
}

// `print`, `db`, `fetch`, `key`, `env` and `now` come in through deps so the
// test can run all of this against the in-memory store and a stubbed Stripe.
async function main(deps = {}) {
  const print = deps.print || console.log;
  const store = deps.db || db;
  const env = deps.env || process.env;
  const args = parseArgs(deps.argv || process.argv.slice(2));
  if (args.send && args.dryRun) throw new Error('--send and --dry-run say opposite things. Pick one.');
  const live = args.send;
  const mode = live ? 'SEND' : 'DRY RUN';
  const cap = limits(env);
  const key = deps.key || env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set. Run this where the key lives.');
  const io = { fetch: deps.fetch, key };

  // The report's own calculation, with the report's own settings.
  const owed = await computeOwed({
    argv: saturdayArgs(env), key, fetch: deps.fetch, now: deps.now, warn: (...a) => print(a.join(' '))
  });
  const period = { start: owed.since, end: owed.until };
  const label = windowLabel(period.start, period.end, owed.tz);

  if (!deps.db) await store.initDb();
  const creators = await store.listCreators();
  const payouts = await store.listCreatorPayouts(period.start, period.end);
  const plan = planPayouts({ rows: owed.rows, creators, payouts, limits: cap });
  plan.lines.forEach((l) => { if (l.status === 'over-cap') l.cap = cap.perCreator; });

  print(`\nCreator payouts  (${mode}${live ? '' : ' - nothing is sent; add --send to pay'})`);
  print(`Pay week  ${label}  ${owed.tz}\n`);
  // A warning, never a stop: late is sometimes the right call, and he decides.
  if (tooLateForFriday(deps.now ? new Date(deps.now) : new Date(), owed.tz)) print(LATE_WARNING + '\n');

  const show = (l) => {
    const who = l.creator ? `${l.creator.name} <${l.creator.email}>` : '';
    print(`  ${l.code.padEnd(18)} ${money(l.owed).padStart(9)}   ${describe(l, live)}${who ? '   ' + who : ''}`);
  };

  if (!plan.lines.length) {
    print('  Nobody is owed anything for this week.\n');
    return { refused: false, sent: 0, sentCents: 0, lines: plan.lines };
  }

  if (plan.overTotal && !args.force) {
    plan.lines.forEach(show);
    print(`\nREFUSED: this would pay ${money(plan.total)} in total, over the ${money(cap.total)} limit`
      + ' (PAYOUT_MAX_TOTAL_CENTS). Nothing has been sent.');
    print('Check the report. If the numbers are right, run again with --force.\n');
    return { refused: true, sent: 0, sentCents: 0, lines: plan.lines };
  }
  if (plan.overTotal) {
    print(`--force: paying ${money(plan.total)}, over the ${money(cap.total)} limit.\n`);
  }

  if (live) {
    const ctx = { store, io, currency: owed.currency, label };
    for (const l of plan.lines) {
      if (l.status !== 'pay') continue;
      Object.assign(l, await payOne(l, period, ctx));
    }
  }
  plan.lines.forEach(show);

  // The summary counts what happened, not what was planned.
  const count = (s) => plan.lines.filter((l) => l.status === s);
  const sent = live ? count('sent') : count('pay');
  const sentCents = sent.reduce((sum, l) => sum + l.owed, 0);
  print('');
  print(`${live ? 'Sent' : 'Would send'}: ${money(sentCents)} to ${sent.length} creator(s).`);
  const skipped = [
    ['already paid', count('paid').length],
    ['not set up yet', count('not-ready').length],
    ['over the per-creator cap', count('over-cap').length],
    ['no creator sign-up', count('no-creator').length],
    ['FAILED', count('failed').length]
  ].filter(([, n]) => n);
  if (skipped.length) print('Not paid: ' + skipped.map(([why, n]) => `${n} ${why}`).join(', ') + '.');
  if (owed.unknown.size) {
    print(`WARNING: ${owed.unknown.size} code(s) were used that are not in the promotion code list. `
      + 'Whoever earned those is not in this run - see the report.');
  }
  if (count('failed').length) print('Run it again once the cause is fixed. Anyone already paid is skipped.');
  print('');
  return { refused: false, sent: sent.length, sentCents, lines: plan.lines };
}

if (require.main === module) {
  main()
    .then((r) => process.exit(r.refused ? 2 : r.lines.some((l) => l.status === 'failed') ? 1 : 0))
    .catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
}

module.exports = {
  parseArgs, limits, planPayouts, transferGroup, tooLateForFriday, main,
  DEFAULT_MAX_PER_CREATOR_CENTS, DEFAULT_MAX_TOTAL_CENTS
};
