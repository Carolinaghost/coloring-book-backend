#!/usr/bin/env node
// Renders a real family test book: several people, one photo each, one book -
// using the same prompt and the same OpenAI call the paid family flow uses.
// render-test-book.js only ever sends one photo, so it cannot exercise any of
// this.
//
//   node scripts/render-family-book.js \
//     --photos https://crayonauts.com/samples/examples/set1-mom.png,https://crayonauts.com/samples/examples/set1-dad.png \
//     --names "Mum,Dad" --types "adult,adult" --pages 2
//
// Needs an OpenAI credential: either OPENAI_API_KEY in the environment, or an
// outbound proxy that attaches one to api.openai.com on the way out. Use
// --dry-run to check the cast and the pairing without spending anything.
//
// Options:
//   --photos <list>   comma-separated paths or https URLs, IN NAME ORDER (required)
//   --names <list>    comma-separated names, in the same order        (required)
//   --types <list>    comma-separated kid|adult, in the same order    (default kid)
//   --star <name>     who the story follows        (default: the first child)
//   --theme <name>    story theme                  (default Family Keepsake)
//   --detail <level>  simple | standard | detailed (default standard)
//   --pages <n>       render only the first n pages             (default all 15)
//   --notes <text>    the customer's extra detail, if any
//   --out <dir>       where to write the pages     (default ./family-book)
//   --dry-run         build and print everything, call nobody
//
// Every page is one image API call against your account, so a full book costs a
// full book. Use --dry-run first and --pages while you are still iterating.
//
// WHY THE COUNTS MUST MATCH
// castLine() tells the model "there is one reference photo per person, in this
// same order" and renderScene sends the photos in array order as image[]. That
// pairing is positional and nothing downstream re-checks it, so one extra photo
// slides every face onto the wrong name and the book still renders, quietly
// wrong. Hence the refusal below - and hence the check that cleanPeople did not
// silently drop or truncate anyone, because dropping the second of three names
// re-indexes the photos just as badly as passing the wrong number of them.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  buildPrompt, renderScene, canCallOpenAI, STORY_SCENES,
  cleanPeople, MAX_PEOPLE, DETAIL_LEVELS, normalizeDetail
} = require('../server');

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

function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// A path or an https URL, either way coming back as the three fields
// renderScene wants. The filename is only a label on the upload, but it is what
// you see in an error, so it is kept meaningful.
async function loadPhoto(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source} -> HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error(`${source} -> empty response`);
    const headerType = (response.headers.get('content-type') || '').split(';')[0].trim();
    const mimetype = headerType.startsWith('image/')
      ? headerType
      : (MIME_BY_EXT[path.extname(new URL(source).pathname).toLowerCase()] || 'image/jpeg');
    return { buffer, mimetype, filename: path.basename(new URL(source).pathname) || 'photo.png' };
  }
  const buffer = fs.readFileSync(source);
  return {
    buffer,
    mimetype: MIME_BY_EXT[path.extname(source).toLowerCase()] || 'image/jpeg',
    filename: path.basename(source)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === 'true';

  const photoSources = splitList(args.photos);
  const names = splitList(args.names);
  const types = splitList(args.types);
  if (!photoSources.length) throw new Error('Pass one photo per person: --photos ./mum.jpg,./dad.jpg');
  if (!names.length) throw new Error('Pass one name per photo, in the same order: --names "Mum,Dad"');

  // Refused, not guessed at. See the note at the top of this file.
  if (photoSources.length !== names.length) {
    throw new Error(`${photoSources.length} photo(s) but ${names.length} name(s). `
      + 'They pair up by position, so a mismatch would put the wrong face on the wrong person.');
  }
  if (types.length && types.length !== names.length) {
    throw new Error(`${types.length} type(s) but ${names.length} name(s). Give one kid|adult per person, or none at all.`);
  }
  const badType = types.find((t) => t !== 'kid' && t !== 'adult');
  if (badType) throw new Error(`Unknown person type "${badType}". Each --types entry is kid or adult.`);
  if (names.length < 2) {
    throw new Error('A family book needs at least two people. One person is what render-test-book.js is for.');
  }
  if (names.length > MAX_PEOPLE) {
    throw new Error(`${names.length} people, but a family book holds at most ${MAX_PEOPLE}.`);
  }

  const star = args.star && args.star !== 'true' ? args.star.trim() : '';
  if (star && !names.includes(star)) {
    throw new Error(`--star "${star}" is not one of the names (${names.join(', ')}).`);
  }

  // The server's own cleaner, not this script's idea of one, so the cast that
  // reaches the prompt here is the cast that would reach it from a real order.
  const cast = cleanPeople(names.map((name, i) => ({
    name,
    subjectType: types[i] || 'kid',
    star: star ? name === star : false
  })));
  // A backstop, and today an unreachable one: the checks above already refuse
  // an empty name and a cast over MAX_PEOPLE. It stays because cleanPeople is
  // the server's, not this script's - if it ever starts dropping somebody for a
  // new reason, the cast silently re-indexes against the photos and every face
  // lands on the wrong name. Better to fail here than to find out from a book.
  if (cast.length !== photoSources.length) {
    throw new Error(`${photoSources.length} photo(s) but only ${cast.length} usable name(s) - `
      + 'a name was dropped as empty. Give a real name for every photo.');
  }

  const theme = args.theme || 'Family Keepsake';
  if (!STORY_SCENES[theme]) {
    throw new Error(`Unknown theme "${theme}". Try one of: ${Object.keys(STORY_SCENES).join(', ')}`);
  }
  if (args.detail && !DETAIL_LEVELS[String(args.detail).toLowerCase()]) {
    throw new Error(`Unknown detail level "${args.detail}". Try one of: ${Object.keys(DETAIL_LEVELS).join(', ')}`);
  }
  const detail = normalizeDetail(args.detail);
  const notes = args.notes && args.notes !== 'true' ? args.notes : '';
  const outDir = args.out || './family-book';

  if (!dryRun && !canCallOpenAI) {
    throw new Error('No OpenAI credential. Set OPENAI_API_KEY, run somewhere the outbound proxy attaches one, or pass --dry-run.');
  }

  const scenes = STORY_SCENES[theme];
  const wanted = parseInt(args.pages, 10);
  const total = wanted > 0 ? Math.min(wanted, scenes.length) : scenes.length;

  const photos = [];
  for (const source of photoSources) {
    try {
      photos.push(await loadPhoto(source));
    } catch (err) {
      throw new Error(`Could not read a reference photo: ${err.message}`);
    }
  }

  // Printed before anything is spent, because the pairing is the one thing that
  // cannot be seen in the finished pages until a face is on the wrong person.
  console.log(`Theme "${theme}", detail "${detail}", ${total} page(s) -> ${outDir}`);
  console.log('Cast, paired with the photos in this order:');
  cast.forEach((person, i) => {
    const mark = person.star ? ' <- the story follows this one' : '';
    console.log(`  ${i + 1}. ${person.name} (${person.subjectType})  ${photoSources[i]}`
      + `  [${(photos[i].buffer.length / 1024).toFixed(0)} KB ${photos[i].mimetype}]${mark}`);
  });
  if (!cast.some((p) => p.star)) {
    console.log('  (no --star given: the prompt picks the first child, or the first person if there is no child)');
  }
  console.log(dryRun ? '\nDry run: nothing will be drawn.\n' : `\nThat is ${total} image API call(s) against your key.\n`);

  fs.mkdirSync(outDir, { recursive: true });

  const prompts = [];
  let failed = 0;
  for (let i = 0; i < total; i++) {
    // The cast is the SIXTH argument. Handed to buildPrompt any other way it is
    // read as notes or as the detail level, castLine() never runs, and the book
    // comes back as a single-subject book with nobody's name in it.
    // childCount and subjectType are ignored once the cast has two or more
    // people, so 1/'kid' here is a placeholder, not a claim about anybody.
    const prompt = buildPrompt(theme, i, 1, 'kid', notes, cast, detail);
    prompts.push(`--- page ${i + 1} ---\n${prompt}\n`);
    const label = `page ${String(i + 1).padStart(2, '0')}/${total}`;
    const camera = (prompt.match(/Camera: (.*?)\.(?:\s|$)/) || [])[1] || '';
    if (dryRun) {
      console.log(`${label}  skipped  ${camera}`);
      continue;
    }
    try {
      // photos (plural) is what makes this a family render: renderScene sends
      // the array as image[], one per person, in this order. Passing a single
      // buffer instead would send one photo and the cast line would be lying.
      // paid: true so the test uses the full rate budget rather than the slice
      // held back for free previews.
      const dataUrl = await renderScene({ photos, prompt, paid: true });
      const file = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`${label}  ok   ${camera}`);
    } catch (err) {
      failed++;
      console.error(`${label}  FAIL ${err.message}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'prompts.txt'), prompts.join('\n'));
  if (dryRun) {
    console.log(`\nNothing drawn. ${total} prompt(s) written to ${path.join(outDir, 'prompts.txt')} - read one and check the cast line names everybody, in the order above.`);
    return;
  }
  console.log(`\n${total - failed}/${total} page(s) written to ${outDir}. Prompts in ${path.join(outDir, 'prompts.txt')}.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
