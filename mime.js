// Just enough MIME to read a customer's email: the headers that matter and the
// plain-text body. Handles multipart (nested), base64, quoted-printable, and
// RFC 2047 encoded words in headers. Anything it cannot read comes back empty
// rather than throwing, and the assistant hands an empty message to a person.

function splitHeadBody(buf) {
  const s = buf.toString('latin1');
  let i = s.indexOf('\r\n\r\n'); let gap = 4;
  if (i < 0) { i = s.indexOf('\n\n'); gap = 2; }
  if (i < 0) return { head: s, body: Buffer.alloc(0) };
  return { head: s.slice(0, i), body: buf.slice(i + gap) };
}

function parseHeaders(head) {
  const out = {};
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([!-9;-~]+):\s?(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2];
  }
  return out;
}

function decodeCharset(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return buf.toString('utf8');
    return new TextDecoder(cs).decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

function qpDecode(str) {
  const s = str.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2;
    } else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

// "=?UTF-8?B?...?=" and "=?utf-8?Q?...?=" inside a header value.
function decodeWords(value) {
  return String(value || '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, cs, enc, text) => {
      try {
        const buf = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : qpDecode(text.replace(/_/g, ' '));
        return decodeCharset(buf, cs);
      } catch (e) { return all; }
    });
}

function param(value, name) {
  const m = String(value || '').match(new RegExp(name + '\\s*=\\s*("([^"]*)"|[^;\\s]+)', 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[1]) : '';
}

function decodeBody(body, headers) {
  const cte = String(headers['content-transfer-encoding'] || '').toLowerCase().trim();
  let buf = body;
  if (cte === 'base64') buf = Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
  else if (cte === 'quoted-printable') buf = qpDecode(body.toString('latin1'));
  return decodeCharset(buf, param(headers['content-type'], 'charset'));
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Walks the parts, preferring text/plain, falling back to text/html.
function findText(buf, headers, depth = 0) {
  const ct = String(headers['content-type'] || 'text/plain').toLowerCase();
  if (depth > 6) return { plain: '', html: '' };
  if (ct.startsWith('multipart/')) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return { plain: '', html: '' };
    const s = buf.toString('latin1');
    const parts = s.split('--' + boundary).slice(1);
    let plain = ''; let html = '';
    for (const p of parts) {
      if (p.startsWith('--')) break;
      const partBuf = Buffer.from(p.replace(/^\r?\n/, ''), 'latin1');
      const { head, body } = splitHeadBody(partBuf);
      const h = parseHeaders(head);
      if (/attachment/i.test(h['content-disposition'] || '')) continue;
      const got = findText(body, h, depth + 1);
      if (!plain && got.plain) plain = got.plain;
      if (!html && got.html) html = got.html;
    }
    return { plain, html };
  }
  if (ct.startsWith('text/plain')) return { plain: decodeBody(buf, headers), html: '' };
  if (ct.startsWith('text/html')) return { plain: '', html: decodeBody(buf, headers) };
  return { plain: '', html: '' };
}

// The customer's own words: quoted history cut off, length capped.
function stripQuoted(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200}wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/.test(line) && out.length > 2) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

function addressOf(value) {
  const v = decodeWords(value);
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim().toLowerCase();
}

function nameOf(value) {
  const v = decodeWords(value);
  const m = v.match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : '';
}

function parseEmail(raw) {
  const { head, body } = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const { plain, html } = findText(body, headers);
  const text = stripQuoted(plain || htmlToText(html)).slice(0, 6000);
  return {
    headers,
    messageId: (headers['message-id'] || '').trim(),
    references: (headers['references'] || '').trim(),
    from: addressOf(headers['reply-to'] || headers['from']),
    fromHeader: addressOf(headers['from']),
    fromName: nameOf(headers['from']),
    subject: decodeWords(headers['subject'] || '').replace(/[\r\n]+/g, ' ').trim(),
    text
  };
}

module.exports = { parseEmail, parseHeaders, decodeWords, qpDecode, htmlToText, stripQuoted, addressOf };
