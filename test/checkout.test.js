#!/usr/bin/env node
'use strict';

// Tests for what /checkout sends Stripe (server.js).
//
//   npm test
//
// Three things, all of which fail silently.
//
// The promotion code box. Influencer codes are created in the Stripe dashboard
// and the code someone types is the attribution, so if allow_promotion_codes
// goes missing there is no code box, no discount, and no way to tell whose
// audience bought - and nothing fails loudly enough to notice. It is one line
// in a long form body, easy to lose in a merge.
//
// The card statement descriptor. This account is managed under Bluevine and
// has no descriptor field in its dashboard, so the session is the only place
// it can be set, and a charge nobody recognises is a chargeback.
//
// The creator link. A creator posts crayonauts.com/?c=THEIRCODE, and the code
// rides through to the session as discounts[] so the customer never has to
// type it. If that link stops attaching the code, every sale it makes still
// goes through at full price and lands in the report as "nobody is owed" - the
// creator is simply not paid, and nothing anywhere says so.
//
// All three have to survive the fallbacks. /checkout tries the best session first
// and drops one refusable thing per rung - consent, then the descriptor - so a
// Stripe account that refuses either still takes the money. Anything appended
// to only one rung disappears on the others, which is why each rung is checked
// here rather than just the first.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';

const http = require('http');
const { app, STATEMENT_DESCRIPTOR_SUFFIX } = require('../server.js');

const DESCRIPTOR = 'payment_intent_data[statement_descriptor_suffix]';
const CONSENT = 'consent_collection[terms_of_service]';

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

function request(server, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Stand in for Stripe and keep every body it is sent. `refuse` decides what
// this pretend account will not accept, so each real-world case can be played
// out: an account with no terms URL, a managed account that rejects
// descriptors, and one that does both.
function captureStripe(sent, refuse, promos, lookups) {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    // The promotion code lookup is a GET to a different endpoint, and it is
    // kept out of `sent` on purpose: `sent` means session attempts, and the
    // counts asserted below are about the fallback ladder, not about this.
    if (String(url).includes('/v1/promotion_codes')) {
      const asked = new URL(String(url)).searchParams.get('code');
      if (lookups) lookups.push(asked);
      const hit = (promos || {})[asked];
      return { ok: true, json: async () => ({ data: hit ? [hit] : [] }) };
    }
    if (String(url).includes('api.stripe.com')) {
      const body = opts.body instanceof URLSearchParams ? opts.body.toString() : String(opts.body);
      const params = new URLSearchParams(body);
      sent.push(params);
      const reason = refuse ? refuse(params) : null;
      if (reason) return { ok: false, json: async () => ({ error: { message: reason } }) };
      return { ok: true, json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.test/c/pay/cs_test_123' }) };
    }
    return realFetch(url, opts);
  };
  return () => { global.fetch = realFetch; };
}

const refusesConsent = (p) => p.get(CONSENT) ? 'no terms of service url set (pretend)' : null;
const refusesDescriptor = (p) => p.get(DESCRIPTOR) ? 'no statement descriptor prefix set (pretend)' : null;
const refusesBoth = (p) => refusesConsent(p) || refusesDescriptor(p);

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  // Every checkout in this file: place an order, pay for it, and hand back
  // every body Stripe was sent, in the order the ladder tried them.
  async function checkout(refuse, orderFields, extra) {
    const sent = [];
    const lookups = [];
    const { code, promos } = extra || {};
    const restore = captureStripe(sent, refuse, promos, lookups);
    try {
      const made = JSON.parse((await request(server, '/orders', {
        method: 'POST',
        body: JSON.stringify(Object.assign(
          { childName: 'Ava', email: 'a@b.test', theme: 'Portrait', pageCount: 15 },
          orderFields || {}))
      })).body);
      const res = await request(server, '/checkout', {
        method: 'POST',
        body: JSON.stringify({ orderId: made.order.id, token: made.accessToken, product: 'digital', code })
      });
      return { res, sent, lookups, order: made.order, taken: sent[sent.length - 1] };
    } finally {
      restore();
    }
  }

  try {
    console.log('\nAn account that accepts everything');

    const happy = await checkout(null);
    check('checkout answers', happy.res.status, 200);
    // One sale, one request. The ladder must not cost a round trip per rung
    // when nothing is wrong.
    check('Stripe is asked once', happy.sent.length, 1);
    check('the card descriptor is set', happy.taken.get(DESCRIPTOR), STATEMENT_DESCRIPTOR_SUFFIX);
    check('consent is collected', happy.taken.get(CONSENT), 'required');
    check('the promotion code box is offered', happy.taken.get('allow_promotion_codes'), 'true');
    check('the order is referenced', happy.taken.get('client_reference_id'), String(happy.order.id));
    check('and it is charged', happy.taken.get('line_items[0][price_data][unit_amount]'), '1500');
    // Stripe refuses a session that sets both, and the failure would only show
    // up when somebody tried to pay.
    check('no discounts[] alongside the code box',
      [...happy.taken.keys()].filter((k) => k.startsWith('discounts')), []);

    console.log('\nAn account with no terms URL');

    // The old behaviour, still the likeliest: Stripe refuses the consent box.
    const noTerms = await checkout(refusesConsent);
    check('the sale still goes through', noTerms.res.status, 200);
    // Two, not three: Stripe said the consent box was the problem, so the rung
    // that still carried it was skipped rather than sent again.
    check('it took two tries, not three', noTerms.sent.length, 2);
    check('consent was dropped', noTerms.taken.get(CONSENT), null);
    // The reason this file exists: the descriptor must not fall with it.
    check('but the descriptor survived', noTerms.taken.get(DESCRIPTOR), STATEMENT_DESCRIPTOR_SUFFIX);
    check('and so did the code box', noTerms.taken.get('allow_promotion_codes'), 'true');

    console.log('\nA managed account that refuses descriptors');

    // What Bluevine may well do, since it sets the prefix and we cannot see it.
    const noDescriptor = await checkout(refusesDescriptor);
    check('the sale still goes through', noDescriptor.res.status, 200);
    check('the descriptor was dropped', noDescriptor.taken.get(DESCRIPTOR), null);
    // Consent outranks it - it is the evidence that settles a chargeback.
    check('consent was kept instead', noDescriptor.taken.get(CONSENT), 'required');
    check('and the code box', noDescriptor.taken.get('allow_promotion_codes'), 'true');
    check('two tries here too', noDescriptor.sent.length, 2);

    console.log('\nAn account that refuses both');

    const neither = await checkout(refusesBoth);
    check('the sale STILL goes through', neither.res.status, 200);
    check('with neither consent', neither.taken.get(CONSENT), null);
    check('nor a descriptor', neither.taken.get(DESCRIPTOR), null);
    // Whatever else is dropped, these three are what the customer is buying
    // and what pays the influencer. They ride every rung.
    check('the code box is still there', neither.taken.get('allow_promotion_codes'), 'true');
    check('the price is untouched', neither.taken.get('line_items[0][price_data][unit_amount]'), '1500');
    check('and the order is still referenced',
      neither.taken.get('client_reference_id'), String(neither.order.id));
    // Three: Stripe reports one objection at a time, so the descriptor cannot
    // be known bad until a session is sent without the consent box.
    check('no rung was sent twice over', neither.sent.length, 3);

    console.log('\nWhen Stripe is simply broken');

    // Nothing to do with consent or descriptors - the ladder must give up and
    // report, not answer 200 with no checkout URL.
    const broken = await checkout(() => 'Invalid API Key provided (pretend)');
    check('the customer is told', broken.res.status, 502);
    check('with the reason from Stripe', /Invalid API Key/.test(broken.res.body), true);
    // It walked the whole ladder rather than giving up on the first refusal.
    // An unreadable refusal must never be the thing that blocks a sale, so this
    // is deliberate waste on a path that is already broken.
    check('it tried everything before giving up', broken.sent.length, 4);

    console.log('\nA family book costs more');

    // The number here and the number the site shows come from the same place
    // (GET /options). If they ever disagree, a customer is quoted one price and
    // charged another.
    const family = await checkout(null, {
      childName: 'Leo',
      people: [
        { name: 'Leo', subjectType: 'kid', star: true, photo: 'data:image/png;base64,iVBORw0KGgo=' },
        { name: 'Mum', subjectType: 'adult', photo: 'data:image/png;base64,iVBORw0KGgo=' }
      ]
    });
    check('a family book is charged the family price',
      family.taken.get('line_items[0][price_data][unit_amount]'), '2500');
    check('and Stripe names it as one',
      /family/i.test(family.taken.get('line_items[0][price_data][product_data][name]') || ''), true);
    check('a family book still offers the code box', family.taken.get('allow_promotion_codes'), 'true');
    check('and carries the same descriptor', family.taken.get(DESCRIPTOR), STATEMENT_DESCRIPTOR_SUFFIX);

    const options = JSON.parse((await request(server, '/options')).body);
    check('the site is told the same family price', String(options.family.priceCents), '2500');
    check('and the same single price', String(options.priceCents), '1500');

    console.log('\nThe descriptor itself is one Stripe will take');

    // Stripe rejects the whole session on any of these, and the rejection would
    // only be discovered by a customer failing to check out.
    check('no characters Stripe forbids',
      /[<>\\'"*]/.test(STATEMENT_DESCRIPTOR_SUFFIX), false);
    check('not only digits', /[a-z]/i.test(STATEMENT_DESCRIPTOR_SUFFIX), true);
    check('not empty', STATEMENT_DESCRIPTOR_SUFFIX.trim().length > 0, true);
    // The account prefix is prepended to this and the pair must fit 22
    // characters. We cannot see the prefix, so leave it room.
    check('short enough to leave room for the account prefix',
      STATEMENT_DESCRIPTOR_SUFFIX.length <= 12, true);

    console.log('\nA customer arriving from a creator link');

    const LIVE = { JERRELL: { id: 'promo_live', active: true } };
    const DEAD = { OLDGUY: { id: 'promo_dead', active: false } };

    const viaLink = await checkout(null, null, { code: 'JERRELL', promos: LIVE });
    check('the sale goes through', viaLink.res.status, 200);
    check('the creator code is attached to the session',
      viaLink.taken.get('discounts[0][promotion_code]'), 'promo_live');
    // Both at once is the one thing Stripe refuses outright here, and it would
    // only show up when a customer tried to pay.
    check('and the typing box is not also asked for',
      viaLink.taken.get('allow_promotion_codes'), null);
    check('still one request to create the session', viaLink.sent.length, 1);

    // The code arrives from a URL somebody typed into an ad caption.
    const sloppy = await checkout(null, null, { code: ' jerrell ', promos: LIVE });
    check('a lower-case, space-padded code still finds the creator',
      sloppy.taken.get('discounts[0][promotion_code]'), 'promo_live');
    check('and Stripe was asked for the tidied code', sloppy.lookups, ['JERRELL']);

    // Everything below is a link that cannot pay anybody. None of them may cost
    // the sale - the customer gets the ordinary box and buys the book.
    for (const [label, bad] of [
      ['an unknown code', { code: 'NOSUCHCODE', promos: LIVE }],
      ['a deactivated code', { code: 'OLDGUY', promos: DEAD }],
      ['a junk code from a mangled link', { code: 'DROP TABLE;', promos: LIVE }]
    ]) {
      const r = await checkout(null, null, bad);
      check(`${label} still sells the book`, r.res.status, 200);
      check(`${label} falls back to the typing box`, r.taken.get('allow_promotion_codes'), 'true');
      check(`${label} attaches no discount`,
        [...r.taken.keys()].filter((k) => k.startsWith('discounts')), []);
    }

    // A link plus the awkward account: the code has to survive the ladder, not
    // just the first rung.
    const linkNoTerms = await checkout(refusesBoth, null, { code: 'JERRELL', promos: LIVE });
    check('a creator link survives an account that refuses everything',
      linkNoTerms.taken.get('discounts[0][promotion_code]'), 'promo_live');
    check('and that sale still goes through', linkNoTerms.res.status, 200);

    // No code at all must not start costing a round trip.
    check('a plain visit never asks Stripe about codes', happy.lookups, []);

  } finally {
    server.close();
  }

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
