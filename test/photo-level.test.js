#!/usr/bin/env node
'use strict';
// photo-level.js: tilted photos are straightened before drawing, anything it
// is not sure about goes through untouched.
//   npm test
// The fixtures are the site's AI-made sample kids (no real children).
if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') { console.error('unset DATABASE_URL'); process.exit(1); }
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
process.env.MIRROR_CHANCE = '0';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { levelPhoto, eyeTilt, MIN_DEG } = require('../photo-level');
let pass = 0; const fail = [];
const check = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); } else { fail.push(n); console.log('  FAIL ' + n + (d !== undefined ? ' -> ' + JSON.stringify(d) : '')); } };
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));

(async () => {
  const mei = fx('tilted-face-mei.jpg');
  const owen = fx('tilted-face-owen.jpg');

  const before = await eyeTilt(mei);
  check('finds one face in the Mei photo', before.faces === 1, before);
  check('reads her tilt as about 21 degrees', before.tilt !== null && Math.abs(Math.abs(before.tilt) - 21) < 4, before.tilt);

  const t0 = Date.now();
  const out = await levelPhoto({ buffer: mei, mimetype: 'image/jpeg', filename: 'mei.png' });
  const ms = Date.now() - t0;
  check('the Mei photo is straightened', out.levelledBy !== undefined && out.buffer !== mei);
  const after = await eyeTilt(out.buffer);
  check('after straightening the eyes are level (under the threshold)', after.tilt !== null && Math.abs(after.tilt) < MIN_DEG, after.tilt);
  const [m0, m1] = await Promise.all([sharp(mei).metadata(), sharp(out.buffer).metadata()]);
  check('same size as the photo it came from', m0.width === m1.width && m0.height === m1.height, [m0.width, m0.height, m1.width, m1.height]);
  check('sent as a jpeg', out.mimetype === 'image/jpeg' && out.filename === 'mei.jpg' && m1.format === 'jpeg', [out.mimetype, out.filename, m1.format]);
  check('takes well under a second', ms < 3000, ms);

  const again = await levelPhoto({ buffer: out.buffer, mimetype: 'image/jpeg', filename: 'x.jpg' });
  check('an already-level photo goes through untouched', again.levelledBy === undefined && again.buffer === out.buffer);

  const blank = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#fff' } }).png().toBuffer();
  const none = await levelPhoto({ buffer: blank, mimetype: 'image/png', filename: 'b.png' });
  check('no face: untouched', none.buffer === blank && none.levelledBy === undefined);

  // Two kids side by side, each tilted: turning the whole picture for one of
  // them is a guess, so it is left alone.
  const left = await sharp(mei).resize(400, 400).toBuffer();
  const right = await sharp(owen).resize(400, 400).toBuffer();
  const pair = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#fff' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 400, top: 0 }]).jpeg().toBuffer();
  const pairRead = await eyeTilt(pair);
  const two = await levelPhoto({ buffer: pair, mimetype: 'image/jpeg', filename: 'two.jpg' });
  check('two faces: found both, photo untouched', pairRead.faces === 2 && two.buffer === pair, pairRead);

  const broken = Buffer.from('not an image at all');
  const bad = await levelPhoto({ buffer: broken, mimetype: 'image/jpeg', filename: 'bad.jpg' });
  check('an unreadable photo goes through untouched rather than failing the page', bad.buffer === broken);

  // Through renderScene: what OpenAI is sent is the straightened photo.
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.openai.com/v1/images')) {
      sent.push({ image: Buffer.from(await opts.body.get('image').arrayBuffer()), prompt: opts.body.get('prompt') });
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) };
    }
    return realFetch(url, opts);
  };
  const s = require('../server');
  await s.renderScene({ buffer: owen, mimetype: 'image/jpeg', filename: 'owen.jpg', prompt: 'x', paid: true });
  const sentTilt = await eyeTilt(sent[0].image);
  check('renderScene sends OpenAI the straightened photo', !sent[0].image.equals(owen) && Math.abs(sentTilt.tilt) < MIN_DEG, sentTilt.tilt);

  const p = s.buildPrompt('Portrait', 0, 1, 'kid', '', [], 'standard');
  check('every prompt asks for a level head', p.includes(s.HEAD_LEVEL.trim()));
  check('the detail level is still last', p.lastIndexOf('Detail level:') > p.indexOf('Head position:'));
  check('no camera direction asks for a tilted head', s.SHOTS.every((x) => !/tilt/i.test(x)), s.SHOTS.filter((x) => /tilt/i.test(x)));
  const fam = s.buildPrompt('Superhero', 3, 1, 'kid', '', [{ name: 'Ann', subjectType: 'adult' }, { name: 'Bo', subjectType: 'kid' }], 'standard');
  check('family books get it too', fam.includes('Head position:'));

  global.fetch = realFetch;
  console.log(pass + ' passed' + (fail.length ? ', FAILED: ' + fail.join('; ') : ''));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
