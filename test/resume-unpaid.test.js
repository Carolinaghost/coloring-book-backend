#!/usr/bin/env node
'use strict';

// A customer who saw their free preview and left at checkout gets an emailed
// "come back to your book" link. That link must show them their two preview
// pages again with Unlock underneath - not refuse them for not having paid.
// Everything past the preview stays behind payment.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';
delete process.env.DATABASE_URL;   // in-memory store
const http = require('http');
const { app } = require('../server.js');

let pass = 0;
const failures = [];
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}
function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    console.log('\nAn unpaid order opened from its link');
    const made = await call(server, 'POST', '/orders', { theme: 'Superhero', pageCount: 15, photo: 'data:image/png;base64,AAAA' });
    check('the order exists', made.status, 200);
    const id = made.json.order.id, token = made.json.accessToken;

    const pages = await call(server, 'GET', `/orders/${id}/pages?token=${encodeURIComponent(token)}`);
    check('its pages are served, not refused', pages.status, 200);
    check('and are marked as preview only', pages.json.previewOnly, true);
    check('as a list', Array.isArray(pages.json.pages), true);
    check('with nothing past the free preview in it', pages.json.pages.every((p) => p.sceneIndex < 2), true);

    const bad = await call(server, 'GET', `/orders/${id}/pages?token=wrong`);
    check('a bad token is still refused', bad.status, 403);
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
