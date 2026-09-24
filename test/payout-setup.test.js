#!/usr/bin/env node
'use strict';

// The payout setup invite, with Stripe stubbed out.
//
//   npm test
//
// Three things are guarded here, and all three fail quietly if they break.
//
// The setup link is a credential. Whoever holds it can start a creator's bank
// and tax setup as them, so an unknown token, a blank one, and a creator with
// no Connect account must all get the same flat refusal - and the token must
// never turn up in a log line, an error page or the admin list.
//
// "Ready to be paid" is recorded once. Stripe sends account.updated for every
// change to an account and retries whatever it thinks we missed, so the same
// event arriving twice is normal and must not move the date.
//
// The backfill script does nothing unless told --send. It creates real Stripe
// accounts and emails real people, and it must never invite somebody twice.

const crypto = require('crypto');

process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
process.env.SITE_URL = 'https://crayonauts.com';
delete process.env.PAYOUT_SETUP_BASE_URL;
delete process.env.DATABASE_URL;   // exercise the in-memory store

const db = require('../db.js');
const { app } = require('../server.js');
const mailer = require('../mailer.js');
const backfill = require('../scripts/send-payout-setup.js');

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

// Stripe, answering only the two calls this feature makes.
const realFetch = global.fetch;
const accountCreates = [];
const linkCreates = [];
let refuseLinks = false;
async function fakeStripe(url, opts) {
  const href = typeof url === 'string' ? url : url.href || String(url);
  if (href === 'https://api.stripe.com/v1/accounts') {
    const form = new URLSearchParams(opts.body.toString());
    accountCreates.push(Object.fromEntries(form));
    return { ok: true, json: async () => ({ id: 'acct_test' + accountCreates.length }) };
  }
  if (href === 'https://api.stripe.com/v1/account_links') {
    const form = new URLSearchParams(opts.body.toString());
    linkCreates.push(Object.fromEntries(form));
    if (refuseLinks) {
      // Stripe's messages are free to quote the request back, which is why
      // the route must report the code and never this text.
      return { ok: false, json: async () => ({ error: {
        code: 'url_invalid', type: 'invalid_request_error',
        message: 'Not a valid URL: ' + form.get('refresh_url') } }) };
    }
    return { ok: true, json: async () => ({ url: 'https://connect.stripe.com/setup/e/acct/abc' + linkCreates.length }) };
  }
  return realFetch(url, opts);
}

const sent = [];
mailer.sendMail = async (m) => { sent.push(m); return true; };
Object.defineProperty(mailer, 'configured', { get: () => true });

// Everything the server says, so the token can be looked for in it.
const logged = [];
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}

function stripeSignature(raw) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(t + '.' + raw, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

async function webhook(port, event) {
  const raw = JSON.stringify(event);
  const resp = await realFetch(`http://127.0.0.1:${port}/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': stripeSignature(raw) },
    body: raw
  });
  return resp.status;
}

async function openLink(port, token) {
  const resp = await realFetch(`http://127.0.0.1:${port}/creators/payout-setup/${token}`, { redirect: 'manual' });
  return { status: resp.status, location: resp.headers.get('location'), body: await resp.text() };
}

let n = 0;
function creator(extra = {}) {
  n++;
  return db.saveCreator({
    code: 'CREATOR' + n, name: 'Creator Number' + n, email: `c${n}@example.com`,
    handle: '@c' + n, ratePercent: 20, promoId: 'promo_' + n, ...extra
  });
}

async function main() {
  global.fetch = fakeStripe;
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();

    console.log('\nLooking a creator up by their setup link');
    const plain = await creator();         // never set up: payout_link_token is ''
    const ready = await creator();
    const token = crypto.randomBytes(24).toString('hex');
    await db.setCreatorStripeAccount(ready.id, 'acct_ready', token);

    const found = await db.getCreatorByPayoutToken(token);
    check('the right creator comes back', found && found.code, ready.code);
    check('with their Connect account', found && found.stripeAccountId, 'acct_ready');
    check('an unknown token finds nobody',
      await db.getCreatorByPayoutToken(crypto.randomBytes(24).toString('hex')), null);
    // The column defaults to ''. If '' were looked up, it would match whoever
    // has not been set up yet - and hand their page to anybody.
    check('a blank token finds nobody, even with blank rows in the table',
      await db.getCreatorByPayoutToken(''), null);
    check('and so does nothing at all', await db.getCreatorByPayoutToken(undefined), null);
    check('the admin list never carries the token',
      (await db.listCreators()).some((c) => 'payoutLinkToken' in c || JSON.stringify(c).includes(token)), false);
    check('but does say where each creator is',
      (await db.listCreators()).find((c) => c.id === ready.id).stripeAccountId, 'acct_ready');
    void plain;

    console.log('\nOpening the link');
    const opened = await openLink(port, token);
    check('sends them on to Stripe', opened.status, 302);
    check('at the onboarding link Stripe just made', opened.location, 'https://connect.stripe.com/setup/e/acct/abc1');
    check('for their account', linkCreates[0].account, 'acct_ready');
    check('as onboarding', linkCreates[0].type, 'account_onboarding');
    // Stripe's links expire in minutes. When one has, Stripe sends them back
    // to refresh_url, which has to be this same page so a new one is made.
    check('coming back here when Stripe\'s link runs out',
      linkCreates[0].refresh_url, `https://crayonauts.com/creators/payout-setup/${token}`);
    check('and to the creators page when they finish',
      linkCreates[0].return_url, 'https://crayonauts.com/creators.html?payout=done');

    const again = await openLink(port, token);
    check('it works a second time, with a fresh Stripe link',
      [again.status, again.location], [302, 'https://connect.stripe.com/setup/e/acct/abc2']);

    const unknown = await openLink(port, crypto.randomBytes(24).toString('hex'));
    check('an unknown token is refused', unknown.status, 404);
    check('in plain words, pointing at accounts@', /accounts@crayonauts\.com/.test(unknown.body), true);
    const junk = await openLink(port, 'not-a-token');
    check('junk is refused the same way', [junk.status, junk.body], [unknown.status, unknown.body]);

    const noAccount = await creator();
    const orphanToken = crypto.randomBytes(24).toString('hex');
    await db.setCreatorStripeAccount(noAccount.id, '', orphanToken);
    const orphan = await openLink(port, orphanToken);
    check('a creator with no Connect account is refused, not crashed', orphan.status, 404);
    check('and Stripe was never asked about them', linkCreates.length, 2);

    refuseLinks = true;
    const broken = await openLink(port, token);
    refuseLinks = false;
    check('Stripe saying no is an error page, not a crash', broken.status, 502);
    check('which does not show the token', broken.body.includes(token), false);
    check('and nothing the server logged shows it either',
      logged.some((line) => line.includes(token)), false);

    console.log('\nStripe saying a creator can be paid');
    const updated = (payoutsEnabled) => ({
      id: 'evt_' + Math.random().toString(36).slice(2), type: 'account.updated',
      data: { object: { id: 'acct_ready', object: 'account', payouts_enabled: payoutsEnabled } }
    });
    check('an account still in progress is accepted', await webhook(port, updated(false)), 200);
    const readyAt = async () => (await db.listCreators()).find((c) => c.id === ready.id).payoutReadyAt;
    check('and marks nothing', await readyAt(), null);

    check('the "payouts enabled" event is accepted', await webhook(port, updated(true)), 200);
    const first = await readyAt();
    check('and marks them ready', first instanceof Date, true);
    await new Promise((r) => setTimeout(r, 15));
    check('the same news again is accepted', await webhook(port, updated(true)), 200);
    check('and does not move the date', (await readyAt()).getTime(), first.getTime());
    check('an account we do not know is accepted and ignored',
      await webhook(port, { id: 'evt_x', type: 'account.updated',
        data: { object: { id: 'acct_nobody', payouts_enabled: true } } }), 200);

    console.log('\nThe backfill, run with no flags');
    // A fresh set of creators in each of the three states.
    const needsAccount = await creator();
    const needsEmail = await creator();
    await db.setCreatorStripeAccount(needsEmail.id, 'acct_existing', crypto.randomBytes(24).toString('hex'));
    const alreadySent = await creator();
    await db.setCreatorStripeAccount(alreadySent.id, 'acct_done', crypto.randomBytes(24).toString('hex'));
    await db.markPayoutLinkSent(alreadySent.id);
    await db.markPayoutLinkSent(ready.id);   // the earlier creators are not this test's business
    const others = [plain.id, noAccount.id];

    const accountsBefore = accountCreates.length;
    const out = [];
    const dry = await backfill.main({ argv: [], db, mailer, fetch: fakeStripe, print: (l) => out.push(l) });
    check('creates no Stripe account', accountCreates.length, accountsBefore);
    check('sends no email', sent.length, 0);
    check('changes nothing in the database',
      (await db.listCreators()).find((c) => c.id === needsAccount.id).stripeAccountId, '');
    check('and says it is a dry run', out.some((l) => /DRY RUN/.test(l)), true);
    check('naming who would get an account',
      out.some((l) => l.includes(needsAccount.code) && /would create Connect account/.test(l)), true);
    check('and who would only get the email',
      out.some((l) => l.includes(needsEmail.code) && /would send setup email/.test(l)), true);
    check('and who is left alone',
      out.some((l) => l.includes(alreadySent.code) && /already sent/.test(l)), true);
    check('counted', [dry.account, dry.email, dry.skip], [1 + others.length, 1, 2]);

    let conflicted = null;
    try { await backfill.main({ argv: ['--send', '--dry-run'], db, mailer, fetch: fakeStripe, print: () => {} }); }
    catch (err) { conflicted = err.message; }
    check('--send with --dry-run is refused rather than guessed at', /Pick one/.test(conflicted || ''), true);
    check('and did nothing', [accountCreates.length, sent.length], [accountsBefore, 0]);

    console.log('\nThe backfill, run with --send');
    const live = await backfill.main({ argv: ['--send'], db, mailer, fetch: fakeStripe, print: () => {} });
    const after = await db.listCreators();
    const byId = (id) => after.find((c) => c.id === id);
    check('makes an account for whoever had none', Boolean(byId(needsAccount.id).stripeAccountId), true);
    const made = accountCreates.find((a) => a['metadata[creator_id]'] === String(needsAccount.id)) || {};
    check('as an Express account', made.type, 'express');
    check('that can only receive transfers',
      [made['capabilities[transfers][requested]'], 'capabilities[card_payments][requested]' in made], ['true', false]);
    check('for an individual in the US', [made.business_type, made.country], ['individual', 'US']);
    check('tagged with who it belongs to', [made.email, made['metadata[creator_code]']],
      [needsAccount.email, needsAccount.code]);
    check('keeps the account somebody already had', byId(needsEmail.id).stripeAccountId, 'acct_existing');
    check('sends the invite to both', sent.map((m) => m.to).filter((to) =>
      to === needsAccount.email || to === needsEmail.email).length, 2);
    check('and none to the creator already invited', sent.some((m) => m.to === alreadySent.email), false);
    check('records each invite as sent',
      [byId(needsAccount.id).payoutLinkSentAt instanceof Date, byId(needsEmail.id).payoutLinkSentAt instanceof Date],
      [true, true]);
    check('counted', [live.account, live.email, live.skip, live.failed], [1 + others.length, 1, 2, 0]);

    // The link in the email is the one the route accepts.
    const mailed = sent.find((m) => m.to === needsEmail.email);
    const mailedToken = (mailed.text.match(/payout-setup\/([0-9a-f]{48})/) || [])[1];
    check('the emailed link opens their setup',
      (await db.getCreatorByPayoutToken(mailedToken) || {}).id, needsEmail.id);
    check('the invite says Stripe hosts it', /hosted by Stripe/.test(mailed.text), true);
    check('and not to forward it', /do not forward it/.test(mailed.text), true);
    check('and it is signed off like the welcome', /\n- Crayonauts$/.test(mailed.text), true);

    const sentSoFar = sent.length;
    const accountsSoFar = accountCreates.length;
    const rerun = await backfill.main({ argv: ['--send'], db, mailer, fetch: fakeStripe, print: () => {} });
    check('run again, it invites nobody twice', sent.length, sentSoFar);
    check('and makes no second account', accountCreates.length, accountsSoFar);
    check('because everybody is now skipped', rerun.skip, after.length);
  } finally {
    server.close();
    global.fetch = realFetch;
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
