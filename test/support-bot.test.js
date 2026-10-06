#!/usr/bin/env node
'use strict';
// Tests for the support@ assistant (support-bot.js, mime.js, imap.js taggedEnd).
// The inbox, the model and the mail server are all stubbed.
//
//   npm test

if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') {
  console.error('DATABASE_URL is set; unset it to test the in-memory store.');
  process.exit(1);
}
const db = require('../db');
const realMailer = require('../mailer');
const { createSupportBot, skipReason } = require('../support-bot');
const { parseEmail } = require('../mime');
const { taggedEnd } = require('../imap');

let pass = 0; const failures = [];
function check(name, ok) { if (ok) pass++; else failures.push(name); }

function rawMail({ from, subject, body, id, extra = '' }) {
  return Buffer.from('From: ' + from + '\r\nSubject: ' + subject + '\r\nMessage-ID: ' + id + '\r\n' + extra
    + 'Content-Type: text/plain; charset=utf-8\r\n\r\n' + body + '\r\n');
}

// A fake inbox: messages by UID.
function fakeImap(box) {
  return () => ({
    connect: async () => {}, login: async () => {}, logout: async () => {},
    select: async () => ({ uidValidity: box.validity, uidNext: box.mail.length + 1 }),
    uidsAfter: async (after) => box.mail.map((m, i) => i + 1).filter((u) => u > after),
    fetchRaw: async (uid) => box.mail[uid - 1]
  });
}

(async () => {
  // --- parsing and filters
  const m1 = parseEmail(rawMail({ from: 'Pat <pat@example.com>', subject: 'Price?', body: 'How much is a family book?\r\n\r\nOn Mon, Oct 5, 2026 at 1:00 PM Someone wrote:\r\n> old', id: '<a@x>' }));
  check('parses sender and strips quoted history', m1.from === 'pat@example.com' && m1.text === 'How much is a family book?');
  check('DMARC report skipped', skipReason(parseEmail(rawMail({ from: 'noreply-dmarc@zoho.com', subject: 'Report domain: crayonauts.com', body: 'x', id: '<d@x>' }))) !== null);
  check('auto-submitted skipped', skipReason(parseEmail(rawMail({ from: 'a@b.com', subject: 'Hi', body: 'x', id: '<e@x>', extra: 'Auto-Submitted: auto-replied\r\n' }))) === 'auto-submitted');
  check('own domain skipped', skipReason(parseEmail(rawMail({ from: 'admin@crayonauts.com', subject: 'Hi', body: 'x', id: '<f@x>' }))) !== null);
  check('mailing list skipped', skipReason(parseEmail(rawMail({ from: 'news@shop.com', subject: 'Sale', body: 'x', id: '<g@x>', extra: 'List-Unsubscribe: <mailto:u@shop.com>\r\n' }))) === 'mailing list');
  check('normal customer not skipped', skipReason(m1) === null);
  check('IMAP literal containing a fake tag does not end the reply',
    taggedEnd(Buffer.from('* 1 FETCH (BODY[] {10}\r\nA2 OK hi\r\n)\r\nA2 OK done\r\n'), 'A2') === 49
    && taggedEnd(Buffer.from('* 1 FETCH (BODY[] {10}\r\nA2 OK hi\r\n)\r\n'), 'A2') === -1);

  // --- the bot
  const sent = [];
  const mailer = { configured: true, plainEmail: realMailer.plainEmail, sendMail: async (m) => { sent.push(m); return true; } };
  const decisions = {
    'pat@example.com': { action: 'reply', reply: 'Hi Pat, a family book is $25.', summary: 'asked price' },
    'lee@example.com': { action: 'escalate', reply: 'Thanks Lee - Jonathan will get back to you within a day.', summary: 'book never arrived' },
    'spam@seo.com': { action: 'ignore', reply: '', summary: 'SEO pitch' }
  };
  const asked = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[1].content;
    asked.push(user);
    const who = (user.match(/<([^>]+)>/) || [])[1];
    const d = decisions[who] || { action: 'escalate', reply: 'A person will reply.', summary: '?' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(d) } }] }) };
  };
  const box = { validity: 7, mail: [rawMail({ from: 'old@example.com', subject: 'Old', body: 'old question', id: '<old@x>' })] };
  const bot = createSupportBot({ db, mailer, imap: { user: 'support@crayonauts.com', pass: 'x' }, openaiKey: 'sk-test',
    alertEmail: 'owner@example.com', fetchImpl: fakeFetch, makeImap: fakeImap(box), log: { log() {}, error() {} } });

  let r = await bot.pollOnce();
  check('first run only sets a starting point', r.baseline === 1 && sent.length === 0 && asked.length === 0);

  box.mail.push(
    rawMail({ from: 'Pat <pat@example.com>', subject: 'Price?', body: 'How much is a family book?', id: '<p1@x>' }),
    rawMail({ from: 'Lee <lee@example.com>', subject: 'Where is my book', body: 'I paid yesterday, nothing came.', id: '<l1@x>' }),
    rawMail({ from: 'spam@seo.com', subject: 'Rank #1 on Google', body: 'cheap SEO', id: '<s1@x>' }),
    rawMail({ from: 'noreply-dmarc@zoho.com', subject: 'Report domain: crayonauts.com', body: 'xml', id: '<d1@x>' })
  );
  r = await bot.pollOnce();
  check('four new messages handled in order', r.results.map((x) => x.outcome).join(',') === 'replied,escalated,ignored,skipped');
  const toPat = sent.find((m) => m.to === 'pat@example.com');
  check('Pat gets an answer, threaded, marked automatic', toPat && toPat.subject === 'Re: Price?'
    && toPat.text.includes('$25') && toPat.text.includes('written by our assistant')
    && toPat.headers.includes('In-Reply-To: <p1@x>') && toPat.headers.includes('Auto-Submitted: auto-replied'));
  check('Lee gets a holding note', sent.some((m) => m.to === 'lee@example.com' && /within a day/.test(m.text)));
  check('owner alerted about Lee', sent.some((m) => m.to === 'owner@example.com' && /Needs you/.test(m.subject) && /nothing came/.test(m.text)));
  check('spam and DMARC get nothing', !sent.some((m) => m.to === 'spam@seo.com' || /dmarc/.test(m.to)));
  check('model never saw the DMARC report or old mail', asked.length === 3 && !asked.some((a) => /old question/.test(a)));

  const before = sent.length;
  r = await bot.pollOnce();
  check('nothing new, nothing sent', r.results.length === 0 && sent.length === before);

  // Same Message-ID again (a resend or second copy) is not answered twice.
  box.mail.push(rawMail({ from: 'Pat <pat@example.com>', subject: 'Price?', body: 'How much is a family book?', id: '<p1@x>' }));
  r = await bot.pollOnce();
  check('duplicate Message-ID not answered twice', r.results[0].outcome === 'seen' && sent.length === before);

  // A loop with another auto-responder stops after 3 replies a day.
  for (let i = 0; i < 4; i++) box.mail.push(rawMail({ from: 'Pat <pat@example.com>', subject: 'Again ' + i, body: 'hello?', id: '<pl' + i + '@x>' }));
  r = await bot.pollOnce();
  const outs = r.results.map((x) => x.outcome);
  check('sender limit holds the 4th and 5th', outs.join(',') === 'replied,replied,held,held');

  // The model failing means a person is told, nothing is guessed.
  const bot2 = createSupportBot({ db, mailer, imap: { user: 'u', pass: 'p' }, openaiKey: 'k', alertEmail: 'owner@example.com',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) }),
    makeImap: fakeImap(box), log: { log() {}, error() {} } });
  const out = await bot2.handle(parseEmail(rawMail({ from: 'Kim <kim@example.com>', subject: 'Q', body: 'question', id: '<k1@x>' })));
  check('model error is held for a person', out === 'held' && !sent.some((m) => m.to === 'kim@example.com')
    && sent.some((m) => m.to === 'owner@example.com' && /could not read it/.test(m.text)));

  // A mail server failure does not skip the message.
  const box3 = { validity: 9, mail: [] };
  let failSend = true;
  const flaky = { configured: true, plainEmail: realMailer.plainEmail, sendMail: async (m) => { if (failSend) throw new Error('smtp down'); sent.push(m); } };
  const bot3 = createSupportBot({ db, mailer: flaky, imap: { user: 'u3', pass: 'p' }, openaiKey: 'k', alertEmail: '',
    fetchImpl: fakeFetch, makeImap: fakeImap(box3), log: { log() {}, error() {} } });
  // Separate state key is shared in memory, so reset it for this inbox.
  await db.setBotState('support_inbox', JSON.stringify({ uidValidity: 9, lastUid: 0 }));
  box3.mail.push(rawMail({ from: 'Rae <rae@example.com>', subject: 'Styles?', body: 'What styles are there?', id: '<r1@x>' }));
  decisions['rae@example.com'] = { action: 'reply', reply: 'Hi Rae, lots of styles.', summary: 'styles' };
  r = await bot3.pollOnce();
  check('send failure stops without moving on', r.results[0].outcome === 'error');
  failSend = false;
  r = await bot3.pollOnce();
  check('next check retries and answers', r.results[0] && r.results[0].outcome === 'replied' && sent.some((m) => m.to === 'rae@example.com'));

  console.log(pass + ' passed' + (failures.length ? ', FAILED: ' + failures.join('; ') : ''));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
