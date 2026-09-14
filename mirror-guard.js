'use strict';

// Does this page have words drawn into it?
//
// Pages get mirrored so a book does not lean the same way throughout
// (server.js: maybeMirror). A page with writing on it must not be, or the
// writing comes back reversed. BASE_STYLE asks for "no text or captions" and
// the model letters signs, jars, cushions and picture frames anyway.
//
// The first version of this blurred the page and looked for the solid shapes
// that survived, on the theory that a coloring page is open outlines and only
// letters are filled in. That theory was wrong, and it was wrong in the
// direction that ships the bug: the model letters a sign with the same thin
// stroke it draws everything else with - the words are meant to be coloured in
// too - so the blur washed the words away with the drawing. It missed all six
// real cases. It passed its own suite because the fixtures were solid bold
// type, the one kind of lettering these pages never contain.
//
// So: no blur, full resolution, and letters found the way a person finds them -
// separate small marks of a common size, sitting in a row between a shared
// cap-line and a shared baseline.
//
// KNOWN LIMIT, please read before trusting this. Coloring pages are full of
// rows of similar aligned strokes - hair curls, knit ribbing, castle
// crenellations, grass, fence palings - and this flags a fair number of them.
// Measured on 63 pages with no words: 14 flagged. That is the cheap direction
// (one page keeps the lean it was drawn with) and it is tuned that way on
// purpose. The expensive direction is a miss, and the honest position is that
// six real lettered pages is not enough evidence to promise there are none.
// If mirroring matters more than that uncertainty, put OCR behind it instead.

const sharp = require('sharp');

// Tuned against test/fixtures, which are real pages at the size production
// actually produces. Change one, re-run test/mirror-guard.test.js - and do not
// tune against generated lettering, which is how this went wrong the first time.
const WIDTH = 1024;         // work at the size the model emits; downscaling hides thin strokes
const DARK = 128;           // 0-255; ink against paper, no blur in front of it
const MIN_H = 10;           // glyph box, in working pixels
const MAX_H = 90;
const MAX_ASPECT = 2.2;     // a letter is not much wider than it is tall
const MIN_FILL = 0.12;      // of its own box; below this it is a stray line
const MAX_FILL = 0.9;       // above this it is a filled shape, not a stroked letter
const ALIGN = 0.18;         // how far off the shared cap-line and baseline a letter may sit
const HEIGHT_RATIO = 1.6;   // tallest over shortest, within one word
const GAP_RATIO = 1.2;      // space between letters, relative to their height
const WORD_LENGTH = 3;      // letters in a row before it counts as a word

// Every separate mark on the page, as { x, y, w, h } boxes, filtered down to
// the ones shaped like a letter. Letters are their own islands: they sit on a
// sign, not touching the drawing around them.
function marks(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const found = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let minX = width, maxX = -1, minY = height, maxY = -1, area = 0;

    while (head < tail) {
      const at = queue[head++];
      const x = at % width;
      const y = (at - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && mask[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; queue[tail++] = at - 1; }
      if (x < width - 1 && mask[at + 1] && !seen[at + 1]) { seen[at + 1] = 1; queue[tail++] = at + 1; }
      if (y > 0 && mask[at - width] && !seen[at - width]) { seen[at - width] = 1; queue[tail++] = at - width; }
      if (y < height - 1 && mask[at + width] && !seen[at + width]) { seen[at + width] = 1; queue[tail++] = at + width; }
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (h < MIN_H || h > MAX_H) continue;
    if (w < 2 || w > h * MAX_ASPECT) continue;
    const fill = area / (w * h);
    if (fill < MIN_FILL || fill > MAX_FILL) continue;
    found.push({ x: minX, y: minY, w, h });
  }
  return found;
}

// How many letters sit in the longest row. Capitals share a cap-line AND a
// baseline; a row of unrelated marks may share a middle, but rarely both edges.
function longestRow(letters) {
  let longest = 0;

  for (const first of letters) {
    const line = letters
      .filter((other) =>
        Math.abs(other.y - first.y) < first.h * ALIGN
        && Math.abs((other.y + other.h) - (first.y + first.h)) < first.h * ALIGN
        && Math.max(other.h, first.h) / Math.min(other.h, first.h) < HEIGHT_RATIO)
      .sort((a, b) => a.x - b.x);

    // Walk left to right. A wide gap ends the word rather than joining two
    // across half the page.
    let run = 0;
    let last = null;
    for (const mark of line) {
      if (!last) { last = mark; run = 1; continue; }
      const gap = mark.x - (last.x + last.w);
      if (gap >= -2 && gap < last.h * GAP_RATIO) run++;
      else if (gap >= 0) run = 1;
      last = mark;
      if (run > longest) longest = run;
    }
  }
  return longest;
}

// Resolves to true when the page appears to have words drawn into it.
async function hasWords(buffer) {
  const { data, info } = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(WIDTH, WIDTH, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mask = new Uint8Array(info.width * info.height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * info.channels] < DARK ? 1 : 0;

  return longestRow(marks(mask, info.width, info.height)) >= WORD_LENGTH;
}

module.exports = { hasWords, WORD_LENGTH };
