#!/usr/bin/env node
'use strict';
// The daily payout (daily-payout.js): 60% of the previous day's sales, once.
//   npm test
const { runDailyPayout, midnightUnix, previousDay } = require('../daily-payout');

let pass = 0; const fail = [];
const check = (n, ok) => (ok ? pass++ : (fail.push(n), console.log('  FAIL ' + n)));

// A fake Stripe: balance transactions, a balance, and the payouts it was asked for.
function fakeStripe({ txns, available, refusePayout }) {
  const asked = { payouts: [], listQueries: [] };
  const impl = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/v1/balance_transactions') {
      asked.listQueries.push(Object.fromEntries(u.searchParams));
      const gte = Number(u.searchParams.get('available_on[gte]'));
      const lt = Number(u.searchParams.get('available_on[lt]'));
      const data = txns.filter((t) => t.available_on >= gte && t.available_on < lt);
      return { ok: true, json: async () => ({ data, has_more: false }) };
    }
    if (u.pathname === '/v1/balance') {
      return { ok: true, json: async () => ({ available: [{ currency: 'usd', amount: available }] }) };
    }
    if (u.pathname === '/v1/payouts' && opts.method === 'POST') {
      if (refusePayout) return { ok: false, status: 400, json: async () => ({ error: { message: refusePayout } }) };
      const body = Object.fromEntries(new URLSearchParams(opts.body.toString()));
      asked.payouts.push({ body, idem: opts.headers['Idempotency-Key'] });
      return { ok: true, json: async () => ({ id: 'po_test', arrival_date: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { impl, asked };
}

(async () => {
  // EDT: 27 Oct 2026 00:00 New York = 04:00 UTC.
  check('midnight in New York (EDT)', midnightUnix('2026-10-27', 'America/New_York') === Date.UTC(2026, 9, 27, 4) / 1000);
  // EST: 10 Dec 2026 00:00 New York = 05:00 UTC.
  check('midnight in New York (EST)', midnightUnix('2026-12-10', 'America/New_York') === Date.UTC(2026, 11, 10, 5) / 1000);
  check('previous day across a month', previousDay('2026-11-01') === '2026-10-31');

  const dayStart = midnightUnix('2026-10-26', 'America/New_York');
  const inDay = dayStart + 3600;
  const txns = [
    { id: 't1', type: 'charge', currency: 'usd', net: 1426, available_on: inDay },        // $15 sale minus fee
    { id: 't2', type: 'payment', currency: 'usd', net: 2864, available_on: inDay },       // $29.99 sale minus fee
    { id: 't3', type: 'refund', currency: 'usd', net: -1500, available_on: inDay },       // a refund
    { id: 't4', type: 'transfer', currency: 'usd', net: -300, available_on: inDay },      // creator payout - not a sale
    { id: 't5', type: 'payout', currency: 'usd', net: -5000, available_on: inDay },       // old payout - not a sale
    { id: 't6', type: 'charge', currency: 'usd', net: 9999, available_on: dayStart - 1 }, // the day before - not counted
    { id: 't7', type: 'charge', currency: 'usd', net: 7777, available_on: midnightUnix('2026-10-27', 'America/New_York') } // today - not counted
  ];
  let s = fakeStripe({ txns, available: 100000 });
  let r = await runDailyPayout({ key: 'rk', percent: 60, today: '2026-10-27', fetchImpl: s.impl });
  const expected = Math.floor((1426 + 2864 - 1500) * 0.6); // 1674
  check('pays 60% of the previous day only (sales minus fees and refunds)', r.status === 'paid' && r.amount === expected);
  check('one payout, in USD, for that amount', s.asked.payouts.length === 1 && s.asked.payouts[0].body.amount === String(expected) && s.asked.payouts[0].body.currency === 'usd');
  check('idempotency key names the day', s.asked.payouts[0].idem === 'crayonauts-daily-payout-2026-10-26');
  check('creator transfers and old payouts ignored', r.salesNet === 1426 + 2864 - 1500);

  s = fakeStripe({ txns, available: 1000 });
  r = await runDailyPayout({ key: 'rk', percent: 60, today: '2026-10-27', fetchImpl: s.impl });
  check('capped at what is available', r.status === 'paid' && r.amount === 1000 && r.capped === true);

  s = fakeStripe({ txns: [], available: 50000 });
  r = await runDailyPayout({ key: 'rk', percent: 60, today: '2026-10-27', fetchImpl: s.impl });
  check('no sales, no payout', r.status === 'nothing to pay' && s.asked.payouts.length === 0);

  s = fakeStripe({ txns: [{ id: 'x', type: 'charge', currency: 'usd', net: 150, available_on: inDay }], available: 50000 });
  r = await runDailyPayout({ key: 'rk', percent: 60, today: '2026-10-27', fetchImpl: s.impl });
  check('under $1 stays in Stripe', r.status === 'below $1' && s.asked.payouts.length === 0);

  s = fakeStripe({ txns, available: 100000, refusePayout: 'You cannot create manual payouts while automatic payouts are enabled' });
  let threw = null;
  try { await runDailyPayout({ key: 'rk', percent: 60, today: '2026-10-27', fetchImpl: s.impl }); } catch (e) { threw = e.message; }
  check('a refusal surfaces as an error (so it is alerted on)', /automatic payouts/.test(threw || ''));

  r = await runDailyPayout({ key: 'rk', percent: 0, today: '2026-10-27', fetchImpl: s.impl });
  check('off without a percent', r.status === 'off');

  console.log(pass + ' passed' + (fail.length ? ', FAILED: ' + fail.join('; ') : ''));
  process.exit(fail.length ? 1 : 0);
})();
