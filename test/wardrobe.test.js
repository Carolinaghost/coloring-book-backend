#!/usr/bin/env node
'use strict';

// Tests for the theme outfit - the line that says what the child is wearing
// (server.js: THEME_OUTFITS / wardrobeLine / buildPrompt).
//
//   npm test
//
// Why this exists. The prompt never mentioned clothing at all. PHOTO_USE told
// the model to take "faces, hair and features" from the photo, but a model with
// no wardrobe instruction still has to dress the child from somewhere, and the
// only somewhere it had was the snapshot. So a Superhero book put the cape on
// the four pages whose scene line happens to say "cape" and left the child in
// their own t-shirt for the other eleven, and an Adventure book - the whole
// sample set on the site - is fifteen pages of the same shirt and shorts with
// no explorer outfit anywhere. From the outside that reads as "only a couple of
// the pictures do it", which is exactly what came back from the ads.
//
// These tests check the wiring: that the sentence is present on every page of a
// costumed theme, that it is the SAME sentence on every page (a book whose hero
// changes clothes between pages is its own kind of broken), that it is absent
// where the child should be in their own clothes, and that it does not
// contradict BASE_STYLE by asking for a logo or lettering. Whether the drawing
// actually comes back in the outfit is a question for a real draw and a pair of
// eyes; no assertion can answer it.

const {
  buildPrompt, wardrobeLine, THEME_OUTFITS, STORY_SCENES
} = require('../server.js');

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

console.log('\nThe outfit is on every page');

// The bug in one assertion. Adventure page 7 names no clothing at all, so
// before this change the prompt for it said nothing about what to wear.
const mid = buildPrompt('Adventure scene', 6, 1, 'kid', '', null, 'standard');
check('Adventure page 7 says what to wear', /Wardrobe:/.test(mid), true);
check('Adventure page 7 names the safari hat', /safari hat/.test(mid), true);
check('Adventure page 7 overrules the photo',
  /Ignore the clothing in the reference photo completely/.test(mid), true);

// Every page of every costumed theme, not a sample of them.
for (const theme of Object.keys(THEME_OUTFITS)) {
  const total = STORY_SCENES[theme].length;
  const from = THEME_OUTFITS[theme].from;
  let dressed = 0;
  const lines = new Set();
  for (let i = 0; i < total; i++) {
    const line = wardrobeLine(theme, i, false, 'the child');
    if (line) { dressed++; lines.add(line); }
  }
  check(`${theme}: dressed on pages ${from + 1}-${total}`, dressed, total - from);
  check(`${theme}: the same outfit on all of them`, lines.size, 1);
}

console.log('\nWhere it should stay out of the way');

// Superhero page one is the child FINDING the cape. The story is the costume
// arriving, and it cannot arrive if it is already on.
check('Superhero page 1 is still the child in their own clothes',
  wardrobeLine('Superhero', 0, false, 'the child'), '');
check('Superhero page 2 has the costume on',
  /flowing|cape/.test(wardrobeLine('Superhero', 1, false, 'the child')), true);

// Two themes have no costume on purpose.
check('Portrait has no outfit', wardrobeLine('Portrait', 0, false, 'the child'), '');
check('Family Keepsake has no outfit', wardrobeLine('Family Keepsake', 5, false, 'the child'), '');
check('Portrait prompts say nothing about a wardrobe',
  /Wardrobe:/.test(buildPrompt('Portrait', 3, 1, 'kid', '', null, 'standard')), false);

// An unknown theme must not throw - buildPrompt falls back to Portrait scenes
// and the outfit lookup has to fall back with it rather than crash the draw.
check('an unknown theme is not a crash', wardrobeLine('Nonsense', 0, false, 'the child'), '');

console.log('\nIt agrees with the rest of the prompt');

// BASE_STYLE forbids logos, emblems with anything in them, and lettering on
// every surface in the picture. An outfit that asks for a chest emblem or a
// badge has to ask for an EMPTY one or the two instructions fight, and the one
// that loses is whichever the model read last.
const hero = wardrobeLine('Superhero', 4, false, 'the child');
check('the hero emblem is explicitly empty', /nothing at all drawn inside it/.test(hero), true);
const cop = wardrobeLine('Police Officer', 4, false, 'the child');
check('the police badge carries no words', /nothing written on it/.test(cop), true);
for (const theme of Object.keys(THEME_OUTFITS)) {
  const line = wardrobeLine(theme, 14, false, 'the child');
  check(`${theme}: asks for no logo or lettering`,
    /\blogo\b|\bbrand\b|\bslogan\b|\bwritten across\b|\bnumber\b/.test(line), false);
}

console.log('\nIt matches who the book is about');

check('one child reads "is wearing"',
  /the child is wearing/.test(buildPrompt('Doctor', 3, 1, 'kid', '', null, 'standard')), true);
check('two children read "are wearing"',
  /both children are wearing/.test(buildPrompt('Doctor', 3, 2, 'kid', '', null, 'standard')), true);
check('an adult book says person, not child',
  /the person is wearing/.test(buildPrompt('Doctor', 3, 1, 'adult', '', null, 'standard')), true);

const family = buildPrompt('Firefighter', 3, 2, 'kid', '', [
  { name: 'Malik', subjectType: 'kid', star: true },
  { name: 'Jasmin', subjectType: 'kid' }
], 'standard');
check('a family is dressed by name', /Malik and Jasmin are wearing/.test(family), true);

console.log('\nIt does not shove anything else out');

const full = buildPrompt('Firefighter', 2, 1, 'kid', 'she loves purple', null, 'simple');
check('the scene survives', /Scene: /.test(full), true);
check('the camera survives', /Camera: /.test(full), true);
check('the wardrobe comes before the notes',
  full.indexOf('Wardrobe:') < full.indexOf('she loves purple'), true);
check('the detail level is still last',
  full.indexOf('Wardrobe:') < full.lastIndexOf('.'), true);
check('the notes still land', /she loves purple/.test(full), true);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
