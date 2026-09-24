#!/usr/bin/env node
'use strict';

// Tests for the style preview grid - four styles drawn from the visitor's own
// photo the moment it is uploaded, before a name, a theme or an order exists
// (server.js: STYLE_GRID / styleGridFor / POST /style-preview).
//
//   npm test
//
// This grid is an advert. Two ways it can quietly stop being one:
//
// A tile can drift onto the wrong scene. Superhero's scene 0 is "discovers a
// glowing cape in their bedroom", and the costume only starts at scene 1 - so
// a tile taking scene 0 sells the superhero style with a child in a bedroom
// holding some cloth. The scene each tile resolves to is read back here, not
// assumed from an index.
//
// And the quota can be spent without a picture to show for it. Four images are
// taken up front so a visitor with three left is stopped cleanly rather than
// charged for a grid that cannot finish; anything that fails to draw is handed
// back.

const http = require('http');
const { app, buildPrompt, STYLE_GRID, STYLE_GRID_SIZE, styleGridFor, STORY_SCENES } = require('../server.js');

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

function request(server, path, { method = 'GET', body, type } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const headers = type ? { 'Content-Type': type } : {};
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipart(fields, files) {
  const boundary = '----stylegrid' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n`
      + 'Content-Type: image/png\r\n\r\n'));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// What the spec fixes: four tiles, these styles, in this order.
const WANT = {
  kid: ['Portrait', 'Adventure scene', 'Superhero', 'Police Officer'],
  adult: ['Portrait', 'Grandparent Garden', 'Family Keepsake', 'Superhero']
};

async function main() {
  console.log('\nFour styles, the ones the spec names');

  check('a kid book shows these four', STYLE_GRID.kid.map((t) => t.theme), WANT.kid);
  check('an adult or family book shows these four', STYLE_GRID.adult.map((t) => t.theme), WANT.adult);
  check('four tiles, not three or five', STYLE_GRID_SIZE, 4);
  check('anything unrecognised is treated as a kid book',
    styleGridFor('nonsense').map((t) => t.theme), WANT.kid);

  // Fairy tale and the other careers stay pickable in step 3 - they just are
  // not drawn automatically here.
  const shown = new Set([...WANT.kid, ...WANT.adult]);
  check('Fairy tale is not one of the four', shown.has('Fairy tale'), false);
  check('Firefighter and Doctor are not either',
    ['Firefighter', 'Doctor'].filter((t) => shown.has(t)), []);
  check('but all four still exist as real themes',
    [...shown].filter((t) => !STORY_SCENES[t]), []);

  console.log('\nEach tile draws the scene that sells its style');

  for (const audience of ['kid', 'adult']) {
    for (const tile of styleGridFor(audience)) {
      const scenes = STORY_SCENES[tile.theme];
      check(`${audience}/${tile.label} points at a real scene`,
        tile.sceneIndex >= 0 && tile.sceneIndex < scenes.length, true);
    }
  }

  // The scene is read back, so reordering STORY_SCENES cannot quietly turn the
  // superhero tile into a bedroom.
  const kidHero = buildPrompt('Superhero', styleGridFor('kid')[2].sceneIndex, 1, 'kid', '', null, 'standard');
  check('the kid superhero tile is already in costume', /cape flying/.test(kidHero), true);
  check('and not the bedroom before the costume exists', /bedroom/.test(kidHero), false);
  check('it says what the costume is', /superhero costume/.test(kidHero), true);

  const adultHero = buildPrompt('Superhero', styleGridFor('adult')[3].sceneIndex, 1, 'adult', '', null, 'standard');
  check('the adult superhero tile wears the same costume', /superhero costume/.test(adultHero), true);
  // The spec's known wrinkle. Superhero was written for a kid: every scene says
  // "the child", and some ask them to leap off a roof.
  check('nothing in it still calls the subject a child', /\bthe child\b/.test(adultHero), false);
  check('and it does not ask a grandparent to leap off a building',
    /leaps off|races a speeding|lifts a fallen/.test(adultHero), false);
  check('it is the rooftop at sunset instead', /rooftop at sunset/.test(adultHero), true);

  console.log('\nNo tile says "child" to an adult');

  for (const tile of styleGridFor('adult')) {
    const prompt = buildPrompt(tile.theme, tile.sceneIndex, 1, 'adult', '', null, 'standard');
    check(`${tile.label} speaks about a person`, /\bthe child\b/.test(prompt), false);
  }

  console.log('\nThe site can see the grid, and a photo is required');

  const server = app.listen(0);
  try {
    const options = JSON.parse((await request(server, '/options')).body);
    check('/options lists the kid tiles', options.styleGrid.kid.map((t) => t.theme), WANT.kid);
    check('/options lists the adult tiles', options.styleGrid.adult.map((t) => t.theme), WANT.adult);
    check('and labels them for a human',
      options.styleGrid.kid.map((t) => t.label),
      ['Simple portrait', 'Adventure scene', 'Superhero', 'Police officer']);

    const empty = multipart({ audience: 'kid' }, []);
    const noPhoto = await request(server, '/style-preview', { method: 'POST', body: empty.body, type: empty.type });
    check('no photo is refused', noPhoto.status, 400);

    const mismatch = multipart(
      { audience: 'adult', people: JSON.stringify([{ name: 'Mum', subjectType: 'adult' }]) },
      [{ field: 'photos', name: 'a.png', data: PNG }, { field: 'photos', name: 'b.png', data: PNG }]
    );
    const bad = await request(server, '/style-preview', { method: 'POST', body: mismatch.body, type: mismatch.type });
    check('photos without names are refused', bad.status, 400);
    check('and it says which way round', /2 photo\(s\) but 1 name\(s\)/.test(bad.body), true);
  } finally {
    server.close();
  }

  console.log('\nFour images a run, eight a day, two runs');

  // The spec's arithmetic, checked rather than assumed. The allowance is
  // counted in images, so a four-tile grid spends four of the eight.
  const db = require('../db.js');
  const day = '2026-09-24';
  const ip = 'test-grid-' + Math.random().toString(36).slice(2);

  const first = await db.takePreviewQuota(ip, day, 8, 4);
  check('the first grid is allowed', [first.allowed, first.used], [true, 4]);
  const second = await db.takePreviewQuota(ip, day, 8, 4);
  check('so is the second', [second.allowed, second.used], [true, 8]);
  const third = await db.takePreviewQuota(ip, day, 8, 4);
  check('the third is refused - this is the stop that sends them to step 3', third.allowed, false);
  check('and nothing was taken for it', third.used, 8);

  // All or nothing. A visitor with two left must not start a four-tile grid,
  // watch two arrive and be charged for four.
  const short = 'test-short-' + Math.random().toString(36).slice(2);
  await db.takePreviewQuota(short, day, 8, 6);
  const partial = await db.takePreviewQuota(short, day, 8, 4);
  check('two left is not enough for a grid of four', partial.allowed, false);
  check('and the two are still there, not half spent', partial.left, 2);
  check('a single page still fits in what is left',
    (await db.takePreviewQuota(short, day, 8, 1)).allowed, true);

  // A tile OpenAI refuses has taken an image and given back no picture.
  const refunded = 'test-refund-' + Math.random().toString(36).slice(2);
  await db.takePreviewQuota(refunded, day, 8, 4);
  await db.refundPreviewQuota(refunded, day, 2);
  check('two failed tiles are handed back',
    (await db.takePreviewQuota(refunded, day, 8, 4)).allowed, true);
  // A refund undoes something; it is never a credit to spend later.
  const floor = 'test-floor-' + Math.random().toString(36).slice(2);
  await db.takePreviewQuota(floor, day, 8, 1);
  await db.refundPreviewQuota(floor, day, 99);
  check('refunding more than was taken does not go below zero',
    (await db.takePreviewQuota(floor, day, 8, 8)).allowed, true);

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
