// text-guard.js
//
// Does this page have readable lettering on it? This asks a vision model,
// because the pixel checks in mirror-guard.js cannot read.
//
// Measured on 16 September 2026 against 30 pages: the 18 in test/fixtures,
// plus 12 made that day - 6 with lettering forced on purpose and 6 ordinary
// pages. This check scored 29/30, mirror-guard scored 26/30, and they never
// missed the same page. maybeMirror asks both and flips only when both say
// the page is clean: 30/30 together, with no clean page wrongly held back.
//
// The page this one missed was a small framed wall plaque three words long.
// The pages mirror-guard missed were large stylised sign lettering. That is
// the split, and it is why both stay.
//
// Every failure answers 'there might be words'. A page leaning the same way
// as its neighbours is one nobody notices. A page with backwards writing on
// it is one that gets sent back.

const MODEL = process.env.TEXT_GUARD_MODEL || 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const QUESTION = 'Does this picture contain any readable letters, words or numbers anywhere in it - on a sign, banner, label, book, blackboard, clock face or anywhere else? Answer with one word: YES or NO.';

async function hasText(buffer) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return true;
  const url = 'data:image/png;base64,' + buffer.toString('base64');
  const content = [{ type: 'text', text: QUESTION }, { type: 'image_url', image_url: { url: url } }];
  const body = JSON.stringify({ model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: content }] });
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const res = await fetch(ENDPOINT, { method: 'POST', headers: headers, body: body });
  const data = await res.json();
  const choice = data && data.choices ? data.choices[0] : null;
  const answer = choice && choice.message ? String(choice.message.content).trim().toUpperCase() : '';
  return !answer.startsWith('NO');
}

module.exports = { hasText, QUESTION };
