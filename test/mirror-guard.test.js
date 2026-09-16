#!/usr/bin/env node
'use strict';

// Tests for the word check that decides whether a page may be mirrored
// (mirror-guard.js, used by server.js: maybeMirror).
//
//   npm test
//
// The fixtures in test/fixtures are real pages from a 60-page run, at the size
// the model actually produces. Six of them came back with lettering drawn in;
// twelve came back clean. They are the whole point of this file.
//
// An earlier version of this suite used lettering drawn on here with sharp -
// solid bold type - and passed while the guard missed all six real pages. Solid
// type is the one kind of lettering these pages never contain: the model
// letters a sign in the same thin stroke as the drawing, because the words are
// meant to be coloured in. Generated positives cannot stand in for real ones
// here. Do not reintroduce them as the only positive case.
//
// A miss is the expensive direction: it ships a book with backwards writing in
// it. A false alarm costs one page the flip it would have got.

const fs = require('fs');
const path = require('path');

const { hasWords, WORD_LENGTH } = require('../mirror-guard.js');
const FIXTURES = path.join(__dirname, 'fixtures');

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

function fixtures(group) {
  return fs.readdirSync(path.join(FIXTURES, group)).filter((f) => f.endsWith('.webp')).sort();
}

async function main() {
  console.log('\nReal pages that came back with words on them');
  // p01 DOG TREATS / LOVE IS A WET NOSE & WARM COOKIES, p04 and p08 LOVE DOGS,
  // p10 DOG LOVER, p11 DOG MOM, p15 DOGS MAKE LIFE BETTER.
  const lettered = fixtures('words');
  check('all six are present', lettered.length, 6);

  const missed = [];
  for (const page of lettered) {
    if (!await hasWords(fs.readFileSync(path.join(FIXTURES, 'words', page)))) missed.push(page);
  }
  check('every one is caught', missed, []);

  console.log('\nReal pages with no words on them');
  const clean = fixtures('no-words');
  check('all twelve are present', clean.length, 12);

  const falseAlarms = [];
  for (const page of clean) {
    if (await hasWords(fs.readFileSync(path.join(FIXTURES, 'no-words', page)))) falseAlarms.push(page);
  }
  check('none is mistaken for writing', falseAlarms, []);

  console.log('\nThe mirror itself');

  // Mirroring ships off, so testing maybeMirror as configured would prove
  // nothing. Force it fully on: then every call takes the flip path and the
  // only thing standing between a lettered page and a reversed one is the
  // word check - which is exactly what needs proving.
  process.env.MIRROR_CHANCE = '1';
  const { maybeMirror } = require('../server.js');
  const textGuard = require('../text-guard.js');

  // maybeMirror asks two guards: the pixel check in mirror-guard.js, and the
  // vision check in text-guard.js, which is a real OpenAI call. Left alone that
  // makes this file need a network and a billing account to run, and it behaved
  // differently depending on whether a key happened to be in the environment -
  // it passed locally and failed in CI, which is the worst of both.
  //
  // So the vision half is stubbed here and its answer set per case. That is not
  // a way of dodging it: text-guard.js answering "there might be words" with no
  // key is deliberate and correct, because a page that cannot be checked must
  // never be flipped. This file is about what maybeMirror does with the answer.
  const realHasText = textGuard.hasText;

  async function flipsIn(file, rounds) {
    const before = fs.readFileSync(file).toString('base64');
    let flipped = 0;
    for (let i = 0; i < rounds; i++) {
      if (await maybeMirror(before) !== before) flipped++;
    }
    return flipped;
  }

  try {
    // Vision says the page is clean, so the pixel check is the only thing left
    // standing between a lettered page and a reversed one. Sixty throws with
    // the coin removed; one flip here is a book of backwards writing in the post.
    textGuard.hasText = async () => false;
    check('a page with writing is never flipped',
      await flipsIn(path.join(FIXTURES, 'words', 'dogwalk-p15.webp'), 60), 0);

    // And the feature still works when it is turned on, rather than the guards
    // quietly refusing everything.
    check('a page with no words still flips',
      await flipsIn(path.join(FIXTURES, 'no-words', 'owen-p09.webp'), 10), 10);

    // The other way round: a page the pixel check is happy with, that vision
    // says has lettering on it. Either guard alone has to be enough to stop a
    // flip, or the second one is decoration.
    textGuard.hasText = async () => true;
    check('vision alone can stop a flip',
      await flipsIn(path.join(FIXTURES, 'no-words', 'owen-p09.webp'), 20), 0);

    // A guard that throws must not read as "no words, go ahead".
    textGuard.hasText = async () => { throw new Error('vision check unavailable'); };
    check('a guard that fails stops the flip too',
      await flipsIn(path.join(FIXTURES, 'no-words', 'owen-p09.webp'), 20), 0);
  } finally {
    textGuard.hasText = realHasText;
  }

  check('three letters make a word', WORD_LENGTH, 3);

  console.log('\nWhat happens when the check cannot run');
  let threw = false;
  try {
    await hasWords(Buffer.from('this is not an image'));
  } catch (err) {
    threw = true;
  }
  // server.js catches this and keeps the page unflipped. The point here is that
  // it raises rather than quietly answering "no words, go ahead and flip".
  check('unreadable input raises instead of passing', threw, true);

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
