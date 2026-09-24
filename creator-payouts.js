'use strict';

// Getting a creator set up to be paid.
//
// Each creator gets a Stripe Connect Express account. Crayonauts takes the
// customer's money; the creator only ever RECEIVES a transfer, so the account
// asks for the transfers capability and nothing else - no card_payments, which
// would put them through the checks for somebody taking payments themselves.
//
// Their bank details and tax form go into a page Stripe hosts. We never see
// either, and they never travel by email. What we email is a link to our own
// /creators/payout-setup/<token>, which mints a fresh Stripe onboarding link
// every time it is opened - Stripe's own links expire within minutes, so one
// of those in an inbox would be dead by the time most people clicked it.
//
// The token is the whole credential for that page. It is 48 hex characters,
// read back from the database by one function only, and never logged.
//
// Used by the sign-up handler in server.js and by scripts/send-payout-setup.js,
// so the two cannot drift into setting people up differently.

const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');

const API = 'https://api.stripe.com/v1';

function newPayoutToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Defaults to the storefront. If the storefront does not pass /creators/*
// through to this server, PAYOUT_SETUP_BASE_URL points the emailed link at
// this server directly instead.
function setupBase() {
  return (process.env.PAYOUT_SETUP_BASE_URL || process.env.SITE_URL || 'https://crayonauts.com')
    .replace(/\/+$/, '');
}

function payoutSetupUrl(token, base = setupBase()) {
  return base + '/creators/payout-setup/' + token;
}

async function stripePost(path, form, deps) {
  const fetchImpl = deps.fetch || fetch;
  const key = deps.key || process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.');
  const resp = await fetchImpl(API + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });
  let body = null;
  try { body = await resp.json(); } catch (err) { body = null; }
  return { ok: resp.ok, body };
}

async function createConnectAccount(creator, deps = {}) {
  const form = new URLSearchParams();
  form.append('type', 'express');
  form.append('country', 'US');
  form.append('email', creator.email);
  form.append('business_type', 'individual');
  form.append('capabilities[transfers][requested]', 'true');
  form.append('metadata[creator_code]', creator.code);
  form.append('metadata[creator_id]', String(creator.id));
  const { ok, body } = await stripePost('/accounts', form, deps);
  if (!ok || !body || !body.id) {
    throw new Error('Stripe refused the Connect account: '
      + ((body && body.error && body.error.message) || 'no reason given'));
  }
  return body.id;
}

// The URL Stripe's onboarding lives at, good for a few minutes. Both of ours
// carry the token, so a failure here reports Stripe's error code and type and
// never its message, which is free to quote the URLs back.
async function createAccountLink(stripeAccountId, token, deps = {}) {
  const base = (deps.siteUrl || process.env.SITE_URL || 'https://crayonauts.com').replace(/\/+$/, '');
  const form = new URLSearchParams();
  form.append('account', stripeAccountId);
  form.append('type', 'account_onboarding');
  form.append('refresh_url', payoutSetupUrl(token, deps.setupBase || setupBase()));
  form.append('return_url', base + '/creators.html?payout=done');
  const { ok, body } = await stripePost('/account_links', form, deps);
  if (!ok || !body || !body.url) {
    const e = body && body.error;
    throw new Error('Stripe refused the account link: '
      + ((e && (e.code || e.type)) || 'no reason given'));
  }
  return body.url;
}

// What setUpCreatorPayouts would do for this creator, without doing it.
//   'skip'    the setup email already went - never send it twice
//   'account' no Connect account yet: make one, then send the email
//   'email'   the account exists, the email never went out
function payoutPlan(creator) {
  if (creator.payoutLinkSentAt) return 'skip';
  if (!creator.stripeAccountId) return 'account';
  return 'email';
}

// Makes the account if there is none, then sends the setup email if it has
// not gone. Throws if Stripe or the mail server says no; the caller decides
// whether that matters.
//
// The token is minted fresh here every time, including for a creator who
// already has one. That is safe because nobody can be holding the old one -
// a token only leaves this server in the email, and a creator whose email
// went out is skipped above - and it means nothing outside
// getCreatorByPayoutToken ever has to read a token back.
async function setUpCreatorPayouts(creator, deps = {}) {
  const store = deps.db || db;
  const mail = deps.mailer || mailer;
  const plan = payoutPlan(creator);
  if (plan === 'skip') return { plan, accountCreated: false, emailed: false };

  let accountId = creator.stripeAccountId;
  if (!accountId) accountId = await createConnectAccount(creator, deps);
  const token = newPayoutToken();
  await store.setCreatorStripeAccount(creator.id, accountId, token);
  const result = { plan, accountId, accountCreated: plan === 'account', emailed: false };

  if (!mail.configured) return result;
  const msg = mail.creatorPayoutSetupEmail({ name: creator.name, setupUrl: payoutSetupUrl(token, deps.setupBase || setupBase()) });
  const from = deps.from || process.env.CREATOR_MAIL_FROM || 'admin@crayonauts.com';
  await mail.sendMail({
    to: creator.email, subject: msg.subject, text: msg.text, html: msg.html,
    from, replyTo: from
  });
  await store.markPayoutLinkSent(creator.id);
  result.emailed = true;
  return result;
}

module.exports = {
  newPayoutToken, payoutSetupUrl, createConnectAccount, createAccountLink,
  payoutPlan, setUpCreatorPayouts
};
