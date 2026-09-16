'use strict';

// Watches the service and says something before it breaks.
//
// Two jobs, kept apart on purpose:
//
//   1. Warn early, so a plan gets upgraded on a Tuesday afternoon rather than
//      at 2am after a customer has already been let down.
//   2. Fix a very short list of safe, boring failures without waking anyone.
//      Everything else notifies and stops.
//
// The list in Part 2 is deliberately two items long. A watchdog that retries
// broadly against a paid image API is the one failure here that can spend real
// money quickly, which is why there is a global rate limit as well as a
// per-order cap. Resist widening it.
//
// Every check runs independently. One throwing must not take the others with
// it, or a bug in the cheapest check hides the expensive one.

const LEVEL_RANK = { WARNING: 1, CRITICAL: 2 };

// How long after paying a book may take before something is wrong. Generation
// runs about three minutes, so ten leaves room for a queue without crying wolf.
const STUCK_MINUTES = 10;
const DB_WARN_AT = 0.70;
const DB_CRITICAL_AT = 0.85;
const MEMORY_WARN_AT = 0.70;
const MEMORY_SAMPLES = 6;          // ~30 minutes at a 5-minute interval
const QUEUE_FULL_RUNS = 3;         // full this many checks running means queuing
const MAX_FIXES_PER_HOUR = 5;
const MAX_AUTO_PER_ORDER = 2;

// Rolling samples, in memory. Losing them on a restart is fine: they only exist
// to tell a spike during one render from a level that is not coming back down.
let memorySamples = [];
let queueFullRuns = 0;

function pct(n) { return (n * 100).toFixed(0) + '%'; }
function mb(bytes) { return (bytes / 1048576).toFixed(0) + ' MB'; }
function gb(bytes) { return (bytes / 1073741824).toFixed(2) + ' GB'; }
function minutesSince(t) { return Math.floor((Date.now() - new Date(t).getTime()) / 60000); }

// ---------------------------------------------------------------------------
// Part 1 - the checks. Each returns an array of findings; [] means all well.
// A finding's `key` is its identity for deduplication, so it must name the
// specific thing (the order) and not just the kind of problem.
// ---------------------------------------------------------------------------

async function checkOrders({ db }) {
  const found = [];
  const orders = await db.ordersNeedingAttention(STUCK_MINUTES);

  for (const o of orders) {
    const mins = minutesSince(o.paidAt);
    const total = o.pageCount || 15;
    const done = o.generationStatus === 'done';

    if (!done && o.pagesReady === 0 && o.generationStatus === 'idle') {
      found.push({
        key: `order:${o.id}:never-started`, level: 'CRITICAL', orderId: o.id,
        fix: o.hasPhoto ? 'rekick' : null,
        subject: `Order ${o.id} paid ${mins} min ago, no pages`,
        detail: `Paid ${mins} minutes ago and generation never started. `
          + (o.hasPhoto ? 'The photo is still there, so it can be picked up.' : 'The photo is gone, so this needs a person.')
      });
    } else if (!done && o.pagesReady < total) {
      found.push({
        key: `order:${o.id}:stalled`, level: 'CRITICAL', orderId: o.id,
        fix: o.hasPhoto ? 'rekick' : null,
        subject: `Order ${o.id} stuck at ${o.pagesReady}/${total} pages`,
        detail: `Paid ${mins} minutes ago, status "${o.generationStatus}", `
          + `${o.pagesReady} of ${total} pages drawn.`
      });
    }

    if (done && o.email && !o.readyEmailAt) {
      found.push({
        key: `order:${o.id}:not-told`, level: 'CRITICAL', orderId: o.id, fix: 'resend',
        subject: `Order ${o.id} finished but the customer was not told`,
        detail: `The book is done and no ready-email is recorded as sent.`
      });
    }

    if (o.readyEmailFails > 0 && !o.readyEmailAt) {
      found.push({
        key: `order:${o.id}:email-failed`, level: 'CRITICAL', orderId: o.id, fix: 'resend',
        subject: `Order ${o.id} ready-email failed ${o.readyEmailFails}x`,
        detail: `The email has been attempted ${o.readyEmailFails} time(s) and has not gone.`
      });
    }
  }
  return found;
}

// Two different numbers get called "database size", and they are not
// comparable. Neon's plan limit applies to its synthetic size - logical data
// across every branch, plus retained WAL. pg_database_size() is the physical
// size of one database and omits all of that, so measuring it and comparing it
// to a Neon limit under-reports: the warning would arrive late, which is the
// one thing a capacity warning must not do.
//
// So the source is explicit, each source has its OWN ceiling variable, and the
// alert says which number it read. Crossing them is not possible by accident.
async function checkDatabase({ db, storage }) {
  if (!storage) return [];
  const { source, ceilingBytes } = storage;
  if (!ceilingBytes) return [];

  const bytes = source === 'neon'
    ? await storage.neonBytes()
    : await db.databaseSizeBytes();
  if (bytes === null || bytes === undefined) return [];

  const used = bytes / ceilingBytes;
  if (used < DB_WARN_AT) return [];
  const level = used >= DB_CRITICAL_AT ? 'CRITICAL' : 'WARNING';
  const named = source === 'neon'
    ? "Neon's own storage figure, which is what the plan limit applies to"
    : 'pg_database_size, which is NOT the number Neon caps on - it omits WAL, '
      + 'history and other branches, so the real usage is higher than this';
  return [{
    key: 'capacity:database', level,
    subject: `Storage ${pct(used)} full (${gb(bytes)} of ${gb(ceilingBytes)})`,
    detail: `Read from ${named}.\n\n`
      + `Pages are purged after the retention window, so this reflects recent `
      + `trade rather than every order ever taken.`
  }];
}

async function checkMemory({ runtime }) {
  if (!runtime || !runtime.memoryBytes || !runtime.memoryLimitBytes) return [];
  memorySamples.push(runtime.memoryBytes / runtime.memoryLimitBytes);
  if (memorySamples.length > MEMORY_SAMPLES) memorySamples.shift();
  // A single spike while a book renders is normal and expected. Only a run of
  // samples all high means the instance is actually too small.
  if (memorySamples.length < MEMORY_SAMPLES) return [];
  if (!memorySamples.every((s) => s >= MEMORY_WARN_AT)) return [];
  const worst = Math.max(...memorySamples);
  return [{
    key: 'capacity:memory', level: 'WARNING',
    subject: `Memory above ${pct(MEMORY_WARN_AT)} for ${MEMORY_SAMPLES} checks running`,
    detail: `Peak ${pct(worst)} of ${mb(runtime.memoryLimitBytes)}. Sustained, not a spike. `
      + `A 15-page book peaks around 250 MB, so this is concurrency, not one order.`
  }];
}

async function checkQueue({ runtime }) {
  if (!runtime || !runtime.maxConcurrent) return [];
  if (runtime.renderingNow >= runtime.maxConcurrent) queueFullRuns++; else queueFullRuns = 0;
  if (queueFullRuns < QUEUE_FULL_RUNS) return [];
  return [{
    key: 'capacity:queue', level: 'WARNING',
    subject: `All ${runtime.maxConcurrent} render slots busy for ${queueFullRuns} checks running`,
    detail: `Customers are waiting longer than they should. The instance wants to `
      + `be bigger, or MAX_CONCURRENT_BOOKS lower so the queue is honest.`
  }];
}

async function checkOpenAi({ runtime }) {
  if (!runtime || !runtime.openAiErrors) return [];
  const { rateLimited, failed, windowMinutes } = runtime.openAiErrors;
  const found = [];
  if (rateLimited > 0) {
    found.push({
      key: 'openai:rate-limited', level: 'WARNING',
      subject: `OpenAI rate-limited ${rateLimited}x in ${windowMinutes} min`,
      detail: `Pages are being refused and retried. Books will be slow.`
    });
  }
  if (failed >= 5) {
    found.push({
      key: 'openai:failing', level: 'CRITICAL',
      subject: `OpenAI failed ${failed}x in ${windowMinutes} min`,
      detail: `Not rate limiting - real errors. Books are probably not finishing.`
    });
  }
  return found;
}

async function checkPreviews({ runtime }) {
  if (!runtime || !runtime.previewsThisHour || !runtime.previewLimitPerHour) return [];
  const used = runtime.previewsThisHour / runtime.previewLimitPerHour;
  if (used < DB_WARN_AT) return [];
  const cost = (runtime.previewsThisHour * 0.054 * 2).toFixed(2);
  return [{
    key: 'cost:previews', level: 'WARNING',
    subject: `Free previews at ${pct(used)} of the hourly cap`,
    detail: `${runtime.previewsThisHour} previews this hour, about $${cost} of OpenAI. `
      + `Previews are the cheapest way to lose money quietly.`
  }];
}

const CHECKS = [
  ['orders', checkOrders],
  ['database', checkDatabase],
  ['memory', checkMemory],
  ['queue', checkQueue],
  ['openai', checkOpenAi],
  ['previews', checkPreviews]
];

// One failing check must not silence the rest.
async function gather(ctx) {
  const results = await Promise.allSettled(CHECKS.map(([, fn]) => fn(ctx)));
  const findings = [];
  const broken = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') findings.push(...(r.value || []));
    else broken.push({ check: CHECKS[i][0], error: r.reason && r.reason.message });
  });
  for (const b of broken) {
    console.error(`Watchdog: the ${b.check} check threw - ${b.error}`);
    findings.push({
      key: `watchdog:check-broken:${b.check}`, level: 'WARNING',
      subject: `The ${b.check} check is broken`,
      detail: `It threw: ${b.error}. The other checks still ran.`
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Part 2 - self-healing. Two actions, both capped, both logged.
// ---------------------------------------------------------------------------

async function selfHeal(findings, ctx) {
  const { db, rekickOrder, resendReadyEmail } = ctx;
  const done = [];

  const fixable = findings.filter((f) => f.fix && f.orderId);
  if (!fixable.length) return done;

  const recent = await db.countActionsSince(60);
  if (recent >= MAX_FIXES_PER_HOUR) {
    findings.push({
      key: 'watchdog:rate-limited', level: 'CRITICAL',
      subject: `Watchdog stopped fixing - ${recent} automatic fixes in an hour`,
      detail: `The limit is ${MAX_FIXES_PER_HOUR}. Something is wrong that retrying `
        + `will not solve, and retrying costs money. Nothing more will be fixed `
        + `automatically until a person looks.`
    });
    return done;
  }

  let budget = MAX_FIXES_PER_HOUR - recent;
  for (const f of fixable) {
    if (budget <= 0) break;
    const already = await db.countActionsForOrder(f.orderId, f.fix);
    if (already >= MAX_AUTO_PER_ORDER) continue;   // tried enough; a person now

    try {
      if (f.fix === 'rekick' && rekickOrder) await rekickOrder(f.orderId);
      else if (f.fix === 'resend' && resendReadyEmail) await resendReadyEmail(f.orderId);
      else continue;
      await db.recordAction(f.orderId, f.fix, f.subject);
      done.push({ orderId: f.orderId, action: f.fix });
      budget--;
      console.log(`Watchdog: ${f.fix} on order ${f.orderId} (attempt ${already + 1} of ${MAX_AUTO_PER_ORDER}).`);
    } catch (err) {
      console.error(`Watchdog: ${f.fix} on order ${f.orderId} failed - ${err.message}`);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Part 3 - telling him, without becoming noise.
//
// The rule that decides whether this gets muted: alert on the transition, then
// be quiet until it clears or gets worse. A condition that lasts all day is one
// email at the start and one at the end.
// ---------------------------------------------------------------------------

function shouldTell(stored, finding) {
  if (!stored || !stored.toldAt) return true;                       // new
  if (LEVEL_RANK[finding.level] > LEVEL_RANK[stored.toldLevel]) return true;  // worse
  return false;                                                     // same, stay quiet
}

async function notify(findings, ctx) {
  const { db, send } = ctx;
  const stored = await db.getAlerts();
  const byKey = new Map(stored.map((a) => [a.key, a]));
  const seen = new Set();
  const toTell = [];

  for (const f of findings) {
    seen.add(f.key);
    const was = byKey.get(f.key);
    const tell = shouldTell(was, f);
    if (tell) toTell.push(f);
    await db.saveAlert({
      key: f.key, level: f.level, detail: f.detail,
      firstSeen: was ? was.firstSeen : null,
      toldLevel: tell ? f.level : (was && was.toldLevel) || null,
      toldAt: tell ? new Date() : (was && was.toldAt) || null
    });
  }

  // Anything that was a problem and is not any more.
  const cleared = stored.filter((a) => !seen.has(a.key) && a.toldAt);
  for (const a of stored) if (!seen.has(a.key)) await db.clearAlert(a.key);

  const critical = toTell.filter((f) => f.level === 'CRITICAL');
  const warnings = toTell.filter((f) => f.level === 'WARNING');

  // CRITICAL goes now, one email each, so the subject line alone is the message.
  for (const f of critical) {
    await send({ level: 'CRITICAL', subject: f.subject, lines: [f.detail] });
  }
  // WARNINGs travel together - none of them is worth its own buzz.
  if (warnings.length) {
    await send({
      level: 'WARNING',
      subject: warnings.length === 1 ? warnings[0].subject : `${warnings.length} things worth a look`,
      lines: warnings.map((f) => `${f.subject}\n    ${f.detail}`)
    });
  }
  // And say when it is over, or the last thing he heard is bad news.
  if (cleared.length) {
    await send({
      level: 'CLEAR',
      subject: cleared.length === 1
        ? `Cleared: ${cleared[0].key}`
        : `${cleared.length} alerts cleared`,
      lines: cleared.map((a) => `${a.key} - was ${a.level}, now fine.`)
    });
  }

  return { told: toTell, cleared };
}

async function runWatchdog(ctx) {
  const findings = await gather(ctx);
  const healed = await selfHeal(findings, ctx);
  const sent = await notify(findings, ctx);
  return { findings, healed, ...sent };
}

// The once-a-day picture, which is about the business rather than the machine.
async function dailyDigest(ctx) {
  const { db, send } = ctx;
  const day = await db.dayTotals(1);
  const fixes = await db.recentActions(60 * 24);
  const open = await db.getAlerts();
  const spend = (day.pages * 0.054).toFixed(2);
  const lines = [
    `Orders paid:     ${day.orders}`,
    `Revenue:         $${(day.revenueCents / 100).toFixed(2)}`,
    `Pages drawn:     ${day.pages}  (about $${spend} of OpenAI)`,
    `Fixed on its own: ${fixes.length}`
  ];
  for (const f of fixes) lines.push(`    order ${f.orderId}: ${f.action} - ${f.reason}`);
  lines.push(`Still open:      ${open.length}`);
  for (const a of open) lines.push(`    [${a.level}] ${a.key}`);
  await send({ level: 'DAILY', subject: `${day.orders} orders, $${(day.revenueCents / 100).toFixed(2)}`, lines });
  return { day, fixes: fixes.length, open: open.length };
}

function resetSamples() { memorySamples = []; queueFullRuns = 0; }

module.exports = {
  runWatchdog, dailyDigest, gather, selfHeal, notify, resetSamples,
  STUCK_MINUTES, MAX_FIXES_PER_HOUR, MAX_AUTO_PER_ORDER, MEMORY_SAMPLES, QUEUE_FULL_RUNS
};
