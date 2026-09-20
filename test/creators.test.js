#!/usr/bin/env node
'use strict';

// The creator sign-up form, end to end, with Stripe stubbed out.
//
//   npm test
//
// What this file is really guarding is money and identity, in that order.
//
// A creator's code decides who gets paid for a sale. Hand the same person two
// codes and their own sales are split across both, and the Thursday report
// pays them for one of the halves. Hand two people the same code and there is
// no way afterwards to say whose sale it was. Both are unrecoverable once
// somebody has posted the code to an audience, so both are checked here.
//
// The other thing checked is that a creator code never becomes a discount.
// The coupon behind it is 0.01% off - the smallest number Stripe accepts,
// because a promotion code must hang off SOME coupon and Stripe has no
// zero-discount one. If that ever gets pointed at the 20% or 100% coupon by
// mistake, every creator link starts giving books away and the first anyone
// knows is the bank balance.

process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.SITE_URL = 'https://crayonauts.com';
delete process.env.DATABASE_URL;   // exercise the in-memory store

const db = require('../db.js');
const { app, cleanCreatorCode, reservedCreatorCode, looksLikeEmail } = require('../server.js');
const mailer = require('../mailer.js');

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

// Every promotion code Stripe was asked to create, so the test can say what
// coupon each one hung off rather than only that one was made.
const stripeCreates = [];
const stripeCodes = new Set();
const realFetch = global.fetch;

function stubStripe() {
  global.fetch = async (url, opts) => {
    const href = typeof url === 'string' ? url : url.href || String(url);
    if (href.startsWith('https://api.stripe.com/v1/promotion_codes')) {
      if (!opts || (opts.method || 'GET') === 'GET') {
        // The lookup resolvePromotionCode does. Answer from what we created,
        // so "is this code free" is really asking Stripe, as it does live.
        const wanted = new URL(href).searchParams.get('code');
        return {
          ok: true,
          json: async () => ({
            data: stripeCodes.has(wanted) ? [{ id: 'promo_' + wanted, active: true }] : []
          })
        };
      }
      const form = new URLSearchParams(opts.body.toString());
      const code = form.get('code');
      if (stripeCodes.has(code)) {
        return { ok: false, json: async () => ({ error: { message: 'code already exists' } }) };
      }
      stripeCodes.add(code);
      stripeCreates.push({
        code,
        // Read the way Stripe's current API actually spells it. The first cut
        // of this sent a flat `coupon=creatortrack`, which a stub happily
        // accepted and live Stripe rejected outright with "Received unknown
        // parameter: coupon" - a message that reads like a permissions problem
        // and is not one. A stub that accepts a shape the real API refuses is
        // worse than no stub, so this reads only the nested spelling, and the
        // flat one is asserted absent below.
        promotionType: form.get('promotion[type]'),
        coupon: form.get('promotion[coupon]'),
        flatCoupon: form.get('coupon'),
        rate: form.get('metadata[rate_percent]'),
        email: form.get('metadata[creator_email]')
      });
      return { ok: true, json: async () => ({ id: 'promo_' + code }) };
    }
    return realFetch(url, opts);
  };
}

// The welcome mail, captured rather than sent.
const sent = [];
mailer.sendMail = async (m) => { sent.push(m); return true; };
Object.defineProperty(mailer, 'configured', { get: () => true });

function signUp(port, body) {
  return fetchJson(`http://127.0.0.1:${port}/creators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function fetchJson(url, opts) {
  const resp = await realFetch(url, opts);
  let body = null;
  try { body = await resp.json(); } catch (err) { body = null; }
  return { status: resp.status, body };
}

// The endpoint answers before it sends the mail, on purpose, so a test that
// looks at `sent` immediately after the reply sometimes looks too early.
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

async function main() {
  console.log('\nTurning a name into a code');

  check('a plain name becomes a plain code', cleanCreatorCode('Jerrell Crump'), 'JERRELLCRUMP');
  check('accents are stripped, not rejected', cleanCreatorCode('José Peña'), 'JOSEPENA');
  check('punctuation and emoji go', cleanCreatorCode("O'Brien-Smith!! 🎨"), 'OBRIENSMITH');
  check('digits are kept', cleanCreatorCode('mom_of_3'), 'MOMOF3');
  check('nothing usable comes back empty', cleanCreatorCode('🎨🎨🎨'), '');
  check('and it never runs past what Stripe will show', cleanCreatorCode('A'.repeat(90)).length, 20);

  console.log('\nCodes a creator may not have');
  // These prefixes already mean something at checkout. A creator called
  // Freeman must not end up with a code that starts a free-book code.
  check('FREE is taken', reservedCreatorCode('FREEMAN'), true);
  check('OWNER is taken', reservedCreatorCode('OWNERSHIP'), true);
  check('TEST is taken', reservedCreatorCode('TESTER'), true);
  check('an ordinary name is not', reservedCreatorCode('JERRELL'), false);

  console.log('\nEmails that would never receive the code');
  check('no at sign', looksLikeEmail('jerrell.com'), false);
  check('no dot after the at', looksLikeEmail('jerrell@localhost'), false);
  check('a space in it', looksLikeEmail('jer rell@mail.com'), false);
  check('empty', looksLikeEmail(''), false);
  check('an ordinary address', looksLikeEmail('jerrell@gmail.com'), true);
  check('a plus address', looksLikeEmail('jerrell+crayons@gmail.com'), true);

  console.log('\nA real sign-up');
  stubStripe();
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();

    const first = await signUp(port, {
      name: 'Jerrell Crump', email: 'Jerrell@Example.com',
      platform: 'TikTok', handle: '@jerrell', followers: '40k'
    });
    check('the form is accepted', first.status, 200);
    check('and gives back a code', first.body.code, 'JERRELLCRUMP');
    check('and a link that carries it', first.body.link, 'https://crayonauts.com?c=jerrellcrump');
    check('at the standard rate', first.body.ratePercent, 25);
    check('and does not claim they were already signed up', first.body.alreadySignedUp, false);

    check('exactly one code was created in Stripe', stripeCreates.length, 1);
    // The whole point: a creator code tracks, it does not discount.
    check('against the tracking coupon, not a discount one', stripeCreates[0].coupon, 'creatortrack');
    check('sent the way the current API spells it', stripeCreates[0].promotionType, 'coupon');
    check('and not the flat spelling Stripe now rejects', stripeCreates[0].flatCoupon, null);
    check('with the rate recorded on the code itself', stripeCreates[0].rate, '25');
    check('and the creator reachable from Stripe alone', stripeCreates[0].email, 'jerrell@example.com');

    await settle();
    check('the welcome email went', sent.length, 1);
    check('to the address they gave', sent[0].to, 'jerrell@example.com');
    check('with the code in it', sent[0].text.includes('JERRELLCRUMP'), true);
    check('and the link in it', sent[0].text.includes('?c=jerrellcrump'), true);
    // Bank details by email is the thing this whole design avoids. If that
    // sentence ever disappears, somebody will send a routing number back.
    check('and it tells them not to email bank details',
      /do not send\s*\n?\s*either of those by email/.test(sent[0].text), true);

    console.log('\nThe same person, twice');
    const again = await signUp(port, {
      name: 'Jerrell Crump', email: 'JERRELL@example.com',
      platform: 'TikTok', handle: '@jerrell', followers: '40k'
    });
    check('is not turned away', again.status, 200);
    check('and gets the code they already have', again.body.code, 'JERRELLCRUMP');
    check('and is told so', again.body.alreadySignedUp, true);
    check('no second code was created', stripeCreates.length, 1);
    await settle();
    check('and no second welcome email', sent.length, 1);

    console.log('\nTwo different people who share a name');
    const clash = await signUp(port, {
      name: 'Jerrell Crump', email: 'other.jerrell@example.com',
      platform: 'Instagram', handle: '@jc2', followers: '2k'
    });
    check('the second one still gets in', clash.status, 200);
    check('with a code of their own', clash.body.code === 'JERRELLCRUMP', false);
    check('that starts from their name', clash.body.code.startsWith('JERRELLCRUMP'), true);
    check('and is a second code in Stripe', stripeCreates.length, 2);

    console.log('\nForms that should bounce');
    const noName = await signUp(port, { name: 'J', email: 'a@b.com', handle: '@x' });
    check('a one-letter name', noName.status, 400);
    const badEmail = await signUp(port, { name: 'Someone Real', email: 'nope', handle: '@x' });
    check('an email that cannot receive anything', badEmail.status, 400);
    const noHandle = await signUp(port, { name: 'Someone Real', email: 'c@d.com', handle: '' });
    check('no idea where they post', noHandle.status, 400);
    check('none of them touched Stripe', stripeCreates.length, 2);

    console.log('\nSomebody hammering the form');
    // Three a day per visitor. Two of those are already spent above by the
    // two sign-ups that reached Stripe; the refusals never counted.
    const third = await signUp(port, { name: 'Third Person', email: 't3@example.com', handle: '@t3' });
    check('the third is fine', third.status, 200);
    const fourth = await signUp(port, { name: 'Fourth Person', email: 't4@example.com', handle: '@t4' });
    check('the fourth is refused', fourth.status, 429);
    check('and no code was made for them', stripeCreates.length, 3);
    check('and they are told where to go instead',
      /support@crayonauts\.com/.test(fourth.body.error), true);

    console.log('\nWhat Jonathan can see');
    const listed = await db.listCreators();
    check('every creator who got a code is listed', listed.length, 3);
    check('and the list records whether the welcome went',
      listed.every((c) => 'welcomedAt' in c), true);
  } finally {
    server.close();
    global.fetch = realFetch;
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
