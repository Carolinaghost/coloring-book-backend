'use strict';

// A small client for the Lulu Print API (https://api.lulu.com/docs/).
//
// Lulu prints and posts the printed copies. Auth is OAuth client credentials:
// the client key and secret (from the developer portal's API Keys page) buy a
// short-lived bearer token, which is cached until a minute before it expires.
//
// The sandbox is a separate account with its own keys. Print-jobs there are
// never printed or charged, which is what makes it safe to test against.

const PROD = 'https://api.lulu.com';
const SANDBOX = 'https://api.sandbox.lulu.com';
const TOKEN_PATH = '/auth/realms/glasstree/protocol/openid-connect/token';

function createLulu({ clientKey, clientSecret, sandbox = false, fetchImpl, now = () => Date.now() } = {}) {
  const base = sandbox ? SANDBOX : PROD;
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const configured = Boolean(clientKey && clientSecret);
  let token = null;
  let tokenUntil = 0;

  async function getToken() {
    if (!configured) throw new Error('Lulu is not configured (no client key/secret).');
    if (token && now() < tokenUntil) return token;
    const resp = await doFetch(base + TOKEN_PATH, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientKey}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.access_token) {
      throw new Error(`Lulu login failed (${resp.status}): ${body.error_description || body.error || 'no token'}`);
    }
    token = body.access_token;
    tokenUntil = now() + Math.max(30, (Number(body.expires_in) || 300) - 60) * 1000;
    return token;
  }

  async function call(method, path, payload) {
    const t = await getToken();
    const resp = await doFetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const text = await resp.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text.slice(0, 500) }; }
    if (!resp.ok) {
      if (resp.status === 401) { token = null; tokenUntil = 0; }
      const err = new Error(`Lulu ${method} ${path} failed (${resp.status}): ${describe(body)}`);
      err.status = resp.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  return {
    configured,
    sandbox,
    base,
    // { width, height, unit } in points for the given product and page count.
    coverDimensions: (podPackageId, pageCount) => call('POST', '/cover-dimensions/',
      { pod_package_id: podPackageId, interior_page_count: pageCount, unit: 'pt' }),
    costCalculation: (payload) => call('POST', '/print-job-cost-calculations/', payload),
    createPrintJob: (payload) => call('POST', '/print-jobs/', payload),
    getPrintJob: (id) => call('GET', `/print-jobs/${encodeURIComponent(id)}/`),
    validateInterior: (sourceUrl, podPackageId) => call('POST', '/validate-interior/',
      { source_url: sourceUrl, pod_package_id: podPackageId }),
    getInteriorValidation: (id) => call('GET', `/validate-interior/${encodeURIComponent(id)}/`),
    validateCover: (sourceUrl, podPackageId, pageCount) => call('POST', '/validate-cover/',
      { source_url: sourceUrl, pod_package_id: podPackageId, interior_page_count: pageCount }),
    getCoverValidation: (id) => call('GET', `/validate-cover/${encodeURIComponent(id)}/`)
  };
}

// Lulu's errors come back in a few shapes - a detail string, field-keyed lists,
// nested objects. Flattened to one line for the alert email and the logs.
function describe(body) {
  if (!body || typeof body !== 'object') return String(body || 'no detail');
  if (typeof body.detail === 'string') return body.detail;
  const parts = [];
  const walk = (v, key) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, key ? `${key}.${k}` : k));
    else parts.push(key ? `${key}: ${v}` : String(v));
  };
  walk(body, '');
  return parts.join('; ').slice(0, 800) || 'no detail';
}

module.exports = { createLulu, describe };
