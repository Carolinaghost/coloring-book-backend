'use strict';

// Builds the finished coloring book as a PDF, server-side.
//
// Written by hand rather than with a PDF library, for one reason: the image
// encoding. These pages are line drawings, and the size of the file decides
// whether it can be emailed at all - a mail attachment is base64-encoded on the
// wire, which adds about a third, and Gmail refuses over 25MB, Outlook over 20.
//
// Measured on a real 1024x1024 page out of this pipeline, as the bytes that
// actually sit in the PDF, times fifteen pages:
//
//   256 levels (8-bit grey)   5.3 MB      16 levels (4-bit)   1.9 MB
//   JPEG q80                  3.1 MB       4 levels (2-bit)   0.9 MB
//                                          2 levels (1-bit)   0.6 MB
//
// A PDF library only embeds PNG or JPEG, which forces 8-bit or JPEG - the two
// most expensive rows. The owner measured 7.89MB for an 8-bit book, which would
// trip the 8MB guard below and silently lose the attachment on every order.
// Writing the PDF here allows 2-bit DeviceGray, which a library cannot reach.
//
// 4 levels rather than 2 was decided by looking, not by the numbers: at 2
// levels the freckles on a portrait disappear and fine hair strokes break up.
// The whole product is that the drawing looks like the child, so that is not a
// trade worth 0.3MB. At 4 levels the freckles survive and the line edges stay
// clean; 16 levels is indistinguishable from 256 and costs twice as much.
//
// Layout matches the PDF the site has always built client-side with jsPDF, so
// the emailed file and the downloaded file are the same book: 8.5x8.5 inch
// pages, a text cover, then each page 8x8 inches inset by a quarter inch.

const zlib = require('zlib');
const sharp = require('sharp');

const PT = 72;                       // PDF points per inch
const PAGE = 8.5 * PT;               // 612
const MARGIN = 0.25 * PT;            // 18
const ART = 8 * PT;                  // 576
const BITS = 2;                      // 4 levels of grey

// Widths per 1000 units for the two standard fonts used on the cover. Only
// needed to centre the text; a few units out moves it a hair, nothing worse.
const W_BOLD = { ' ': 278, "'": 238, ',': 278, '.': 278, '-': 333, '!': 333, '?': 611,
  '(': 333, ')': 333, '/': 278, '\\': 278, '&': 722, '"': 474, ':': 333, ';': 333, '_': 556 };
const W_REG = { ' ': 278, "'": 191, ',': 278, '.': 278, '-': 333, '!': 333, '?': 556,
  '(': 333, ')': 333, '/': 278, '\\': 278, '&': 667, '"': 355, ':': 278, ';': 278, '_': 556 };
const BOLD_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const BOLD_UPPER_W = [722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611];
const BOLD_LOWER_W = [556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500];
const REG_UPPER_W = [667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611];
const REG_LOWER_W = [556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500];
BOLD_UPPER.forEach((c, i) => {
  W_BOLD[c] = BOLD_UPPER_W[i];
  W_BOLD[c.toLowerCase()] = BOLD_LOWER_W[i];
  W_REG[c] = REG_UPPER_W[i];
  W_REG[c.toLowerCase()] = REG_LOWER_W[i];
});
for (const d of '0123456789') { W_BOLD[d] = 556; W_REG[d] = 556; }

function textWidth(str, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  // Measure what will actually be written, or a dropped character shifts the
  // centring of a line it is not even in.
  for (const ch of toWinAnsi(str)) w += (table[ch] === undefined ? 556 : table[ch]);
  return (w / 1000) * size;
}

// The standard fonts are asked for WinAnsiEncoding below, which is Latin-1 plus
// a handful of extras - so a name is written as Latin-1 bytes. Anything outside
// that (a Chinese or Cyrillic name, an emoji) has no glyph in Helvetica at all
// and would come out as mojibake, so it is dropped rather than mangled. The
// client-side PDF has always had the same limitation.
function toWinAnsi(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10) { out += ' '; continue; }
    if (code >= 32 && code <= 126) { out += ch; continue; }
    if (code >= 160 && code <= 255) { out += ch; continue; }
    // the curly quotes a phone keyboard produces, folded to straight ones
    if (ch === '\u2018' || ch === '\u2019') { out += "'"; continue; }
    if (ch === '\u201C' || ch === '\u201D') { out += '"'; continue; }
    if (ch === '\u2013' || ch === '\u2014') { out += '-'; continue; }
  }
  return out;
}

// ( ) and \ end or escape a PDF string literal, so a child called
// "Jo (Jojo)" would otherwise produce a file no reader can open.
function pdfString(str) {
  return '(' + toWinAnsi(str).replace(/[\\()]/g, (c) => '\\' + c) + ')';
}

// Pack 8-bit greyscale into `bits` per pixel, rows padded to a byte boundary -
// which is how a PDF DeviceGray image is laid out.
function packGray(gray, width, height, bits) {
  const levels = (1 << bits) - 1;
  const perByte = 8 / bits;
  const rowBytes = Math.ceil(width / perByte);
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const v = Math.round((gray[src + x] / 255) * levels);
      out[dst + Math.floor(x / perByte)] |= v << (8 - bits - (x % perByte) * bits);
    }
  }
  return out;
}

// A stored page is a data URL. Returns what the PDF needs to embed it.
async function encodePage(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  const raw = Buffer.from(comma === -1 ? dataUrl : dataUrl.slice(comma + 1), 'base64');
  const { data, info } = await sharp(raw).grayscale().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    stream: zlib.deflateSync(packGray(data, info.width, info.height, BITS), { level: 9 })
  };
}

async function buildBookPdf({ childName, theme, pages }) {
  // Fall back AFTER the encoding drop, not before: a name written entirely in
  // characters Helvetica has no glyph for survives the first check and then
  // vanishes, leaving a cover that reads "'s".
  const who = toWinAnsi((childName || '').trim()).trim() || 'My';

  // Sort here rather than trusting the caller. listPages orders by scene_index
  // today, but a book whose pages come out shuffled is not obviously broken -
  // it is just wrong, and nobody would find out until a parent opened the PDF.
  const inOrder = pages.slice().sort((a, b) => (a.sceneIndex || 0) - (b.sceneIndex || 0));
  const encoded = [];
  for (const p of inOrder) encoded.push(await encodePage(p.image));

  const objects = [];                       // objects[i] is object number i+1
  const add = (body) => { objects.push(body); return objects.length; };

  const pageRefs = [];
  const kidsPlaceholder = add(null);        // 1: catalog, filled below
  const pagesObj = add(null);               // 2: page tree
  // WinAnsiEncoding, not the default: under StandardEncoding byte 0x27 is a
  // curly quoteright, so "Ava's" came out "Ava's" with the wrong apostrophe,
  // and every accented letter in the Latin-1 range mapped to something else.
  const enc = ' /Encoding /WinAnsiEncoding';
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold' + enc + ' >>');
  const fontReg = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica' + enc + ' >>');

  // --- the cover, matching what jsPDF has always drawn ---
  const line = (str, size, bold, yInches) => {
    const x = (PAGE - textWidth(str, size, bold)) / 2;
    const y = PAGE - yInches * PT;          // jsPDF measures y from the top
    return `BT /${bold ? 'F1' : 'F2'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(str)} Tj ET\n`;
  };
  const cover = line(who + "'s", 26, true, 3.6)
    + line((theme || 'Coloring') + ' Story', 26, true, 4.3)
    + line('A custom coloring book', 12, false, 5.0);
  const coverStream = add({ dict: '<< /Length ' + Buffer.byteLength(cover) + ' >>', data: Buffer.from(cover, 'latin1') });
  pageRefs.push(add(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE} ${PAGE}] `
    + `/Resources << /Font << /F1 ${fontBold} 0 R /F2 ${fontReg} 0 R >> >> /Contents ${coverStream} 0 R >>`));

  // --- one page per drawing ---
  for (const img of encoded) {
    const imgObj = add({
      dict: '<< /Type /XObject /Subtype /Image /Width ' + img.width + ' /Height ' + img.height
        + ' /ColorSpace /DeviceGray /BitsPerComponent ' + BITS
        + ' /Filter /FlateDecode /Length ' + img.stream.length + ' >>',
      data: img.stream
    });
    const content = `q\n${ART} 0 0 ${ART} ${MARGIN} ${MARGIN} cm\n/Im0 Do\nQ\n`;
    const contentObj = add({ dict: '<< /Length ' + Buffer.byteLength(content) + ' >>', data: Buffer.from(content, 'latin1') });
    pageRefs.push(add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE} ${PAGE}] `
      + `/Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>`));
  }

  objects[kidsPlaceholder - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Count ${pageRefs.length} /Kids [`
    + pageRefs.map((r) => r + ' 0 R').join(' ') + '] >>';

  // --- serialise, recording where each object starts for the xref table ---
  const chunks = [];
  let offset = 0;
  const push = (buf) => { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1'); chunks.push(b); offset += b.length; };
  const offsets = [];

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  objects.forEach((obj, i) => {
    offsets[i] = offset;
    push(`${i + 1} 0 obj\n`);
    if (obj && obj.dict !== undefined) {
      push(obj.dict + '\nstream\n');
      push(obj.data);
      push('\nendstream\nendobj\n');
    } else {
      push(obj + '\nendobj\n');
    }
  });

  const xref = offset;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) table += String(o).padStart(10, '0') + ' 00000 n \n';
  push(table);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

function pdfFileName(childName) {
  return String(childName || 'My').replace(/[^a-z0-9]/gi, '-') + '-coloring-book.pdf';
}

module.exports = { buildBookPdf, pdfFileName, BITS };
