#!/usr/bin/env node
// Does a blunter instruction stop the model writing on things?
//
//   OPENAI_API_KEY=sk-... node scripts/check-lettering.js --photo ./her.jpg
//
// BASE_STYLE already says "no text or captions" and the model letters signs,
// jars and cushions anyway - four pages in a sixty-page run shipped with the
// writing mirrored. Detecting that lettering afterwards turned out to be hard
// (mirror-guard.js, and the note at the top of it). Not producing it in the
// first place would make the whole problem go away, so it is worth one run
// before building anything cleverer.
//
// This renders the same scenes twice, once with the wording production sends
// today and once with the candidate below, and reports how many pages came
// back with writing on them.
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
//   --variants <list>   current,blank (default both)
//   --out <dir>         default ./lettering-check
//
// Cost: scenes x variants image calls. The default is 12.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildPrompt, renderScene, STORY_SCENES, BASE_STYLE } = require('../server');
const { hasWords } = require('../mirror-guard');

// The candidate. BASE_STYLE's "no text or captions" is a rule about the page;
// this names the things the model actually writes on, because that is where it
// has been putting words in spite of the rule.
const BLANK_STYLE = BASE_STYLE.replace(
  'no text or captions,',
  'no text or captions - leave every sign, label, jar, tin, box, book cover, '
  + 'cushion, picture frame, poster, banner, gift tag and shop front completely '
  + 'blank, with no letters, words, numbers, monograms or pretend scribbled '
  + 'writing anywhere in the picture, not even on objects that would normally '
  + 'carry them -'
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
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY first.');

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
  const wanted = (args.variants && args.variants !== 'true' ? args.variants : 'current,blank').split(',');

  const variants = [
    { name: 'current', style: BASE_STYLE, note: 'what production sends today' },
    { name: 'blank', style: BLANK_STYLE, note: 'names the objects to leave blank' }
  ].filter((v) => wanted.includes(v.name));

  const buffer = fs.readFileSync(args.photo);
  const ext = path.extname(args.photo).toLowerCase();
  const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg';
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Theme "${theme}", ${subjectType}, scenes ${scenes.map((n) => n + 1).join(',')}`);
  console.log(`Notes: ${notes || '(none)'}`);
  console.log(`${scenes.length * variants.length} image call(s) against your key.\n`);

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
  console.log('If "blank" comes back clean and "current" does not, move BLANK_STYLE into');
  console.log('BASE_STYLE in server.js - that is the whole fix, and mirroring can go back on.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
