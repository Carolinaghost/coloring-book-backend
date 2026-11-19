#!/usr/bin/env node
'use strict';
// Free preview pages get two extra lines in the prompt (clean lines, a
// carefully drawn face, framed a little closer). Paid pages do not. Checked at
// the request OpenAI is sent, because that is the only place it does anything:
//   - the four-tile style grid (POST /style-preview)
//   - a free preview page (POST /convert, no paid order)
//   - a paid page (renderScene called with the plain prompt)
//   npm test
if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') { console.error('unset DATABASE_URL'); process.exit(1); }
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
process.env.MIRROR_CHANCE = '0';

const sharp = require('sharp');
let pass = 0; const fail = [];
const check = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail.push(n); console.log('  FAIL ' + n + (d !== undefined ? ' -> ' + JSON.stringify(d) : '')); } };
const CLEAR = 'Line quality: crisp, clean, smooth outlines';
const CLOSER = 'Frame it a little closer than usual';

(async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.openai.com/v1/images')) {
      sent.push({ prompt: opts.body.get('prompt'), quality: opts.body.get('quality') });
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) };
    }
    return realFetch(url, opts);
  };
  const s = require('../server');
  const has = (p) => p.includes(CLEAR) && p.includes(CLOSER);

  check('on by default', s.PREVIEW_CLARITY === true);
  const base = s.buildPrompt('Portrait', 0, 1, 'kid', '', [], 'standard');
  check('buildPrompt itself is unchanged (paid books keep their prompt)', !base.includes(CLEAR) && !base.includes(CLOSER));
  const pp = s.previewPrompt(base);
  check('previewPrompt adds both lines at the end, once', pp.startsWith(base) && has(pp)
    && pp.split(CLEAR).length === 2 && pp.split(CLOSER).length === 2);
  check('the detail level is still in the preview prompt', pp.includes('Detail level:'));

  await s.renderScene({ buffer: png, mimetype: 'image/png', filename: 'p.png', prompt: base, paid: true });
  check('a paid page is sent without the preview lines', sent.length === 1 && !has(sent[0].prompt) && sent[0].quality === 'medium', sent[0] && sent[0].quality);

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
  check('free preview page is sent with both lines, at low', sent.length === 2 && has(sent[1].prompt) && sent[1].quality === 'low',
    sent[1] && sent[1].quality);

  const grid = new FormData();
  grid.append('photo', new Blob([png], { type: 'image/png' }), 'kid.png');
  const gres = await realFetch(`http://127.0.0.1:${port}/style-preview`, { method: 'POST', body: grid });
  const gbody = await gres.json().catch(() => ({}));
  const tiles = sent.slice(2);
  check('style grid answers', gres.status === 200, [gres.status, gbody.error]);
  check('all four style tiles are sent with both lines, at low', tiles.length === 4 && tiles.every((t) => has(t.prompt) && t.quality === 'low'),
    tiles.map((t) => [has(t.prompt), t.quality]));

  server.close();
  global.fetch = realFetch;
  console.log(pass + ' passed' + (fail.length ? ', FAILED: ' + fail.join('; ') : ''));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
