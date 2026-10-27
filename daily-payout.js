'use strict';
// The daily payout: a set share of each day's sales goes to the bank, the rest
// stays in Stripe.
//
// Jonathan asked for 60% of every day's sales paid out daily, with 40% left in
// Stripe to build up - it is what creator payouts (Tuesday transfers out of the
// Stripe balance), refunds and disputes are paid from. Stripe has no
// percentage setting: its automatic payouts send the whole balance, or the
// whole balance above a fixed minimum. So the account is on MANUAL payouts and
// this sends one payout a day itself.
//
// "A day's sales" is everything that became AVAILABLE in Stripe during the
// previous calendar day (US Eastern): card payments, minus Stripe's fees,
// minus refunds and dispute adjustments. Money only becomes available a couple
// of days after the sale, and only available money can be paid out, so this is
// the honest version of "that day's money". Transfers to creators and earlier
// payouts are left out - creators are paid from the 40% that stays behind.
//
// One payout per day, never two: the server claims the day in the job_runs
// table before doing anything, and Stripe gets an idempotency key named after
// the day, so even a retried request cannot pay twice. Nothing here throws at
// the caller; every outcome comes back as a plain result to log or alert on.

const STRIPE = 'https://api.stripe.com/v1';

// Every balance-transaction type that moves money out of or around the
// account rather than coming in from a sale. Leaving these out is what keeps
// creator transfers and previous payouts from being counted as "sales".
const NOT_SALES = new Set([
  'payout', 'payout_cancel', 'payout_failure', 'payout_minimum_balance_hold',
  'payout_minimum_balance_release', 'transfer', 'transfer_cancel', 'transfer_failure',
  'transfer_refund', 'topup', 'topup_reversal'
]);

// Midnight at the start of `date` (YYYY-MM-DD) in tz, as unix seconds. Found by
// asking Intl what the wall clock reads at noon UTC that day and backing out
// the offset - DST-safe without a date library.
function midnightUnix(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(noonUtc));
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value);
  const wallMinutes = (get('hour') % 24) * 60 + get('minute');
  const offsetMinutes = wallMinutes - 12 * 60; // e.g. -240 in EDT
  return Math.floor((Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60000) / 1000);
}

function previousDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

async function stripeGet(path, key, fetchImpl) {
  const resp = await fetchImpl(STRIPE + path, { headers: { Authorization: `Bearer ${key}` } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((body.error && body.error.message) || `Stripe said ${resp.status}`);
  return body;
}

// The net of every sale-side balance transaction that became available on
// `day` (in tz). Paginates; a small shop's day is one page.
async function salesNetForDay(day, { key, tz, fetchImpl }) {
  const start = midnightUnix(day, tz);
  const end = midnightUnix(nextDay(day), tz);
  let net = 0;
  let count = 0;
  let after = null;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ 'available_on[gte]': String(start), 'available_on[lt]': String(end), limit: '100', currency: 'usd' });
    if (after) q.set('starting_after', after);
    const body = await stripeGet('/balance_transactions?' + q.toString(), key, fetchImpl);
    for (const t of body.data || []) {
      if (t.currency !== 'usd' || NOT_SALES.has(t.type)) continue;
      net += Number(t.net) || 0;
      count++;
    }
    if (!body.has_more || !(body.data || []).length) break;
    after = body.data[body.data.length - 1].id;
  }
  return { net, count, start, end };
}

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// today: the US-Eastern date the job runs on. Pays out percent% of the sales
// that became available the day before.
async function runDailyPayout({ key, percent, today, tz = 'America/New_York', fetchImpl = fetch }) {
  const pct = Number(percent);
  if (!key) return { status: 'no key' };
  if (!(pct > 0 && pct <= 100)) return { status: 'off' };
  const day = previousDay(today);
  const sales = await salesNetForDay(day, { key, tz, fetchImpl });
  let amount = Math.floor(sales.net * pct / 100);
  if (amount <= 0) return { status: 'nothing to pay', day, salesNet: sales.net, sales: sales.count };

  // Never ask for more than is actually there: a refund or a creator payout
  // that already went out can leave less available than the day earned.
  const balance = await stripeGet('/balance', key, fetchImpl);
  const available = ((balance.available || []).find((b) => b.currency === 'usd') || {}).amount || 0;
  const capped = amount > available;
  if (capped) amount = Math.max(0, available);
  // Stripe's smallest US payout is $1. Anything under stays in Stripe.
  if (amount < 100) return { status: 'below $1', day, salesNet: sales.net, sales: sales.count, available };

  const form = new URLSearchParams({
    amount: String(amount),
    currency: 'usd',
    description: `Crayonauts ${pct}% of ${day} sales`,
    'metadata[for_day]': day,
    'metadata[percent]': String(pct),
    'metadata[sales_net_cents]': String(sales.net)
  });
  const resp = await fetchImpl(STRIPE + '/payouts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `crayonauts-daily-payout-${day}`
    },
    body: form
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((out.error && out.error.message) || `Stripe refused the payout (${resp.status})`);
  }
  return { status: 'paid', day, amount, salesNet: sales.net, sales: sales.count, capped, payoutId: out.id, arrival: out.arrival_date };
}

module.exports = { runDailyPayout, salesNetForDay, midnightUnix, previousDay, nextDay, NOT_SALES };
