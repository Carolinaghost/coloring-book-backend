#!/usr/bin/env node
'use strict';

// What the admin page is told about each creator's sales.
//
//   npm test
//
// Signing somebody up and somebody selling for you are two different things,
// and the creator list could not tell them apart: four names, four codes, and
// no way to see that none of them had sold anything. This is the number that
// closed that gap, so what it guards is that the number means what it says.
//
// Three ways it could lie, all of them quietly:
//
//   A sale counted for the wrong person.  Two creators, two codes, and the
//   totals have to land on the right names - a swap here pays the wrong
//   person and nothing about the page looks wrong.
//
//   An abandoned checkout counted as a sale.  The code rides on the session
//   the moment it opens, long before anybody pays. Counting those would show
//   a creator revenue that never arrived in the bank.
//
//   A short total presented as the whole truth.  Stripe pages its answers. If
//   the walk stops early the totals are simply too low, so it has to say so
//   rather than hand back a smaller number with the same confidence.

process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.SITE_URL = 'https://crayonauts.com';
process.env.CREATOR_SALES_CACHE_MS = '0';   // recompute on every request
delete process.env.ADMIN_KEY;               // the key itself is tested elsewhere
delete process.env.DATABASE_URL;            // in-memory store

const db = require('../db.js');
const { app } = require('../server.js');

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

const realFetch = global.fetch;

// Stripe, as far as this file is concerned: a fixed set of promotion codes and
// a fixed set of checkout sessions, paged the way the real API pages them.
function stubStripe({ codes, sessions, pageSize = 100, fail = false }) {
  global.fetch = async (url) => {
    if (fail) throw new Error('Stripe is having a moment');
    const href = typeof url === 'string' ? url : url.href || String(url);
    const parsed = new URL(href);
    const after = parsed.searchParams.get('starting_after');
    const source = href.includes('/promotion_codes') ? codes : sessions;
    const start = after ? source.findIndex((x) => x.id === after) + 1 : 0;
    const page = source.slice(start, start + pageSize);
    return {
      ok: true,
      json: async () => ({ data: page, has_more: start + pageSize < source.length })
    };
  };
}

function paidSession(id, promoId, cents) {
  return {
    id, payment_status: 'paid', amount_total: cents,
    discounts: [{ promotion_code: promoId }]
  };
}

async function getCreators(port) {
  const resp = await realFetch(`http://127.0.0.1:${port}/creators`);
  return { status: resp.status, body: await resp.json() };
}

(async () => {
  console.log('Creator sales');

  // Two creators so a mix-up between them has somewhere to show.
  await db.saveCreator({
    code: 'HONEYDIP', name: 'Cheryl R Gray', email: 'cheryl@example.com',
    platform: 'Instagram', handle: '@sugarpants2021', followers: '2051',
    ratePercent: 20, promoId: 'promo_honeydip', freeCode: 'FREE-AAA',
    freePromoId: 'promo_free_honeydip'
  });
  await db.saveCreator({
    code: 'QUAPACE', name: 'Qua pace', email: 'qua@example.com',
    platform: 'Instagram', handle: '@quapace', followers: '148',
    ratePercent: 20, promoId: 'promo_quapace', freeCode: 'FREE-BBB',
    freePromoId: 'promo_free_quapace'
  });

  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();

    stubStripe({
      codes: [
        { id: 'promo_honeydip', times_redeemed: 2 },
        { id: 'promo_quapace', times_redeemed: 0 },
        { id: 'promo_free_honeydip', times_redeemed: 1 },
        { id: 'promo_free_quapace', times_redeemed: 0 }
      ],
      sessions: [
        paidSession('cs_1', 'promo_honeydip', 1500),
        paidSession('cs_2', 'promo_honeydip', 2500),
        // Opened, carried the code, never paid for.
        { id: 'cs_3', payment_status: 'unpaid', amount_total: 1500,
          discounts: [{ promotion_code: 'promo_quapace' }] }
      ]
    });

    const listed = await getCreators(port);
    check('the list loads', listed.status, 200);
    const cheryl = listed.body.creators.find((c) => c.code === 'HONEYDIP');
    const qua = listed.body.creators.find((c) => c.code === 'QUAPACE');

    check('a seller shows her sales', cheryl.sales, 2);
    check('and what they were worth', cheryl.revenueCents, 4000);
    check('and that she used her free book', cheryl.freeBookUsed, true);

    // The one that matters most: nothing of Cheryl's lands on Qua.
    check('a creator with no sales shows none', qua.sales, 0);
    check('and no revenue', qua.revenueCents, 0);
    check('and no free book used', qua.freeBookUsed, false);
    check('an abandoned checkout is not a sale', qua.revenueCents, 0);
    check('the totals are whole', listed.body.salesComplete, true);

    // Stripe pages its answers. Walk past the cap and the totals are short,
    // which is only safe if the page is told.
    stubStripe({
      codes: [{ id: 'promo_honeydip', times_redeemed: 2 }],
      sessions: Array.from({ length: 1200 }, (_, i) =>
        paidSession('cs_p' + i, 'promo_honeydip', 100)),
      pageSize: 100
    });
    const capped = await getCreators(port);
    check('a truncated walk admits it', capped.body.salesComplete, false);

    // Stripe being unreachable must not turn a page of names into an error.
    stubStripe({ codes: [], sessions: [], fail: true });
    const broken = await getCreators(port);
    check('the names still load when Stripe is down', broken.status, 200);
    check('and there are still two of them', broken.body.creators.length, 2);
    check('with sales left blank rather than zeroed', broken.body.creators[0].sales, null);
    check('and the page told it cannot vouch for them', broken.body.salesComplete, null);
  } finally {
    global.fetch = realFetch;
    server.close();
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
})();
