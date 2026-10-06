// Minimal IMAP client - just enough to read the support@ inbox.
//
// Same reason as mailer.js: no packages can be added to this project, so this
// speaks the handful of IMAP commands the support assistant needs over TLS
// (port 993): LOGIN, SELECT, UID SEARCH, UID FETCH, LOGOUT. It reads messages
// with BODY.PEEK so nothing it looks at is marked as read - Jonathan still
// sees every message as new in Zoho.

const tls = require('tls');

function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// True once `buf` holds a complete tagged reply for `tag`. Literals ({n}\r\n
// followed by n raw bytes) are skipped over whole, so a message body that
// happens to contain "A3 OK" on a line cannot end the reply early.
function taggedEnd(buf, tag) {
  let pos = 0;
  while (pos < buf.length) {
    const crlf = buf.indexOf('\r\n', pos);
    if (crlf < 0) return -1;
    const line = buf.slice(pos, crlf).toString('latin1');
    const lit = line.match(/\{(\d+)\}$/);
    if (lit) {
      const n = parseInt(lit[1], 10);
      const after = crlf + 2 + n;
      if (after > buf.length) return -1;
      // The line carries on after the literal, up to its own CRLF.
      pos = after;
      continue;
    }
    if (line.startsWith(tag + ' ')) return crlf + 2;
    pos = crlf + 2;
  }
  return -1;
}

class ImapClient {
  constructor({ host, port = 993, user, pass, timeoutMs = 30000 }) {
    this.host = host; this.port = port; this.user = user; this.pass = pass;
    this.timeoutMs = timeoutMs;
    this.socket = null; this.buf = Buffer.alloc(0); this.n = 0;
    this.waiter = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host: this.host, port: this.port, servername: this.host });
      this.socket = s;
      s.setTimeout(this.timeoutMs, () => s.destroy(new Error('IMAP timed out')));
      s.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this._check(); });
      s.on('error', (e) => { if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(e); } else reject(e); });
      s.on('close', () => { if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(new Error('IMAP connection closed')); } });
      // The greeting is untagged: wait for the first full line.
      this.waiter = {
        test: () => { const i = this.buf.indexOf('\r\n'); return i < 0 ? -1 : i + 2; },
        resolve: (text) => (/^\* (OK|PREAUTH)/.test(text) ? resolve() : reject(new Error('IMAP greeting: ' + text.trim()))),
        reject
      };
      this._check();
    });
  }

  _check() {
    if (!this.waiter) return;
    const end = this.waiter.test();
    if (end < 0) return;
    const out = this.buf.slice(0, end);
    this.buf = this.buf.slice(end);
    const w = this.waiter; this.waiter = null;
    w.resolve(out.toString('latin1'), out);
  }

  command(cmd) {
    const tag = 'A' + (++this.n);
    return new Promise((resolve, reject) => {
      this.waiter = {
        test: () => taggedEnd(this.buf, tag),
        resolve: (text, raw) => {
          const last = text.trimEnd().split('\r\n').pop();
          if (!last.startsWith(tag + ' OK')) {
            // Never echo the LOGIN line itself, which carries the password.
            return reject(new Error('IMAP ' + (cmd.startsWith('LOGIN') ? 'LOGIN' : cmd.split(' ')[0]) + ' failed: ' + last.slice(tag.length + 1)));
          }
          resolve({ text, raw });
        },
        reject
      };
      this.socket.write(tag + ' ' + cmd + '\r\n');
      this._check();
    });
  }

  async login() { await this.command('LOGIN ' + quote(this.user) + ' ' + quote(this.pass)); }

  async select(box = 'INBOX') {
    const { text } = await this.command('SELECT ' + quote(box));
    const num = (re) => { const m = text.match(re); return m ? parseInt(m[1], 10) : null; };
    return {
      exists: num(/\* (\d+) EXISTS/),
      uidValidity: num(/UIDVALIDITY (\d+)/),
      uidNext: num(/UIDNEXT (\d+)/)
    };
  }

  // UIDs strictly above `after`. "n:*" always returns the newest message even
  // when n is past it, so the filter is what makes "nothing new" mean nothing.
  async uidsAfter(after) {
    const { text } = await this.command('UID SEARCH UID ' + (after + 1) + ':*');
    const m = text.match(/\* SEARCH([\d ]*)/);
    return (m ? m[1].trim().split(/\s+/).filter(Boolean).map(Number) : [])
      .filter((u) => u > after).sort((a, b) => a - b);
  }

  // The whole raw message (RFC 822), without marking it read.
  async fetchRaw(uid) {
    const { raw } = await this.command('UID FETCH ' + uid + ' (BODY.PEEK[])');
    const head = raw.indexOf('{');
    const close = raw.indexOf('}\r\n', head);
    if (head < 0 || close < 0) return null;
    const n = parseInt(raw.slice(head + 1, close).toString('latin1'), 10);
    return raw.slice(close + 3, close + 3 + n);
  }

  async logout() {
    try { await this.command('LOGOUT'); } catch (e) { /* servers hang up after BYE */ }
    try { this.socket.end(); this.socket.destroy(); } catch (e) {}
  }
}

module.exports = { ImapClient, taggedEnd };
