#!/usr/bin/env node
'use strict';

// Tests for the sample pages the site scatters around its "this is what you
// get" block (server.js: SAMPLE_PAGES, /samples.json, /samples, /embed).
//
//   npm test
//
// The list is read from disk once at boot, so the thing worth checking is that
// what the site is told about matches what is actually deployed. A page named
// in the manifest but missing from the folder is a broken image on the site,
// and nothing else would catch it.

const fs = require('fs');
const path = require('path');
const http = require('http');

const { app, SAMPLE_PAGES } = require('../server.js');
const SAMPLES_DIR = path.join(__dirname, '..', 'public', 'samples');
const EMBED_DIR = path.join(__dirname, '..', 'public', 'embed');

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

// A real request through the real routes, so the static mounts are exercised
// rather than assumed.
function get(server, url) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        body: Buffer.concat(chunks)
      }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('\nSample pages');

  const onDisk = fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.webp')).sort();

  check('the site is offered some pages', SAMPLE_PAGES.length > 0, true);
  check('the list matches the folder', SAMPLE_PAGES, onDisk);
  check('every page is a .webp', SAMPLE_PAGES.every((f) => f.endsWith('.webp')), true);
  check('no page is listed twice', new Set(SAMPLE_PAGES).size, SAMPLE_PAGES.length);
  // Fewer than the tiles on screen and the scatter would have to repeat itself.
  check('enough pages to fill the scatter', SAMPLE_PAGES.length >= 18, true);
  check('every listed page exists on disk',
    SAMPLE_PAGES.filter((f) => !fs.existsSync(path.join(SAMPLES_DIR, f))), []);
  check('no page is empty',
    SAMPLE_PAGES.filter((f) => fs.statSync(path.join(SAMPLES_DIR, f)).size === 0), []);

  console.log('\nRoutes');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  try {
    const manifest = await get(server, '/samples.json');
    check('/samples.json answers', manifest.status, 200);
    const body = JSON.parse(manifest.body.toString('utf8'));
    check('manifest base points at the static mount', body.base, '/samples/');
    check('manifest lists the pages', body.pages, SAMPLE_PAGES);

    // The path the browser actually builds: base + a name from the manifest.
    const first = await get(server, body.base + body.pages[0]);
    check('a listed page is served', first.status, 200);
    check('served as an image', first.type, 'image/webp');
    check('served with real bytes', first.body.length > 0, true);

    const widget = await get(server, '/embed/sample-scatter.js');
    check('the widget is served', widget.status, 200);
    check('the widget looks for the manifest',
      widget.body.toString('utf8').includes('/samples.json'), true);
    check('the widget file on disk is what is served',
      widget.body.length, fs.statSync(path.join(EMBED_DIR, 'sample-scatter.js')).size);

    const missing = await get(server, '/samples/not-a-real-page.webp');
    check('an unknown page 404s rather than hanging', missing.status, 404);
  } finally {
    server.close();
  }

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
