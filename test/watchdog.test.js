#!/usr/bin/env node
'use strict';

// Tests for the watchdog (watchdog.js).
//
//   npm test
//
// This thing exists to be trusted while nobody is watching it, which puts the
// weight on two properties that are easy to get wrong and invisible when they
// are wrong:
//
//   - it must not email the same thing every five minutes, or it gets muted,
//     and then it may as well not exist;
//   - it must not retry forever against a paid image API, because that is the
//     one failure here that spends real money on its own.
//
// Everything below is one of those two, or the honesty of a check.

const watchdog = require('../watchdog.js');

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

const minsAgo = (m) => new Date(Date.now() - m * 60000);

// A stand-in for the database, holding only what the watchdog reads and writes.
function fakeDb(orders) {
  const alerts = new Map();
  const actions = [];
  return {
    _actions: actions,
    _alerts: alerts,
    async ordersNeedingAttention(minutes) {
      return orders.filter((o) => Date.now() - new Date(o.paidAt).getTime() >= minutes * 60000);
    },
    async databaseSizeBytes() { return this._dbBytes === undefined ? null : this._dbBytes; },
    async getAlerts() { return [...alerts.values()].map((a) => ({ ...a })); },
    async saveAlert(a) { alerts.set(a.key, { ...a, firstSeen: a.firstSeen || new Date() }); },
    async clearAlert(k) { alerts.delete(k); },
    async recordAction(orderId, action, reason) { actions.push({ orderId, action, reason, createdAt: new Date() }); },
    async countActionsSince() { return actions.length; },
    async countActionsForOrder(orderId, action) {
      return actions.filter((a) => a.orderId === orderId && a.action === action).length;
    },
    async recentActions() { return actions.map((a) => ({ ...a })); },
    async dayTotals() { return { orders: 3, revenueCents: 4500, pages: 45 }; }
  };
}

function collector() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); } };
}

function ctxFor(db, extra) {
  const out = collector();
  return Object.assign({
    db, send: out.send, _sent: out.sent,
    runtime: null, dbCeilingBytes: 0,
    rekickOrder: async () => {},
    resendReadyEmail: async () => {}
  }, extra || {});
}

async function main() {
  console.log('\nA stuck order is noticed; a slow one is left alone');

  watchdog.resetSamples();
  // Paid 22 minutes ago, nothing drawn. Generation takes about 3 minutes.
  const stuck = { id: 41, paidAt: minsAgo(22), pageCount: 15, generationStatus: 'idle',
    pagesReady: 0, renderAttempts: 0, readyEmailAt: null, readyEmailFails: 0,
    email: 'a@b.test', hasPhoto: true };
  let found = await watchdog.gather(ctxFor(fakeDb([stuck])));
  check('the stuck one is found', found.map((f) => f.key), ['order:41:never-started']);
  check('and it is critical', found[0].level, 'CRITICAL');
  check('the subject reads on a phone without opening it',
    /^Order 41 paid \d+ min ago, no pages$/.test(found[0].subject), true);

  // Paid two minutes ago and already drawing. That is just a book being made.
  const slow = { ...stuck, id: 42, paidAt: minsAgo(2), generationStatus: 'running', pagesReady: 4 };
  found = await watchdog.gather(ctxFor(fakeDb([slow])));
  check('a book still being drawn is not an alert', found, []);

  // Finished, but nobody was told.
  const untold = { ...stuck, id: 43, paidAt: minsAgo(30), generationStatus: 'done',
    pagesReady: 15, readyEmailAt: null };
  found = await watchdog.gather(ctxFor(fakeDb([untold])));
  check('a finished order nobody was told about is caught',
    found.map((f) => f.key), ['order:43:not-told']);

  const told = { ...untold, id: 44, readyEmailAt: minsAgo(25) };
  found = await watchdog.gather(ctxFor(fakeDb([told])));
  check('and a finished order that was told about is not', found, []);

  console.log('\nThe same problem does not email every five minutes');

  const db = fakeDb([stuck]);
  const ctx = ctxFor(db);
  await watchdog.runWatchdog(ctx);
  await watchdog.runWatchdog(ctx);
  await watchdog.runWatchdog(ctx);
  const alerts = ctx._sent.filter((m) => m.level === 'CRITICAL');
  check('three runs, one email', alerts.length, 1);

  console.log('\nAnd it says when it is over');

  // Same context, but now the order is fine.
  const fixedCtx = ctxFor(db);
  fixedCtx.db = Object.assign({}, db, { ordersNeedingAttention: async () => [] });
  await watchdog.runWatchdog(fixedCtx);
  const clears = fixedCtx._sent.filter((m) => m.level === 'CLEAR');
  check('an all-clear goes out', clears.length, 1);
  check('and it says what cleared', /order:41/.test(clears[0].lines.join(' ')), true);
  // Once it has cleared it must not keep announcing itself either.
  const againCtx = ctxFor(fixedCtx.db);
  await watchdog.runWatchdog(againCtx);
  check('and only once', againCtx._sent.length, 0);

  console.log('\nA condition getting worse does get through');

  const warnThenCrit = fakeDb([]);
  warnThenCrit._dbBytes = 0.75 * 1e9;
  const c1 = ctxFor(warnThenCrit, { dbCeilingBytes: 1e9 });
  await watchdog.runWatchdog(c1);
  check('70% sends a warning', c1._sent.map((m) => m.level), ['WARNING']);
  warnThenCrit._dbBytes = 0.9 * 1e9;
  const c2 = ctxFor(warnThenCrit, { dbCeilingBytes: 1e9 });
  await watchdog.runWatchdog(c2);
  check('and 85% escalates rather than staying quiet', c2._sent.map((m) => m.level), ['CRITICAL']);

  console.log('\nIt gives up on an order rather than retrying forever');

  const retryDb = fakeDb([stuck]);
  let kicks = 0;
  const retryCtx = () => ctxFor(retryDb, { rekickOrder: async () => { kicks++; } });
  await watchdog.runWatchdog(retryCtx());
  await watchdog.runWatchdog(retryCtx());
  await watchdog.runWatchdog(retryCtx());
  await watchdog.runWatchdog(retryCtx());
  check('it tries twice and then stops', kicks, watchdog.MAX_AUTO_PER_ORDER);
  check('and both attempts are on the record', retryDb._actions.length, 2);
  check('with the order number on them', retryDb._actions[0].orderId, 41);

  console.log('\nAnd it stops fixing anything at all if it is fixing too much');

  // Six different broken orders at once. The sixth must not be touched: a
  // retry loop against a paid API is the failure that costs money fastest.
  const many = [];
  for (let i = 1; i <= 6; i++) {
    many.push({ ...stuck, id: 100 + i });
  }
  const floodDb = fakeDb(many);
  let fixes = 0;
  const floodCtx = ctxFor(floodDb, { rekickOrder: async () => { fixes++; } });
  await watchdog.runWatchdog(floodCtx);
  check('it fixes up to the hourly limit', fixes, watchdog.MAX_FIXES_PER_HOUR);

  // Next run: already over the limit, so nothing more is touched at all.
  const floodCtx2 = ctxFor(floodDb, { rekickOrder: async () => { fixes++; } });
  await watchdog.runWatchdog(floodCtx2);
  check('and then stops entirely', fixes, watchdog.MAX_FIXES_PER_HOUR);
  check('shouting about it instead',
    floodCtx2._sent.some((m) => /stopped fixing/.test(m.subject)), true);

  console.log('\nOne broken check does not silence the others');

  const brokenDb = fakeDb([stuck]);
  brokenDb.databaseSizeBytes = async () => { throw new Error('connection reset'); };
  const brokenCtx = ctxFor(brokenDb, { dbCeilingBytes: 1e9 });
  const out = await watchdog.gather(brokenCtx);
  check('the order check still reported',
    out.some((f) => f.key === 'order:41:never-started'), true);
  check('and the broken one is reported as broken',
    out.some((f) => f.key === 'watchdog:check-broken:database'), true);
  check('with the reason it threw',
    out.find((f) => f.key === 'watchdog:check-broken:database').detail.includes('connection reset'), true);

  console.log('\nMemory: a spike during a render is not an alarm');

  watchdog.resetSamples();
  const memDb = fakeDb([]);
  // One high sample among low ones is a book being drawn.
  for (const frac of [0.3, 0.9, 0.3, 0.3, 0.3, 0.3]) {
    const c = ctxFor(memDb, { runtime: { memoryBytes: frac * 2e9, memoryLimitBytes: 2e9 } });
    await watchdog.runWatchdog(c);
  }
  check('a single spike says nothing', memDb._alerts.has('capacity:memory'), false);

  watchdog.resetSamples();
  const memDb2 = fakeDb([]);
  let lastSent = null;
  for (let i = 0; i < watchdog.MEMORY_SAMPLES; i++) {
    const c = ctxFor(memDb2, { runtime: { memoryBytes: 0.8 * 2e9, memoryLimitBytes: 2e9 } });
    await watchdog.runWatchdog(c);
    lastSent = c._sent;
  }
  check('but staying high does', memDb2._alerts.has('capacity:memory'), true);
  check('as a warning, not a 2am critical', lastSent[0] && lastSent[0].level, 'WARNING');

  console.log('\nLetting the database sleep');

  // Neon bills time awake, not queries, and suspends after ~5 minutes idle. So
  // a poll every 60 seconds never lets the timer run out: measured at 0.25 CU
  // running continuously, ~183 CU-hours a month against an allowance of 191.9.
  // The fix is to poll rarely when there is no reason to poll at all.
  const { pollDelayMs } = require('../server.js');
  const MIN = 60000;
  const opts = { activeWindowMs: 15 * MIN, sweepMs: MIN, idleMs: 30 * MIN };

  check('nothing happening, so it waits half an hour',
    pollDelayMs({ ...opts }), 30 * MIN);
  check('a book being drawn keeps it on the fast cadence',
    pollDelayMs({ ...opts, rendering: 1 }), MIN);
  check('so does something having just happened',
    pollDelayMs({ ...opts, sinceActivityMs: 2 * MIN }), MIN);
  // An open alert has to be watched until it clears, or the all-clear arrives
  // half an hour late and the escalation never happens at all.
  check('and an open alert, until it clears',
    pollDelayMs({ ...opts, openAlerts: true }), MIN);
  check('but once it is quiet again it backs off',
    pollDelayMs({ ...opts, sinceActivityMs: 20 * MIN }), 30 * MIN);
  // The boundary: exactly at the window is still quiet, a moment inside is not.
  check('the activity window is exclusive at its edge',
    pollDelayMs({ ...opts, sinceActivityMs: 15 * MIN }), 30 * MIN);
  check('and inclusive just inside it',
    pollDelayMs({ ...opts, sinceActivityMs: 15 * MIN - 1 }), MIN);

  console.log('\nThe daily digest');

  const digestDb = fakeDb([]);
  const digestCtx = ctxFor(digestDb);
  await watchdog.dailyDigest(digestCtx);
  const digest = digestCtx._sent[0];
  check('one email a day', digestCtx._sent.length, 1);
  check('with the money in the subject', digest.subject, '3 orders, $45.00');
  check('and the OpenAI spend in the body',
    digest.lines.some((l) => /\$2\.43 of OpenAI/.test(l)), true);

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
