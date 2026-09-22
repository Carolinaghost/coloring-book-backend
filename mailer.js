// Minimal SMTP client.
//
// We can't add nodemailer (no package installs available for this project), so
// this speaks just enough SMTP to send one transactional email over an
// authenticated, encrypted connection. Two transports:
//   port 465 -> implicit TLS (connect straight into TLS)
//   port 587 -> plain connect, then STARTTLS upgrade
//
// Google Workspace accepts both with an App Password. It will NOT accept a
// normal account password.

const net = require('net');
const tls = require('tls');

const HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const PORT = parseInt(process.env.SMTP_PORT, 10) || 465;
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const FROM = process.env.MAIL_FROM || USER;
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Crayonauts';
// Implicit TLS by default on 465, STARTTLS elsewhere. SMTP_SECURE overrides,
// so a non-standard port can still be told which transport to use instead of
// silently falling back to plaintext.
const SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : PORT === 465;

const configured = Boolean(USER && PASS);

function readReply(socket, expect) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // A reply is complete when a line reads "NNN <space>" (not "NNN-").
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;
      cleanup();
      const code = parseInt(last.slice(0, 3), 10);
      if (expect && !expect.includes(code)) {
        return reject(new Error('SMTP expected ' + expect.join('/') + ' but got: ' + last));
      }
      resolve({ code, text: buf });
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('SMTP timed out waiting for a reply')); }, 20000);
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

function say(socket, line, expect) {
  socket.write(line + '\r\n');
  return readReply(socket, expect);
}

function connect() {
  return new Promise((resolve, reject) => {
    const onFail = (e) => reject(e);
    if (SECURE) {
      const s = tls.connect({ host: HOST, port: PORT, servername: HOST }, () => resolve(s));
      s.once('error', onFail);
    } else {
      const s = net.connect({ host: HOST, port: PORT }, () => resolve(s));
      s.once('error', onFail);
    }
  });
}

// RFC 5321: a line consisting of a single "." ends the message, so any line
// that starts with "." must be escaped by doubling it.
function dotStuff(body) {
  return body.split(/\r?\n/).map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

// base64 for a mail body must be wrapped: RFC 2045 caps an encoded line at 76
// characters, and some servers reject or silently mangle anything longer.
function base64Lines(buffer) {
  return (buffer.toString('base64').match(/.{1,76}/g) || []).join('\r\n');
}

// `from` and `replyTo` are per-message because the three mailboxes on this
// domain do three different jobs: support@ is the customer's, admin@ sets
// creators up, accounts@ handles what they get paid. A creator whose welcome
// arrives from support@ replies to support@, and their question lands in the
// queue meant for parents whose book has not turned up.
function buildMessage({ to, subject, text, html, attachments, from, replyTo }) {
  const alt = 'alt_' + Math.random().toString(36).slice(2);
  const sender = from || FROM;
  const answers = replyTo || sender;

  // The two readable versions of the same message.
  const altPart = [
    '--' + alt,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
    '--' + alt,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '--' + alt + '--',
    ''
  ].join('\r\n');

  const files = attachments || [];
  if (!files.length) {
    const headers = [
      'From: ' + FROM_NAME + ' <' + sender + '>',
      'Reply-To: ' + answers,
      'To: ' + to,
      'Subject: ' + subject,
      'MIME-Version: 1.0',
      'Date: ' + new Date().toUTCString(),
      'Content-Type: multipart/alternative; boundary="' + alt + '"'
    ].join('\r\n');
    return headers + '\r\n\r\n' + altPart;
  }

  // With a file attached the shape has to change: multipart/mixed on the
  // outside, the alternative pair as its first part, the files after it. Nested
  // the other way round, most clients show the PDF instead of the message.
  const mixed = 'mix_' + Math.random().toString(36).slice(2);
  const headers = [
    'From: ' + FROM_NAME + ' <' + sender + '>',
    'Reply-To: ' + answers,
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Date: ' + new Date().toUTCString(),
    'Content-Type: multipart/mixed; boundary="' + mixed + '"'
  ].join('\r\n');

  const parts = [
    '',
    '--' + mixed,
    'Content-Type: multipart/alternative; boundary="' + alt + '"',
    '',
    altPart
  ];
  for (const f of files) {
    parts.push(
      '--' + mixed,
      'Content-Type: ' + (f.contentType || 'application/octet-stream') + '; name="' + f.filename + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + f.filename + '"',
      '',
      base64Lines(f.content)
    );
  }
  parts.push('--' + mixed + '--', '');

  return headers + '\r\n' + parts.join('\r\n');
}

async function sendMail({ to, subject, text, html, attachments, from, replyTo }) {
  if (!configured) throw new Error('SMTP_USER / SMTP_PASS are not set.');
  // The envelope sender follows the header, or the two disagree and every
  // receiver that checks alignment - which is all of them now - marks it down.
  const sender = from || FROM;

  let socket = await connect();
  try {
    await readReply(socket, [220]);
    await say(socket, 'EHLO crayonauts', [250]);

    if (!SECURE) {
      await say(socket, 'STARTTLS', [220]);
      socket = await new Promise((resolve, reject) => {
        const up = tls.connect({ socket, servername: HOST }, () => resolve(up));
        up.once('error', reject);
      });
      await say(socket, 'EHLO crayonauts', [250]);
    }

    await say(socket, 'AUTH LOGIN', [334]);
    await say(socket, Buffer.from(USER).toString('base64'), [334]);
    await say(socket, Buffer.from(PASS).toString('base64'), [235]);

    await say(socket, 'MAIL FROM:<' + sender + '>', [250]);
    await say(socket, 'RCPT TO:<' + to + '>', [250, 251]);
    await say(socket, 'DATA', [354]);

    socket.write(dotStuff(buildMessage({ to, subject, text, html, attachments, from: sender, replyTo })) + '\r\n.\r\n');
    await readReply(socket, [250]);

    try { await say(socket, 'QUIT', [221]); } catch (e) { /* some servers just hang up */ }
    return true;
  } finally {
    try { socket.end(); socket.destroy(); } catch (e) {}
  }
}

// The email a customer gets once their payment clears.
function orderReadyEmail({ childName, orderId, accessToken, siteUrl, pageCount }) {
  // The token rides in the URL FRAGMENT, not the query string: fragments are
  // not sent to servers and don't end up in access logs or Referer headers.
  const link = siteUrl + '?order=' + orderId + '#t=' + encodeURIComponent(accessToken);
  const who = childName || 'your child';
  const subject = 'Your coloring book is ready';
  const text = [
    'Thanks for your order!',
    '',
    who + "'s coloring book (" + pageCount + ' pages) is ready to download:',
    link,
    '',
    'Keep this link - it is how you get back to your book. It works for 30 days,',
    'so download the PDF and save it somewhere safe.',
    '',
    '- Crayonauts'
  ].join('\n');
  const html = [
    '<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#2A2724;">',
    '<h2 style="color:#2F5FA8;">Your coloring book is ready</h2>',
    '<p>Thanks for your order! ' + who + "'s coloring book (" + pageCount + ' pages) is ready.</p>',
    '<p><a href="' + link + '" style="display:inline-block;background:#2F5FA8;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Download your book</a></p>',
    '<p style="font-size:13px;color:#6B6357;">Keep this email - that link is how you get back to your book. '
    + 'It works for <strong>30 days</strong>, so download the PDF and save it somewhere safe.</p>',
    '</div>'
  ].join('');
  return { subject, text, html };
}

// Sent when the free preview would not draw and we finished it afterwards.
//
// The apology comes first and the pages come second, because by the time this
// lands the customer has already been told something went wrong and has had
// several minutes to decide we are not very good at this. The pages are the
// argument against that, so they are attached rather than linked - an inbox
// on a phone shows an image without asking, and a link is a decision.
//
// No discount, no offer, nothing to click except the way back to their own
// book. They asked for two free pages; this is the two free pages, late.
function previewReadyEmail({ childName, orderId, accessToken, siteUrl, pageCount, totalPages }) {
  // Same reasoning as the ready email: the token rides in the fragment, which
  // browsers do not send to servers and logs never see.
  const link = siteUrl + '?order=' + orderId + '#t=' + encodeURIComponent(accessToken);
  const who = childName || 'your child';
  const pages = pageCount === 1 ? 'page' : 'pages';
  const subject = 'Your free ' + pages + ' of ' + who + "'s coloring book";
  const text = [
    'Sorry about that - the drawing would not come out while you were waiting.',
    'It has now. Your free ' + pages + ' ' + (pageCount === 1 ? 'is' : 'are') + ' attached.',
    '',
    'To see ' + who + "'s whole book - all " + totalPages + ' pages - pick up where you left off:',
    link,
    '',
    'Nothing was charged and nothing was used up. If you would rather start',
    'again with a different photo, that is fine too.',
    '',
    '- Crayonauts'
  ].join('\n');
  const html = [
    '<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#2A2724;">',
    '<h2 style="color:#2F5FA8;">Sorry about the wait</h2>',
    '<p>The drawing would not come out while you were on the site. It has now &mdash; '
    + 'your free ' + pages + ' ' + (pageCount === 1 ? 'is' : 'are') + ' attached to this email.</p>',
    '<p>To see ' + escapeHtml(who) + "'s whole book, all " + totalPages + ' pages:</p>',
    '<p><a href="' + link + '" style="display:inline-block;background:#2F5FA8;color:#fff;padding:12px 22px;'
    + 'border-radius:8px;text-decoration:none;font-weight:bold;">Pick up where you left off</a></p>',
    '<p style="font-size:13px;color:#6B6357;">Nothing was charged and nothing was used up. '
    + 'If you would rather start again with a different photo, that is fine too.</p>',
    '</div>'
  ].join('');
  return { subject, text, html };
}

// The one email a new creator gets. Everything they need to start earning is
// in it, and nothing they have to fill in is: bank details and the W-9 are
// collected by the payment service, in a separate invite, because a routing
// number emailed back as an attachment sits in an inbox forever.
//
// The code is printed AND the link is printed. They are not the same thing to
// a creator: the link is what goes in a bio, the code is what goes in a
// caption somebody reads out loud. Give one and not the other and half the
// audience has no way through.
function creatorWelcomeEmail({ name, code, siteUrl, ratePercent, freeCode }) {
  const link = siteUrl + '?c=' + encodeURIComponent(code.toLowerCase());
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const rate = Number(ratePercent) || 25;
  const subject = "You're in - here's your Crayonauts code";
  const text = [
    'Hi ' + first + ',',
    '',
    "You're set up as a Crayonauts creator. Here is everything you need.",
    '',
    'Your code:  ' + code,
    'Your link:  ' + link,
    ''
  ];
  if (freeCode) {
    text.push(
      'And your free book, on us: use code ' + freeCode + ' at checkout. It works',
      'once, it never expires, and it takes the price to zero.',
      ''
    );
  }
  text.push(
    'Either one works. The link is for your bio; the code is for when somebody',
    'is reading your caption or listening to you say it out loud. Both track',
    'back to you, and neither changes the price your audience pays.',
    '',
    'You earn ' + rate + '% of every book bought through them.',
    '',
    'The pay week runs Thursday morning to Wednesday night, US Eastern.',
    'Whatever sold in that week is paid the Friday after it closes.',
    '',
    'One more thing: you will get a separate invite to set up how you get paid.',
    'That is where your tax form and your bank details go - please do not send',
    'either of those by email.',
    '',
    'Anything about setting up, just reply to this. Anything about what you are',
    'owed comes from accounts@crayonauts.com.',
    '',
    '- Crayonauts'
  );
  const textBody = text.join('\n');
  const html = [
    '<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#2A2724;">',
    '<h2 style="color:#2F5FA8;">You&rsquo;re in, ' + escapeHtml(first) + '</h2>',
    '<p>You&rsquo;re set up as a Crayonauts creator. Here is everything you need.</p>',
    '<div style="background:#F6F4EF;border-radius:10px;padding:16px 18px;margin:18px 0;">',
    '<p style="margin:0 0 6px;font-size:13px;color:#6B6357;">Your code</p>',
    '<p style="margin:0 0 14px;font-size:22px;font-weight:bold;letter-spacing:1px;">' + escapeHtml(code) + '</p>',
    '<p style="margin:0 0 6px;font-size:13px;color:#6B6357;">Your link</p>',
    '<p style="margin:0;"><a href="' + link + '">' + escapeHtml(link) + '</a></p>',
    '</div>',
    freeCode
      ? '<div style="background:#FBF6EA;border-left:4px solid #E8622C;border-radius:8px;padding:14px 16px;margin:18px 0;">'
        + '<p style="margin:0 0 4px;font-weight:bold;">And your free book, on us.</p>'
        + '<p style="margin:0;">Use <strong style="letter-spacing:1px;">' + escapeHtml(freeCode)
        + '</strong> at checkout. It works once, it never expires, and it takes the price to zero.</p>'
        + '</div>'
      : '',
    '<p>Either one works. The link is for your bio; the code is for when somebody is reading your '
    + 'caption or listening to you say it out loud. Both track back to you, and neither changes the '
    + 'price your audience pays.</p>',
    '<p style="font-size:17px;"><strong>You earn ' + rate + '% of every book bought through them.</strong></p>',
    '<p>The pay week runs Thursday morning to Wednesday night, US Eastern. Whatever sold in that '
    + 'week is paid the Friday after it closes.</p>',
    '<p style="font-size:13px;color:#6B6357;">One more thing: you&rsquo;ll get a separate invite to set '
    + 'up how you get paid. That&rsquo;s where your tax form and your bank details go &mdash; please '
    + 'don&rsquo;t send either of those by email.</p>',
    '<p style="font-size:13px;color:#6B6357;">Anything about setting up, just reply to this. '
    + 'Anything about what you&rsquo;re owed comes from accounts@crayonauts.com.</p>',
    '</div>'
  ].join('');
  return { subject, text: textBody, html };
}

// Only ever wraps values that came off a form, so it covers the five that
// matter and does not pretend to be a sanitiser.
function escapeHtml(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { sendMail, orderReadyEmail, previewReadyEmail, creatorWelcomeEmail, buildMessage, configured, HOST, PORT, SECURE, USER: USER || null };
