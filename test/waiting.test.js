#!/usr/bin/env node
'use strict';

// Tests for what the waiting page is told (server.js: GET /orders/:id/access).
//
//   npm test
//
// After paying, the customer sits on a page watching pages appear. Almost
// nobody has twelve minutes for that, so the page tells them they can close it
// and we will email the book to them. People only believe that if it reads
// their own address back, and only relax if it names a time.
//
// Both facts come from here rather than from the browser, so that an emailed
// link opened on a phone says the same thing as the tab they paid in. If
// either field goes missing the page still works and still counts pages - it
// just quietly stops naming the address, which is the part that makes someone
// comfortable leaving. Nothing else would catch that.

const http = require('http');
const { app } = require('../server.js');

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

function request(server, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function place(server, fields) {
  const made = await request(server, '/orders', { method: 'POST', body: JSON.stringify(fields) });
  return JSON.parse(made.body);
}

async function access(server, made) {
  const res = await request(server,
    `/orders/${made.order.id}/access?token=${encodeURIComponent(made.accessToken)}`);
  return { status: res.status, body: JSON.parse(res.body) };
}

const PHOTO = 'data:image/png;base64,iVBORw0KGgo=';

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  try {
    console.log('\nA single-child order');

    const single = await place(server, {
      childName: 'Ava', email: 'ava.mum@example.test', theme: 'Portrait', pageCount: 15
    });
    const one = await access(server, single);
    check('the waiting page can read the order', one.status, 200);
    check('it is told where the book is going', one.body.email, 'ava.mum@example.test');
    // Under two people is a single book, and gets the shorter wait quoted.
    check('and that this is not a family book', one.body.peopleCount, 0);

    console.log('\nA family order');

    const family = await place(server, {
      childName: 'Leo', email: 'leo.dad@example.test', theme: 'Portrait', pageCount: 15,
      people: [
        { name: 'Leo', subjectType: 'kid', star: true, photo: PHOTO },
        { name: 'Mum', subjectType: 'adult', photo: PHOTO },
        { name: 'Dad', subjectType: 'adult', photo: PHOTO }
      ]
    });
    const many = await access(server, family);
    // A family page takes about half as long again to draw, so the page has to
    // know which kind of book this is before it quotes a time.
    check('the cast size comes back', many.body.peopleCount, 3);
    check('two or more is a family', many.body.peopleCount >= 2, true);
    check('the address comes back too', many.body.email, 'leo.dad@example.test');

    console.log('\nNone of it without the token');

    const noToken = await request(server, `/orders/${family.order.id}/access`);
    check('no token, no answer', noToken.status, 403);
    const wrongToken = await request(server,
      `/orders/${family.order.id}/access?token=${'x'.repeat(String(family.accessToken).length)}`);
    check('a wrong token is refused', wrongToken.status, 403);
    check('and it leaks neither field', /example\.test|peopleCount/.test(wrongToken.body), false);

    console.log('\nThe page counter still has what it needs');

    // The counter is what the people who stay on the page watch. The new
    // wording sits beside it, not instead of it.
    check('the total is still there', many.body.pageCount, 15);
    check('and the progress', typeof many.body.pagesReady, 'number');
    // generationStatus is absent until rendering starts; the page reads it as
    // 'idle' until then, so absent has to mean "not started", never "done".
    check('and nothing claims it is finished yet',
      ['done', 'partial', 'failed'].includes(many.body.generationStatus), false);
    check('it knows payment has not landed yet', many.body.paid, false);

    // Photos are big and the waiting page has no use for them - it polls this
    // every five seconds.
    check('no photos are sent to the waiting page',
      /iVBORw0KGgo/.test(JSON.stringify(many.body)), false);
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
