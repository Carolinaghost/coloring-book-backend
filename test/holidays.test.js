#!/usr/bin/env node
'use strict';

// Tests for the holiday themes - Birthday, Christmas and Halloween
// (server.js: STORY_SCENES / THEME_OUTFITS / /options / /story-length).
//
//   npm test
//
// The holidays are sold to everyone - a kid, a grown-up star, siblings and a
// whole family - and the things most likely to go wrong with them are the
// things a holiday tempts a page into: a "Happy Birthday" banner, a name piped
// on a cake, a gift tag, a letter to Santa. BASE_STYLE forbids all lettering,
// but a scene that asks for a sign is a scene that argues with it, so the scene
// text is kept clean of the words that invite one. Whether the drawing comes
// back clean is a question for a real draw and a pair of eyes.

const http = require('http');

const { app, buildPrompt, wardrobeLine, STORY_SCENES, THEME_OUTFITS } = require('../server.js');

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

function get(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

const HOLIDAYS = ['Birthday', 'Christmas', 'Halloween'];
const LETTERING = /\b(signs?|banners?|written|writes?|writing|reads|letters?|lettering|name on|names?|tags?|cards?|words?)\b/i;
// Halloween is cute. These are the words that turn a page into a scary one.
const SCARY = /\b(scary|spooky|creepy|blood|bloody|gore|skull|skeleton|zombie|monster|witch|vampire|haunted|grave|graveyard|scream|frighten\w*|terrif\w*|horror)\b/i;
// Characters somebody else owns. Santa and a reindeer are fine; these are not.
const TRADEMARK = /\b(rudolph|grinch|frosty|elsa|olaf|mickey|minnie|spider-?man|batman|disney|pixar|marvel|pok[eé]mon|barbie)\b/i;

async function main() {
  console.log('\nEach holiday is a full theme');

  for (const theme of HOLIDAYS) {
    check(`${theme}: exists`, Array.isArray(STORY_SCENES[theme]), true);
    check(`${theme}: 15 scenes`, (STORY_SCENES[theme] || []).length, 15);
    check(`${theme}: no scene repeats`, new Set(STORY_SCENES[theme]).size, 15);
    check(`${theme}: has an outfit`, typeof (THEME_OUTFITS[theme] || {}).outfit, 'string');
    check(`${theme}: worn from page one`, (THEME_OUTFITS[theme] || {}).from, 0);
  }
  check('Birthday wears a paper party hat', /paper party hat/.test(THEME_OUTFITS.Birthday.outfit), true);
  check('Christmas wears a sweater, scarf and mittens',
    ['sweater', 'scarf', 'mittens'].filter((w) => !THEME_OUTFITS.Christmas.outfit.includes(w)), []);
  check('Halloween wears a wizard robe and pointed hat',
    /wizard robe/.test(THEME_OUTFITS.Halloween.outfit) && /pointed wizard hat/.test(THEME_OUTFITS.Halloween.outfit), true);

  console.log('\nNothing on the page asks for lettering');

  const lettered = [];
  for (const theme of HOLIDAYS) {
    STORY_SCENES[theme].forEach((scene, i) => {
      const hit = scene.match(LETTERING);
      if (hit) lettered.push(`${theme} #${i + 1}: ${hit[0]}`);
    });
    const outfitHit = THEME_OUTFITS[theme].outfit.match(LETTERING);
    if (outfitHit) lettered.push(`${theme} outfit: ${outfitHit[0]}`);
  }
  check('no scene or outfit invites a sign, banner, tag or name', lettered, []);
  // The wardrobe line must not ask for a picture on the clothes either.
  for (const theme of HOLIDAYS) {
    check(`${theme}: outfit asks for no logo, emblem or motif`,
      /\blogo\b|\bbrand\b|\bslogan\b|\bemblem\b|\bmotif\b|\bnumber\b|\bprinted\b/.test(THEME_OUTFITS[theme].outfit), false);
  }

  console.log('\nHalloween is cute, and nobody else owns the characters');

  const scary = STORY_SCENES.Halloween.concat(THEME_OUTFITS.Halloween.outfit).filter((s) => SCARY.test(s));
  check('nothing scary in Halloween', scary, []);
  const owned = [];
  for (const theme of HOLIDAYS) {
    STORY_SCENES[theme].forEach((scene, i) => { if (TRADEMARK.test(scene)) owned.push(`${theme} #${i + 1}`); });
  }
  check('no trademarked characters', owned, []);

  console.log('\nEvery cast fits every scene');

  // A grown-up star, two siblings and a whole family all get the scene with
  // "the child" swapped out. A scene that cannot take the swap would draw the
  // cast and then a child nobody uploaded.
  const family = [
    { name: 'Mum', subjectType: 'adult' },
    { name: 'Gran', subjectType: 'adult' },
    { name: 'Leo', subjectType: 'kid', star: true }
  ];
  const broken = [];
  for (const theme of HOLIDAYS) {
    STORY_SCENES[theme].forEach((_, i) => {
      const adult = buildPrompt(theme, i, 1, 'adult', '').split('Scene:')[1];
      const twins = buildPrompt(theme, i, 2, 'kid', '').split('Scene:')[1];
      const fam = buildPrompt(theme, i, 1, 'kid', '', family).split('Scene:')[1];
      if (!/^ the person /.test(adult)) broken.push(`${theme} #${i + 1} adult`);
      if (!/^ both children /.test(twins)) broken.push(`${theme} #${i + 1} twins`);
      if (!/^ Mum, Gran and Leo /.test(fam) || /\bthe child\b/.test(fam)) broken.push(`${theme} #${i + 1} family`);
    });
  }
  check('one grown-up, two kids and a family all read correctly', broken, []);
  check('a holiday family is dressed by name',
    /Mum, Gran and Leo are wearing a friendly wizard costume/.test(buildPrompt('Halloween', 3, 1, 'kid', '', family)), true);
  check('a lone child is dressed from page one',
    /the child is wearing a party outfit/.test(wardrobeLine('Birthday', 0, false, 'the child')), true);

  console.log('\nThe site is told about them');

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const options = JSON.parse((await get(server, '/options')).body);
    check('/options lists all three', HOLIDAYS.filter((t) => !options.themes.includes(t)), []);
    for (const theme of HOLIDAYS) {
      const len = JSON.parse((await get(server, '/story-length?theme=' + encodeURIComponent(theme))).body);
      check(`/story-length knows ${theme}`, len, { theme, sceneCount: 15 });
    }
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
