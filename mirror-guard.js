'use strict';

// Does this page have words drawn into it?
//
// The pages get mirrored so a book does not lean the same way on every page
// (server.js: maybeMirror). That was safe only while the pages had no
// lettering in them. They do: BASE_STYLE asks for "no text or captions" and
// the model writes on signs, jars, cushions and shop fronts anyway, and a
// mirrored page turns those words back to front.
//
// So a page has to be read before it is flipped. Rather than pay for OCR on
// every page, this leans on what a coloring page is: open outlines, nothing
// filled in. Thin strokes wash out under a blur; the solid shapes that survive
// are almost always letters. Letters then give themselves away by sitting in a
// row - four or more blobs of a similar size sharing a baseline - which a dog
// nose and a pair of eyes never do.
//
// Wrong in the cautious direction by design: an unflipped page is a page, but a
// page of backwards writing is a reprint.

const sharp = require('sharp');

// Everything below is tuned against the sample books in public/samples and
// measured by test/mirror-guard.test.js. Change one, re-run that.
const WIDTH = 512;          // working size; letters stay legible, labelling stays quick
const BLUR = 1.6;           // washes out outline strokes, leaves filled shapes
const DARK = 100;           // 0-255, what counts as still-solid after the blur
const MIN_BLOB = 8;         // smaller than this is speckle
const MAX_BLOB = 1400;      // larger than this is a filled object, not a glyph
const MIN_H = 5;            // glyph box, in working pixels
const MAX_H = 64;
const ROW_TOLERANCE = 0.45; // how far off a shared baseline a glyph may sit
const HEIGHT_RATIO = 2.4;   // tallest over shortest, within one word
const GAP_RATIO = 2.2;      // space between glyphs, relative to their height
const WORD_LENGTH = 4;      // blobs in a row before it counts as a word

// Solid shapes left standing after the blur, as { x, y, w, h, area } boxes.
function solidBlobs(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const blobs = [];
  const queue = new Int32Array(mask.length);

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
    if (area < MIN_BLOB || area > MAX_BLOB) continue;
    if (h < MIN_H || h > MAX_H) continue;
    if (w > h * 6) continue;  // a rule or a shelf edge, not a letter
    blobs.push({ x: minX, y: minY, w, h, area });
  }
  return blobs;
}

// The giveaway is the row, not the shape: letters of a size, side by side, on a
// line. Anything that manages that is writing as far as a mirror is concerned.
function longestRun(blobs) {
  let longest = 0;

  for (let i = 0; i < blobs.length; i++) {
    const line = [blobs[i]];
    const first = blobs[i];
    const mid = first.y + first.h / 2;

    const near = blobs
      .filter((b) => b !== first
        && Math.abs((b.y + b.h / 2) - mid) < first.h * ROW_TOLERANCE
        && Math.max(b.h, first.h) / Math.min(b.h, first.h) < HEIGHT_RATIO)
      .sort((a, b) => a.x - b.x);

    // Walk left to right; a wide gap ends the word rather than joining two.
    let run = [first];
    for (const b of near.concat(line)) {
      const last = run[run.length - 1];
      if (b === last) continue;
      const gap = b.x - (last.x + last.w);
      if (b.x >= last.x && gap >= 0 && gap < last.h * GAP_RATIO) run.push(b);
    }
    if (run.length > longest) longest = run.length;
  }
  return longest;
}

// Resolves to true when the page appears to have words drawn into it.
async function hasWords(buffer) {
  const { data, info } = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(WIDTH, WIDTH, { fit: 'inside' })
    .blur(BLUR)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mask = new Uint8Array(info.width * info.height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * info.channels] < DARK ? 1 : 0;

  return longestRun(solidBlobs(mask, info.width, info.height)) >= WORD_LENGTH;
}

module.exports = { hasWords, WORD_LENGTH };
