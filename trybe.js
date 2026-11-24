'use strict';
// Trybe (the creator platform behind the "Crayonauts Parent Creators"
// program) pays a creator 20% of the sales her videos bring in. It can only
// do that if it hears about our sales, so when a book is paid this sends
// Trybe the order: our order id, what was paid, and the visitor id Trybe's
// own script gave the buyer in the browser. Trybe matches the visitor to the
// creator video they came from; orders it can't match cost nothing.
//
// Guide: https://jointrybe.com/help/brand-guides/trybe-pixel-and-orders-api
//
// Nothing here is allowed to touch an order. Every send is fire-and-forget,
// every failure is logged and swallowed. With no TRYBE_API_KEY set, or
// TRYBE_ORDERS=off, it does nothing at all. The buyer's email is NOT sent.
const ENDPOINT = 'https://jointrybe.com/attribution/v1/orders';
const KEY = () => process.env.TRYBE_API_KEY || '';
const ON = () => String(process.env.TRYBE_ORDERS || 'on').toLowerCase() !== 'off';

// The browser's id, as Trybe hands it out (a uuid today). Anything else is
// dropped rather than passed along.
function cleanVid(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : '';
}

// The request body Trybe asks for. null when there is nothing to send:
// no visitor id, nothing paid, or no order.
function orderBody({ order, session, apiKey }) {
  if (!order || !session) return null;
  const md = session.metadata || {};
  const vid = cleanVid(md.trybe_vid);
  const cents = Number(session.amount_total);
  if (!vid || !(cents > 0)) return null;
  const product = md.product === 'print' ? 'print' : 'digital';
  const isFamily = Array.isArray(order.people) && order.people.length > 1;
  const value = Math.round(cents) / 100;
  return {
    apiKey,
    orderId: String(order.id),
    value,
    currency: 'USD',
    vid,
    orderTime: new Date(session.created ? session.created * 1000 : Date.now()).toISOString(),
    items: [{
      productId: (isFamily ? 'family-' : 'personal-') + product,
      productName: (isFamily ? 'Family' : 'Personalized') + ' coloring book' + (product === 'print' ? ' (printed)' : ' (PDF)'),
      quantity: 1,
      price: value
    }]
  };
}

// Sends one paid order. Resolves to a short result for the log; never throws.
async function sendOrder({ order, session, fetchImpl, log = console } = {}) {
  try {
    const apiKey = KEY();
    if (!apiKey || !ON()) return { sent: false, reason: 'off' };
    const body = orderBody({ order, session, apiKey });
    if (!body) return { sent: false, reason: 'no-visitor-or-unpaid' };
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    const resp = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
    });
    // 409 = Trybe already has this order (a Stripe retry): that is fine.
    if (resp.ok || resp.status === 409) {
      log.log(`Order ${order.id}: sent to Trybe (${resp.status})`);
      return { sent: true, status: resp.status };
    }
    log.error(`Order ${order.id}: Trybe said ${resp.status}`);
    return { sent: false, status: resp.status };
  } catch (err) {
    log.error(`Order ${order && order.id}: could not reach Trybe -`, err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendOrder, orderBody, cleanVid, ENDPOINT };
