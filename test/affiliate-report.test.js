#!/usr/bin/env node
'use strict';

// Tests for scripts/affiliate-report.js - who sold what, and what you owe them.
//
//   npm test
//
// This report decides what real people get paid, and every way it can be wrong
// looks like a clean run. Three of those ways have their own section below:
//
//   - the promotion code on a session is an ID, not the code somebody typed
//   - a code that is not in the promotion code list is money somebody earned
//     and would never see, and it used to look identical to a direct sale
//   - Stripe's default page is TEN, so a report that takes the first page and
//     stops loses everything after the tenth session and looks healthy doing it
//
// Nothing here touches Stripe. The fetch is a stub.

const { promoIdFromSession, attribute, tally, listAll, csvCell } = require('../scripts/affiliate-report.js');

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

function row(code) { return { code, coupon: '-', active: true, sales: 0, paid: 0, list: 0 }; }
function paid(extra) { return { payment_status: 'paid', amount_total: 1900, amount_subtotal: 2000, ...extra }; }
function withCode(id) { return { discounts: [{ promotion_code: id, coupon: 'co_1' }] }; }

async function main() {
  console.log('\nFinding the promotion code on a session');

  check('an unexpanded id is read as the id',
    promoIdFromSession({ discounts: [{ promotion_code: 'promo_1ABC', coupon: 'co_1' }] }), 'promo_1ABC');
  check('an expanded object gives the same id',
    promoIdFromSession({ discounts: [{ promotion_code: { id: 'promo_1ABC', code: 'OWEN10' } }] }), 'promo_1ABC');
  check('so both shapes attribute to the same influencer',
    promoIdFromSession({ discounts: [{ promotion_code: 'promo_1ABC' }] })
      === promoIdFromSession({ discounts: [{ promotion_code: { id: 'promo_1ABC', code: 'OWEN10' } }] }), true);

  check('a coupon with no code applied has no promotion code',
    promoIdFromSession({ discounts: [{ promotion_code: null, coupon: 'co_1' }] }), null);
  check('no discounts at all', promoIdFromSession({ discounts: [] }), null);
  check('a null discounts field', promoIdFromSession({ discounts: null }), null);
  check('a missing discounts field', promoIdFromSession({}), null);
  check('a null entry inside discounts does not throw',
    promoIdFromSession({ discounts: [null, { promotion_code: 'promo_2' }] }), 'promo_2');

  console.log('\nA code nobody recognises is not the same as no code');

  const byId = new Map([['promo_owen', row('OWEN10')]]);
  check('a known code attributes to its row', attribute(paid(withCode('promo_owen')), byId).kind, 'code');
  check('no code at all is a direct sale', attribute(paid({ discounts: [] }), byId).kind, 'none');
  // The silent underpayment. A deleted promotion code still appears on old
  // sessions, and counting it as a direct sale is money somebody earned and
  // will never be told about.
  check('a code missing from the list is flagged, not counted as direct',
    attribute(paid(withCode('promo_deleted')), byId).kind, 'unknown');
  check('and it says which id, so it can be looked up',
    attribute(paid(withCode('promo_deleted')), byId).promoId, 'promo_deleted');

  console.log('\nAdding it up');

  const codes = new Map([['promo_owen', row('OWEN10')], ['promo_anna', row('ANNA5')]]);
  const result = tally([
    paid(withCode('promo_owen')),
    paid({ ...withCode('promo_owen'), amount_total: 2900, amount_subtotal: 3000 }),
    paid({ discounts: [] }),
    paid(withCode('promo_gone')),
    // Completed but never actually paid.
    { payment_status: 'unpaid', amount_total: 9900, ...withCode('promo_owen') }
  ], codes);

  check('sales land on the right code', codes.get('promo_owen').sales, 2);
  check('what customers paid adds up', codes.get('promo_owen').paid, 4800);
  check('list price is tracked separately for PAY_ON', codes.get('promo_owen').list, 5000);
  check('an influencer with no sales keeps a zero row', codes.get('promo_anna').sales, 0);
  check('completed-but-unpaid is left out', codes.get('promo_owen').sales, 2);
  check('direct sales are counted apart', [result.unattributed, result.unattributedPaid], [1, 1900]);
  check('an unrecognised code is its own bucket', [...result.unknown.keys()], ['promo_gone']);
  check('and carries what it earned', result.unknown.get('promo_gone'), { sales: 1, paid: 1900 });

  console.log('\nPaging to the end, not to the first page');

  const all = Array.from({ length: 250 }, (_, i) => ({ id: `cs_${i}` }));
  const asked = [];
  const stub = async (url) => {
    const params = new URL(url).searchParams;
    asked.push([params.get('starting_after'), params.get('limit')]);
    const from = params.get('starting_after')
      ? all.findIndex((s) => s.id === params.get('starting_after')) + 1
      : 0;
    const data = all.slice(from, from + Number(params.get('limit')));
    return { ok: true, json: async () => ({ data, has_more: from + data.length < all.length }) };
  };
  const got = await listAll('/checkout/sessions', {}, { fetch: stub, key: 'sk_test' });
  check('every session is read, not just the first page', got.length, 250);
  check('it followed the cursor three times, asking for 100 each time',
    asked, [[null, '100'], ['cs_99', '100'], ['cs_199', '100']]);

  // has_more true with nothing in data has no last id to page from. The old
  // shape read .id off undefined and crashed; asking again with the same cursor
  // would have looped forever.
  const emptyThenMore = async () => ({ ok: true, json: async () => ({ data: [], has_more: true }) });
  check('an empty page with has_more still set stops instead of crashing',
    (await listAll('/x', {}, { fetch: emptyThenMore, key: 'k' })).length, 0);

  let threw = null;
  try {
    await listAll('/x', {}, { key: 'sk_bad', fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }) }) });
  } catch (err) { threw = err.message; }
  check('a bad key throws instead of reporting zero sales',
    /Stripe 401 on \/x: Invalid API Key/.test(threw || ''), true);

  console.log('\nThe CSV survives what people call their coupons');

  check('a comma does not shift every column after it',
    csvCell('Launch week, 20% off'), '"Launch week, 20% off"');
  check('a quote is doubled, not dropped', csvCell('The "big" one'), '"The ""big"" one"');
  check('a newline is quoted too', csvCell('two\nlines'), '"two\nlines"');
  check('an ordinary name is left alone', csvCell('Launch week'), 'Launch week');
  check('nothing becomes an empty cell', csvCell(null), '');

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
