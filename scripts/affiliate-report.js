#!/usr/bin/env node
'use strict';

// Who sold what, and what you owe them.
//
// Reads Stripe directly - no new dependency, same fetch-and-bearer-token
// approach server.js already uses for checkout.
//
//   node scripts/affiliate-report.js                  last 7 days, 20% rate
//   node scripts/affiliate-report.js --days 30
//   node scripts/affiliate-report.js --rate 25
//   node scripts/affiliate-report.js --rates JERRELL=25,OWEN10=15
//   node scripts/affiliate-report.js --csv
//
// Options:
//   --days <n>    how far back to look                   (default 7)
//   --rate <n>    commission, percent of what was PAID   (default 20)
//   --rates <s>   per-code overrides, CODE=percent,...   (default none)
//   --csv         machine-readable instead of a table
//
// Not everybody is on the same deal. Jerrell negotiated 25%, the influencers
// are on 20%, and a single --rate has to be wrong for one of them: too low and
// somebody is shortchanged, too high and it comes out of the margin. Either way
// the report prints a confident total and nothing looks wrong. --rates names
// the exceptions; anyone it does not name keeps --rate.
//
// Commission is calculated on what the customer actually paid, after their
// discount - not on the list price. If you would rather pay on list price,
// change PAY_ON below and say so to the influencers, because the two give
// noticeably different numbers on a 20%-off code.
//
// These are sales at checkout. A refund or a dispute happens afterwards and is
// invisible here, so a refunded order still shows as owed. Check before paying
// on anything large.

const PAY_ON = 'paid';   // 'paid' or 'list'

const KEY = process.env.STRIPE_SECRET_KEY;
const API = 'https://api.stripe.com/v1';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    a[k] = n && !n.startsWith('--') ? (i++, n) : 'true';
  }
  return a;
}

// "JERRELL=25,OWEN10=15" -> Map { JERRELL => 25, OWEN10 => 15 }.
//
// Keys are upper-cased because that is the only way a case-insensitive match
// against the Stripe code can be a lookup rather than a scan, and because
// "jerrell=25" typed in a hurry has to mean the same thing as "JERRELL=25".
//
// Everything questionable throws. A --rates flag exists precisely because
// paying the wrong percentage is invisible in the output, so quietly skipping
// a pair this cannot read would reintroduce the bug it is here to fix: the
// report would run, look fine, and pay the default.
function parseRates(spec) {
  const rates = new Map();
  if (spec === undefined || spec === null) return rates;
  const text = String(spec).trim();
  if (!text) return rates;

  for (const part of text.split(',')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    // eq === 0 is "=25" with no code, eq === -1 is no "=" at all, and a second
    // "=" means this is not the CODE=percent shape either.
    if (eq <= 0 || eq !== pair.lastIndexOf('=')) {
      throw new Error(`--rates wants comma-separated CODE=percent pairs; "${pair}" is not one.`);
    }
    const code = pair.slice(0, eq).trim().toUpperCase();
    const raw = pair.slice(eq + 1).trim();

    // Naming a code twice means two different answers to "what is this person
    // paid". Last-one-wins would pick one of them silently.
    if (rates.has(code)) {
      throw new Error(`--rates names ${code} more than once. Give it one rate.`);
    }
    // parseFloat would read "25%" and "25oops" as 25, so the whole string has
    // to be a number before it is believed. The leading '-' is allowed through
    // so that -5 gets the range error below, which says what is actually wrong.
    if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(raw)) {
      throw new Error(`--rates ${code}=${raw}: "${raw}" is not a number.`);
    }
    const percent = Number(raw);
    if (!(percent >= 0 && percent <= 100)) {
      throw new Error(`--rates ${code}=${raw}: a commission must be between 0 and 100.`);
    }
    rates.set(code, percent);
  }
  return rates;
}

async function stripe(path, params = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const key = deps.key || KEY;
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + key } });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${res.status} on ${path}: ${(body.error && body.error.message) || 'unknown'}`);
  }
  return body;
}

// Stripe's page limit is 1..100 and its DEFAULT IS 10 - not 100. Low volume
// today, but a report that silently stops at the first page is worse than no
// report, so this walks the whole list.
async function listAll(path, params, deps = {}) {
  const out = [];
  let startingAfter;
  for (;;) {
    const page = await stripe(path, { ...params, limit: 100, starting_after: startingAfter }, deps);
    const data = Array.isArray(page.data) ? page.data : [];
    out.push(...data);
    // has_more is the end condition, but an empty page has no last id to take a
    // cursor from - and asking again with the same cursor would loop forever.
    if (!page.has_more || !data.length) return out;
    startingAfter = data[data.length - 1].id;
  }
}

// The promotion code on a session is an ID - "promo_1ABC...", never the
// "OWEN10" somebody typed. Match against that ID string as the code itself and
// every sale falls into unattributed: the report runs, prints a tidy table, and
// says no influencer ever sold anything. That reads as a business problem
// rather than a bug, which is what makes it worth its own function.
//
// Reading the ID off both shapes is deliberate. Unexpanded it is the string;
// expanded (expand[]=data.discounts.promotion_code) it is an object with .id.
// Taking the ID either way means this does not depend on expansion happening,
// and the id -> code map below is what turns it into a name.
function promoIdFromSession(session) {
  const discounts = Array.isArray(session.discounts) ? session.discounts : [];
  for (const d of discounts) {
    if (!d) continue;
    if (typeof d.promotion_code === 'string' && d.promotion_code) return d.promotion_code;
    if (d.promotion_code && typeof d.promotion_code === 'object' && d.promotion_code.id) {
      return d.promotion_code.id;
    }
  }
  return null;
}

// Two very different things used to land in the same bucket, and only one of
// them is good news:
//
//   'none'    nobody typed a code. The sale is yours, nobody is owed.
//   'unknown' a code WAS used, and it is not in the promotion code list -
//             deleted from the dashboard, or belonging to another account.
//             Somebody earned that and would never be paid for it.
//
// Counting the second as the first is a silent underpayment that looks exactly
// like an honest direct sale, so they are separated and the unknown ones are
// named in the output.
function attribute(session, byId) {
  const promoId = promoIdFromSession(session);
  if (!promoId) return { kind: 'none' };
  const row = byId.get(promoId);
  return row ? { kind: 'code', row } : { kind: 'unknown', promoId };
}

const money = (cents) => '$' + (cents / 100).toFixed(2);
const pct = (n) => n + '%';

// A coupon name is free text from the Stripe dashboard, so "Launch week, 20%
// off" is a perfectly ordinary thing to call one - and it would quietly shift
// every column after it by one.
function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tally(sessions, byId) {
  let unattributed = 0, unattributedPaid = 0;
  const unknown = new Map();
  for (const s of sessions) {
    // status=complete is not the same as paid: a session completed with an
    // asynchronous payment method can still be unpaid, and counting it would
    // credit somebody for money that never arrived.
    if (s.payment_status !== 'paid') continue;
    const paid = s.amount_total || 0;
    const listPrice = s.amount_subtotal || paid;
    const found = attribute(s, byId);
    if (found.kind === 'code') {
      found.row.sales++; found.row.paid += paid; found.row.list += listPrice;
    } else if (found.kind === 'unknown') {
      const seen = unknown.get(found.promoId) || { sales: 0, paid: 0 };
      seen.sales++; seen.paid += paid;
      unknown.set(found.promoId, seen);
    } else {
      unattributed++; unattributedPaid += paid;
    }
  }
  return { unattributed, unattributedPaid, unknown };
}

// deps is for the tests: a stubbed fetch and a fake key instead of real Stripe,
// and an argv that is not the process's. Empty in normal use.
async function main(deps = {}) {
  const key = deps.key || KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set. Run this where the key lives.');
  const io = { fetch: deps.fetch, key };
  const args = parseArgs(deps.argv || process.argv.slice(2));
  const days = parseInt(args.days, 10) > 0 ? parseInt(args.days, 10) : 7;
  const rate = args.rate !== undefined ? parseFloat(args.rate) : 20;
  if (!(rate >= 0 && rate <= 100)) throw new Error('--rate must be between 0 and 100.');
  const rates = parseRates(args.rates);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  // Every code, including the ones nobody used - an influencer with zero sales
  // is a thing you want to see, not a row that quietly goes missing.
  const codes = await listAll('/promotion_codes', {}, io);
  const byId = new Map();
  codes.forEach((c) => {
    const upper = String(c.code || '').toUpperCase();
    byId.set(c.id, {
      code: c.code,
      coupon: (c.coupon && (c.coupon.name || c.coupon.id)) || '-',
      active: c.active,
      // Resolved once, here, so the rate column, the owed column and the CSV
      // all read the same number. Working it out again at print time is how a
      // table and a CSV of the same run end up disagreeing.
      rate: rates.has(upper) ? rates.get(upper) : rate,
      sales: 0,
      paid: 0,
      list: 0
    });
  });

  // The typo case, and the reason this warning is worth the lines: --rates
  // JERREL=25 matches nothing, so Jerrell is paid 20% and the report is as
  // tidy and as wrong as it was before --rates existed. On stderr, so it
  // cannot land in the middle of --csv output.
  const known = new Set(codes.map((c) => String(c.code || '').toUpperCase()));
  const unmatched = [...rates.keys()].filter((c) => !known.has(c));
  if (unmatched.length) {
    console.warn(`WARNING: --rates names ${unmatched.length} code(s) that do not exist in Stripe: `
      + `${unmatched.join(', ')}.`);
    console.warn('Check the spelling - anyone not matched is being paid the default '
      + `rate of ${rate}%.`);
  }

  // status=complete drops abandoned carts before they are paged over. It does
  // not decide what counts as a sale - payment_status does, in tally().
  const sessions = await listAll('/checkout/sessions', { 'created[gte]': since, status: 'complete' }, io);

  // Selling in more than one currency would make these totals a sum of
  // different units, printed with one dollar sign. Refuse rather than mislead.
  const currencies = new Set(sessions.filter((s) => s.payment_status === 'paid')
    .map((s) => (s.currency || 'usd').toLowerCase()));
  if (currencies.size > 1) {
    throw new Error(`Sales in more than one currency (${[...currencies].join(', ')}). `
      + 'This report adds them up as if they were one, so it will not run.');
  }

  const { unattributed, unattributedPaid, unknown } = tally(sessions, byId);

  const rows = [...byId.values()]
    .map((r) => ({ ...r, owed: Math.round((PAY_ON === 'list' ? r.list : r.paid) * r.rate / 100) }))
    .sort((a, b) => b.owed - a.owed || a.code.localeCompare(b.code));

  if (args.csv) {
    console.log('code,coupon,active,sales,customers_paid,rate_percent,owed');
    rows.forEach((r) => console.log([r.code, r.coupon, r.active, r.sales,
      (r.paid / 100).toFixed(2), r.rate, (r.owed / 100).toFixed(2)].map(csvCell).join(',')));
    return;
  }

  const from = new Date(since * 1000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const overrides = rows.filter((r) => r.rate !== rate).length;
  console.log(`\nAffiliate report  ${from} to ${to}  (${days} days, ${rate}% of what customers paid`
    + (overrides ? `, ${overrides} code(s) on their own rate` : '') + ')\n');
  console.log('CODE              SALES   CUSTOMERS PAID   RATE      OWED   COUPON');
  console.log('-'.repeat(78));
  let totalSales = 0, totalPaid = 0, totalOwed = 0;
  for (const r of rows) {
    totalSales += r.sales; totalPaid += r.paid; totalOwed += r.owed;
    const flag = r.active ? '' : '  (inactive)';
    console.log(
      r.code.padEnd(18) +
      String(r.sales).padStart(5) +
      money(r.paid).padStart(16) +
      pct(r.rate).padStart(7) +
      money(r.owed).padStart(10) +
      '   ' + r.coupon + flag
    );
  }
  console.log('-'.repeat(78));
  // No rate on the total line: with two rates in the table, one number there
  // would be a third rate that nobody is actually paid.
  console.log('TOTAL'.padEnd(18) + String(totalSales).padStart(5) + money(totalPaid).padStart(16)
    + ''.padStart(7) + money(totalOwed).padStart(10));
  if (unattributed) {
    console.log(`\n${unattributed} paid order(s) used no code - ${money(unattributedPaid)}. Those are yours, nobody is owed.`);
  }
  if (unknown.size) {
    console.log(`\nWARNING: ${unknown.size} code(s) were used that are not in your promotion code list.`);
    console.log('Somebody earned these and is not being paid for them. Deleted from the dashboard?');
    for (const [id, seen] of unknown) console.log(`  ${id}  ${seen.sales} sale(s)  ${money(seen.paid)}`);
  }
  if (!totalSales) console.log('\nNo code was used in this window.');
  console.log('');
}

if (require.main === module) {
  main().catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
}

module.exports = { promoIdFromSession, attribute, tally, listAll, csvCell, parseArgs, parseRates, main };
