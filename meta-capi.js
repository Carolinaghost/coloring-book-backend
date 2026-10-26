'use strict';
// Meta Conversions API: the same events the Pixel sends from the browser, sent
// again from this server so Meta still hears about a sale when the browser
// blocks the Pixel or the buyer closes the tab before Stripe sends them back.
//
// Both copies of an event carry the same event_id and event_name, and Meta
// keeps one of them (it de-duplicates within 48 hours). So this can never
// double-count a sale - it only fills in the ones the browser missed.
//
// Nothing here is allowed to touch an order. Every send is fire-and-forget and
// every failure is logged and swallowed. With no META_CAPI_TOKEN set it does
// nothing at all.
//
// Personal details go only in the form Meta asks for: email, phone and our
// order id are lower-cased/normalised and SHA-256 hashed before they leave.
// The browser cookie ids (_fbp/_fbc), IP address and browser name are sent as
// they are, which is what Meta needs to match the event to an ad click.
const crypto = require('crypto');

const TOKEN = () => process.env.META_CAPI_TOKEN || '';
const PIXEL_ID = () => process.env.META_PIXEL_ID || '1760133305035577';
const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || 'v24.0';
const TEST_CODE = () => process.env.META_CAPI_TEST_CODE || '';

function sha256(v) {
  return crypto.createHash('sha256').update(v).digest('hex');
}
function hashEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e && e.includes('@') ? sha256(e) : null;
}
// Meta wants digits only, with the country code. Ours are US numbers.
function hashPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '1' + d;
  return d.length >= 11 && d.length <= 15 ? sha256(d) : null;
}
function hashId(id) {
  const s = String(id == null ? '' : id).trim();
  return s ? sha256(s) : null;
}
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// The browser details worth keeping from the moment checkout starts, sized
// for Stripe metadata (500 characters a value).
function browserDetails({ fb, ip, userAgent }) {
  const f = fb && typeof fb === 'object' ? fb : {};
  const ok = (v, re) => (typeof v === 'string' && re.test(v) ? v : '');
  return {
    fbp: ok(f.fbp, /^fb\.\d\.\d+\.\d+$/),
    fbc: ok(f.fbc, /^fb\.\d\.\d+\.[A-Za-z0-9_\-.]{1,400}$/),
    url: ok(f.url, /^https:\/\/(www\.)?crayonauts\.com\//) ? clip(f.url, 490) : '',
    ip: clip(ip && ip !== 'unknown' ? ip : '', 60),
    ua: clip(userAgent, 490)
  };
}

function buildEvent({ eventName, eventId, eventTime, sourceUrl, email, phone, externalId, fbp, fbc, ip, ua, customData }) {
  const user = {};
  const em = hashEmail(email); if (em) user.em = [em];
  const ph = hashPhone(phone); if (ph) user.ph = [ph];
  const ex = hashId(externalId); if (ex) user.external_id = [ex];
  if (fbp) user.fbp = fbp;
  if (fbc) user.fbc = fbc;
  if (ip) user.client_ip_address = ip;
  if (ua) user.client_user_agent = ua;
  const ev = {
    event_name: eventName,
    event_time: Math.floor((eventTime || Date.now()) / 1000),
    event_id: String(eventId),
    action_source: 'website',
    event_source_url: sourceUrl || 'https://crayonauts.com/',
    user_data: user
  };
  if (customData) ev.custom_data = customData;
  return ev;
}

// Returns Meta's answer, or null when switched off or failed. Never throws.
async function sendEvent(fields, { fetchImpl = fetch, log = console } = {}) {
  if (!TOKEN()) return null;
  try {
    const body = { data: [buildEvent(fields)] };
    if (TEST_CODE()) body.test_event_code = TEST_CODE();
    const url = `https://graph.facebook.com/${GRAPH_VERSION()}/${PIXEL_ID()}/events?access_token=${encodeURIComponent(TOKEN())}`;
    const resp = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      log.error(`Meta ${fields.eventName} ${fields.eventId}: refused - ${(out.error && out.error.message) || resp.status}`);
      return null;
    }
    log.log(`Meta ${fields.eventName} ${fields.eventId}: sent (${out.events_received || 0} received).`);
    return out;
  } catch (err) {
    log.error(`Meta ${fields.eventName} ${fields.eventId}: could not send - ${err.message}`);
    return null;
  }
}

module.exports = { sendEvent, buildEvent, browserDetails, hashEmail, hashPhone, hashId, sha256, enabled: () => !!TOKEN() };
