'use strict';

// How a finished page is stored.
//
// The pages are line drawings and were being kept as full-colour photographs.
// Measured on a real 1024x1024 page out of this pipeline: 720 KB as stored,
// 64 KB at four levels of grey. About eleven times smaller, for a book that is
// black lines on white.
//
// Four levels rather than two was settled by looking, at print size, when the
// PDF builder was written: at two the freckles on a portrait disappear and fine
// hair strokes break up. Four keeps them. See pdf.js for that comparison.
//
// Two facts make this safe to apply to pages already sold:
//
//   The customer's PDF does not change at all. pdf.js already quantises to
//   these same four levels on its way into the file, so a book built from a
//   re-encoded page is byte-for-byte the book built from the original.
//
//   Encoding is idempotent. Running it twice changes not one pixel, so a
//   migration that stops halfway can simply be run again.
//
// The only thing that does change is the thumbnails on the waiting page, which
// are line art at about 150 pixels and look identical.

const sharp = require('sharp');

const LEVELS = 4;
const STEP = 255 / (LEVELS - 1);

function isDataUrl(s) {
  return typeof s === 'string' && s.startsWith('data:') && s.includes(',');
}

// Returns a data URL, always. If anything goes wrong the original is handed
// back untouched: a page that fails to shrink is a nuisance, a page that fails
// to save is a customer's book with a hole in it.
async function encodeForStorage(dataUrl) {
  if (!isDataUrl(dataUrl)) return dataUrl;
  try {
    const raw = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    const { data, info } = await sharp(raw).grayscale().raw().toBuffer({ resolveWithObject: true });
    const quantised = Buffer.from(data).map((v) => Math.round(v / STEP) * STEP);
    const png = await sharp(quantised, { raw: { width: info.width, height: info.height, channels: 1 } })
      .png({ palette: true, colours: LEVELS, compressionLevel: 9 })
      .toBuffer();
    // Never hand back something bigger than what arrived.
    const out = 'data:image/png;base64,' + png.toString('base64');
    return out.length < dataUrl.length ? out : dataUrl;
  } catch (err) {
    console.error('Could not re-encode a page for storage, keeping it as it came -', err.message);
    return dataUrl;
  }
}

module.exports = { encodeForStorage, LEVELS };
