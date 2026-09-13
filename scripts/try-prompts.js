#!/usr/bin/env node
// Renders ONE scene several different ways so you can see which prompt shape
// actually breaks the model off the reference photo's camera angle.
//
//   OPENAI_API_KEY=sk-... node scripts/try-prompts.js --photo ./me.jpg --subject adult
//
// Several people, each run on their own - one person per photo, never combined
// into a group scene. Pass a folder, or a comma-separated list:
//
//   node scripts/try-prompts.js --photos ./photos/kids --subject kid
//   node scripts/try-prompts.js --photos ./mum.jpg,./dad.jpg --subject adult
//
// Each photo gets its own folder of results under --out (default ./prompt-test)
// alongside variants.txt, which records what every variant asked for.
//
// Cost adds up multiplicatively: five variants across six people is thirty
// image calls. Settle the variant on ONE photo first, then re-run the winner
// across everyone with --only <name>, which is one image per person.
//
// --notes adds a detail to every variant, the same way the customer's own note
// reaches a real book: --notes "she loves her dog, include her dog".
//
// This file deliberately builds its own prompts and calls instead of reusing
// buildPrompt: it exists to test shapes that are NOT in production yet. When a
// variant wins, its shape moves into server.js and this script goes away.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { STORY_SCENES, BASE_STYLE: STYLE } = require('../server');

const KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-image-2';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
  }
  return args;
}

const PHOTO_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

// One entry per person. A folder is read as "everyone in here, separately";
// nobody is ever merged into a single group prompt.
function collectPhotos(value) {
  if (!value || value === 'true') return [];
  const out = [];
  value.split(',').map((v) => v.trim()).filter(Boolean).forEach(function (entry) {
    if (fs.existsSync(entry) && fs.statSync(entry).isDirectory()) {
      fs.readdirSync(entry)
        .filter((f) => PHOTO_EXTS.includes(path.extname(f).toLowerCase()))
        .sort()
        .forEach((f) => out.push(path.join(entry, f)));
    } else {
      out.push(entry);
    }
  });
  return out;
}

// Pulled from server.js rather than copied, so the test always exercises the
// same style text production sends.

// The camera the page is supposed to use. Deliberately one the reference photo
// cannot be: a selfie is never a full figure seen from below.
const CAMERA = 'full body, head to toe in the frame, seen from slightly below';

function variants(scene, subject, notes) {
  const extra = notes ? ` Also incorporate this detail where it fits naturally: ${notes}.` : '';
  return [
    {
      // What production sends today: style first, camera last, and the photo
      // handled with a list of don'ts.
      name: 'a-current',
      note: 'current production shape (style first, negative instructions)',
      body: `${STYLE} Keep the face, hair and features of ${subject} recognisable from the reference photo. Use the reference photo only for the faces, hair and features. Do not copy its pose, framing, background or camera angle: this page is a new drawing of the same people somewhere else, not the photo traced over. Scene: ${scene}. Camera: ${CAMERA}.${extra}`
    },
    {
      // Same words, different order: what to draw comes first.
      name: 'b-scene-first',
      note: 'scene and camera first, style constraints after',
      body: `Draw ${subject} ${scene}. ${CAMERA[0].toUpperCase()}${CAMERA.slice(1)}. ${STYLE} The attached photo is a likeness reference for the face only.${extra}`
    },
    {
      // Says affirmatively what the finished page IS, and names the photo's
      // role instead of forbidding things.
      name: 'c-identity-ref',
      note: 'affirmative target description, photo named as identity reference',
      body: `A new coloring book page showing ${subject} ${scene}. The whole figure is in the frame, head to toe, drawn from a low camera looking up, in a setting drawn from scratch. The attached photo is an identity reference: copy the face, hair and glasses from it so the person is recognisable, and invent everything else - pose, body, clothing, background, camera position. ${STYLE}${extra}`
    },
    {
      name: 'd-identity-ref-fidelity',
      note: 'same as c, plus input_fidelity: high',
      fidelity: 'high',
      body: `A new coloring book page showing ${subject} ${scene}. The whole figure is in the frame, head to toe, drawn from a low camera looking up, in a setting drawn from scratch. The attached photo is an identity reference: copy the face, hair and glasses from it so the person is recognisable, and invent everything else - pose, body, clothing, background, camera position. ${STYLE}${extra}`
    },
    {
      // No source image at all. A vision model writes a likeness description
      // once, and that text drives a plain generation, which has nothing to
      // anchor the camera to. Weakest likeness, strongest camera control.
      name: 'e-describe-then-generate',
      note: 'vision description -> /images/generations, no source image',
      describe: true
    }
  ];
}

async function post(url, body, headers) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, ...headers }, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (err) { throw new Error(`${res.status} non-JSON reply: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  return data;
}

async function describePerson(buffer, mimetype, model) {
  const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
  const data = await post('https://api.openai.com/v1/chat/completions', JSON.stringify({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this person the way a character sheet would, for an illustrator who will draw them from many angles and has never seen the photo. Cover age range, hair, face shape, glasses, and anything else that makes them recognisable. Do not describe the background, the pose, or the camera. Two or three sentences, no preamble.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }]
  }), { 'Content-Type': 'application/json' });
  return data.choices[0].message.content.trim();
}

async function renderEdit(buffer, mimetype, filename, prompt, fidelity) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  form.append('quality', 'medium');
  if (fidelity) form.append('input_fidelity', fidelity);
  form.append('image', new Blob([buffer], { type: mimetype }), filename);
  const data = await post('https://api.openai.com/v1/images/edits', form, {});
  return data.data[0].b64_json;
}

async function renderGenerate(prompt) {
  const data = await post('https://api.openai.com/v1/images/generations', JSON.stringify({
    model: MODEL, prompt, size: '1024x1024', quality: 'medium'
  }), { 'Content-Type': 'application/json' });
  return data.data[0].b64_json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const photos = collectPhotos(args.photos || args.photo);
  if (!photos.length) throw new Error('Pass a reference photo: --photo ./me.jpg, or --photos ./folder');
  if (!KEY) throw new Error('Set OPENAI_API_KEY first.');

  const theme = args.theme || 'Family Keepsake';
  if (!STORY_SCENES[theme]) throw new Error(`Unknown theme "${theme}". Try: ${Object.keys(STORY_SCENES).join(', ')}`);
  const sceneIndex = parseInt(args.scene, 10) || 0;
  const describeModel = args.describeModel || 'gpt-4o';
  const notes = args.notes && args.notes !== 'true' ? args.notes.trim() : '';
  const outDir = args.out || './prompt-test';

  const count = Math.min(3, Math.max(1, parseInt(args.kids, 10) || 1));
  const adult = args.subject === 'adult';
  const subject = count > 1
    ? (count === 2 ? 'both ' : 'all three ') + (adult ? 'people' : 'children')
    : (adult ? 'the person' : 'the child');

  let scene = (STORY_SCENES[theme][sceneIndex] || STORY_SCENES[theme][0]);
  scene = scene.replace(/^the child\s+/, '').replace(/\bthe child\b/g, subject);

  fs.mkdirSync(outDir, { recursive: true });

  let list = variants(scene, subject, notes);
  if (args.only && args.only !== 'true') list = list.filter((v) => v.name === args.only);
  if (!list.length) throw new Error('No variant matched --only.');

  console.log(`Scene: ${scene}`);
  console.log(`Wanted camera: ${CAMERA}`);
  console.log(`${photos.length} photo(s), each run on its own, ${list.length} variant(s) each`);
  console.log(`${photos.length * list.length} image call(s) -> ${outDir}\n`);

  const log = [];
  let failed = 0;
  for (const photo of photos) {
    // Each person is a separate run against their own photo. Nothing is shared
    // between them, so one bad photo cannot spoil anyone else's results.
    const who = path.basename(photo, path.extname(photo));
    const personDir = photos.length > 1 ? path.join(outDir, who) : outDir;
    fs.mkdirSync(personDir, { recursive: true });
    let buffer;
    try {
      buffer = fs.readFileSync(photo);
    } catch (err) {
      failed += list.length;
      console.error(`${who.padEnd(18)} SKIPPED  ${err.message}`);
      continue;
    }
    const mimetype = path.extname(photo).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    console.log(`${who}:`);

    for (const v of list) {
      try {
        let b64;
        let prompt = v.body;
        if (v.describe) {
          const description = await describePerson(buffer, mimetype, describeModel);
          prompt = `${STYLE} A coloring book page showing ${description} The scene: ${subject} ${scene}. Camera: ${CAMERA}.`
          + (notes ? ` Also incorporate this detail where it fits naturally: ${notes}.` : '');
          console.log(`  ${v.name}: description -> ${description.replace(/\s+/g, ' ').slice(0, 110)}...`);
          b64 = await renderGenerate(prompt);
        } else {
          b64 = await renderEdit(buffer, mimetype, path.basename(photo), prompt, v.fidelity);
        }
        fs.writeFileSync(path.join(personDir, `variant-${v.name}.png`), Buffer.from(b64, 'base64'));
        log.push(`--- ${who} / ${v.name} (${v.note}) ---\n${prompt}\n`);
        console.log(`  ${v.name.padEnd(26)} ok`);
      } catch (err) {
        failed++;
        log.push(`--- ${who} / ${v.name} (${v.note}) FAILED: ${err.message} ---\n${v.body || ''}\n`);
        console.error(`  ${v.name.padEnd(26)} FAIL ${err.message}`);
      }
    }
  }

  fs.writeFileSync(path.join(outDir, 'variants.txt'), log.join('\n'));
  const total = photos.length * list.length;
  console.log(`\n${total - failed}/${total} image(s) written to ${outDir}.`);
  console.log('Compare each against that person\'s photo: the one that is NOT a head-on portrait wins.');
  if (failed) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exit(1); });
