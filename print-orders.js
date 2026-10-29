'use strict';

// Printed copies: from a paid checkout to a book in the post.
//
//   checkout.session.completed  recordPaidSession() keeps the address Stripe
//                               collected. Status 'waiting', or 'held' when a
//                               discount took the book below what printing it
//                               costs - those wait for Jonathan to release.
//   book finished               prepareAndSend() colours the first drawing for
//                               the cover, builds the two print PDFs and hands
//                               Lulu a print-job pointing at them. 'sent'.
//   heartbeat sweep             retries anything still waiting, and asks Lulu
//                               about every 'sent' job. Shipped -> the customer
//                               gets the tracking link and it is 'shipped'.
//
// Lulu downloads the PDFs from /print-files/<order>/<token>/{interior,cover}.pdf.
// The token is random per order; without it the files are a 404.
//
// Nothing here throws at the caller. A printed copy that fails is retried and
// then emailed to Jonathan - it never stops the digital book being delivered.

const crypto = require('crypto');
const { buildPrintInterior, buildPrintCover, interiorPageCount, POD_PACKAGE_ID } = require('./print-pdf');

const FINAL = new Set(['SHIPPED', 'DELIVERED', 'REJECTED', 'CANCELED', 'CANCELLED']);

function createPrintOrders({
  db, lulu, mailer, colorize, alert, filesBaseUrl, contactEmail,
  shippingLevel = 'MAIL', holdBelowCents = 1000, maxAttempts = 5,
  log = console, now = () => Date.now(), cacheMs = 6 * 60 * 60 * 1000
}) {
  const cache = new Map();          // orderId -> { interior, cover, pageCount, at }
  const unpaidWarned = new Set();
  const say = (level, subject, lines) => Promise.resolve(alert && alert({ level, subject, lines }))
    .catch((err) => log.error('Print alert failed:', err.message));

  // Stripe has moved the collected address around between API versions:
  // session.shipping_details on older ones, collected_information.shipping_details
  // on newer. Either is read; phone and email come from customer_details.
  function shipFromSession(session, order) {
    const sd = (session.collected_information && session.collected_information.shipping_details)
      || session.shipping_details || {};
    const a = sd.address || {};
    const cd = session.customer_details || {};
    return {
      name: String(sd.name || cd.name || '').trim(),
      street1: String(a.line1 || '').trim(),
      street2: String(a.line2 || '').trim(),
      city: String(a.city || '').trim(),
      state_code: String(a.state || '').trim(),
      postcode: String(a.postal_code || '').trim(),
      country_code: String(a.country || '').trim(),
      phone_number: String(cd.phone || '').trim(),
      email: String(cd.email || (order && order.email) || '').trim()
    };
  }

  function missingShipFields(ship) {
    return ['name', 'street1', 'city', 'postcode', 'country_code', 'phone_number', 'email']
      .filter((k) => !ship[k]);
  }

  function isPrintSession(session, order) {
    return (session.metadata && session.metadata.product === 'print') || (order && order.product === 'print');
  }

  async function recordPaidSession(session, order) {
    if (!order || !isPrintSession(session, order)) return null;
    const ship = shipFromSession(session, order);
    const td = session.total_details || {};
    const shippingCents = Number(td.amount_shipping || (session.shipping_cost && session.shipping_cost.amount_total) || 0);
    // What the customer paid for the book itself, after any code.
    const bookCents = Number(session.amount_subtotal || 0) - Number(td.amount_discount || 0);
    const missing = missingShipFields(ship);
    let status = 'waiting';
    let why = '';
    if (missing.length) { status = 'held'; why = 'the address is missing: ' + missing.join(', '); }
    else if (bookCents < holdBelowCents) {
      status = 'held';
      why = `a discount code brought the book to $${(bookCents / 100).toFixed(2)}, under the`
        + ` $${(holdBelowCents / 100).toFixed(2)} it takes to cover printing`;
    }
    const existing = await db.getPrintOrder(order.id);
    if (existing) return existing;               // a Stripe retry
    // Several printed books bought in one checkout go out in one box (see
    // prepareAndSend), so they share a key: the Stripe session.
    const md = session.metadata || {};
    const packageKey = md.orders && String(md.orders).includes(',') ? String(session.id || '') : '';
    const row = await db.savePrintOrder({
      orderId: order.id, ship, shippingCents, status, packageKey,
      filesToken: crypto.randomBytes(18).toString('hex')
    });
    if (why) await db.updatePrintOrder(order.id, { lastError: why });
    log.log(`Order ${order.id}: printed copy recorded (${status}${why ? ' - ' + why : ''}).`);
    if (status === 'held') {
      await say('WARN', `Printed copy for order ${order.id} is on hold`, [
        `Order ${order.id} paid for a printed copy, but it has not been sent to Lulu because ${why}.`,
        'Nothing is printed until it is released. To print it anyway, release it from the admin page.'
      ]);
    }
    return row;
  }

  function fileUrl(orderId, token, which) {
    return `${String(filesBaseUrl).replace(/\/+$/, '')}/print-files/${orderId}/${token}/${which}.pdf`;
  }

  async function buildFiles(order, row) {
    const pages = await db.listPages(order.id);
    if (!pages.length) throw new Error('the order has no pages');
    const sorted = pages.slice().sort((a, b) => (a.sceneIndex || 0) - (b.sceneIndex || 0));
    const pageCount = interiorPageCount(sorted.length);
    const interior = await buildPrintInterior({ childName: order.childName, pages: sorted });
    const dims = await lulu.coverDimensions(POD_PACKAGE_ID, pageCount);
    const toPt = (v) => (dims.unit === 'mm' ? Number(v) * 72 / 25.4 : dims.unit === 'inch' ? Number(v) * 72 : Number(v));
    const cover = await buildPrintCover({
      childName: order.childName,
      lineImage: sorted[0].image,
      colorImage: row.coverColor,
      widthPt: toPt(dims.width),
      heightPt: toPt(dims.height)
    });
    const entry = { interior: interior.pdf, cover, pageCount, at: now() };
    cache.set(Number(order.id), entry);
    return entry;
  }

  // For the /print-files route. Built on demand if this process has not got
  // them (a restart since the job was sent), from the same pages.
  async function getFile(orderId, token, which) {
    if (which !== 'interior' && which !== 'cover') return null;
    const row = await db.getPrintOrder(orderId);
    if (!row || !row.filesToken || !token || !safeEqual(row.filesToken, token)) return null;
    let entry = cache.get(Number(orderId));
    if (!entry || now() - entry.at > cacheMs) {
      const order = await db.getOrderWithToken(orderId);
      if (!order || !row.coverColor) return null;
      entry = await buildFiles(order, row);
    }
    return entry[which];
  }

  // The printed copies that go out in one box with this one: every waiting
  // copy from the same checkout (the same package key). A book bought on its
  // own is a package of one. Copies on hold or already sent are left out -
  // a held copy goes later, on its own, when it is released.
  async function packageFor(row) {
    if (!row.packageKey) return [row];
    const all = await db.listPrintOrders(['waiting', 'preparing']);
    const members = all.filter((r) => r.packageKey === row.packageKey);
    return members.length ? members.sort((a, b) => a.orderId - b.orderId) : [row];
  }

  // How long a box waits for its slowest book. Past this, whatever is finished
  // goes, and the rest follows on its own - one stuck book must not keep the
  // others from ever being printed.
  const PACKAGE_WAIT_MS = 24 * 60 * 60 * 1000;

  async function prepareAndSend(orderId) {
    let row = await db.getPrintOrder(orderId);
    if (!row || row.status !== 'waiting') return row;
    if (!lulu || !lulu.configured) return row;

    let members = await packageFor(row);
    if (members.some((m) => m.status === 'preparing')) return row;   // another pass has this box
    const orders = new Map();
    for (const m of members) {
      const o = await db.getOrderWithToken(m.orderId);
      if (o) orders.set(m.orderId, o);
    }
    const isDone = (m) => orders.has(m.orderId) && orders.get(m.orderId).generationStatus === 'done';
    if (!isDone(row)) return row;  // the book is not finished yet
    if (!members.every(isDone)) {
      const waited = now() - new Date(row.createdAt).getTime();
      if (waited < PACKAGE_WAIT_MS) return row;  // wait for the rest of the box
      members = members.filter(isDone);
    }

    const ids = members.map((m) => m.orderId);
    const lead = members[0];
    const attempts = row.attempts + 1;
    for (const m of members) await db.updatePrintOrder(m.orderId, { status: 'preparing', attempts });
    try {
      const lineItems = [];
      let pagesTotal = 0;
      for (let m of members) {
        m = await db.getPrintOrder(m.orderId);
        const order = orders.get(m.orderId);
        if (!m.coverColor) {
          const pages = await db.listPages(m.orderId);
          const first = pages.slice().sort((a, b) => (a.sceneIndex || 0) - (b.sceneIndex || 0))[0];
          if (!first) throw new Error(`order ${m.orderId} has no pages`);
          const coloured = await colorize(first.image);
          m = await db.updatePrintOrder(m.orderId, { coverColor: coloured });
        }
        const files = await buildFiles(order, m);
        pagesTotal += files.pageCount;
        const name = String(order.childName || '').trim();
        lineItems.push({
          external_id: String(m.orderId),
          title: (name ? name + "'s" : 'My') + ' Coloring Adventure',
          quantity: 1,
          printable_normalization: {
            pod_package_id: POD_PACKAGE_ID,
            interior: { source_url: fileUrl(m.orderId, m.filesToken, 'interior') },
            cover: { source_url: fileUrl(m.orderId, m.filesToken, 'cover') }
          }
        });
      }
      // One address for the box: the one the customer gave at checkout,
      // which every copy in it carries.
      const s = lead.ship || {};
      const payload = {
        contact_email: contactEmail,
        external_id: `crayonauts-${ids.join('-')}`,
        shipping_level: shippingLevel,
        shipping_address: {
          name: s.name, street1: s.street1, ...(s.street2 ? { street2: s.street2 } : {}),
          city: s.city, state_code: s.state_code, postcode: s.postcode,
          country_code: s.country_code, phone_number: s.phone_number, email: s.email
        },
        line_items: lineItems
      };
      const job = await lulu.createPrintJob(payload);
      const jobStatus = (job.status && job.status.name) || '';
      for (const id of ids) {
        const updated = await db.updatePrintOrder(id, {
          status: 'sent', luluJobId: String(job.id || ''), luluStatus: jobStatus, lastError: ''
        });
        if (id === row.orderId) row = updated;
      }
      const which = ids.length > 1 ? `orders ${ids.join(', ')} (one box)` : `order ${orderId}`;
      log.log(`Printed copies for ${which} sent to Lulu as job ${job.id} (${jobStatus}, ${pagesTotal} pages).`);
      await say('INFO', ids.length > 1 ? `Printed copies for orders ${ids.join(', ')} sent to Lulu`
        : `Printed copy for order ${orderId} sent to Lulu`, [
        `Lulu print job ${job.id}${lulu.sandbox ? ' (SANDBOX - nothing will be printed)' : ''}.`,
        ...(ids.length > 1 ? [`${ids.length} books in one box.`] : []),
        `Ship to: ${s.name}, ${s.city} ${s.state_code}.`,
        `Status at Lulu: ${jobStatus || 'unknown'}.`
      ]);
      return row;
    } catch (err) {
      const giveUp = attempts >= maxAttempts;
      log.error(`Order ${orderId}: printed copy attempt ${attempts} failed - ${err.message}`);
      for (const id of ids) {
        const updated = await db.updatePrintOrder(id, {
          status: giveUp ? 'failed' : 'waiting', lastError: String(err.message).slice(0, 1000)
        });
        if (id === row.orderId) row = updated;
      }
      if (giveUp) {
        await say('ALERT', `Printed copy for order ${ids.join(', ')} could not be sent to Lulu`, [
          `Tried ${attempts} times. Last error: ${err.message}`,
          'The customer has their digital book. The printed copy needs a look.'
        ]);
      }
      return row;
    }
  }

  function trackingFrom(job) {
    const urls = [];
    for (const li of job.line_items || job.items || []) {
      const m = (li.status && li.status.messages) || {};
      if (Array.isArray(m.tracking_urls)) urls.push(...m.tracking_urls);
    }
    for (const li of (job.status && job.status.line_item_statuses) || []) {
      const m = li.messages || {};
      if (Array.isArray(m.tracking_urls)) urls.push(...m.tracking_urls);
    }
    return urls.find(Boolean) || '';
  }

  async function checkJob(row) {
    if (!row.luluJobId) return row;
    const job = await lulu.getPrintJob(row.luluJobId);
    const name = (job.status && job.status.name) || '';
    const message = (job.status && job.status.message) || '';
    if (name && name !== row.luluStatus) {
      row = await db.updatePrintOrder(row.orderId, { luluStatus: name });
      log.log(`Order ${row.orderId}: Lulu job ${row.luluJobId} is now ${name}.`);
    }
    if (name === 'SHIPPED' || name === 'DELIVERED') {
      const trackingUrl = trackingFrom(job);
      row = await db.updatePrintOrder(row.orderId, { status: 'shipped', trackingUrl });
      // Books in one box share one Lulu job, so one "on its way" email names
      // them all, sent by the lowest order in the box. The others are marked
      // as emailed without sending, so nobody gets the same parcel three times.
      const box = row.packageKey
        ? (await db.listPrintOrders()).filter((r) => r.luluJobId === row.luluJobId).sort((a, b) => a.orderId - b.orderId)
        : [row];
      const leadsBox = box[0].orderId === row.orderId;
      if (!row.shippedEmailAt && !leadsBox) {
        row = await db.updatePrintOrder(row.orderId, { shippedEmailAt: new Date(now()).toISOString() });
      }
      if (!row.shippedEmailAt && mailer && mailer.configured) {
        const order = await db.getOrderWithToken(row.orderId);
        const to = (row.ship && row.ship.email) || (order && order.email);
        const names = [];
        if (box.length > 1) {
          for (const b of box) {
            const o = b.orderId === row.orderId ? order : await db.getOrderWithToken(b.orderId);
            if (o && o.childName) names.push(o.childName);
          }
        }
        if (to) {
          const mail = mailer.printShippedEmail({ childName: order && order.childName, trackingUrl, names });
          await mailer.sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
          row = await db.updatePrintOrder(row.orderId, { shippedEmailAt: new Date(now()).toISOString() });
        }
      }
    } else if (name === 'REJECTED' || name === 'CANCELED' || name === 'CANCELLED') {
      row = await db.updatePrintOrder(row.orderId, { status: 'failed', lastError: `Lulu ${name}: ${message}`.slice(0, 1000) });
      await say('ALERT', `Lulu ${name.toLowerCase()} the printed copy for order ${row.orderId}`, [
        `Lulu job ${row.luluJobId}: ${message || 'no reason given'}.`
      ]);
    } else if (name === 'UNPAID' && !unpaidWarned.has(row.orderId)
      && now() - new Date(row.updatedAt).getTime() > 60 * 60 * 1000) {
      unpaidWarned.add(row.orderId);
      await say('WARN', `Lulu job for order ${row.orderId} is waiting for payment`, [
        `Lulu job ${row.luluJobId} has been UNPAID for over an hour, so it will not be printed.`,
        'Add a card to the Lulu developer account (it then pays each job automatically), or pay this job there.'
      ]);
    }
    return row;
  }

  let sweeping = false;
  async function sweep() {
    if (sweeping || !lulu || !lulu.configured) return;
    sweeping = true;
    try {
      const rows = await db.listPrintOrders(['waiting', 'preparing', 'sent']);
      for (const row of rows) {
        try {
          // 'preparing' for over half an hour means the process doing it died
          // mid-way (a deploy, a crash). Put it back in the queue.
          if (row.status === 'preparing' && now() - new Date(row.updatedAt).getTime() > 30 * 60 * 1000) {
            await db.updatePrintOrder(row.orderId, { status: 'waiting' });
            await prepareAndSend(row.orderId);
          } else if (row.status === 'waiting') await prepareAndSend(row.orderId);
          else if (row.status === 'sent' && !FINAL.has(row.luluStatus)) await checkJob(row);
        } catch (err) {
          log.error(`Order ${row.orderId}: print sweep step failed - ${err.message}`);
        }
      }
    } finally {
      sweeping = false;
    }
  }

  async function release(orderId) {
    const row = await db.getPrintOrder(orderId);
    if (!row || (row.status !== 'held' && row.status !== 'failed')) return row;
    if (missingShipFields(row.ship || {}).length) return row;
    return db.updatePrintOrder(orderId, { status: 'waiting', attempts: 0, lastError: '' });
  }

  return { recordPaidSession, prepareAndSend, sweep, checkJob, getFile, release, shipFromSession, fileUrl, trackingFrom };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { createPrintOrders };
