'use strict';

// Asks Neon how much storage the project is using.
//
// This exists because the obvious number is the wrong one. Two different
// figures get called "database size" here and they are not comparable:
//
//   pg_database_size()        the physical size of ONE database, as Postgres
//                             sees it right now.
//
//   Neon's synthetic size     the logical size of every database on every
//                             branch, PLUS retained WAL. Independent of Neon's
//                             own compression and garbage collection, which is
//                             why it is the number they bill and cap on.
//
// The plan's 0.5 GB limit applies to the second one. Measuring the first and
// comparing it to that limit would under-report - it omits WAL, history and
// every other branch - so the warning would arrive late or not at all, which
// is the one thing a capacity warning must not do.
//
// Needs NEON_API_KEY and NEON_PROJECT_ID. Without them this returns null and
// the watchdog falls back to the Postgres figure, against its own ceiling.

const ENDPOINT = 'https://console.neon.tech/api/v2/projects/';

async function storageBytes({ apiKey, projectId, timeoutMs = 8000 } = {}) {
  const key = apiKey || process.env.NEON_API_KEY;
  const project = projectId || process.env.NEON_PROJECT_ID;
  if (!key || !project) return null;

  const res = await fetch(ENDPOINT + encodeURIComponent(project), {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    throw new Error(`Neon API answered ${res.status}`);
  }
  const body = await res.json();
  const bytes = body && body.project && body.project.synthetic_storage_size;
  if (typeof bytes !== 'number') {
    throw new Error('Neon API returned no synthetic_storage_size');
  }
  return bytes;
}

function configured() {
  return Boolean(process.env.NEON_API_KEY && process.env.NEON_PROJECT_ID);
}

module.exports = { storageBytes, configured, ENDPOINT };
