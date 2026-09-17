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

const { app, buildPrompt, DETAIL_LEVELS, DEFAULT_DETAIL, normalizeDetail } = require('../server.js');

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

  for (const level of LEVELS) {
    const prompt = buildPrompt('Superhero', 3, 1, 'kid', '', null, level);
    check(`${level} still forbids text`, /no text or captions of any kind/.test(prompt), true);
    check(`${level} still forbids shading`, /no shading, no gray tones/.test(prompt), true);
    check(`${level} still leaves hair open`, /open white space/.test(prompt), true);
    check(`${level} still names the scene and the camera`,
      /Scene: .*\. Camera: /.test(prompt), true);
  }

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
