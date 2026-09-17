#!/usr/bin/env node
'use strict';

// Shrinks pages already sitting in order_pages.
//
//   node scripts/reencode-pages.js                 look, change nothing
//   node scripts/reencode-pages.js --limit 5       try five orders for real
//   node scripts/reencode-pages.js --write         do the lot
//
// DRY RUN BY DEFAULT. Nothing is written without --write.
//
// This rewrites customer data and the original pixels do not come back, so the
// reasons it is safe are worth stating rather than assuming:
//
//   The customer's PDF does not change. pdf.js already quantises to these same
//   four levels, so a book built from a re-encoded page is byte-for-byte the
//   book built from the original. Verified, not assumed - see test/page-encode.
//
//   It is idempotent. A second pass changes no pixels, so stopping halfway and
//   running it again is fine, and so is running it twice by mistake.
//
//   Each page is checked after encoding and before writing: it must decode, and
//   it must be the same dimensions. Anything that fails is left exactly as it
//   was and reported.
//
//   Orders still being drawn are skipped, so nothing is rewritten underneath a
//   render that is in progress.
//
// What does change: the thumbnails on the waiting page become greyscale. They
// are line art at about 150 pixels and look the same.

const sharp = require('sharp');
const db = require('../db');
const { encodeForStorage } = require('../page-encode');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg === -1 ? Infinity : parseInt(args[limitArg + 1], 10) || Infinity;

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

// A page must survive the round trip before it is allowed to replace the one
// that works today.
async function safeToReplace(before, after) {
  if (!after || after === before) return false;
  if (after.length >= before.length) return false;
  const bin = (d) => Buffer.from(d.slice(d.indexOf(',') + 1), 'base64');
  const a = await sharp(bin(before)).metadata();
  const b = await sharp(bin(after)).metadata();
  return Boolean(b.width) && b.width === a.width && b.height === a.height;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Nothing to do.');
    process.exit(1);
  }
  await db.initDb();

  const pool = db.pool || null;
  if (!pool) {
    console.error('No database pool - is DATABASE_URL a real Postgres URL?');
    process.exit(1);
  }

  console.log(WRITE ? '\nWRITING. This rewrites stored pages.' : '\nDry run. Nothing will be written.');

  const { rows: orders } = await pool.query(
    `SELECT o.id, o.generation_status,
            (SELECT COUNT(*)::int FROM order_pages p WHERE p.order_id = o.id) AS pages
       FROM orders o
      WHERE EXISTS (SELECT 1 FROM order_pages p WHERE p.order_id = o.id)
        AND COALESCE(o.generation_status, '') <> 'running'
      ORDER BY o.id`
  );
  console.log(`${orders.length} order(s) with pages, not currently rendering.\n`);

  let before = 0, after = 0, changed = 0, skipped = 0, failed = 0, done = 0;

  for (const o of orders) {
    if (done >= LIMIT) break;
    const { rows: pages } = await pool.query(
      'SELECT scene_index, image FROM order_pages WHERE order_id = $1 ORDER BY scene_index', [o.id]);

    let oBefore = 0, oAfter = 0, oChanged = 0;
    for (const p of pages) {
      oBefore += p.image.length;
      let next;
      try {
        next = await encodeForStorage(p.image);
      } catch (err) {
        console.error(`  order ${o.id} page ${p.scene_index}: encode failed - ${err.message}`);
        failed++; oAfter += p.image.length; continue;
      }
      if (!await safeToReplace(p.image, next)) { skipped++; oAfter += p.image.length; continue; }

      oAfter += next.length;
      oChanged++;
      if (WRITE) {
        await pool.query(
          'UPDATE order_pages SET image = $1 WHERE order_id = $2 AND scene_index = $3',
          [next, o.id, p.scene_index]);
      }
    }

    before += oBefore; after += oAfter; changed += oChanged; done++;
    const saved = oBefore - oAfter;
    console.log(`  order ${String(o.id).padStart(4)}  ${String(pages.length).padStart(2)} pages  `
      + `${mb(oBefore).padStart(8)} -> ${mb(oAfter).padStart(8)}  `
      + (saved > 0 ? `saves ${mb(saved)}` : 'nothing to gain'));
  }

  console.log(`\n${done} order(s) looked at, ${changed} page(s) ${WRITE ? 'rewritten' : 'would be rewritten'}`
    + (skipped ? `, ${skipped} already small` : '')
    + (failed ? `, ${failed} FAILED and left alone` : ''));
  console.log(`  ${mb(before)} -> ${mb(after)}   saves ${mb(before - after)}`
    + (before ? `  (${(before / (after || 1)).toFixed(1)}x smaller)` : ''));
  if (!WRITE) console.log('\nNothing was written. Re-run with --write to do it.');

  await db.close?.();
  process.exit(0);
}

main().catch((err) => { console.error('\nFailed:', err); process.exit(1); });
