#!/usr/bin/env node
// Renders a real test book from a reference photo, using the same prompt and
// the same OpenAI call the paid flow uses, and writes the pages to disk so you
// can look at them before promoting anything.
//
//   OPENAI_API_KEY=sk-... node scripts/render-test-book.js --photo ./kids.jpg --kids 2
//
// Options:
//   --photo <path>    reference photo (required)
//   --kids <1-3>      how many subjects are in the photo   (default 2)
//   --theme <name>    story theme                          (default Superhero)
//   --subject <type>  kid | adult                          (default kid)
//   --pages <n>       render only the first n pages        (default all 15)
//   --notes <text>    the customer's extra detail, if any
//   --out <dir>       where to write the pages             (default ./test-book)
//
// Every page is one image API call against your key, so a full book costs a
// full book. Use --pages while you are still iterating on wording.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildPrompt, renderScene, STORY_SCENES } = require('../server');

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
  if (!args.photo) throw new Error('Pass a reference photo: --photo ./kids.jpg');
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY first.');

  const theme = args.theme || 'Superhero';
  if (!STORY_SCENES[theme]) {
    throw new Error(`Unknown theme "${theme}". Try one of: ${Object.keys(STORY_SCENES).join(', ')}`);
  }
  const kids = Math.min(3, Math.max(1, parseInt(args.kids, 10) || 2));
  const subjectType = args.subject === 'adult' ? 'adult' : 'kid';
  const notes = args.notes && args.notes !== 'true' ? args.notes : '';
  const outDir = args.out || './test-book';

  const scenes = STORY_SCENES[theme];
  const wanted = parseInt(args.pages, 10);
  const total = wanted > 0 ? Math.min(wanted, scenes.length) : scenes.length;

  const buffer = fs.readFileSync(args.photo);
  const ext = path.extname(args.photo).toLowerCase();
  const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg';
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Theme "${theme}", ${kids} ${subjectType === 'adult' ? 'adult(s)' : 'kid(s)'}, `
    + `${total} page(s) -> ${outDir}`);
  console.log(`That is ${total} image API call(s) against your key.\n`);

  const prompts = [];
  let failed = 0;
  for (let i = 0; i < total; i++) {
    const prompt = buildPrompt(theme, i, kids, subjectType, notes);
    prompts.push(`--- page ${i + 1} ---\n${prompt}\n`);
    const label = `page ${String(i + 1).padStart(2, '0')}/${total}`;
    const camera = (prompt.match(/Camera: (.*?)\.(?:\s|$)/) || [])[1] || '';
    try {
      // paid: true so the test uses the full rate budget rather than the slice
      // held back for free previews.
      const dataUrl = await renderScene({ buffer, mimetype, filename: path.basename(args.photo), prompt, paid: true });
      const file = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`${label}  ok   ${camera}`);
    } catch (err) {
      failed++;
      console.error(`${label}  FAIL ${err.message}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'prompts.txt'), prompts.join('\n'));
  console.log(`\n${total - failed}/${total} page(s) written to ${outDir}. Prompts in ${path.join(outDir, 'prompts.txt')}.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
