#!/usr/bin/env node
'use strict';

// Tests for how a page is stored (page-encode.js).
//
//   npm test
//
// This encoding is applied to pages customers have already bought, and the
// original pixels do not come back. So the tests that matter are not "is it
// smaller" - they are the three properties that make rewriting sold work safe:
//
//   the customer's PDF does not change,
//   running it twice changes nothing,
//   and anything it cannot handle comes back untouched rather than broken.

const sharp = require('sharp');
const path = require('path');
const { encodeForStorage } = require('../page-encode.js');
const { buildBookPdf } = require('../pdf.js');

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

const FIX = path.join(__dirname, 'fixtures', 'no-words');
const asUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64');

async function main() {
  const original = await sharp(path.join(FIX, 'owen-p01.webp')).png().toBuffer();
  const before = asUrl(original);
  const after = await encodeForStorage(before);

  console.log('\nIt is much smaller');
  console.log(`         (${(before.length / 1024).toFixed(0)} KB -> ${(after.length / 1024).toFixed(0)} KB)`);
  check('the stored page shrinks', after.length < before.length / 5, true);
  check('and it is still a data URL', after.startsWith('data:image/png;base64,'), true);

  const bin = (d) => Buffer.from(d.slice(d.indexOf(',') + 1), 'base64');
  const m = await sharp(bin(after)).metadata();
  check('same size on the page', [m.width, m.height], [1024, 1024]);

  console.log('\nThe customer\'s book does not change');

  // The reason this is safe to run on orders already sold: pdf.js quantises to
  // these same four levels on its way into the file, so the book built from a
  // re-encoded page is the book built from the original.
  const mk = (url) => buildBookPdf({ childName: 'Ava', theme: 'Portrait', pages: [{ sceneIndex: 0, image: url }] });
  const pdfBefore = await mk(before);
  const pdfAfter = await mk(after);
  check('byte for byte the same PDF', pdfAfter.equals(pdfBefore), true);

  console.log('\nRunning it twice changes nothing');

  // Which is what makes a migration that stops halfway safe to simply re-run.
  const twice = await encodeForStorage(after);
  check('the second pass is a no-op', twice, after);

  console.log('\nWhat it refuses to touch');

  // A page that fails to save is a hole in a customer's book, so anything it
  // cannot handle comes back exactly as it arrived.
  check('junk comes back untouched', await encodeForStorage('not a data url'), 'not a data url');
  check('null comes back null', await encodeForStorage(null), null);
  const broken = 'data:image/png;base64,' + Buffer.from('this is not a png').toString('base64');
  check('an unreadable image comes back untouched', await encodeForStorage(broken), broken);

  // Something already small must not be made bigger by re-encoding it.
  const tiny = asUrl(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
    .png().toBuffer());
  const tinyOut = await encodeForStorage(tiny);
  check('never returns something larger than it was given',
    tinyOut.length <= tiny.length, true);

  console.log('\nEvery real page shrinks, not just a lucky one');

  const fs = require('fs');
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.webp'));
  let worst = 0, total = 0, smaller = 0;
  for (const f of files) {
    const src = asUrl(await sharp(path.join(FIX, f)).png().toBuffer());
    const out = await encodeForStorage(src);
    const ratio = src.length / out.length;
    if (out.length < src.length) smaller++;
    worst = worst === 0 ? ratio : Math.min(worst, ratio);
    total += ratio;
  }
  console.log(`         (${files.length} real pages, ${(total / files.length).toFixed(1)}x on average, `
    + `${worst.toFixed(1)}x at worst)`);
  check('all of them shrink', smaller, files.length);
  check('and the worst case is still worth doing', worst > 4, true);

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
