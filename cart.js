'use strict';
// Several books in one checkout.
//
// Each book is still its own order - its own photo, pages, PDF, email and
// printed copy - and the cart is only a way to pay for them together. Stripe
// knows nothing of that: it sees one session with one line per book, one
// shipping charge ($4.99 for the whole box - printed copies bought together
// are mailed together) and, if a code was used, one discount across the lot.
//
// Everything downstream (the printed-copy record, the Meta Purchase, the
// order's amount in /stats and the admin CSV) was written for one book per
// session and reads the session's totals as that book's numbers. Rather than
// teach each of them about carts, splitSession hands each order a copy of the
// session whose totals are that one book's share, so they keep working
// unchanged:
//
//   amount_subtotal  the book's own price
//   amount_discount  the code's discount, shared by price (a $25 family book
//                    carries more of it than a $15 one), pennies to the last
//   amount_shipping  its share of the box's shipping if it has a printed
//                    copy, else 0
//   amount_total     subtotal - discount + shipping
//
// The shares always add back up to Stripe's totals exactly - the last book
// takes whatever rounding left over - so no report ever shows a cent that was
// not charged, or misses one that was.

function priceFor(order, { priceCents, familyPriceCents, shippingCents }) {
  const isFamily = Array.isArray(order.people) && order.people.length > 1;
  return {
    bookCents: isFamily ? familyPriceCents : priceCents,
    shipCents: order.product === 'print' ? shippingCents : 0
  };
}

// Shares `total` across `weights` in proportion, whole cents, summing exactly.
function shareOut(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => (sum > 0 ? Math.floor((total * w) / sum) : 0));
  const left = total - out.reduce((a, b) => a + b, 0);
  if (out.length) out[out.length - 1] += left;
  return out;
}

function splitSession(session, orders, prices) {
  const list = orders.map((o) => ({ order: o, ...priceFor(o, prices) }));
  const td = session.total_details || {};
  const subtotal = Number(session.amount_subtotal || 0);
  const discount = Number(td.amount_discount || 0);
  const shipping = Number(td.amount_shipping || 0);
  // Stripe's subtotal is the books before the code. Share it by our own
  // prices, so a book's subtotal is still right if a price changed on Render
  // between checkout and payment (Stripe's number wins over ours).
  const subtotals = shareOut(subtotal, list.map((x) => x.bookCents));
  const discounts = shareOut(Math.min(discount, subtotal), subtotals);
  const ships = shareOut(shipping, list.map((x) => x.shipCents));
  return list.map((x, i) => {
    const amountTotal = subtotals[i] - discounts[i] + ships[i];
    return {
      order: x.order,
      amountCents: amountTotal,
      session: Object.assign({}, session, {
        amount_subtotal: subtotals[i],
        amount_total: amountTotal,
        total_details: Object.assign({}, td, { amount_discount: discounts[i], amount_shipping: ships[i] }),
        shipping_cost: ships[i] ? Object.assign({}, session.shipping_cost || {}, { amount_total: ships[i] }) : null,
        metadata: Object.assign({}, session.metadata || {}, { product: x.order.product === 'print' ? 'print' : 'digital' })
      })
    };
  });
}

module.exports = { priceFor, shareOut, splitSession };
