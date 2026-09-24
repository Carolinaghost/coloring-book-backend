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
//   node scripts/affiliate-report.js --period
//   node scripts/affiliate-report.js --csv
//
// Options:
//   --period      the pay week that just ended: Saturday 00:00 to Friday
//                 23:59:59.999 local time. This is what the Saturday morning
//                 run uses, and what the creators were promised.
//   --tz <zone>   which local time --period means (default America/New_York)
//   --days <n>    a rolling window ending now, for looking around (default 7)
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

// Creators are told: the week runs Saturday 12:00am to Friday 11:59pm, and
// it is paid the Friday after it closes. So the week being paid for is a fixed calendar block in
// THEIR day, not a rolling seven days ending whenever the report happened to
// be run. Those two are not the same, and the gap between them is a sale that
// gets paid twice or never - a rolling window run at 08:00 Saturday misses
// everything sold between 08:00 last Saturday and midnight, and pays again for
// everything after 08:00 last Friday.
const PAY_WEEK_STARTS_ON = 6;             // Saturday, with Sunday as 0
const DEFAULT_TZ = 'America/New_York';

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

// A restricted API key hands back promotion codes with no coupon on them at
// all - not an id, not an expanded object, and asking for expand[]=data.coupon
// does not change it. The coupon column then reads "-" on every row, which
// looks like the coupons were deleted rather than like a key permission.
//
// Promotion codes can still be listed one coupon at a time, so the link is
// rebuilt from the other end. Only when it is actually missing: with a full
// key the codes arrive with their coupon already on them and this costs
// nothing and asks Stripe for nothing.
async function couponNames(codes, io) {
  const names = new Map();
  if (!codes.length || codes.every((c) => c && c.coupon)) return names;
  for (const coupon of await listAll('/coupons', {}, io)) {
    for (const p of await listAll('/promotion_codes', { coupon: coupon.id }, io)) {
      names.set(p.id, coupon.name || coupon.id);
    }
  }
  return names;
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

// Everything below is about one hard thing: "midnight, local" is a different
// instant in March than in November, and Stripe only speaks in UTC seconds.

// The zone's offset from UTC at a given instant, in minutes. Read from the
// formatter rather than computed, so the DST rules are the platform's problem.
function offsetMinutes(at, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(at);
  const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;                       // "GMT" with no offset means UTC
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// The calendar day and weekday it is in that zone right now.
function localParts(at, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(at);
  const get = (t) => (f.find((p) => p.type === t) || {}).value;
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    dow: days[get('weekday')]
  };
}

// The instant that is midnight on a given local calendar day. Guess with the
// offset that applies near it, then re-read the offset at the guess - the
// second pass is what gets the two days a year when the first guess lands on
// the wrong side of a clock change.
function localMidnight({ year, month, day }, tz) {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let at = naive - offsetMinutes(new Date(naive), tz) * 60000;
  at = naive - offsetMinutes(new Date(at), tz) * 60000;
  return at;
}

// The pay week that has finished: Saturday 00:00 up to, but not including, the
// following Saturday 00:00 - which is Friday 23:59:59.999 as promised.
// Run at 08:00 on Saturday, "the most recent Saturday midnight" is this
// morning, so the week it closes is the one just gone.
function payPeriod(now, tz) {
  const here = localParts(now, tz);
  const back = (here.dow - PAY_WEEK_STARTS_ON + 7) % 7;
  const endDay = new Date(Date.UTC(here.year, here.month - 1, here.day) - back * 86400000);
  const asParts = (d) => ({
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate()
  });
  const end = localMidnight(asParts(endDay), tz);
  const start = localMidnight(asParts(new Date(endDay.getTime() - 7 * 86400000)), tz);
  return { start: Math.floor(start / 1000), end: Math.floor(end / 1000) };
}

// Friday, not the Saturday that the exclusive end lands on.
function windowLabel(startSec, endSec, tz) {
  const day = (sec) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric'
  }).format(new Date(sec * 1000));
  return `${day(startSec)} 00:00 to ${day(endSec - 1000)} 23:59`;
}

// What the Saturday run pays by. server.js emails the report with these and
// scripts/pay-creators.js sends the money with them, so the two cannot be
// working from different rates or a different week.
//
// Jerrell negotiated 25 and is the only exception. Anyone else is on the
// default rate, which the sign-up form also writes into each code's metadata.
// PAYOUT_REPORT_RATES is an env var so a second exception needs no deploy.
const DEFAULT_REPORT_RATES = 'JERRELL=25';
function saturdayArgs(env = process.env) {
  return ['--period', '--tz', env.PAYOUT_REPORT_TZ || DEFAULT_TZ,
    '--rates', env.PAYOUT_REPORT_RATES || DEFAULT_REPORT_RATES];
}

// Who is owed what. Everything that decides a number lives here and nothing
// that prints does, because two things use it: the report below, which shows
// Jonathan the numbers, and scripts/pay-creators.js, which sends them. If the
// money were worked out twice, the two could disagree and the one that moved
// real money would be the one nobody had looked at.
async function computeOwed(deps = {}) {
  const warn = deps.warn || console.warn;
  const key = deps.key || KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set. Run this where the key lives.');
  const io = { fetch: deps.fetch, key };
  const args = parseArgs(deps.argv || process.argv.slice(2));
  const days = parseInt(args.days, 10) > 0 ? parseInt(args.days, 10) : 7;
  const rate = args.rate !== undefined ? parseFloat(args.rate) : 20;
  if (!(rate >= 0 && rate <= 100)) throw new Error('--rate must be between 0 and 100.');
  const rates = parseRates(args.rates);
  const tz = args.tz && args.tz !== 'true' ? args.tz : DEFAULT_TZ;
  const now = deps.now ? new Date(deps.now) : new Date();

  // Two shapes of window. The pay period is the one anybody is paid from; the
  // rolling one is for looking around and says so in the heading.
  const usePeriod = args.period === 'true' || args.period === true;
  const period = usePeriod ? payPeriod(now, tz) : null;
  const since = usePeriod ? period.start
    : Math.floor(now.getTime() / 1000) - days * 86400;
  const until = usePeriod ? period.end : null;

  // Every code, including the ones nobody used - an influencer with zero sales
  // is a thing you want to see, not a row that quietly goes missing.
  const codes = await listAll('/promotion_codes', {}, io);
  const couponFor = await couponNames(codes, io);
  const byId = new Map();
  codes.forEach((c) => {
    const upper = String(c.code || '').toUpperCase();
    byId.set(c.id, {
      id: c.id,
      code: c.code,
      coupon: (c.coupon && (c.coupon.name || c.coupon.id)) || couponFor.get(c.id) || '-',
      active: c.active,
      // Resolved once, here, so the rate column, the owed column and the CSV
      // all read the same number. Working it out again at print time is how a
      // table and a CSV of the same run end up disagreeing.
      rate: rates.has(upper) ? rates.get(upper) : rate,
      // Written onto the code when the creator signed up, so the report can
      // name the person and not just the code. Absent on the codes made by
      // hand in the dashboard before the sign-up form existed.
      creatorName: (c.metadata && c.metadata.creator_name) || '',
      creatorEmail: (c.metadata && c.metadata.creator_email) || '',
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
    warn(`WARNING: --rates names ${unmatched.length} code(s) that do not exist in Stripe: `
      + `${unmatched.join(', ')}.`);
    warn('Check the spelling - anyone not matched is being paid the default '
      + `rate of ${rate}%.`);
  }

  // status=complete drops abandoned carts before they are paged over. It does
  // not decide what counts as a sale - payment_status does, in tally().
  const sessionQuery = { 'created[gte]': since, status: 'complete' };
  // Without this the report would sweep up sales made after the period closed
  // and pay them twice - once now, once again next Saturday.
  if (until) sessionQuery['created[lt]'] = until;
  const sessions = await listAll('/checkout/sessions', sessionQuery, io);

  // Selling in more than one currency would make these totals a sum of
  // different units, printed with one dollar sign. Refuse rather than mislead.
  const currencies = new Set(sessions.filter((s) => s.payment_status === 'paid')
    .map((s) => (s.currency || 'usd').toLowerCase()));
  if (currencies.size > 1) {
    throw new Error(`Sales in more than one currency (${[...currencies].join(', ')}). `
      + 'This report adds them up as if they were one, so it will not run.');
  }

  const { unattributed, unattributedPaid, unknown } = tally(sessions, byId);

  // Somebody earning for the first time is the one moment that needs a human:
  // before they can be paid they have to be set up as a contractor, which
  // means a W-9 and bank details they enter themselves. Nothing tells you that
  // moment has arrived except the money showing up, so the report has to.
  //
  // "First time" is asked of Stripe rather than kept in a list, because a list
  // is a thing to maintain and forget. Every complete session BEFORE this
  // window, once: any code in there has earned before and is already dealt
  // with. It is a second pass over the history and it grows with the business,
  // which is fine at this size and is the thing to change first if the report
  // ever gets slow.
  const earnedBefore = new Set();
  for (const s of await listAll('/checkout/sessions',
    { 'created[lt]': since, status: 'complete' }, io)) {
    if (s.payment_status !== 'paid') continue;
    const id = promoIdFromSession(s);
    if (id) earnedBefore.add(id);
  }

  const rows = [...byId.values()]
    .map((r) => {
      const owed = Math.round((PAY_ON === 'list' ? r.list : r.paid) * r.rate / 100);
      return { ...r, owed,
      // Owed, not just used. A free-book code gets redeemed at $0 and earns
      // its holder nothing - flagging that sends Jonathan off to set up a
      // contractor for somebody he owes no money and never will. The only
      // person who needs a W-9 on file is one who is about to be paid.
      firstSale: r.sales > 0 && owed > 0 && !earnedBefore.has(r.id) };
    })
    .sort((a, b) => b.owed - a.owed || a.code.localeCompare(b.code));

  const currency = currencies.size ? [...currencies][0] : 'usd';
  return { args, usePeriod, since, until, days, rate, tz, now, currency,
    rows, unattributed, unattributedPaid, unknown };
}

// `print` and `warn` are how the backend borrows this. The Saturday email runs
// the very same function the command line does and collects the lines instead
// of printing them - so what lands in Jonathan's inbox cannot drift from what
// he sees when he runs it himself, which is the only way two versions of a
// payout number ever stay in agreement.
async function main(deps = {}) {
  const print = deps.print || console.log;
  const { args, usePeriod, since, until, days, rate, tz, now,
    rows, unattributed, unattributedPaid, unknown } = await computeOwed(deps);

  if (args.csv) {
    print('code,coupon,active,sales,customers_paid,rate_percent,owed,'
      + 'first_sale,creator_name,creator_email');
    rows.forEach((r) => print([r.code, r.coupon, r.active, r.sales,
      (r.paid / 100).toFixed(2), r.rate, (r.owed / 100).toFixed(2),
      r.firstSale ? 'yes' : 'no', r.creatorName, r.creatorEmail].map(csvCell).join(',')));
    return;
  }

  const overrides = rows.filter((r) => r.rate !== rate).length;
  const heading = usePeriod
    ? `Pay week  ${windowLabel(since, until, tz)}  ${tz}`
    : `Affiliate report  ${new Date(since * 1000).toISOString().slice(0, 10)} to `
      + `${now.toISOString().slice(0, 10)}  (${days} days, rolling - not a pay week)`;
  print(`\n${heading}  (${rate}% of what customers paid`
    + (overrides ? `, ${overrides} code(s) on their own rate` : '') + ')\n');
  // A live code with no sales is news - somebody is not posting. A DEAD code
  // with no sales is just history, and after a few rounds of testing there is
  // more history in this table than business. Hidden, counted, never silent:
  // an inactive code that DID sell still shows, because that is money owed.
  const retired = rows.filter((r) => !r.active && r.sales === 0);
  const shown = rows.filter((r) => r.active || r.sales > 0);

  print('CODE              SALES   CUSTOMERS PAID   RATE      OWED   COUPON');
  print('-'.repeat(78));
  let totalSales = 0, totalPaid = 0, totalOwed = 0;
  for (const r of shown) {
    totalSales += r.sales; totalPaid += r.paid; totalOwed += r.owed;
    const flag = r.active ? '' : '  (inactive)';
    print(
      r.code.padEnd(18) +
      String(r.sales).padStart(5) +
      money(r.paid).padStart(16) +
      pct(r.rate).padStart(7) +
      money(r.owed).padStart(10) +
      '   ' + r.coupon + flag
    );
  }
  print('-'.repeat(78));
  // No rate on the total line: with two rates in the table, one number there
  // would be a third rate that nobody is actually paid.
  print('TOTAL'.padEnd(18) + String(totalSales).padStart(5) + money(totalPaid).padStart(16)
    + ''.padStart(7) + money(totalOwed).padStart(10));
  if (retired.length) {
    print(`\n${retired.length} deactivated code(s) with no sales are not listed: `
      + retired.map((r) => r.code).join(', '));
  }
  if (unattributed) {
    print(`\n${unattributed} paid order(s) used no code - ${money(unattributedPaid)}. Those are yours, nobody is owed.`);
  }
  if (unknown.size) {
    print(`\nWARNING: ${unknown.size} code(s) were used that are not in your promotion code list.`);
    print('Somebody earned these and is not being paid for them. Deleted from the dashboard?');
    for (const [id, seen] of unknown) print(`  ${id}  ${seen.sales} sale(s)  ${money(seen.paid)}`);
  }
  // Printed last, under the money, because it is the only thing in this report
  // that asks Jonathan to go and do something.
  const newcomers = rows.filter((r) => r.firstSale);
  if (newcomers.length) {
    print(`\n${newcomers.length} code(s) earned for the FIRST time this week.`);
    print('Set each of these up as a contractor in QuickBooks before paying them:');
    print('QuickBooks > Payroll > Contractors > Add a contractor. They fill in their');
    print('own W-9 and bank details - you never handle either.\n');
    for (const r of newcomers) {
      const who = r.creatorEmail
        ? `${r.creatorName || r.code} <${r.creatorEmail}>`
        : 'no name or email on this code - it was made by hand, so find them yourself';
      print(`  ${r.code.padEnd(18)} ${money(r.owed).padStart(9)}   ${who}`);
    }
  }
  if (!totalSales) print('\nNo code was used in this window.');
  print('');
}

if (require.main === module) {
  main().catch((err) => { console.error('\nFailed:', err.message); process.exit(1); });
}

module.exports = { promoIdFromSession, attribute, tally, listAll, csvCell, parseArgs, parseRates, couponNames, payPeriod, windowLabel, computeOwed, saturdayArgs, DEFAULT_REPORT_RATES, money, main };
