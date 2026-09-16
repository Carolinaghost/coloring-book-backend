#!/usr/bin/env node
'use strict';

// Tests for the emailed book (pdf.js, and the email path in server.js).
//
//   npm test
//
// The job this code does is make the finished book small enough to send. A mail
// attachment is base64-encoded on the wire, which adds about a third; Gmail
// refuses over 25MB and Outlook over 20. Stored as they come out of the model,
// the pages of one book are 18-22MB - so an attachment would bounce for most
// customers. Everything here is really one question: is it still small, and is
// it still a book.
//
// The pages used are the real 1024x1024 fixtures in test/fixtures, out of this
// pipeline. A synthetic white square compresses to nothing and would make the
// size assertions meaningless.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const { buildBookPdf, pdfFileName } = require('../pdf.js');

let pass = 0;
const failures = [];

function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
    console.log(`         got  ${JSON.stringify(got)}`);
    console.log(`         want ${JSON.stringify(want)}`);
  }
}

const FIX = path.join(__dirname, 'fixtures');
function realPages() {
  const out = [];
  for (const group of ['no-words', 'words']) {
    for (const f of fs.readdirSync(path.join(FIX, group)).filter((f) => f.endsWith('.webp')).sort()) {
      out.push(path.join(FIX, group, f));
    }
  }
  return out;
}

// A stored page is a data URL, so build them the way the database holds them.
async function asStored(file, size) {
  let img = sharp(file);
  if (size) img = img.resize(size, size);
  const png = await img.png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

// Enough of a PDF reader to answer "how many pages, and in what order". The
// page images are given different widths by the caller, so the order the
// widths appear in the file is the order the pages are in.
function pageCount(pdf) {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}
function imageWidths(pdf) {
  const re = /\/Subtype\s*\/Image\s*\/Width\s+(\d+)/g;
  const out = [];
  let m;
  while ((m = re.exec(pdf.toString('latin1')))) out.push(Number(m[1]));
  return out;
}

async function main() {
  console.log('\nA real 15-page book');

  const files = realPages().slice(0, 15);
  const pages = [];
  for (let i = 0; i < files.length; i++) {
    pages.push({ sceneIndex: i, image: await asStored(files[i]) });
  }

  const pdf = await buildBookPdf({ childName: 'Ava', theme: 'Superhero', pages });
  const mb = pdf.length / 1048576;
  console.log(`         (${mb.toFixed(2)}MB, ${(mb * 4 / 3).toFixed(2)}MB once base64-encoded for mail)`);

  check('it is a PDF', pdf.slice(0, 5).toString('latin1'), '%PDF-');
  check('it ends properly', /%%EOF\s*$/.test(pdf.slice(-16).toString('latin1')), true);
  // One page per row, plus the cover.
  check('a page each, plus the cover', pageCount(pdf), pages.length + 1);

  // The whole reason this exists. 8MB is the cap the email path applies; a real
  // book has to come in far enough under it that no book is ever held back.
  check('under the 8MB the mailer will attach', pdf.length < 8 * 1024 * 1024, true);
  check('and under 2MB, with room to spare', pdf.length < 2 * 1024 * 1024, true);
  // Stored, these same pages are ~18MB. If this ever regresses past ~4MB
  // something has gone back to embedding full-colour images.
  check('far smaller than the pages it was built from', pdf.length < 4 * 1024 * 1024, true);

  console.log('\nThe pages are in the order they were stored');

  // Each page gets its own width, so the widths in the file spell out the order.
  const sized = [];
  const widths = [320, 340, 360, 380, 400];
  for (let i = 0; i < widths.length; i++) {
    sized.push({ sceneIndex: i, image: await asStored(files[i], widths[i]) });
  }
  const ordered = await buildBookPdf({ childName: 'Leo', theme: 'Portrait', pages: sized });
  check('every page is present once', imageWidths(ordered).length, widths.length);
  check('in scene_index order', imageWidths(ordered), widths);

  // Out of order in, in order out: the builder must not rely on the caller.
  const shuffled = [sized[3], sized[0], sized[4], sized[1], sized[2]];
  const fixed = await buildBookPdf({ childName: 'Leo', theme: 'Portrait', pages: shuffled });
  check('and sorted even when handed them jumbled', imageWidths(fixed), widths);

  console.log('\nThe cover');

  const cover = await buildBookPdf({ childName: 'Ava', theme: 'Superhero', pages: [sized[0]] });
  const raw = cover.toString('latin1');
  check("the child's name is on it", raw.includes('(Ava\'s)'), true);
  check('and the theme', raw.includes('(Superhero Story)'), true);
  // A name with brackets in it would end the PDF string early and produce a
  // file no reader can open.
  const bracket = await buildBookPdf({ childName: 'Jo (Jojo)', theme: 'Portrait', pages: [sized[0]] });
  check('brackets in a name are escaped', bracket.toString('latin1').includes('(Jo \\(Jojo\\)\'s)'), true);
  check('and it is still a readable PDF', pageCount(bracket), 2);

  console.log('\nThe images inside it');

  const dict = pdf.toString('latin1');
  // 4 levels of grey. 8-bit is 5x the size and no better to look at; 1-bit
  // loses the freckles on a portrait, which is the part customers pay for.
  check('greyscale, not colour', dict.includes('/ColorSpace /DeviceGray'), true);
  check('at 4 levels', dict.includes('/BitsPerComponent 2'), true);
  check('compressed', dict.includes('/Filter /FlateDecode'), true);
  check('and the drawings are full size', imageWidths(pdf)[0], 1024);

  console.log('\nThe file it is offered as');
  check('named after the child', pdfFileName('Ava'), 'Ava-coloring-book.pdf');
  check('awkward characters are stripped', pdfFileName('Jo (Jojo)'), 'Jo--Jojo--coloring-book.pdf');
  check('and a missing name still names the file', pdfFileName(''), 'My-coloring-book.pdf');

  console.log('\nThe email that carries it');

  // The attachment is a convenience on top of the email. It must never be the
  // reason the email does not arrive - a customer with no email and no link has
  // paid and received nothing.
  const { emailBookReady, MAX_ATTACHMENT_BYTES } = require('../server.js');
  const mailer = require('../mailer.js');

  const sent = [];
  const realSend = mailer.sendMail;
  mailer.sendMail = async (msg) => { sent.push(msg); return true; };

  const order = { id: 7, childName: 'Ava', email: 'a@b.test', accessToken: 'tok' };

  try {
    sent.length = 0;
    await emailBookReady({ order, pdf, pageCount: 15 });
    check('the book is attached', (sent[0].attachments || []).length, 1);
    check('as a PDF', sent[0].attachments[0].contentType, 'application/pdf');
    check('named after the child', sent[0].attachments[0].filename, 'Ava-coloring-book.pdf');
    check('and it is the same bytes', sent[0].attachments[0].content.equals(pdf), true);
    // Both ways to get the book, always: mail filters strip attachments, and
    // the link is the reprint path for someone who deleted the email.
    check('the link is still in the email', /order=7/.test(sent[0].text), true);

    console.log('\nWhen the PDF could not be built');

    sent.length = 0;
    await emailBookReady({ order, pdf: null, pageCount: 15 });
    check('the email still goes out', sent.length, 1);
    check('carrying nothing', (sent[0].attachments || []).length, 0);
    check('but still carrying the link', /order=7/.test(sent[0].text), true);

    console.log('\nWhen the book is too big to send');

    sent.length = 0;
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    await emailBookReady({ order, pdf: huge, pageCount: 15 });
    check('the attachment is dropped', (sent[0].attachments || []).length, 0);
    check('the email is not', sent.length, 1);
    check('and the link is how they get it', /order=7/.test(sent[0].text), true);
    // One byte under is fine: the cap must not be off by one against a book
    // that would have sent perfectly well.
    sent.length = 0;
    await emailBookReady({ order, pdf: Buffer.alloc(MAX_ATTACHMENT_BYTES), pageCount: 15 });
    check('a book exactly at the cap still goes', (sent[0].attachments || []).length, 1);
  } finally {
    mailer.sendMail = realSend;
  }

  console.log('\nThe download link serves the same file');

  // One book, two ways to get it. If these ever diverge, a customer who was
  // sent one thing downloads another.
  const http = require('http');
  const { app } = require('../server.js');
  const db = require('../db.js');

  const realList = db.listPages;
  const realGet = db.getBookPdf;
  const realSave = db.saveBookPdf;
  const realAuth = db.authorizeOrder;
  let storedPdf = null;
  db.listPages = async () => sized;
  db.getBookPdf = async () => storedPdf;
  db.saveBookPdf = async (id, buf) => { storedPdf = buf; };
  db.authorizeOrder = async (id, token) =>
    (token === 'tok' ? { id: 7, childName: 'Ava', theme: 'Superhero', paid: true } : null);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    }).on('error', reject);
  });

  try {
    const bad = await get('/orders/7/book.pdf');
    check('no token, no book', bad.status, 403);

    const first = await get('/orders/7/book.pdf?token=tok');
    check('the book downloads', first.status, 200);
    check('as a PDF', first.headers['content-type'], 'application/pdf');
    check('offered as a file, named for the child',
      first.headers['content-disposition'], 'attachment; filename="Ava-coloring-book.pdf"');
    check('and it really is one', first.body.slice(0, 5).toString('latin1'), '%PDF-');
    // The first download of an old order builds and keeps it...
    check('the build is kept', storedPdf !== null, true);
    // ...and the next one is handed the very same bytes, not a rebuild.
    const second = await get('/orders/7/book.pdf?token=tok');
    check('the second download is byte for byte the first',
      second.body.equals(first.body), true);
  } finally {
    server.close();
    db.listPages = realList;
    db.getBookPdf = realGet;
    db.saveBookPdf = realSave;
    db.authorizeOrder = realAuth;
  }

  console.log('\nThe MIME the attachment is wrapped in');

  // Built by hand in mailer.js. Nested the wrong way round, most clients show
  // the PDF instead of the message.
  const mime = mailer.buildMessage({
    to: 'a@b.test', subject: 'Your book', text: 'plain', html: '<p>html</p>',
    attachments: [{ filename: 'book.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-x') }]
  });
  check('mixed on the outside', /Content-Type: multipart\/mixed/.test(mime.split('\r\n\r\n')[0]), true);
  check('the readable pair inside it', mime.includes('Content-Type: multipart/alternative'), true);
  check('the file is marked as an attachment', /Content-Disposition: attachment; filename="book.pdf"/.test(mime), true);
  check('and base64-encoded', /Content-Transfer-Encoding: base64/.test(mime), true);
  // RFC 2045 caps an encoded line at 76 characters; longer lines get mangled.
  const b64 = mime.split('Content-Transfer-Encoding: base64')[1].split('\r\n\r\n')[1] || '';
  check('within the 76-character line limit',
    b64.split('\r\n').every((l) => l.length <= 76), true);
  // An email with no attachment must keep the shape it always had.
  const plain = mailer.buildMessage({ to: 'a@b.test', subject: 's', text: 't', html: '<p>h</p>' });
  check('an email with no file is unchanged',
    /Content-Type: multipart\/alternative/.test(plain.split('\r\n\r\n')[0]), true);
  check('and carries no mixed wrapper', plain.includes('multipart/mixed'), false);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nfailed:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\ntest run crashed:', err);
  process.exit(1);
});
