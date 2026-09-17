#!/usr/bin/env node
// Draws the SAME photo and the SAME scene once at each detail level, and writes
// a page you can open to see the three side by side.
//
//   node scripts/detail-compare.js --photo ./kids.jpg
//
// Three image API calls against your key, one per level. Everything except the
// detail instruction is held identical, so any difference you see is the
// wording doing its job. If Simple is not obviously emptier than Detailed, the
// wording is wrong - change DETAIL_LEVELS in server.js, not the plumbing.
//
// Options:
//   --photo <path>    reference photo (required)
//   --scene <n>       which scene to draw, 1-based           (default 1)
//   --kids <1-3>      how many subjects are in the photo      (default 1)
//   --theme <name>    story theme                             (default Portrait)
//   --subject <type>  kid | adult                             (default kid)
//   --out <dir>       where to write                          (default ./detail-compare)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildPrompt, renderScene, canCallOpenAI, STORY_SCENES, DETAIL_LEVELS } = require('../server');

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

// Plain HTML, no styling to speak of: the point is three pictures in a row at
// the same size, so the busyness is the only thing that differs.
function contactSheet(theme, sceneText, cells) {
  const columns = cells.map((cell) => `
    <figure>
      <img src="${cell.file}" alt="${cell.label} version">
      <figcaption><strong>${cell.label}</strong><br>ages ${cell.ages}</figcaption>
    </figure>`).join('');
  return `<!doctype html>
<meta charset="utf-8">
<title>Detail levels: ${theme}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  .row { display: flex; gap: 16px; align-items: flex-start; }
  figure { margin: 0; flex: 1; }
  img { width: 100%; border: 1px solid #ccc; }
  figcaption { text-align: center; padding-top: 8px; }
</style>
<h1>Detail levels</h1>
<p>Theme <strong>${theme}</strong>. Scene: ${sceneText}</p>
<div class="row">${columns}</div>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.photo) throw new Error('Pass a reference photo: --photo ./kids.jpg');
  if (!canCallOpenAI) throw new Error('No OpenAI credential. Set OPENAI_API_KEY, or run somewhere the outbound proxy attaches one.');

  const theme = args.theme || 'Portrait';
  if (!STORY_SCENES[theme]) {
    throw new Error(`Unknown theme "${theme}". Try one of: ${Object.keys(STORY_SCENES).join(', ')}`);
  }
  const scenes = STORY_SCENES[theme];
  const sceneIndex = Math.min(Math.max((parseInt(args.scene, 10) || 1) - 1, 0), scenes.length - 1);
  const kids = Math.min(3, Math.max(1, parseInt(args.kids, 10) || 1));
  const subjectType = args.subject === 'adult' ? 'adult' : 'kid';
  const outDir = args.out || './detail-compare';

  const buffer = fs.readFileSync(args.photo);
  const ext = path.extname(args.photo).toLowerCase();
  const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg';
  fs.mkdirSync(outDir, { recursive: true });

  const levels = Object.keys(DETAIL_LEVELS);
  console.log(`Scene ${sceneIndex + 1} of "${theme}" at ${levels.length} detail levels -> ${outDir}`);
  console.log(`That is ${levels.length} image API call(s) against your key.\n`);

  const prompts = [];
  const cells = [];
  let failed = 0;
  for (const level of levels) {
    const prompt = buildPrompt(theme, sceneIndex, kids, subjectType, '', null, level);
    prompts.push(`--- ${level} ---\n${prompt}\n`);
    try {
      const dataUrl = await renderScene({ buffer, mimetype, filename: path.basename(args.photo), prompt, paid: true });
      const file = `${level}.png`;
      fs.writeFileSync(path.join(outDir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
      cells.push({ file, label: DETAIL_LEVELS[level].label, ages: DETAIL_LEVELS[level].ages });
      console.log(`${level.padEnd(9)} ok`);
    } catch (err) {
      failed++;
      console.error(`${level.padEnd(9)} FAIL ${err.message}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'prompts.txt'), prompts.join('\n'));
  fs.writeFileSync(path.join(outDir, 'index.html'), contactSheet(theme, scenes[sceneIndex], cells));
  console.log(`\n${levels.length - failed}/${levels.length} drawn. Open ${path.join(outDir, 'index.html')} to compare them.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
