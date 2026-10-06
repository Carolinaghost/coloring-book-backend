#!/usr/bin/env node
'use strict';
// Tests for the free-book giveaway (server.js: /giveaway/claim, /giveaway/status,
// sendGiveawayReviewAsks). Stripe and the mail server are stubbed.
//
//   npm test

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.error('DATABASE_URL is set; unset it to test the in-memory store.');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.GIVEAWAY_CAP = '3';
process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';

const http = require('http');
let pass = 0; const failures = [];
function check(name, ok) { if (ok) pass++; else failures.push(name); }

const minted = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.stripe.com/v1/promotion_codes') && init && init.method === 'POST') {
    const form = new URLSearchParams(init.body.toString());
    minted.push(form);
    return { ok: true, json: async () => ({ id: 'promo_' + minted.length, code: form.get('code') }) };
  }
  if (u.includes('api.stripe.com/v1/promotion_codes')) {
    return { ok: true, json: async () => ({ data: [] }) };
  }
  return realFetch(url, init);
};

const mailer = require('../mailer');
const sent = [];
mailer.sendMail = async (m) => { sent.push(m); return true; };

const { app, sendGiveawayReviewAsks } = require('../server');
const db = require('../db');

function call(server, method, path, body, ip) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-forwarded-for': ip || '1.1.1.1' } },
    (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
    req.on('error', reject); req.end(data);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = app.listen(0);
  try {
    let r = await call(server, 'GET', '/giveaway/status');
    check('status open with 3 left', r.body.open === true && r.body.remaining === 3);

    r = await call(server, 'POST', '/giveaway/claim', { email: 'not-an-email' });
    check('bad email refused', r.status === 400);

    r = await call(server, 'POST', '/giveaway/claim', { email: 'Ann@Example.com', name: 'Ann Lee', source: 'tiktok' });
    const annCode = r.body.code;
    check('first claim gets a code', r.status === 200 && /^[A-Z0-9-]{4,}$/.test(annCode || '') && r.body.again === false);
    check('code is single use on freebook100', minted[0] && minted[0].get('max_redemptions') === '1'
      && minted[0].get('promotion[coupon]') === 'freebook100' && minted[0].get('metadata[purpose]') === 'giveaway free book');
    await wait(20);
    check('code emailed to Ann', sent.some((m) => m.to === 'ann@example.com' && m.text.includes(annCode)));

    r = await call(server, 'POST', '/giveaway/claim', { email: 'ann@example.com' });
    check('same email gets the same code back', r.body.code === annCode && r.body.again === true && minted.length === 1);

    r = await call(server, 'POST', '/giveaway/claim', { email: 'b@example.com' }, '2.2.2.2');
    r = await call(server, 'POST', '/giveaway/claim', { email: 'c@example.com' }, '2.2.2.2');
    check('third claim fills the cap', r.status === 200);
    r = await call(server, 'POST', '/giveaway/claim', { email: 'd@example.com' }, '3.3.3.3');
    check('fourth claim refused once the cap is reached', r.status === 410 && r.body.closed === true && minted.length === 3);
    r = await call(server, 'GET', '/giveaway/status');
    check('status closed', r.body.open === false && r.body.remaining === 0);

    // IP allowance: 3 a day from one address.
    process.env.GIVEAWAY_CAP = '99';
    const ipHits = [];
    for (const e of ['x1@e.com', 'x2@e.com', 'x3@e.com']) ipHits.push((await call(server, 'POST', '/giveaway/claim', { email: e }, '9.9.9.9')).status);
    const fourth = (await call(server, 'POST', '/giveaway/claim', { email: 'x4@e.com' }, '9.9.9.9')).status;
    check('fourth try from one IP in a day is refused', ipHits.every((s) => s === 410) && fourth === 429);

    // Review asks: nothing before 5 days, then one each, never twice.
    sent.length = 0;
    check('no review asks for fresh claims', (await sendGiveawayReviewAsks()) === 0);
    const claim = await db.getGiveawayClaim('ann@example.com');
    const aged = await db.claimsNeedingReviewAsk(-1);
    check('claims become due', aged.length === 3 && claim);
    const n = await (async () => { const orig = db.claimsNeedingReviewAsk; db.claimsNeedingReviewAsk = () => orig(-1); try { return await sendGiveawayReviewAsks(); } finally { db.claimsNeedingReviewAsk = orig; } })();
    check('three review asks sent', n === 3 && sent.filter((m) => /How did the coloring book go/.test(m.subject)).length === 3);
    const again = await (async () => { const orig = db.claimsNeedingReviewAsk; db.claimsNeedingReviewAsk = () => orig(-1); try { return await sendGiveawayReviewAsks(); } finally { db.claimsNeedingReviewAsk = orig; } })();
    check('never asked twice', again === 0);
  } finally {
    server.close();
  }
  console.log(pass + ' passed' + (failures.length ? ', FAILED: ' + failures.join('; ') : ''));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
