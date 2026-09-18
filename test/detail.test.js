#!/usr/bin/env node
'use strict';

// Tests for the detail level - how busy a page is, chosen for whoever is
// holding the crayon (server.js: DETAIL_LEVELS / normalizeDetail / buildPrompt
// / /orders / /options).
//
//   npm test
//
// What is worth protecting here is that SOMETHING is always chosen. Leaving the
// instruction out is what produced the random page-to-page swing this whole
// feature exists to fix, so an order with no level, a misspelt level or an old
// browser that has never heard of the field must all still come out of
// buildPrompt carrying the middle band - never carrying nothing.
//
// These tests check the wiring, not the artwork. Whether Simple actually LOOKS
// emptier than Detailed is a question for scripts/detail-compare.js and a pair
// of eyes; no assertion can answer it.

const http = require('http');

const { app, buildPrompt, DETAIL_LEVELS, DEFAULT_DETAIL, normalizeDetail, BASE_STYLE } = require('../server.js');

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

const LEVELS = Object.keys(DETAIL_LEVELS);

async function main() {
  console.log('\nNothing chosen still means something chosen');

  check('there are three levels', LEVELS, ['simple', 'standard', 'detailed']);
  check('the default is the middle one', DEFAULT_DETAIL, 'standard');
  for (const missing of [undefined, null, '', '   ', 'medium', 'age 4', 42, {}]) {
    check(`${JSON.stringify(missing)} falls back to the middle band`, normalizeDetail(missing), 'standard');
  }
  check('a level is accepted whatever the casing', normalizeDetail('  DeTaiLed '), 'detailed');

  console.log('\nThe level reaches the drawing instruction');

  for (const level of LEVELS) {
    const prompt = buildPrompt('Portrait', 0, 1, 'kid', '', null, level);
    check(`${level} carries its own wording`, prompt.includes(DETAIL_LEVELS[level].prompt), true);
    check(`${level} carries no other level's wording`,
      LEVELS.filter((other) => other !== level && prompt.includes(DETAIL_LEVELS[other].prompt)), []);
  }

  // The six-argument call is how every caller wrote it before this existed.
  // It has to keep working, and it has to come out with the default rather
  // than with nothing.
  const old = buildPrompt('Portrait', 0, 1, 'kid', '');
  check('a call that predates the feature still gets an instruction',
    old.includes(DETAIL_LEVELS[DEFAULT_DETAIL].prompt), true);

  console.log('\nThe level adds to the house rules, it does not replace them');

  // Both paths, because they build the prompt through different branches and a
  // family book is where the beards are.
  const CAST = [
    { name: 'Mum', subjectType: 'adult' },
    { name: 'Dad', subjectType: 'adult' },
    { name: 'Leo', subjectType: 'kid' }
  ];
  const PATHS = [['single', null], ['family', CAST]];

  for (const [path, cast] of PATHS) {
    for (const level of LEVELS) {
      const prompt = buildPrompt('Superhero', 3, 1, 'kid', '', cast, level);
      check(`${path}/${level} still forbids text`, /no text or captions of any kind/.test(prompt), true);
      check(`${path}/${level} still forbids shading`, /no shading, no gray tones/.test(prompt), true);
      check(`${path}/${level} still leaves hair open`, /open white space/.test(prompt), true);
      check(`${path}/${level} still names the scene and the camera`,
        /Scene: .*\. Camera: /.test(prompt), true);

      // A beard came back as hundreds of tiny dots - already grey, nothing left
      // for a child to colour - while the hair on the same head obeyed the rule
      // perfectly, because the rule said "hair" and a beard is not read as hair.
      // This can only prove the sentence is still in the prompt. Whether the
      // model obeys it is a question for scripts/render-family-book.js and a
      // look at the chin.
      check(`${path}/${level} reaches beards, not just hair`,
        /beard, moustache or stubble/.test(prompt), true);
      // Stippling is a field of separate dots, so it was none of the three
      // things the old list banned and slipped straight past it.
      check(`${path}/${level} rules out stippling`, /stippling/.test(prompt), true);
      check(`${path}/${level} rules out a field of small dots`,
        /any field of small dots/.test(prompt), true);
      check(`${path}/${level} rules out speckled texture on a beard`,
        /never speckles, flecks or shaded texture/.test(prompt), true);
      // Hair came back colourable but as the busiest thing on the page: a
      // curtain of very fine parallel strands. "A few strands" was already
      // there and was being read as a few hundred, so what this adds is the
      // spacing, not a smaller count.
      check(`${path}/${level} rules out a curtain of parallel strands`,
        /dense curtain of many fine parallel strands/.test(prompt), true);
      check(`${path}/${level} asks for white between the strands`,
        /well separated, with plenty of white showing between them/.test(prompt), true);
      // For a while Simple opened up the whole page except the head: four big
      // shapes in the scene, two hundred lines on the hair. BASE_STYLE sets the
      // floor; the level says how many strands it wants above it.
      check(`${path}/${level} says how much hair this level wants`,
        /\bHair (follows|carries|may carry)\b/.test(prompt), true);
    }
  }

  // Freckles are dots, they are wanted, and they are all over the sample pages.
  // The ban is on the mass, not the mark - so nothing may forbid dots outright.
  // Each level asks for a different amount, and no level is allowed to undo the
  // floor BASE_STYLE sets - a level may add strands, never density.
  const hairLines = LEVELS.map((l) => (DETAIL_LEVELS[l].prompt.match(/Hair[^.]*\./) || [''])[0]);
  check('every level says something about hair', hairLines.filter((h) => !h), []);
  check('and no two levels say the same thing', new Set(hairLines).size, LEVELS.length);
  check('simple is the one that names a number', /three or four separate strands/.test(DETAIL_LEVELS.simple.prompt), true);
  check('detailed adds strands but not density',
    /more strands, never a denser curtain/.test(DETAIL_LEVELS.detailed.prompt), true);

  check('the word dots appears exactly once', (BASE_STYLE.match(/dots/g) || []).length, 1);
  check('and that once is the field, not dots on their own',
    /any field of small dots/.test(BASE_STYLE), true);

  // Simple is one word away from a blank sheet with a child floating on it.
  check('simple still asks for a place', /reads as a real place/.test(DETAIL_LEVELS.simple.prompt), true);
  // Detailed is where lettering and crosshatching creep back in.
  check('detailed still rules out shading', /never shading/.test(DETAIL_LEVELS.detailed.prompt), true);
  check('detailed still rules out lettering', /no letters, words or numbers/.test(DETAIL_LEVELS.detailed.prompt), true);

  console.log('\nThe site can see the levels, and an order remembers one');

  const server = app.listen(0);
  try {
    const options = JSON.parse((await request(server, '/options')).body);
    check('/options lists all three', options.detailLevels.map((d) => d.key), LEVELS);
    check('/options labels them for a human',
      options.detailLevels.map((d) => `${d.label} ${d.ages}`),
      ['Simple 3-4', 'Standard 5-7', 'Detailed 8+']);
    check('/options names the default', options.defaultDetailLevel, 'standard');

    const placed = await request(server, '/orders', {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify({ childName: 'Ava', email: 'a@b.com', detailLevel: 'simple' })
    });
    check('an order keeps the level it was placed with',
      JSON.parse(placed.body).order.detailLevel, 'simple');

    const silent = await request(server, '/orders', {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify({ childName: 'Ava', email: 'a@b.com' })
    });
    check('an order that says nothing gets the middle band',
      JSON.parse(silent.body).order.detailLevel, 'standard');

    const nonsense = await request(server, '/orders', {
      method: 'POST',
      type: 'application/json',
      body: JSON.stringify({ childName: 'Ava', email: 'a@b.com', detailLevel: 'extremely detailed' })
    });
    check('a level nobody offers is not stored',
      JSON.parse(nonsense.body).order.detailLevel, 'standard');
  } finally {
    server.close();
  }

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
