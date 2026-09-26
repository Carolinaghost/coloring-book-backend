#!/usr/bin/env node
'use strict';

// Tests for family books - several people, a photo each, one book
// (server.js: cleanPeople / castLine / buildPrompt / /convert / /options).
//
//   npm test
//
// The thing worth protecting here is that a family book cannot quietly become a
// worse single-subject book. If the cast goes missing the pages still render,
// just of the wrong people, and nobody finds out until a parent opens the PDF.
// So these check the cast actually reaches the prompt, and that a mismatch
// between photos and names is refused rather than guessed at.

const http = require('http');

const { app, buildPrompt, MAX_PEOPLE, STORY_SCENES } = require('../server.js');

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

// A multipart body with N photos, built by hand so the test does not need a
// form library to exercise the upload path.
function multipart(fields, files) {
  const boundary = '----familytest' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n`
      + 'Content-Type: image/png\r\n\r\n'));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

const FAMILY = [
  { name: 'Mum', subjectType: 'adult' },
  { name: 'Dad', subjectType: 'adult' },
  { name: 'Leo', subjectType: 'kid' }
];

async function main() {
  console.log('\nThe cast reaches the drawing instruction');

  const family = buildPrompt('Family Keepsake', 0, 1, 'kid', '', FAMILY);
  check('everyone is named', ['Mum', 'Dad', 'Leo'].filter((n) => !family.includes(n)), []);
  check('the photos are tied to the order they are sent in',
    family.includes('one reference photo per person, in this same order'), true);
  check('ages are held apart', family.includes('the adults as adults and the children as children'), true);
  check('the scene names the cast, not one child and not "the family"',
    family.includes('Mum, Dad and Leo baking cookies'), true);
  check('"the family" never reaches the model', /\bthe family\b/.test(family), false);
  check('no leftover "the child"', /\bthe child\b/.test(family.split('Scene:')[1]), false);

  console.log('\nThe child is the one the story follows');

  // The book is bought for a child to colour. Whoever is uploaded first, the
  // story has to be about the child, or a parent gets a book starring themselves.
  check('a child is the centre by default', family.includes("this is Leo's story"), true);
  const adultsFirst = buildPrompt('Superhero', 0, 1, 'kid', '', [
    { name: 'Gran', subjectType: 'adult' }, { name: 'Ivy', subjectType: 'kid' }
  ]);
  check('even when adults are listed first', adultsFirst.includes("this is Ivy's story"), true);
  // An explicit choice wins, for the family where more than one child is in it.
  const chosen = buildPrompt('Superhero', 0, 1, 'kid', '', [
    { name: 'Ivy', subjectType: 'kid' }, { name: 'Sam', subjectType: 'kid', star: true }
  ]);
  check('an explicit choice wins', chosen.includes("this is Sam's story"), true);
  check('the others are around them, not instead of them',
    family.includes('never instead of Leo'), true);

  console.log('\nThe cast is closed');

  // Order 64 came back with a mother, a father and a grandmother drawn in that
  // nobody had uploaded, because the scene subject was the words "the family".
  // Two things stop it: the cast is named in the scene line, and the model is
  // told in as many words that nobody else is in the story.
  const pair = buildPrompt('Superhero', 0, 1, 'kid', '', [
    { name: 'Malik', subjectType: 'kid' }, { name: 'Jasmin', subjectType: 'kid', star: true }
  ]);
  check('the scene names them both', pair.includes('Malik and Jasmin discover'), true);
  check('the count is stated', pair.includes('These 2 are the only people this story is about'), true);
  check('inventing relatives is ruled out',
    pair.includes('no extra parents, brothers, sisters or grandparents'), true);
  check('and scene-called extras are still allowed',
    pair.includes('Anyone else appears only if the scene below names them'), true);
  // The scenes that do call for other people must still read correctly.
  const crowd = buildPrompt('Superhero', 11, 1, 'kid', '', [
    { name: 'Malik', subjectType: 'kid' }, { name: 'Jasmin', subjectType: 'kid', star: true }
  ]);
  check('a crowd scene stays plural and keeps its crowd',
    crowd.includes('Malik and Jasmin are cheered on by a crowd'), true);
  // Three names join with commas, and the verb still agrees.
  check('three names read as a list', family.includes('Mum, Dad and Leo'), true);

  console.log('\nA family added as photos only');

  // The site no longer asks each person's name or whether they are a child or
  // a grown-up: it sends the photos in order as Person 1, Person 2, ... with
  // the first one as the star, and 'auto' for their age.
  const photosOnly = buildPrompt('Superhero', 0, 1, 'kid', '', [
    { name: 'Person 1', subjectType: 'auto', star: true },
    { name: 'Person 2', subjectType: 'auto' },
    { name: 'Person 3', subjectType: 'auto' }
  ]);
  check('each is drawn at the age they look in their photo',
    photosOnly.includes('Person 2 (drawn at the age they look in their photo)'), true);
  check('nobody is called a child or an adult by guesswork',
    /Person \d \((a child|an adult)\)/.test(photosOnly), false);
  check('the first photo is the star', photosOnly.includes("this is Person 1's story"), true);
  check('the cast is still closed', photosOnly.includes('These 3 are the only people this story is about'), true);
  check('the scene still names them, not "the family"',
    photosOnly.includes('Person 1, Person 2 and Person 3 discover'), true);
  check('an unknown age still reads as a child, as before',
    buildPrompt('Superhero', 0, 1, 'kid', '', [{ name: 'A', subjectType: 'x' }, { name: 'B' }]).includes('A (a child)'), true);

  console.log('\nEvery theme can carry a family');

  // A family book works by swapping "the child" out of the scene. A scene that
  // never says it would render with the family unmentioned - the page would
  // come back with nobody the parent recognises on it.
  const sceneless = [];
  for (const [theme, scenes] of Object.entries(STORY_SCENES)) {
    scenes.forEach((scene, i) => {
      if (!/\bthe child\b/.test(scene)) sceneless.push(`${theme} p${i + 1}`);
    });
  }
  check('every scene in every theme names the child', sceneless, []);

  // And the swap really happens, on a theme other than the one it was built on.
  const everyTheme = Object.keys(STORY_SCENES).filter((theme) => {
    const built = buildPrompt(theme, 0, 1, 'kid', '', FAMILY);
    const scene = built.split('Scene:')[1] || '';
    return !scene.includes('Mum, Dad and Leo') || /\bthe child\b/.test(scene);
  });
  check('and the cast reaches the scene on all of them', everyTheme, []);

  console.log('\nA one-person book is left exactly as it was');

  const single = buildPrompt('Family Keepsake', 0, 1, 'kid', '');
  check('still speaks of one photo', single.includes('Use the reference photo only for the faces'), true);
  check('no cast line', single.includes('one reference photo per person'), false);
  // One name is not a family - it must not change the wording a lone child gets.
  check('one person is not a family',
    buildPrompt('Family Keepsake', 0, 1, 'kid', '', [FAMILY[2]]), single);

  console.log('\nBad input cannot reach the model');

  const tooMany = Array.from({ length: MAX_PEOPLE + 3 }, (_, i) => ({ name: `P${i}`, subjectType: 'kid' }));
  const capped = buildPrompt('Family Keepsake', 0, 1, 'kid', '', tooMany);
  check('the cast is capped', capped.includes(`P${MAX_PEOPLE}`), false);
  check('and keeps the ones it allows', capped.includes(`P${MAX_PEOPLE - 1}`), true);
  // A nameless person would reach the model as an unnamed face in a numbered
  // list, which is how a book comes back with the wrong person in it.
  const unnamed = buildPrompt('Family Keepsake', 0, 1, 'kid', '', [
    { name: 'Mum', subjectType: 'adult' }, { name: '', subjectType: 'kid' }, { name: 'Leo', subjectType: 'kid' }
  ]);
  check('a nameless person is dropped', unnamed.includes('Mum (an adult) and Leo (a child)'), true);

  console.log('\nOrdering a preview');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  try {
    const options = JSON.parse((await request(server, '/options')).body);
    check('the site is told the family limits', options.family.maxPeople, MAX_PEOPLE);
    check('and that two people make a family', options.family.minPeople, 2);

    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    // Three photos but two names: the model would silently draw the wrong
    // person, so this has to be refused before it costs anyone an image call.
    const mismatch = multipart(
      { theme: 'Family Keepsake', sceneIndex: '0', people: JSON.stringify(FAMILY.slice(0, 2)) },
      [
        { field: 'photos', name: 'a.png', data: png },
        { field: 'photos', name: 'b.png', data: png },
        { field: 'photos', name: 'c.png', data: png }
      ]
    );
    const res = await request(server, '/convert', { method: 'POST', body: mismatch.body, type: mismatch.type });
    check('photos without names are refused', res.status, 400);
    check('and the reason says which way round it is', /3 photo\(s\) but 2 name\(s\)/.test(res.body), true);

    const noPhotos = multipart({ theme: 'Family Keepsake', sceneIndex: '0' }, []);
    const empty = await request(server, '/convert', { method: 'POST', body: noPhotos.body, type: noPhotos.type });
    check('no photo at all is still refused', empty.status, 400);

    // The cast sentence lets a scene call for someone by name - that is how a
    // cheering crowd gets drawn. So a scene that says "a grandchild" or "her
    // mum" quietly adds a person nobody uploaded, and the customer opens the
    // PDF to find a stranger in the family. Found on order 67: every Family
    // Keepsake book drew a fifth child on page 12. Relatives are the cast's
    // job, never the scene's.
    const RELATIVE = /\b(grandchild|grandchildren|grandson|granddaughter|grandparent|grandparents|grandma|grandmother|grandpa|grandfather|mother|mum|mom|father|dad|parent|parents|brother|sister|sibling|siblings|son|daughter|husband|wife)\b/i;
    const namedRelatives = [];
    for (const [theme, scenes] of Object.entries(STORY_SCENES)) {
      scenes.forEach((scene, i) => {
        const hit = scene.match(RELATIVE);
        if (hit) namedRelatives.push(`${theme} #${i + 1}: ${hit[0]}`);
      });
    }
    check('no scene names a relative the cast may not contain', namedRelatives, []);
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
