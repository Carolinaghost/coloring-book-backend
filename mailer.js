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
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Storybook You';
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

function buildMessage({ to, subject, text, html }) {
  const boundary = 'bnd_' + Math.random().toString(36).slice(2);
  const headers = [
    'From: ' + FROM_NAME + ' <' + FROM + '>',
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Date: ' + new Date().toUTCString(),
    'Content-Type: multipart/alternative; boundary="' + boundary + '"'
  ].join('\r\n');

  const body = [
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '--' + boundary + '--',
    ''
  ].join('\r\n');

  return headers + '\r\n' + body;
}

async function sendMail({ to, subject, text, html }) {
  if (!configured) throw new Error('SMTP_USER / SMTP_PASS are not set.');

  let socket = await connect();
  try {
    await readReply(socket, [220]);
    await say(socket, 'EHLO storybook', [250]);

    if (!SECURE) {
      await say(socket, 'STARTTLS', [220]);
      socket = await new Promise((resolve, reject) => {
        const up = tls.connect({ socket, servername: HOST }, () => resolve(up));
        up.once('error', reject);
      });
      await say(socket, 'EHLO storybook', [250]);
    }

    await say(socket, 'AUTH LOGIN', [334]);
    await say(socket, Buffer.from(USER).toString('base64'), [334]);
    await say(socket, Buffer.from(PASS).toString('base64'), [235]);

    await say(socket, 'MAIL FROM:<' + FROM + '>', [250]);
    await say(socket, 'RCPT TO:<' + to + '>', [250, 251]);
    await say(socket, 'DATA', [354]);

    socket.write(dotStuff(buildMessage({ to, subject, text, html })) + '\r\n.\r\n');
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
    '- Storybook You'
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

module.exports = { sendMail, orderReadyEmail, configured, HOST, PORT, SECURE, USER: USER || null };
