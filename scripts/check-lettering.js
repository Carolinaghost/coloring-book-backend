#!/usr/bin/env node
// Does a blunter instruction stop the model writing on things?
//
//   node scripts/check-lettering.js --photo ./her.jpg
//
// Needs an OpenAI credential: either OPENAI_API_KEY in the environment, or an
// outbound proxy that attaches one to api.openai.com on the way out.
//
// Behind a proxy, two things bite. Node's built-in fetch ignores HTTPS_PROXY
// unless you run with NODE_USE_ENV_PROXY=1. And a proxy may cut the request off
// before the drawing is finished - measured against ours, a medium-quality page
// takes about 31 seconds and is dropped at 30, while a low-quality one finishes
// in 18 and succeeds. If pages keep failing with "upstream request failed"
// after roughly half a minute, that is the ceiling, not the prompt. Run it
// somewhere without a proxy in between.
//
// BASE_STYLE used to say only "no text or captions", and the model lettered
// signs, jars and cushions in spite of it - four pages in a sixty-page run
// shipped with the writing mirrored. Detecting that lettering afterwards turned
// out to be hard (mirror-guard.js, and the note at the top of it), so
// BASE_STYLE now names the objects and tells the model to leave them blank.
//
// Whether that worked is an open question until somebody renders pages. This
// puts the old wording and the shipped wording through the same scenes and
// reports how many pages came back with writing on them.
//
// Options:
//   --photo <path>      reference photo (required)
//   --theme <name>      default "Family Keepsake" - every lettered page in the
//                       run so far came from that book
//   --scenes <list>     1-based scene numbers, default 1,4,8,10,11,15, which
//                       are the six that actually produced lettering
//   --subject kid|adult default adult
//   --notes <text>      default "she loves her dog" - the note is what turned
//                       the props into DOG TREATS and DOG MOM, so a run
//                       without it does not reproduce the conditions
//   --variants <list>   before,after (default both)
//   --out <dir>         default ./lettering-check
//
// Cost: scenes x variants image calls. The default is 12.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildPrompt, renderScene, canCallOpenAI, STORY_SCENES, BASE_STYLE } = require('../server');
const { hasWords } = require('../mirror-guard');

// What BASE_STYLE said before the no-writing clause went in. Kept here as the
// control: without it this compares the shipped prompt against itself.
const OLD_STYLE = BASE_STYLE.replace(
  /no text or captions of any kind - .*? anywhere in the picture - simple line art/,
  'no text or captions, simple line art'
);

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.photo) throw new Error('Pass a reference photo: --photo ./her.jpg');
  if (!canCallOpenAI) throw new Error('No OpenAI credential. Set OPENAI_API_KEY, or run somewhere the outbound proxy attaches one.');

  const theme = args.theme || 'Family Keepsake';
  if (!STORY_SCENES[theme]) {
    throw new Error(`Unknown theme "${theme}". Try one of: ${Object.keys(STORY_SCENES).join(', ')}`);
  }
  const scenes = (args.scenes && args.scenes !== 'true' ? args.scenes : '1,4,8,10,11,15')
    .split(',').map((n) => parseInt(n, 10) - 1)
    .filter((n) => n >= 0 && n < STORY_SCENES[theme].length);
  const subjectType = args.subject === 'kid' ? 'kid' : 'adult';
  const notes = args.notes === undefined ? 'she loves her dog'
    : (args.notes === 'true' ? '' : args.notes);
  const outDir = args.out || './lettering-check';
  const wanted = (args.variants && args.variants !== 'true' ? args.variants : 'before,after').split(',');

  const variants = [
    { name: 'before', style: OLD_STYLE, note: 'the wording that let the lettering through' },
    { name: 'after', style: BASE_STYLE, note: 'what production sends now' }
  ].filter((v) => wanted.includes(v.name));

  const buffer = fs.readFileSync(args.photo);
  const ext = path.extname(args.photo).toLowerCase();
  const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg';
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Theme "${theme}", ${subjectType}, scenes ${scenes.map((n) => n + 1).join(',')}`);
  console.log(`Notes: ${notes || '(none)'}`);
  console.log(`${scenes.length * variants.length} image call(s) against your account.\n`);

  const tally = {};
  const prompts = [];

  for (const variant of variants) {
    fs.mkdirSync(path.join(outDir, variant.name), { recursive: true });
    tally[variant.name] = { rendered: 0, lettered: [], failed: [] };
    console.log(`--- ${variant.name} (${variant.note}) ---`);

    for (const sceneIndex of scenes) {
      const prompt = buildPrompt(theme, sceneIndex, 1, subjectType, notes)
        .replace(BASE_STYLE, variant.style);
      prompts.push(`--- ${variant.name} scene ${sceneIndex + 1} ---\n${prompt}\n`);
      const label = `scene ${String(sceneIndex + 1).padStart(2)}`;

      try {
        const dataUrl = await renderScene({
          buffer, mimetype, filename: path.basename(args.photo), prompt, paid: true
        });
        const png = Buffer.from(dataUrl.split(',')[1], 'base64');
        const file = path.join(outDir, variant.name, `scene-${String(sceneIndex + 1).padStart(2, '0')}.png`);
        fs.writeFileSync(file, png);
        tally[variant.name].rendered++;

        const words = await hasWords(png);
        if (words) tally[variant.name].lettered.push(sceneIndex + 1);
        console.log(`${label}  ${words ? 'WORDS' : 'clean'}  ${file}`);
      } catch (err) {
        tally[variant.name].failed.push(sceneIndex + 1);
        console.error(`${label}  FAIL  ${err.message}`);
      }
    }
    console.log('');
  }

  fs.writeFileSync(path.join(outDir, 'prompts.txt'), prompts.join('\n'));

  console.log('================ result ================');
  for (const variant of variants) {
    const t = tally[variant.name];
    console.log(`${variant.name.padEnd(8)} ${t.lettered.length}/${t.rendered} pages with words`
      + (t.lettered.length ? `  (scenes ${t.lettered.join(', ')})` : '')
      + (t.failed.length ? `  [${t.failed.length} failed to render]` : ''));
  }
  console.log('');
  console.log('"WORDS" is mirror-guard\'s verdict, and it over-reports - it flags about one');
  console.log('clean page in five. Open the pages before believing a number either way.');
  console.log(`Pages and prompts are in ${outDir}.`);
  console.log('');
  console.log('If "after" is clean and "before" is not, the wording did its job and mirroring');
  console.log('can go back on: MIRROR_CHANCE=0.5, with the word check as a backstop rather');
  console.log('than the whole defence. If "after" still letters pages, the wording is not');
  console.log('enough on its own - leave mirroring off and put OCR behind it instead.');
  console.log('');
  console.log('Worth a look while the pages are open: the no-writing clause made BASE_STYLE');
  console.log('longer, and a longer style can crowd out the rules after it. Check the hair is');
  console.log('still open white space and the pages are not copying the photo.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
