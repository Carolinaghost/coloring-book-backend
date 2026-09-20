#!/usr/bin/env node
'use strict';

// Tests for scripts/render-family-book.js - the family counterpart to
// render-test-book.js.
//
//   npm test
//
// This script exists to spend money on OpenAI, so the tests run it with
// --dry-run: everything happens except the call. What is worth protecting is
// the refusals. castLine() tells the model "one reference photo per person, in
// this same order" and renderScene sends them positionally as image[], so
// nothing downstream notices a photo list that has slipped by one. The book
// renders, it looks fine, and Dad's face is on Grandma. Every check below is
// there to make that impossible rather than unlikely.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const SCRIPT = path.join(__dirname, '..', 'scripts', 'render-family-book.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'family-book-'));
const outDir = path.join(tmp, 'out');

// Four one-pixel PNGs. Nothing reads them; they only need to exist and be
// distinguishable by name.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const photo = {};
for (const who of ['mum', 'dad', 'leo', 'nan']) {
  photo[who] = path.join(tmp, `${who}.png`);
  fs.writeFileSync(photo[who], PIXEL);
}

// Returns what the script printed and whether it refused, rather than throwing:
// a refusal is the thing under test, not an accident.
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args, '--dry-run', '--out', outDir], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const TWO = ['--photos', `${photo.mum},${photo.dad}`, '--names', 'Mum,Dad', '--types', 'adult,adult'];

function main() {
  console.log('\nIt refuses anything that could pair a face with the wrong name');

  const extraPhoto = run(['--photos', `${photo.mum},${photo.dad},${photo.leo}`, '--names', 'Mum,Dad']);
  check('an extra photo is refused', extraPhoto.ok, false);
  check('and the reason says which way round it is',
    /3 photo\(s\) but 2 name\(s\)/.test(extraPhoto.output), true);
  check('and it says why that matters',
    /wrong face on the wrong person/.test(extraPhoto.output), true);

  const extraName = run(['--photos', `${photo.mum},${photo.dad}`, '--names', 'Mum,Dad,Leo']);
  check('an extra name is refused', extraName.ok, false);
  check('and that reason is the right way round too',
    /2 photo\(s\) but 3 name\(s\)/.test(extraName.output), true);

  const halfTypes = run(['--photos', `${photo.mum},${photo.dad}`, '--names', 'Mum,Dad', '--types', 'adult']);
  check('a short list of types is refused', halfTypes.ok, false);
  check('because it would slide along the cast too',
    /1 type\(s\) but 2 name\(s\)/.test(halfTypes.output), true);

  console.log('\nAnd anything else it cannot honestly draw');

  const alone = run(['--photos', photo.mum, '--names', 'Mum']);
  check('one person is not a family book', alone.ok, false);
  check('and it points at the script that does do that',
    /render-test-book\.js/.test(alone.output), true);

  const crowd = run([
    '--photos', [photo.mum, photo.dad, photo.leo, photo.nan, photo.mum, photo.dad].join(','),
    '--names', 'A,B,C,D,E,F'
  ]);
  check('more people than a family book holds is refused', crowd.ok, false);
  check('and it says the ceiling', /at most 5/.test(crowd.output), true);

  check('a person who is neither kid nor adult is refused',
    run([...TWO.slice(0, 4), '--types', 'adult,grandma']).ok, false);
  check('a star nobody is called is refused',
    run([...TWO, '--star', 'Leo']).ok, false);
  check('a theme that does not exist is refused',
    run([...TWO, '--theme', 'Dinosaurs']).ok, false);
  check('a detail level that does not exist is refused',
    run([...TWO, '--detail', 'very']).ok, false);
  check('a photo that is not there is refused',
    run(['--photos', `${photo.mum},${path.join(tmp, 'nobody.png')}`, '--names', 'Mum,Dad']).ok, false);
  check('no photos at all is refused', run(['--names', 'Mum,Dad']).ok, false);
  check('no names at all is refused', run(['--photos', `${photo.mum},${photo.dad}`]).ok, false);

  console.log('\nWhat it draws is a family book, not a single-subject one');

  const ok = run([...TWO, '--pages', '1']);
  check('a matched cast runs', ok.ok, true);
  const prompt = fs.readFileSync(path.join(outDir, 'prompts.txt'), 'utf8');
  check('castLine ran, so the photos are tied to the name order',
    /one reference photo per person, in this same order: Mum \(an adult\) and Dad \(an adult\)/.test(prompt), true);
  check('the subject is the named cast, not one child and not "the family"',
    /Scene: Mum and Dad /.test(prompt), true);
  check('and the cast is closed so no relatives get invented',
    /These 2 are the only people this story is about/.test(prompt), true);
  check('and it uses the several-photos wording',
    /Use the reference photos only for faces/.test(prompt), true);
  check('the pairing is printed before anything is spent',
    /1\. Mum \(adult\).*mum\.png[\s\S]*2\. Dad \(adult\).*dad\.png/.test(ok.output), true);
  check('a dry run draws nothing', fs.readdirSync(outDir), ['prompts.txt']);

  console.log('\nThe story follows the right person');

  const withKid = run([
    '--photos', `${photo.mum},${photo.dad},${photo.leo}`,
    '--names', 'Mum,Dad,Leo', '--types', 'adult,adult,kid', '--pages', '1'
  ]);
  check('with nobody named, it follows the only child',
    /keep Leo at the centre/.test(fs.readFileSync(path.join(outDir, 'prompts.txt'), 'utf8')), true);
  check('and it says so on screen rather than leaving you to guess',
    /no --star given/.test(withKid.output), true);

  run([
    '--photos', `${photo.mum},${photo.dad},${photo.leo}`,
    '--names', 'Mum,Dad,Leo', '--types', 'adult,adult,kid', '--star', 'Dad', '--pages', '1'
  ]);
  check('naming a star overrides that',
    /keep Dad at the centre/.test(fs.readFileSync(path.join(outDir, 'prompts.txt'), 'utf8')), true);

  console.log('\nThe detail level carries through');

  run([...TWO, '--detail', 'simple', '--pages', '1']);
  check('simple reaches the page',
    /Detail level: very simple/.test(fs.readFileSync(path.join(outDir, 'prompts.txt'), 'utf8')), true);
  run([...TWO, '--pages', '1']);
  check('and saying nothing still means standard',
    /Detail level: moderate/.test(fs.readFileSync(path.join(outDir, 'prompts.txt'), 'utf8')), true);

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailed:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main();
