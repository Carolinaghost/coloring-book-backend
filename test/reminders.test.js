#!/usr/bin/env node
'use strict';

// "Your book is waiting" reminders.
//
//   npm test
//
// Up to two emails to someone who typed their email at Unlock and then did not
// pay. What must never happen: emailing someone who never gave an address,
// someone who paid, someone who said stop, or anyone more than twice.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-not-a-real-key';
process.env.SITE_URL = 'https://crayonauts.com';
delete process.env.DATABASE_URL;   // in-memory store
delete process.env.REMINDER_EMAILS;

const http = require('http');
const db = require('../db.js');
const mailer = require('../mailer.js');
const { app, sendDueReminders, reminderStopSig } = require('../server.js');

let pass = 0;
const failures = [];
function check(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`); }
}

let sent = [];
let sendThrows = false;
mailer.configured = true;
mailer.sendMail = async (msg) => { if (sendThrows) throw new Error('SMTP said no'); sent.push(msg); };

async function newOrder(extra = {}) {
  return db.saveOrder({
    childName: 'Mia', childCount: 1, email: '', theme: 'Superhero', notes: '', thumb: null,
    pageCount: 15, photo: 'data:image/png;base64,AAAA', subjectType: 'kid', detailLevel: 'standard', ...extra
  });
}
// saveOrder hands back a copy; ageing has to reach the stored record.
async function stored(id) { return db.getOrderWithToken(id); }
async function startedAgo(id, minutes) { (await stored(id)).submittedAt = new Date(Date.now() - minutes * 60000).toISOString(); }
async function remindedAgo(id, minutes) { (await stored(id)).reminder1At = new Date(Date.now() - minutes * 60000).toISOString(); }

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Who is written to');
  const noEmail = await newOrder();
  const fresh = await newOrder({ email: 'fresh@example.com' });
  const ready = await newOrder({ email: 'ready@example.com' });
  const old = await newOrder({ email: 'old@example.com' });
  const payer = await newOrder({ email: 'payer@example.com' });
  const payerPaid = await newOrder({ email: 'PAYER@example.com' });
  for (const o of [noEmail, fresh, ready, old, payer, payerPaid]) await startedAgo(o.id, 90);
  await startedAgo(fresh.id, 20);
  await startedAgo(old.id, 5 * 24 * 60);
  (await stored(payerPaid.id)).paid = true;

  let due = await db.reminderCandidates(1, 60, 1320);
  check('someone who never typed an email is never picked', due.includes(noEmail.id), false);
  check('not before the first hour', due.includes(fresh.id), false);
  check('an unpaid order with an email, over an hour old, is picked', due.includes(ready.id), true);
  check('nothing older than three days', due.includes(old.id), false);
  check('not an address that has paid for another order (any letter case)', due.includes(payer.id), false);

  console.log('\nThe first email');
  sent = [];
  await sendDueReminders();
  const mine = sent.filter((m) => m.to === 'ready@example.com');
  check('one email to them', mine.length, 1);
  check('about their own child', /Mia/.test(mine[0].subject), true);
  check('with the way back to their book', mine[0].text.includes('https://crayonauts.com?order=' + ready.id + '#t='), true);
  check('with a stop link', /\/reminders\/stop\?o=\d+&s=[0-9a-f]{24}/.test(mine[0].text), true);
  check('and a List-Unsubscribe header', (mine[0].headers || []).some((h) => /^List-Unsubscribe: <https:\/\/api\.crayonauts\.com\/reminders\/stop/.test(h)), true);
  check('and the postal address', /Sheridan, WY 82801/.test(mine[0].text), true);
  check('nobody else was written to', sent.map((m) => m.to).sort(), ['ready@example.com']);

  sent = [];
  await sendDueReminders();
  check('a second sweep sends nothing', sent.length, 0);

  console.log('\nThe second email, and no third');
  await remindedAgo(ready.id, 600);
  sent = [];
  await sendDueReminders();
  check('not before the gap has passed', sent.length, 0);
  await remindedAgo(ready.id, 1400);
  await sendDueReminders();
  check('the second goes once the gap has passed', sent.length, 1);
  check('and reads as a last note', /Still thinking/.test(sent[0].subject), true);
  sent = [];
  await remindedAgo(ready.id, 5000);
  await sendDueReminders();
  check('there is never a third', sent.length, 0);

  console.log('\nOne email per person, about the newest book');
  const a1 = await newOrder({ email: 'twice@example.com' });
  const a2 = await newOrder({ email: 'twice@example.com' });
  await startedAgo(a1.id, 120); await startedAgo(a2.id, 90);
  due = await db.reminderCandidates(1, 60, 1320);
  check('only the newest of two unpaid orders is picked', [due.includes(a1.id), due.includes(a2.id)], [false, true]);

  console.log('\nA failed send is tried again');
  const b = await newOrder({ email: 'bounce@example.com' });
  await startedAgo(b.id, 90);
  sendThrows = true; sent = [];
  await sendDueReminders();
  check('the stamp is handed back when sending fails', (await stored(b.id)).reminder1At, null);
  sendThrows = false;
  await sendDueReminders();
  check('and it goes on the next sweep', sent.some((m) => m.to === 'bounce@example.com'), true);

  console.log('\nThe stop link');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const c1 = await newOrder({ email: 'stop@example.com' });
  const c2 = await newOrder({ email: 'stop@example.com' });
  await startedAgo(c1.id, 90); await startedAgo(c2.id, 90);
  const bad = await get(port, `/reminders/stop?o=${c2.id}&s=${'0'.repeat(24)}`);
  check('a wrong signature is refused', bad.status, 404);
  check('and changes nothing', (await stored(c2.id)).remindersOff, false);
  const good = await get(port, `/reminders/stop?o=${c2.id}&s=${reminderStopSig(await stored(c2.id))}`);
  check('the right link is accepted', good.status, 200);
  check('and stops that order', (await stored(c2.id)).remindersOff, true);
  check('and every other order under the same email', (await stored(c1.id)).remindersOff, true);
  sent = [];
  await sendDueReminders();
  check('so nothing goes to them', sent.some((m) => m.to === 'stop@example.com'), false);
  server.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
