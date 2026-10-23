#!/usr/bin/env node
'use strict';
// Tests for the SMS opt-in (server.js: POST /sms/optin, normalizeUsPhone,
// smsConsentText). In-memory store; nothing is texted.
//
//   npm test

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.error('DATABASE_URL is set; unset it to test the in-memory store.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.SMS_SIGNUPS_PER_IP = '3';

const http = require('http');
let pass = 0; const failures = [];
function check(name, ok) { if (ok) pass++; else failures.push(name); }

const { app, normalizeUsPhone, smsConsentText } = require('../server');
const db = require('../db');

function call(server, method, path, body, ip) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-forwarded-for': ip || '2.2.2.2' } },
    (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
    req.on('error', reject); req.end(data);
  });
}

(async () => {
  // Phone numbers
  check('formatted US number', normalizeUsPhone('(555) 234-5678') === '+15552345678');
  check('with +1', normalizeUsPhone('+1 555 234 5678') === '+15552345678');
  check('11 digits starting 1', normalizeUsPhone('15552345678') === '+15552345678');
  check('too short', normalizeUsPhone('555-2345') === '');
  check('area code starting 1 rejected', normalizeUsPhone('155 234 5678') === '');
  check('exchange starting 0 rejected', normalizeUsPhone('555 034 5678') === '');
  check('non-US 12 digits rejected', normalizeUsPhone('+44 7700 900123') === '');
  check('empty', normalizeUsPhone('') === '');

  // Consent wording
  const both = smsConsentText({ orderUpdates: true, promos: true });
  check('consent names both kinds', both.includes('order updates and promotional messages'));
  check('consent has STOP/HELP/rates/not a condition', /STOP/.test(both) && /HELP/.test(both) && /data rates/.test(both) && /not a condition/.test(both));
  check('consent links terms + privacy', both.includes('legal.html#sms-terms') && both.includes('legal.html#sms-privacy'));
  check('updates only does not mention promos', !smsConsentText({ orderUpdates: true, promos: false }).includes('promotional'));

  const server = app.listen(0);
  try {
    let r = await call(server, 'POST', '/sms/optin', { phone: '12', orderUpdates: true });
    check('bad phone 400', r.status === 400);
    r = await call(server, 'POST', '/sms/optin', { phone: '555-234-5678' });
    check('no box ticked 400', r.status === 400);
    r = await call(server, 'POST', '/sms/optin', { phone: '555-234-5678', orderUpdates: 'true' });
    check('string "true" is not consent', r.status === 400);

    r = await call(server, 'POST', '/sms/optin', { phone: '(555) 234-5678', orderUpdates: true, promos: false, source: 'sms-page' });
    check('opt-in saved 200', r.status === 200 && r.body.ok === true);
    let row = await db.getSmsOptin('+15552345678');
    check('row stored in E.164', row && row.phone === '+15552345678');
    check('flags stored', row && row.orderUpdates === true && row.promos === false);
    check('consent text stored server-side', row && row.consentText.includes('order updates') && !row.consentText.includes('promotional'));
    check('source stored', row && row.source === 'sms-page');

    r = await call(server, 'POST', '/sms/optin', { phone: '+1 555 234 5678', orderUpdates: true, promos: true, source: 'order' });
    row = await db.getSmsOptin('+15552345678');
    check('re-opt-in updates choices', r.status === 200 && row.promos === true && row.source === 'order');

    // Quota: 3 per IP per day (2 used above from 2.2.2.2, the 400s do not count)
    r = await call(server, 'POST', '/sms/optin', { phone: '555 345 6789', promos: true });
    check('third sign-up allowed', r.status === 200);
    r = await call(server, 'POST', '/sms/optin', { phone: '555 456 7890', promos: true });
    check('fourth sign-up from same IP refused', r.status === 429);
    r = await call(server, 'POST', '/sms/optin', { phone: '555 456 7890', promos: true }, '3.3.3.3');
    check('other IP still allowed', r.status === 200);
  } finally {
    server.close();
  }

  console.log(pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
