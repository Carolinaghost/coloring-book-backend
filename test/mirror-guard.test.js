#!/usr/bin/env node
'use strict';

// Tests for the word check that decides whether a page may be mirrored
// (mirror-guard.js, used by server.js: maybeMirror).
//
//   npm test
//
// Pages get flipped so a book does not lean the same way throughout. A page
// with writing on it must not be, or the writing comes back reversed - which
// is the bug this exists to prevent.
//
// Negatives are real: every sample page in public/samples, none of which has
// words on it. Positives are made here by drawing solid block capitals onto
// those same pages, the way the model letters a sign or a jar, because a page
// that came back with writing on it is exactly the page we do not keep.
//
// A miss is the expensive direction: it ships a book of backwards words. A
// false alarm only costs one page its flip, so the thresholds in mirror-guard
// lean that way on purpose.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { hasWords, WORD_LENGTH } = require('../mirror-guard.js');
const SAMPLES_DIR = path.join(__dirname, '..', 'public', 'samples');

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

// Lettering in the style the model actually produces: solid, not outlined.
// Placed over a real page so the check has to pick it out of a drawing rather
// than off a blank sheet.
function letterOver(file, text, size, x, y) {
  const svg = Buffer.from(
    `<svg width="1024" height="1024"><text x="${x}" y="${y}" font-family="DejaVu Sans"`
    + ` font-weight="bold" font-size="${size}" fill="black">${text}</text></svg>`
  );
  return sharp(file).resize(1024, 1024).composite([{ input: svg }]).png().toBuffer();
}

async function main() {
  console.log('\nPages with no words (real sample pages)');

  const pages = fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.webp')).sort();
  check('there are pages to check', pages.length > 0, true);

  const falseAlarms = [];
  for (const page of pages) {
    if (await hasWords(fs.readFileSync(path.join(SAMPLES_DIR, page)))) falseAlarms.push(page);
  }
  check('none of them is mistaken for writing', falseAlarms, []);

  console.log('\nPages with words drawn on (the case that caused this)');

  // Sizes and wording taken from pages that really did come back lettered.
  const lettered = [
    ['DOG TREATS', 46, 300, 700],
    ['DOGS MAKE LIFE BETTER', 30, 120, 180],
    ['DOG LOVER', 40, 80, 760],
    ['LOVE IS A WET NOSE', 26, 260, 840],
    ['STOP DROP ROLL', 52, 240, 120],
    ['OPEN', 60, 520, 300]
  ];

  const missed = [];
  for (let i = 0; i < lettered.length; i++) {
    const [text, size, x, y] = lettered[i];
    // Spread across different pages so a result cannot come from one drawing.
    const page = path.join(SAMPLES_DIR, pages[i % pages.length]);
    if (!await hasWords(await letterOver(page, text, size, x, y))) missed.push(text);
  }
  check('every one of them is caught', missed, []);

  // Three would also catch a pair of eyes and the mask between them, which is
  // how rail-02 got held back before this was raised.
  check('a word is four letters or more', WORD_LENGTH >= 4, true);

  console.log('\nThe mirror itself');

  // The check is only worth having if maybeMirror actually obeys it. Sixty
  // throws of a coin that lands heads half the time: a page that still gets
  // flipped once is the bug back.
  const { maybeMirror } = require('../server.js');
  const clean = await sharp(path.join(SAMPLES_DIR, pages[0])).resize(1024, 1024).png().toBuffer();
  const signed = await letterOver(path.join(SAMPLES_DIR, pages[0]), 'DOG TREATS', 46, 200, 300);

  async function flipsIn(buffer, rounds) {
    const before = buffer.toString('base64');
    let flipped = 0;
    for (let i = 0; i < rounds; i++) {
      if (await maybeMirror(before) !== before) flipped++;
    }
    return flipped;
  }

  check('a lettered page is never flipped', await flipsIn(signed, 60), 0);
  // Loose on purpose - this is a coin flip, and a tight range would fail on
  // nothing but luck. It is here to catch the check refusing every page.
  const clearFlips = await flipsIn(clean, 60);
  check('a page with no words still gets flipped', clearFlips > 10 && clearFlips < 50, true);

  console.log('\nWhat happens when the check cannot run');
  let threw = false;
  try {
    await hasWords(Buffer.from('this is not an image'));
  } catch (err) {
    threw = true;
  }
  // server.js catches this and keeps the page unflipped; the point here is that
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
