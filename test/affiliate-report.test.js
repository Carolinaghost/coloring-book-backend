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
//   - everyone is not on the same commission, so one --rate pays somebody the
//     wrong percentage and prints the same confident total either way
//
// Nothing here touches Stripe. The fetch is a stub.

const {
  promoIdFromSession, attribute, tally, listAll, csvCell, parseRates,
  payPeriod, windowLabel, main: runMain
} = require('../scripts/affiliate-report.js');

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

// The message a call throws, or null if it did not. Named for what it hands
// back, because main() already has a local `threw` of its own.
function errorFrom(fn) {
  try { fn(); return null; } catch (err) { return err.message; }
}

// Stripe, as far as the report is concerned: the promotion code list and the
// checkout sessions, and nothing else answers.
function stripeStub({ codes, sessions, coupons, byCoupon, asked, history }) {
  return async (url) => {
    const at = new URL(url);
    const path = at.pathname;
    if (asked && path === '/v1/checkout/sessions') asked.push(at.searchParams);
    // The report asks for sessions twice and means two different things. The
    // window has a created[gte]; the "has this code ever earned before" sweep
    // has only a created[lt]. Answering both with the same list is what a
    // careless stub does, and it would make the first-sale flag untestable -
    // every code would look like it had earned before.
    if (path === '/v1/checkout/sessions'
        && at.searchParams.has('created[lt]') && !at.searchParams.has('created[gte]')) {
      return { ok: true, json: async () => ({ data: history || [], has_more: false }) };
    }
    // /v1/promotion_codes?coupon=co_1 is a different question from
    // /v1/promotion_codes, and answering both with the same list would hide
    // exactly the bug the coupon lookup exists to fix.
    const owner = at.searchParams.get('coupon');
    const data = path === '/v1/promotion_codes'
      ? (owner ? ((byCoupon || {})[owner] || []) : codes)
      : path === '/v1/checkout/sessions' ? sessions
        : path === '/v1/coupons' ? coupons
          : null;
    if (!data) throw new Error(`test stub asked for an unexpected path: ${path}`);
    return { ok: true, json: async () => ({ data, has_more: false }) };
  };
}

// Runs the real main() end to end against that stub and hands back what it
// printed. Checking the numbers the report actually prints is the point -
// resolving the rate correctly and then printing owed from the old single
// rate would pass any test that only looked at the map.
async function runReport(argv, fixture, now) {
  const out = [], warn = [];
  const realLog = console.log, realWarn = console.warn;
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => warn.push(a.join(' '));
  try {
    await runMain({ argv, fetch: stripeStub(fixture), key: 'sk_test', now });
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return { out, warn };
}

// JERRELL is on 25%, OWEN10 is on the default. $40 of paid sales each, plus a
// completed-but-unpaid $99 order on JERRELL that must not be worth a cent.
const FIXTURE = {
  codes: [
    { id: 'promo_j', code: 'JERRELL', active: true, coupon: { id: 'co_1', name: 'Partner' } },
    { id: 'promo_o', code: 'OWEN10', active: true, coupon: { id: 'co_2', name: 'Launch' } }
  ],
  sessions: [
    paid({ ...withCode('promo_j'), amount_total: 2000, amount_subtotal: 2500 }),
    paid({ ...withCode('promo_j'), amount_total: 2000, amount_subtotal: 2500 }),
    paid({ ...withCode('promo_o'), amount_total: 4000, amount_subtotal: 5000 }),
    { payment_status: 'unpaid', amount_total: 9900, amount_subtotal: 9900, ...withCode('promo_j') }
  ]
};

// What a restricted key actually returns: no coupon on the promotion code at
// all. The names have to come back from the coupon side or not at all.
const RESTRICTED = {
  codes: [
    { id: 'promo_j', code: 'JERRELL', active: true },
    { id: 'promo_o', code: 'OWEN10', active: true }
  ],
  coupons: [
    { id: 'co_1', name: 'Creator tracking' },
    { id: 'co_2' }
  ],
  byCoupon: {
    co_1: [{ id: 'promo_j' }],
    co_2: [{ id: 'promo_o' }]
  },
  sessions: [paid({ ...withCode('promo_j'), amount_total: 2000, amount_subtotal: 2500 })]
};

function tableRow(lines, code) {
  return lines.find((l) => l.startsWith(code + ' ')) || '';
}

function csvRow(lines, code) {
  return (lines.find((l) => l.startsWith(code + ',')) || '').split(',');
}

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

  console.log('\nReading --rates');

  check('a pair becomes a rate', [...parseRates('JERRELL=25')], [['JERRELL', 25]]);
  check('several pairs', [...parseRates('JERRELL=25,OWEN10=15')], [['JERRELL', 25], ['OWEN10', 15]]);
  check('typed in lowercase, stored the way codes are matched',
    [...parseRates('jerrell=25')], [['JERRELL', 25]]);
  check('spaces around the pairs are forgiven',
    [...parseRates(' JERRELL = 25 , OWEN10=15 ')], [['JERRELL', 25], ['OWEN10', 15]]);
  check('a fraction of a percent survives', parseRates('OWEN10=12.5').get('OWEN10'), 12.5);
  check('0 is a real answer, not a missing one', parseRates('FREEBIE=0').get('FREEBIE'), 0);
  check('no flag at all means no overrides', parseRates(undefined).size, 0);
  check('an empty string means no overrides', parseRates('   ').size, 0);

  check('a pair with no = is rejected',
    /not one/.test(errorFrom(() => parseRates('JERRELL25')) || ''), true);
  check('a pair with no code is rejected',
    /not one/.test(errorFrom(() => parseRates('=25')) || ''), true);
  check('and the error quotes the pair it could not read',
    /"JERRELL25"/.test(errorFrom(() => parseRates('JERRELL25')) || ''), true);
  // parseFloat('25%') is 25, which is how a typo becomes a payment.
  check('a rate that is not a number is rejected, not half-read',
    /is not a number/.test(errorFrom(() => parseRates('JERRELL=25%')) || ''), true);
  check('over 100 is rejected',
    /between 0 and 100/.test(errorFrom(() => parseRates('JERRELL=125')) || ''), true);
  check('negative is rejected',
    /between 0 and 100/.test(errorFrom(() => parseRates('JERRELL=-5')) || ''), true);
  check('the same code twice is rejected rather than last-one-wins',
    /more than once/.test(errorFrom(() => parseRates('JERRELL=25,JERRELL=30')) || ''), true);
  check('and case does not sneak a duplicate past it',
    /more than once/.test(errorFrom(() => parseRates('JERRELL=25,jerrell=30')) || ''), true);

  console.log('\nPaying two different people two different percentages');

  const { out: csv } = await runReport(['--csv', '--rates', 'jerrell=25'], FIXTURE);
  check('the CSV header carries the rate before owed',
    csv[0], 'code,coupon,active,sales,customers_paid,rate_percent,owed,'
      + 'first_sale,creator_name,creator_email');
  // $40 at 25% is $10. At the old single rate it would print $8.00 and look
  // exactly as correct as this does.
  check('lowercase jerrell=25 matched JERRELL, and $40 owes $10',
    csvRow(csv, 'JERRELL').slice(3, 7), ['2', '40.00', '25', '10.00']);
  check('the code nobody named is untouched at 20%: $40 owes $8',
    csvRow(csv, 'OWEN10').slice(3, 7), ['1', '40.00', '20', '8.00']);
  check('the unpaid $99 order is still worth nothing to anybody',
    csvRow(csv, 'JERRELL')[4], '40.00');
  check('nothing is warned about when every named code exists', (await runReport(
    ['--csv', '--rates', 'JERRELL=25'], FIXTURE)).warn.length, 0);

  const { out: table } = await runReport(['--rates', 'JERRELL=25'], FIXTURE);
  check('the table has a rate column',
    /CODE\s+SALES\s+CUSTOMERS PAID\s+RATE\s+OWED\s+COUPON/.test(table[1]), true);
  check('and the rate is printed on the row it applies to',
    /^JERRELL\s+2\s+\$40\.00\s+25%\s+\$10\.00\s+Partner$/.test(
      table.find((l) => l.startsWith('JERRELL')) || ''), true);
  check('the total owed is the two different rates added up, not one rate',
    /^TOTAL\s+3\s+\$80\.00\s+\$18\.00$/.test(
      table.find((l) => l.startsWith('TOTAL')) || ''), true);

  // JERREL=25 is a typo for JERRELL. Without the warning it matches nobody,
  // Jerrell is quietly paid 20%, and the report looks identical to a correct
  // run - which is the whole failure this flag was added to prevent.
  const typo = await runReport(['--csv', '--rates', 'JERREL=25'], FIXTURE);
  check('a --rates code that is not in Stripe is named in a warning',
    typo.warn.some((l) => l.includes('JERREL') && /do not exist in Stripe/.test(l)), true);
  check('and the warning stays out of the CSV',
    typo.out.every((l) => !/WARNING/.test(l)), true);
  check('meanwhile the typo really did leave Jerrell on the default rate',
    csvRow(typo.out, 'JERRELL').slice(5, 7), ['20', '8.00']);

  check('a bad --rates stops the report instead of paying the default',
    /between 0 and 100/.test(
      (await runReport(['--rates', 'JERRELL=250'], FIXTURE).then(() => null, (e) => e.message)) || ''),
    true);

  console.log('\nThe pay week the creators were actually promised');

  const TZ = 'America/New_York';
  const label = (at) => {
    const p = payPeriod(new Date(at), TZ);
    return windowLabel(p.start, p.end, TZ);
  };

  // 08:00 Thursday in New York is 12:00 UTC while daylight time is on.
  check('the Thursday 8am run closes the week that just ended',
    label('2026-09-24T12:00:00Z'), 'Thu, Sep 17 00:00 to Wed, Sep 23 23:59');
  // Running it late must not silently pay a different week.
  check('running it on Friday instead reports the same week',
    label('2026-09-25T12:00:00Z'), 'Thu, Sep 17 00:00 to Wed, Sep 23 23:59');
  check('and still the same on Wednesday night, one hour before close',
    label('2026-09-30T23:00:00Z'), 'Thu, Sep 17 00:00 to Wed, Sep 23 23:59');
  check('five minutes past midnight Thursday, it has rolled on',
    label('2026-10-01T04:05:00Z'), 'Thu, Sep 24 00:00 to Wed, Sep 30 23:59');

  // The week containing the end of US daylight saving is 169 hours long. A
  // window built from a flat seven-times-86400 would end an hour early and
  // drop an hour of Wednesday night sales.
  const dst = payPeriod(new Date('2026-11-05T13:00:00Z'), TZ);
  check('the week that contains the clock change is a real week, not 168 hours',
    (dst.end - dst.start) / 3600, 169);
  check('and it still starts and ends at local midnight',
    label('2026-11-05T13:00:00Z'), 'Thu, Oct 29 00:00 to Wed, Nov 4 23:59');

  // A sale made after the week closed belongs to next week's payout. Without
  // an upper bound it would be paid now and again next Thursday.
  const periodQuery = [];
  const periodRun = await runReport(['--period'], { ...FIXTURE, asked: periodQuery },
    '2026-09-24T12:00:00Z');
  check('the pay week asks Stripe for an upper bound',
    periodQuery[0].get('created[lt]'), String(payPeriod(new Date('2026-09-24T12:00:00Z'), TZ).end));
  check('and a lower bound that is the Thursday midnight',
    periodQuery[0].get('created[gte]'), String(payPeriod(new Date('2026-09-24T12:00:00Z'), TZ).start));
  check('the heading names the week, not a day count',
    /Pay week  Thu, Sep 17 00:00 to Wed, Sep 23 23:59/.test(periodRun.out.join('\n')), true);

  const rolling = [];
  await runReport([], { ...FIXTURE, asked: rolling }, '2026-09-24T12:00:00Z');
  check('a plain rolling run sets no upper bound', rolling[0].get('created[lt]'), null);
  check('and says out loud that it is not a pay week',
    /rolling - not a pay week/.test((await runReport([], FIXTURE, '2026-09-24T12:00:00Z')).out.join('\n')), true);

  console.log('\nNaming the coupon when the key will not attach it');

  const rak = await runReport([], RESTRICTED);
  check('a named coupon is found from the coupon side',
    /Creator tracking/.test(tableRow(rak.out, 'JERRELL')), true);
  check('an unnamed coupon falls back to its id, not to a dash',
    /co_2/.test(tableRow(rak.out, 'OWEN10')), true);
  check('and the money is untouched by the lookup',
    csvRow((await runReport(['--csv'], RESTRICTED)).out, 'JERRELL').slice(4, 7),
    ['20.00', '20', '4.00']);

  // The full-key path must not start asking Stripe for coupons it does not
  // need: FIXTURE's stub has no /v1/coupons answer, so a stray call throws.
  check('a key that does attach the coupon asks for nothing extra',
    /Partner/.test(tableRow((await runReport([], FIXTURE)).out, 'JERRELL')), true);

  console.log('\nSomebody earning for the first time');
  // Before a creator can be paid they have to be set up as a contractor - a
  // W-9 and bank details they enter themselves. Nothing announces that moment
  // except money arriving, so the report has to, and it has to be right about
  // WHICH week it arrived in. Flag somebody twice and they get chased for a
  // form they already filled; miss it and they are paid with no W-9 on file.
  const WITH_CREATORS = {
    codes: [
      { id: 'promo_n', code: 'NEWBIE', active: true, coupon: { id: 'co_1', name: 'Creator tracking' },
        metadata: { creator_name: 'Sam Rivers', creator_email: 'sam@example.com' } },
      { id: 'promo_o', code: 'OLDHAND', active: true, coupon: { id: 'co_1', name: 'Creator tracking' },
        metadata: { creator_name: 'Dana Fox', creator_email: 'dana@example.com' } },
      { id: 'promo_h', code: 'BYHAND', active: true, coupon: { id: 'co_1', name: 'Creator tracking' } }
    ],
    sessions: [
      paid({ ...withCode('promo_n'), amount_total: 1500, amount_subtotal: 1500 }),
      paid({ ...withCode('promo_o'), amount_total: 1500, amount_subtotal: 1500 }),
      paid({ ...withCode('promo_h'), amount_total: 2500, amount_subtotal: 2500 })
    ],
    // OLDHAND sold something before this week. NEWBIE and BYHAND never have.
    history: [paid({ ...withCode('promo_o'), amount_total: 1500, amount_subtotal: 1500 })]
  };

  const first = await runReport([], WITH_CREATORS);
  const firstText = first.out.join('\n');
  check('the first-timer is called out', /NEWBIE/.test(
    firstText.slice(firstText.indexOf('earned for the FIRST time'))), true);
  check('and named, so you can set them up without looking anything up',
    /Sam Rivers <sam@example\.com>/.test(firstText), true);
  check('somebody who has earned before is not chased again',
    /Dana Fox/.test(firstText), false);
  check('a code made by hand carries no details, and the report says so',
    /BYHAND[^\n]*made by hand/.test(firstText), true);
  check('it says where to go, rather than only that something is needed',
    /Payroll > Contractors/.test(firstText), true);
  check('two of the three are new', (firstText.match(/earned for the FIRST time/) ? 
    Number(/(\d+) code\(s\) earned for the FIRST time/.exec(firstText)[1]) : 0), 2);

  // A code with no sales this week is not a first sale, however new it is.
  const quiet = await runReport([], {
    ...WITH_CREATORS,
    sessions: [paid({ ...withCode('promo_o'), amount_total: 1500, amount_subtotal: 1500 })]
  });
  check('a creator who sold nothing this week is not flagged',
    /earned for the FIRST time/.test(quiet.out.join('\n')), false);

  // A free book is redeemed at $0. Its holder earns nothing and never will,
  // so chasing them for a W-9 is a wasted trip for both of them.
  const freebie = await runReport([], {
    codes: [{ id: 'promo_f', code: 'FREE-ABC123', active: true,
      coupon: { id: 'co_free', name: 'Free book 100 percent' } }],
    sessions: [paid({ ...withCode('promo_f'), amount_total: 0, amount_subtotal: 1500 })],
    history: []
  });
  check('a code redeemed at zero is never flagged for setup',
    /earned for the FIRST time/.test(freebie.out.join('\n')), false);

  console.log('\nClearing out the dead codes');
  // Testing leaves deactivated codes behind forever - Stripe will not delete a
  // promotion code - and after a few rounds there is more history in the table
  // than business. A dead code that never sold is hidden but still counted by
  // name, so nothing disappears quietly. A dead code that DID sell stays put,
  // because that is money somebody is owed.
  const WITH_DEAD = {
    codes: [
      { id: 'promo_live', code: 'LIVE', active: true, coupon: { id: 'co_1', name: 'Creator tracking' } },
      { id: 'promo_dead', code: 'ZZTEST', active: false, coupon: { id: 'co_1', name: 'Creator tracking' } },
      { id: 'promo_deadsold', code: 'RETIRED', active: false, coupon: { id: 'co_1', name: 'Creator tracking' } }
    ],
    sessions: [paid({ ...withCode('promo_deadsold'), amount_total: 1500, amount_subtotal: 1500 })],
    history: [paid({ ...withCode('promo_deadsold'), amount_total: 1500, amount_subtotal: 1500 })]
  };
  const dead = await runReport([], WITH_DEAD);
  const deadText = dead.out.join('\n');
  check('a live code with no sales still shows - somebody is not posting',
    /^LIVE\s/m.test(deadText), true);
  check('a dead code with no sales is off the table', /^ZZTEST\s/m.test(deadText), false);
  check('but it is named, not silently dropped', /not listed: ZZTEST/.test(deadText), true);
  check('and a dead code that sold stays, because that is money owed',
    /^RETIRED\s/m.test(deadText), true);

  const csvNew = await runReport(['--csv'], WITH_CREATORS);
  check('the CSV carries it too, for anyone reading it with a spreadsheet',
    csvRow(csvNew.out, 'NEWBIE').slice(7), ['yes', 'Sam Rivers', 'sam@example.com']);
  check('and says no for the one who has earned before',
    csvRow(csvNew.out, 'OLDHAND').slice(7, 8), ['no']);

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
