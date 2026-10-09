#!/usr/bin/env node
'use strict';
// The free preview draws at PREVIEW_QUALITY ('low', ~14s a page) and paid
// pages at PAID_QUALITY ('medium'). Checked at the request OpenAI is sent,
// because that is the only place the setting does anything.
//   npm test
if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') { console.error('unset DATABASE_URL'); process.exit(1); }
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
process.env.MIRROR_CHANCE = '0';

const sharp = require('sharp');
let pass = 0; const fail = [];
const check = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail.push(n); console.log('  FAIL ' + n + (d !== undefined ? ' -> ' + JSON.stringify(d) : '')); } };

(async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.openai.com/v1/images')) {
      sent.push(opts.body.get('quality'));
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) };
    }
    return realFetch(url, opts);
  };
  const s = require('../server');
  check('preview defaults to low', s.PREVIEW_QUALITY === 'low');
  check('paid pages default to medium', s.PAID_QUALITY === 'medium');

  await s.renderScene({ buffer: png, mimetype: 'image/png', filename: 'p.png', prompt: 'x', paid: true });
  check('a paid page (no quality given) is drawn at medium', sent[0] === 'medium', sent);

  const server = s.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const form = new FormData();
  form.append('photo', new Blob([png], { type: 'image/png' }), 'kid.png');
  form.append('theme', 'Portrait');
  form.append('sceneIndex', '0');
  const res = await realFetch(`http://127.0.0.1:${port}/convert`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  check('free preview page answers', res.status === 200, [res.status, body.error]);
  check('free preview page is drawn at low', sent[1] === 'low', sent);

  const paidForm = new FormData();
  paidForm.append('photo', new Blob([png], { type: 'image/png' }), 'kid.png');
  paidForm.append('theme', 'Portrait');
  paidForm.append('sceneIndex', '5');
  const paidRes = await realFetch(`http://127.0.0.1:${port}/convert`, { method: 'POST', body: paidForm });
  check('a page past the preview without a paid order is refused, nothing drawn', paidRes.status === 403 && sent.length === 2, [paidRes.status, sent]);

  server.close();
  global.fetch = realFetch;
  console.log(pass + ' passed' + (fail.length ? ', FAILED: ' + fail.join('; ') : ''));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
