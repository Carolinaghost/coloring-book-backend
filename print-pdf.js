'use strict';

// Print-ready files for a printed copy, made to Lulu's specs.
//
// Lulu prints from two PDFs: the inside pages ("interior") and one wide page
// that wraps around the outside ("cover": back, spine, front). Their rules,
// from the Lulu Book Creation Guide:
//   - every page carries 0.125in of bleed on each side, so an 8.5in square
//     book is an 8.75in square page;
//   - anything that matters sits 0.5in inside the trim;
//   - images 300-600 PPI, fonts embedded, nothing transparent.
//
// The product is 0850X0850.BW.STD.SS.060UW444.MXX: 8.5in square, standard
// black and white, saddle stitched (stapled), 60# white paper, matte cover.
//
// Lulu counts each side of a sheet as a page. Coloring pages are printed on
// one side only - a marker bleeds through and would ruin the drawing on the
// back - so a fifteen-drawing book is 32 pages: a title page, then every
// drawing on a right-hand page with a blank back.
//
// Written by hand like pdf.js, for the same reason: the drawings are line art
// and 2-bit grey keeps the file small, which a PDF library cannot do. The
// cover's type is real text in an embedded font (Baloo 2 ExtraBold, the site's
// font, SIL Open Font License), so it prints sharp at any size.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const POD_PACKAGE_ID = '0850X0850.BW.STD.SS.060UW444.MXX';
const PT = 72;
const TRIM = 8.5 * PT;              // 612
const BLEED = 0.125 * PT;           // 9
const PAGE = TRIM + 2 * BLEED;      // 630
const SAFE = 0.5 * PT;              // 36
const DPI = 300;
const MAX_PAGES = 48;               // Lulu's limit for this product
const MIN_PAGES = 4;

const PAPER = [251, 246, 234];
const CORAL = [232, 93, 74];
const INK = [36, 38, 54];
const YELLOW = [242, 174, 61];
const BLUE = [47, 95, 168];
const SHADOW = [226, 216, 196];

const ASSETS = path.join(__dirname, 'assets', 'print');
let FONT = null;
function font() {
  if (!FONT) {
    FONT = {
      bytes: fs.readFileSync(path.join(ASSETS, 'baloo2-extrabold.ttf')),
      metrics: JSON.parse(fs.readFileSync(path.join(ASSETS, 'baloo2-extrabold.json'), 'utf8'))
    };
  }
  return FONT;
}

// The font is embedded with WinAnsi encoding, so text is written as Latin-1
// bytes. Curly quotes and dashes from a phone keyboard fold to plain ones;
// anything the font has no glyph for is dropped rather than printed as a box.
function toLatin1(str) {
  const widths = font().metrics.widths;
  let out = '';
  for (const ch of String(str || '')) {
    let c = ch;
    if (c === '‘' || c === '’') c = "'";
    else if (c === '“' || c === '”') c = '"';
    else if (c === '–' || c === '—') c = '-';
    else if (c === '\t' || c === '\n') c = ' ';
    const code = c.codePointAt(0);
    if (code > 255) continue;
    if (widths[code] === undefined) continue;
    out += c;
  }
  return out;
}

function textWidth(str, size) {
  const widths = font().metrics.widths;
  let w = 0;
  for (const ch of toLatin1(str)) w += widths[ch.charCodeAt(0)] || 500;
  return (w / 1000) * size;
}

function pdfString(str) {
  return '(' + toLatin1(str).replace(/[\\()]/g, (c) => '\\' + c) + ')';
}

const rgb = (c, op) => c.map((v) => (v / 255).toFixed(3)).join(' ') + ' ' + op + '\n';
const n = (v) => Number(v).toFixed(2);

function roundedRectPath(x, y, w, h, r) {
  const k = r * 0.5523;
  return `${n(x + r)} ${n(y)} m\n`
    + `${n(x + w - r)} ${n(y)} l ${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)} c\n`
    + `${n(x + w)} ${n(y + h - r)} l ${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c\n`
    + `${n(x + r)} ${n(y + h)} l ${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)} c\n`
    + `${n(x)} ${n(y + r)} l ${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c\nh\n`;
}

// Pack 8-bit grey into 2 bits per pixel, rows padded to a byte - the layout a
// PDF DeviceGray image with BitsPerComponent 2 expects.
function packGray2(gray, width, height) {
  const rowBytes = Math.ceil(width / 4);
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const v = (gray[src + x] * 3 + 127) / 255 | 0;
      out[dst + (x >> 2)] |= v << (6 - (x & 3) * 2);
    }
  }
  return out;
}

function imageBuffer(img) {
  if (Buffer.isBuffer(img)) return img;
  const s = String(img || '');
  const comma = s.indexOf(',');
  return Buffer.from(comma === -1 ? s : s.slice(comma + 1), 'base64');
}

// A drawing, enlarged to print resolution. A 1024px page stretched over 7.5in
// is 137 PPI, under Lulu's 300 minimum; enlarging it smooths the strokes into
// grey, so the levels are pushed back out afterwards and the lines print as
// clean black on white rather than soft grey.
async function lineArtImage(img, sidePx) {
  const { data, info } = await sharp(imageBuffer(img))
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize(sidePx, sidePx, { kernel: 'lanczos3', fit: 'fill' })
    .linear(255 / 90, -110 * 255 / 90)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    dict: `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}`
      + ' /ColorSpace /DeviceGray /BitsPerComponent 2 /Filter /FlateDecode /Length LEN >>',
    data: zlib.deflateSync(packGray2(data, info.width, info.height), { level: 9 })
  };
}

async function jpegImage(img, widthPx, heightPx, background) {
  const bg = background || { r: 255, g: 255, b: 255 };
  const data = await sharp(imageBuffer(img))
    .flatten({ background: bg })
    .resize(widthPx, heightPx, { kernel: 'lanczos3', fit: 'fill' })
    .removeAlpha()
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const meta = await sharp(data).metadata();
  return {
    dict: `<< /Type /XObject /Subtype /Image /Width ${meta.width} /Height ${meta.height}`
      + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length LEN >>',
    data
  };
}

// The smallest page count Lulu will take for this many drawings printed one
// per sheet: a title page and its blank back, then two pages per drawing,
// rounded up to a multiple of 4 because a stapled book is folded sheets.
function interiorPageCount(drawings) {
  const raw = 2 + 2 * drawings;
  return Math.max(MIN_PAGES, Math.ceil(raw / 4) * 4);
}

function newPdf() {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const stream = (dict, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    return add({ dict: dict.replace('LEN', String(buf.length)), data: buf });
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const pageRefs = [];

  let fontObj = null;
  function embedFont() {
    if (fontObj) return fontObj;
    const { bytes, metrics } = font();
    const file = stream(`<< /Length LEN /Length1 ${bytes.length} >>`, bytes);
    const desc = add(`<< /Type /FontDescriptor /FontName /Baloo2-ExtraBold /Flags 32`
      + ` /FontBBox [${metrics.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${metrics.ascent}`
      + ` /Descent ${metrics.descent} /CapHeight ${metrics.capHeight} /StemV 140 /FontFile2 ${file} 0 R >>`);
    const widths = [];
    for (let c = 32; c <= 255; c++) widths.push(metrics.widths[c] === undefined ? 0 : metrics.widths[c]);
    fontObj = add(`<< /Type /Font /Subtype /TrueType /BaseFont /Baloo2-ExtraBold /FirstChar 32 /LastChar 255`
      + ` /Widths [${widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${desc} 0 R >>`);
    return fontObj;
  }

  function addPage(width, height, content, resources) {
    const c = stream('<< /Length LEN >>', content);
    pageRefs.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(width)} ${n(height)}]`
      + ` /TrimBox [${n(BLEED)} ${n(BLEED)} ${n(width - BLEED)} ${n(height - BLEED)}]`
      + ` /BleedBox [0 0 ${n(width)} ${n(height)}]`
      + ` /Resources << ${resources || ''} >> /Contents ${c} 0 R >>`));
  }

  function toBuffer() {
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Count ${pageRefs.length} /Kids [`
      + pageRefs.map((r) => r + ' 0 R').join(' ') + '] >>';
    const chunks = [];
    let offset = 0;
    const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); chunks.push(buf); offset += buf.length; };
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
    push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }

  return { add, stream, embedFont, addPage, toBuffer, pageCount: () => pageRefs.length };
}

// Centred text, optionally with an outline. The outline is drawn first at
// twice the width and the fill laid over it, so only its outer half shows.
// Stroking the letters directly would also trace where the font's strokes
// overlap inside a letter (the bars of an E), which reads as a broken glyph.
function centredText(str, size, cx, baseline, { fill, stroke, lineWidth }) {
  const x = cx - textWidth(str, size) / 2;
  const put = `1 0 0 1 ${n(x)} ${n(baseline)} Tm ${pdfString(str)} Tj`;
  let s = '';
  if (stroke) {
    s += 'q ' + rgb(stroke, 'RG') + `${n(2 * (lineWidth || 1))} w 1 j 1 J\n`
      + `BT /F1 ${n(size)} Tf 1 Tr ${put} ET\nQ\n`;
  }
  s += 'q ' + rgb(fill || [255, 255, 255], 'rg') + `BT /F1 ${n(size)} Tf 0 Tr ${put} ET\nQ\n`;
  return s;
}

function possessive(name) {
  const who = toLatin1(String(name || '').trim()).trim();
  return who ? who + "'s" : 'My';
}

// Biggest size from `start` down that fits `maxWidth`.
function fitSize(str, maxWidth, start, min) {
  let size = start;
  while (size > min && textWidth(str, size) > maxWidth) size -= 1;
  return size;
}

// ---------------------------------------------------------------------------
// Interior
// ---------------------------------------------------------------------------
async function buildPrintInterior({ childName, pages }) {
  const drawings = (pages || []).slice().sort((a, b) => (a.sceneIndex || 0) - (b.sceneIndex || 0));
  if (!drawings.length) throw new Error('no pages to print');
  const total = interiorPageCount(drawings.length);
  if (total > MAX_PAGES) throw new Error(`${drawings.length} drawings needs ${total} pages; Lulu's limit is ${MAX_PAGES}`);

  const pdf = newPdf();
  const F = pdf.embedFont();
  const fontRes = `/Font << /F1 ${F} 0 R >>`;
  const ART = 7.5 * PT;                          // inside the 0.5in safety margin
  const artPx = Math.round(7.5 * DPI);
  const artXY = (PAGE - ART) / 2;

  // Page 1: the title page, in outline letters so it can be coloured too.
  const title = possessive(childName).toUpperCase();
  const tSize = fitSize(title, PAGE - 2 * (BLEED + SAFE), 64, 24);
  let t = '';
  t += centredText(title, tSize, PAGE / 2, PAGE - BLEED - 2.4 * PT, { stroke: [0, 0, 0], lineWidth: 1.6 });
  t += centredText('Coloring Adventure', 30, PAGE / 2, PAGE - BLEED - 3.05 * PT, { stroke: [0, 0, 0], lineWidth: 1.2 });
  t += centredText('This book belongs to', 18, PAGE / 2, BLEED + 2.7 * PT, { fill: [0, 0, 0] });
  t += `q 0 G 1.2 w ${n(PAGE / 2 - 2.4 * PT)} ${n(BLEED + 2.0 * PT)} m ${n(PAGE / 2 + 2.4 * PT)} ${n(BLEED + 2.0 * PT)} l S Q\n`;
  pdf.addPage(PAGE, PAGE, t, fontRes);
  pdf.addPage(PAGE, PAGE, '');                    // its blank back

  for (const p of drawings) {
    const img = await lineArtImage(p.image, artPx);
    const ref = pdf.stream(img.dict, img.data);
    const c = `q ${n(ART)} 0 0 ${n(ART)} ${n(artXY)} ${n(artXY)} cm /Im0 Do Q\n`;
    pdf.addPage(PAGE, PAGE, c, `/XObject << /Im0 ${ref} 0 R >>`);
    pdf.addPage(PAGE, PAGE, '');                  // blank back: no marker bleed onto the next drawing
  }
  while (pdf.pageCount() < total) pdf.addPage(PAGE, PAGE, '');

  return { pdf: pdf.toBuffer(), pageCount: total };
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------
// widthPt/heightPt come from Lulu's cover-dimensions endpoint for this product
// and page count, so the spread is exactly what their printer expects.
async function buildPrintCover({ childName, lineImage, colorImage, widthPt, heightPt }) {
  const W = Number(widthPt);
  const H = Number(heightPt);
  const panelW = TRIM + BLEED;                    // one cover face incl. its outer bleed
  const spine = W - 2 * panelW;
  if (!(W > 0 && H > 0) || spine < -0.5 || Math.abs(H - PAGE) > 1) {
    throw new Error(`unexpected cover size ${W}x${H}pt`);
  }
  if (!lineImage || !colorImage) throw new Error('cover needs the drawing and its coloured copy');

  const pdf = newPdf();
  const F = pdf.embedFont();

  // Front face, in its own coordinates: trim from fx0 to fx1, y from BLEED to H-BLEED.
  const fx0 = W - BLEED - TRIM;
  const fx1 = W - BLEED;
  const safeL = fx0 + SAFE;
  const safeR = fx1 - SAFE;
  const safeT = H - BLEED - SAFE;
  const safeB = BLEED + SAFE;
  const cx = (fx0 + fx1) / 2;

  // Title block.
  const title = possessive(childName).toUpperCase();
  const tSize = fitSize(title, safeR - safeL - 10, 74, 28);
  const m = font().metrics;
  const tBase = safeT - (m.capHeight / 1000) * tSize - 4;
  const sSize = 32;
  const sBase = tBase - tSize * 0.18 - (m.capHeight / 1000) * sSize - 14;

  // Picture panel fills what is left of the safe area, square, centred.
  const panelTop = sBase - (m.descent < 0 ? -m.descent : m.descent) / 1000 * sSize - 12;
  const side = Math.min(panelTop - safeB, safeR - safeL);
  const px = cx - side / 2;
  const py = safeB;
  const r = 0.28 * PT;
  const sidePx = Math.round((side / PT) * DPI);

  const line = await lineArtImage(lineImage, sidePx);
  const color = await jpegImage(colorImage, sidePx, sidePx);
  const lineRef = pdf.stream(line.dict, line.data);
  const colorRef = pdf.stream(color.dict, color.data);

  // One wavy seam down the front: coloured to the left, colour-me to the right.
  // The title and the picture split along the same line.
  const amp = 8;
  const waves = 4.5;
  const seamX = (y) => cx + amp * Math.sin(((H - y) / H) * waves * 2 * Math.PI);
  const seam = [];
  for (let y = H; y >= 0; y -= 2) seam.push([seamX(y), y]);
  seam.push([seamX(0), 0]);
  const seamPath = seam.map(([x, y], i) => `${n(x)} ${n(y)} ${i ? 'l' : 'm'}`).join('\n') + '\n';
  const leftClip = seamPath + `${n(fx0 - BLEED - spine)} 0 l ${n(fx0 - BLEED - spine)} ${n(H)} l h W n\n`;
  const rightClip = seamPath + `${n(W)} 0 l ${n(W)} ${n(H)} l h W n\n`;

  let c = '';
  c += rgb(PAPER, 'rg') + `0 0 ${n(W)} ${n(H)} re f\n`;

  // Panel: shadow, line art everywhere, colour on the left of the seam.
  c += 'q ' + rgb(SHADOW, 'rg') + roundedRectPath(px + 3, py - 5, side, side, r) + 'f Q\n';
  c += 'q ' + roundedRectPath(px, py, side, side, r) + 'W n\n';
  c += `q ${n(side)} 0 0 ${n(side)} ${n(px)} ${n(py)} cm /ImL Do Q\n`;
  c += 'q ' + leftClip + `${n(side)} 0 0 ${n(side)} ${n(px)} ${n(py)} cm /ImC Do Q\n`;
  c += 'q 1 J 1 j 1 1 1 RG 7 w ' + seam.filter(([, y]) => y >= py - 2 && y <= py + side + 2)
    .map(([x, y], i) => `${n(x)} ${n(y)} ${i ? 'l' : 'm'}`).join('\n') + ' S Q\n';
  c += 'q 1 J 1 j ' + rgb(YELLOW, 'RG') + '3.4 w ' + seam.filter(([, y]) => y >= py - 2 && y <= py + side + 2)
    .map(([x, y], i) => `${n(x)} ${n(y)} ${i ? 'l' : 'm'}`).join('\n') + ' S Q\n';
  c += 'Q\n';
  c += 'q ' + rgb(INK, 'RG') + '3.4 w ' + roundedRectPath(px, py, side, side, r) + 'S Q\n';

  // Title: filled letters left of the seam, outline letters to the right.
  c += 'q ' + leftClip;
  c += centredText(title, tSize, cx, tBase, { fill: CORAL, stroke: INK, lineWidth: 2.6 });
  c += centredText('Coloring Adventure', sSize, cx, sBase, { fill: BLUE, stroke: INK, lineWidth: 1.3 });
  c += 'Q\nq ' + rightClip;
  c += centredText(title, tSize, cx, tBase, { fill: [255, 255, 255], stroke: INK, lineWidth: 2.6 });
  c += centredText('Coloring Adventure', sSize, cx, sBase, { fill: [255, 255, 255], stroke: INK, lineWidth: 1.3 });
  c += 'Q\n';

  // Back face: the brand, centred.
  const bx = BLEED + TRIM / 2;
  let res = `/Font << /F1 ${F} 0 R >> /XObject << /ImL ${lineRef} 0 R /ImC ${colorRef} 0 R`;
  const logoPath = path.join(ASSETS, 'logo.png');
  if (fs.existsSync(logoPath)) {
    const trimmed = await sharp(logoPath).trim().png().toBuffer();
    const meta = await sharp(trimmed).metadata();
    const lh = 1.1 * PT;
    const lw = lh * meta.width / meta.height;
    const logo = await jpegImage(trimmed, Math.round(lw / PT * DPI), Math.round(lh / PT * DPI),
      { r: PAPER[0], g: PAPER[1], b: PAPER[2] });
    const logoRef = pdf.stream(logo.dict, logo.data);
    res += ` /ImB ${logoRef} 0 R`;
    c += `q ${n(lw)} 0 0 ${n(lh)} ${n(bx - lw / 2)} ${n(H / 2 + 0.35 * PT)} cm /ImB Do Q\n`;
  }
  res += ' >>';
  c += centredText('Crayonauts', 34, bx, H / 2 - 0.15 * PT, { fill: INK });
  c += centredText('Made from a photo at crayonauts.com', 14, bx, H / 2 - 0.6 * PT, { fill: INK });

  pdf.addPage(W, H, c, res);
  return pdf.toBuffer();
}

module.exports = {
  buildPrintInterior, buildPrintCover, interiorPageCount, POD_PACKAGE_ID,
  PAGE_PT: PAGE, TRIM_PT: TRIM, BLEED_PT: BLEED, SAFE_PT: SAFE, toLatin1, textWidth
};
