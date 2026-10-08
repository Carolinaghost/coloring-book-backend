#!/usr/bin/env node
'use strict';
// Trustpilot invitations: paid orders only, sent only to Trustpilot's address.
//   npm test
if (process.env.DATABASE_URL && process.env.ALLOW_DB_TESTS !== '1') { console.error('unset DATABASE_URL'); process.exit(1); }
process.env.NODE_ENV = 'test';
process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
process.env.TRUSTPILOT_BCC = 'crayonauts.com+test@invite.trustpilot.com';
const mailer = require('../mailer');
const sent = [];
mailer.sendMail = async (m) => { sent.push(m); return true; };
const { inviteToTrustpilot } = require('../server');
let pass = 0; const fail = [];
const check = (n, ok) => (ok ? pass++ : fail.push(n));
(async () => {
  check('paid order invited', await inviteToTrustpilot({ id: 7, email: 'a@b.com', amountCents: 1500, childName: 'Mia' }) === true);
  const m = sent[0];
  check('delivered only to Trustpilot, To names the customer', m && m.envelopeTo === process.env.TRUSTPILOT_BCC && m.to === 'a@b.com');
  check('no attachment, carries order id', m && !m.attachments && /order 7/.test(m.text));
  check('free-code order not invited', await inviteToTrustpilot({ id: 8, email: 'c@d.com', amountCents: 0 }) === false);
  check('unknown amount not invited', await inviteToTrustpilot({ id: 9, email: 'c@d.com', amountCents: null }) === false);
  check('nothing else sent', sent.length === 1);
  mailer.sendMail = async () => { throw new Error('smtp down'); };
  check('a mail failure is swallowed', await inviteToTrustpilot({ id: 10, email: 'e@f.com', amountCents: 2500 }) === false);
  // envelopeTo really changes the RCPT line, not the To: header.
  const raw = require('../mailer').buildMessage({ to: 'a@b.com', subject: 's', text: 't', html: 'h' });
  check('header To is the customer', /\r\nTo: a@b\.com\r\n/.test(raw));
  console.log(pass + ' passed' + (fail.length ? ', FAILED: ' + fail.join('; ') : ''));
  process.exit(fail.length ? 1 : 0);
})();
