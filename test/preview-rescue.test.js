#!/usr/bin/env node
'use strict';

// Finishing a free preview that would not draw, and posting it.
//
//   npm test
//
// On 21 September OpenAI's safety system refused five draws inside nine
// minutes. The browser retries three times, but all three land inside the
// first two minutes, so every one failed and four books came to nothing. The
// same photos drew without complaint an hour later. This is what stops that
// costing a customer.
//
// Everything here is guarding one of two ways it could go badly wrong.
//
// Emailing somebody who did not ask.  Most unpaid orders are people who
// wandered off, and they vastly outnumber the failures. Drawing for them costs
// money we did not need to spend; emailing them costs a spam complaint. Only
// an order whose draw actually failed may ever be picked up.
//
// Emailing the same person twice, or emailing them nothing.  The send is
// claimed before it goes out so two sweeps cannot both make it, and the claim
// is handed back when the send fails so a bounce is not mistaken for delivery.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_not_a_real_key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-not-a-real-key';
process.env.SITE_URL = 'https://crayonauts.com';
delete process.env.DATABASE_URL;   // in-memory store

const db = require('../db.js');
const mailer = require('../mailer.js');
const { rescuePreview, rescueFailedPreviews, FREE_PREVIEW_PAGES } = require('../server.js');

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

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const realFetch = global.fetch;
const realSend = mailer.sendMail;
const realConfigured = mailer.configured;

let openaiCalls = 0;
let failDraws = false;
function stubOpenAI() {
  global.fetch = async (url) => {
    const href = typeof url === 'string' ? url : url.href || String(url);
    // The lettering check that guards mirroring is an OpenAI call too, and it
    // fires on a coin flip, so counting every request to them would make this
    // file pass or fail at random. Only drawings are counted.
    if (href.includes('/chat/completions')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'no' } }] }) };
    }
    if (href.includes('api.openai.com')) {
      openaiCalls++;
      if (failDraws) {
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: 'Your request was rejected by the safety system.' } }),
          json: async () => ({ error: { message: 'Your request was rejected by the safety system.' } })
        };
      }
      return { ok: true, json: async () => ({ data: [{ b64_json: PNG_DATA_URL.split(',')[1] }] }) };
    }
    return realFetch(url);
  };
}

let sent = [];
let sendThrows = false;
mailer.configured = true;
mailer.sendMail = async (msg) => {
  if (sendThrows) throw new Error('SMTP said no');
  sent.push(msg);
};

async function newOrder(extra = {}) {
  return db.saveOrder({
    childName: 'Camilla', childCount: 1, email: 'mum@example.com',
    theme: 'Superhero', notes: '', thumb: null, pageCount: 15,
    photo: PNG_DATA_URL, subjectType: 'kid', detailLevel: 'simple', ...extra
  });
}

// Moves the failure back in time so a schedule that is minutes long can be
// tested in milliseconds. It has to reach the STORED record: saveOrder hands
// back a copy on purpose, and ageing the copy ages nothing.
async function agedBy(id, minutes) {
  const stored = await db.getOrderForRender(id);
  stored.previewRescueAt = new Date(Date.now() - minutes * 60000).toISOString();
}

(async () => {
  stubOpenAI();
  console.log('Who gets picked up');

  const wandered = await newOrder();
  const failed = await newOrder();
  await db.markPreviewRescue(failed.id);

  let due = await db.rescuablePreviews(3, [1, 4, 10]);
  check('somebody who simply left is never queued', due.includes(wandered.id), false);
  check('and a failed draw is not due in the first minute', due.includes(failed.id), false);

  await agedBy(failed.id, 2);
  due = await db.rescuablePreviews(3, [1, 4, 10]);
  check('but it is due once the first minute has passed', due.includes(failed.id), true);

  console.log('\nFinishing it');

  openaiCalls = 0;
  sent = [];
  await rescuePreview(failed.id);
  check('it draws the free preview pages and no more', openaiCalls, FREE_PREVIEW_PAGES);
  check('and one email goes out', sent.length, 1);
  check('with a page attached for each', sent[0].attachments.length, FREE_PREVIEW_PAGES);
  check('addressed to the customer', sent[0].to, 'mum@example.com');
  check('saying sorry rather than selling', /free page/i.test(sent[0].subject), true);
  check('and carrying the way back to their own book',
    sent[0].text.includes('https://crayonauts.com?order=' + failed.id), true);

  console.log('\nNot twice');

  sent = [];
  await rescuePreview(failed.id);
  check('a second sweep sends nothing', sent.length, 0);
  check('and it has left the queue',
    (await db.rescuablePreviews(3, [1, 4, 10])).includes(failed.id), false);

  console.log('\nWhen it still will not draw');

  const stubborn = await newOrder();
  await db.markPreviewRescue(stubborn.id);
  failDraws = true;
  openaiCalls = 0;
  sent = [];
  for (let i = 0; i < 4; i++) {
    await agedBy(stubborn.id, 30);
    const ids = await db.rescuablePreviews(3, [1, 4, 10]);
    if (ids.includes(stubborn.id)) await rescuePreview(stubborn.id);
  }
  check('nothing is emailed when there is nothing to send', sent.length, 0);
  check('and it gives up after three goes rather than trying forever',
    openaiCalls, 3 * FREE_PREVIEW_PAGES);
  failDraws = false;

  console.log('\nWhen the email will not send');

  const bounced = await newOrder();
  await db.markPreviewRescue(bounced.id);
  await agedBy(bounced.id, 2);
  sendThrows = true;
  await rescuePreview(bounced.id);
  sendThrows = false;
  // The attempt it just used reset its clock, so age it again before asking -
  // what is being checked is that it is still IN the queue, not that a fresh
  // delay has already elapsed.
  await agedBy(bounced.id, 30);
  check('a failed send does not count as delivered',
    (await db.rescuablePreviews(3, [1, 4, 10])).includes(bounced.id), true);
  sent = [];
  await agedBy(bounced.id, 30);
  await rescuePreview(bounced.id);
  check('so the next sweep tries again', sent.length, 1);

  console.log('\nWhen they paid in the meantime');

  const bought = await newOrder();
  await db.markPreviewRescue(bought.id);
  await agedBy(bought.id, 2);
  // Straight onto the row: markPaid goes through a Stripe session id, and the
  // only thing that matters here is that the order is paid when the sweep looks.
  (await db.getOrderForRender(bought.id)).paid = true;
  check('a paid order leaves this queue',
    (await db.rescuablePreviews(3, [1, 4, 10])).includes(bought.id), false);
  sent = [];
  openaiCalls = 0;
  await rescuePreview(bought.id);
  check('and is not drawn for here either', openaiCalls, 0);
  check('nor emailed the two-page apology', sent.length, 0);

  global.fetch = realFetch;
  mailer.sendMail = realSend;
  mailer.configured = realConfigured;

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})();
