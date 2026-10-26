#!/usr/bin/env node
'use strict';
// Meta Conversions API (meta-capi.js, sendPurchaseToMeta in server.js).
//   npm test
if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') { console.error('unset DATABASE_URL'); process.exit(1); }
process.env.NODE_ENV = 'test';
const crypto = require('crypto');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
let pass = 0; const fail = [];
const check = (n, ok) => (ok ? pass++ : (fail.push(n), console.log('  FAIL ' + n)));
const quiet = { log() {}, error() {} };

(async () => {
  delete process.env.META_CAPI_TOKEN;
  const capi = require('../meta-capi');
  let calls = 0;
  const fakeFetch = async (url, opts) => { calls++; fakeFetch.last = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ events_received: 1 }) }; };

  check('switched off without a token', await capi.sendEvent({ eventName: 'Purchase', eventId: 'x' }, { fetchImpl: fakeFetch, log: quiet }) === null && calls === 0);

  process.env.META_CAPI_TOKEN = 'tok';
  process.env.META_CAPI_TEST_CODE = 'TEST123';
  await capi.sendEvent({ eventName: 'Purchase', eventId: 'purchase-7', email: '  Ada@Example.COM ', phone: '(336) 555-0100',
    externalId: 7, fbp: 'fb.1.1700000000000.123456', ip: '1.2.3.4', ua: 'UA', sourceUrl: 'https://crayonauts.com/',
    customData: { value: 15, currency: 'USD' } }, { fetchImpl: fakeFetch, log: quiet });
  const ev = fakeFetch.last.body.data[0];
  check('one call to the pixel', calls === 1 && /graph\.facebook\.com\/v\d+\.0\/1760133305035577\/events/.test(fakeFetch.last.url));
  check('email trimmed, lower-cased, hashed', ev.user_data.em[0] === sha('ada@example.com'));
  check('US phone gets country code, hashed', ev.user_data.ph[0] === sha('13365550100'));
  check('order id hashed', ev.user_data.external_id[0] === sha('7'));
  check('cookie id, IP, browser sent as they are', ev.user_data.fbp === 'fb.1.1700000000000.123456' && ev.user_data.client_ip_address === '1.2.3.4' && ev.user_data.client_user_agent === 'UA');
  check('no plain email anywhere', !JSON.stringify(fakeFetch.last.body).includes('example.com'));
  check('event id, name, source, time', ev.event_id === 'purchase-7' && ev.event_name === 'Purchase' && ev.action_source === 'website' && Number.isInteger(ev.event_time));
  check('test code passed through', fakeFetch.last.body.test_event_code === 'TEST123');
  delete process.env.META_CAPI_TEST_CODE;

  const d = capi.browserDetails({ fb: { fbp: 'nonsense', fbc: 'fb.1.1700000000000.IwAR_abc-1', url: 'https://evil.example/x' }, ip: 'unknown', userAgent: 'UA' });
  check('junk cookie and foreign URL dropped, good fbc kept', d.fbp === '' && d.fbc === 'fb.1.1700000000000.IwAR_abc-1' && d.url === '' && d.ip === '');

  const refusing = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) });
  check('a refusal is swallowed', await capi.sendEvent({ eventName: 'Lead', eventId: 'l' }, { fetchImpl: refusing, log: quiet }) === null);
  const throwing = async () => { throw new Error('down'); };
  check('a network failure is swallowed', await capi.sendEvent({ eventName: 'Lead', eventId: 'l' }, { fetchImpl: throwing, log: quiet }) === null);

  // The webhook's helper, with the real global fetch stubbed.
  const sent = [];
  global.fetch = async (url, opts) => { if (String(url).includes('graph.facebook.com')) sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ events_received: 1 }) }; };
  const { sendPurchaseToMeta } = require('../server');
  await sendPurchaseToMeta({ id: 42, email: 'b@c.com', theme: 'Christmas', people: [{}, {}] },
    { amount_total: 2999, created: 1790000000, customer_details: { phone: '+13365550100' },
      metadata: { fb_fbp: 'fb.1.1.2', fb_fbc: 'fb.1.1.abc', fb_ip: '5.6.7.8', fb_ua: 'UA2', fb_url: 'https://crayonauts.com/?c=COLORING' } });
  const p = sent[0] && sent[0].data[0];
  check('Purchase id matches the browser (purchase-<order>)', p && p.event_id === 'purchase-42');
  check('value is what Stripe charged', p && p.custom_data.value === 29.99 && p.custom_data.currency === 'USD');
  check('family book, theme named', p && p.custom_data.contents[0].id === 'family' && p.custom_data.content_name === 'Christmas');
  check('browser details from the session reach Meta', p && p.user_data.fbp === 'fb.1.1.2' && p.user_data.fbc === 'fb.1.1.abc' && p.user_data.client_ip_address === '5.6.7.8' && p.event_source_url === 'https://crayonauts.com/?c=COLORING');
  check('event time is the session time', p && p.event_time === 1790000000);

  console.log(pass + ' passed' + (fail.length ? ', FAILED: ' + fail.join('; ') : ''));
  process.exit(fail.length ? 1 : 0);
})();
