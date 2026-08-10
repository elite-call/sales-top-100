// Trellus adapter — reads sessions and their tracker verdicts from rpt.trellus.ai.
//
// API mechanics (undocumented publicly, confirmed against Elite Call's working scripts):
//   - GET https://rpt.trellus.ai/session-list-v5
//   - Everything travels in HEADERS, not the query string.
//   - api_key and team_id are JSON-quoted: the header value literally includes the
//     double quotes, hence '"' + key + '"'.
//   - start/end are MICROSECOND epoch timestamps, sent as strings.
//   - `select` is an array of {table, column_name}; the response is an array of ARRAYS
//     whose positions match that select order. No field names come back.
//   - `cnf` is conjunctive normal form: an array of OR-groups, ANDed together.
//   - Pagination walks `end` backward using the oldest started_at in each batch.
//     The server caps at 50 rows however high you set limit, and 429s without a gap.
//
// Trackers are matched by NAME SUFFIX, not by full id. Trellus ids look like
// `tracker_8ef9c119_next_step_agreed` — the hash is assigned when you create the
// tracker, so config.json only needs the names you gave them.

const ENDPOINT = 'https://rpt.trellus.ai/session-list-v5';
const KEY = process.env.TRELLUS_API_KEY || '';
const TEAM_ID = process.env.TRELLUS_TEAM_ID || '';
const PHONE_COLUMN = process.env.TRELLUS_PHONE_COLUMN || 'phone_number';

export const trellusEnabled = () => !!KEY && !!TEAM_ID;

export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length < 10 ? null : digits.slice(-10);
}

const SELECT = () => ([
  { column_name: 'session_id', table: 'SESSIONS_V2' },
  { column_name: 'started_at', table: 'SESSIONS_V2' },
  { column_name: 'resource_id', table: 'SESSIONS_V2' },
  { column_name: PHONE_COLUMN, table: 'PROSPECT_INFO' },
  { column_name: 'prospect_name', table: 'PROSPECT_INFO' },
  { column_name: 'cadence', table: 'PROSPECT_INFO' },
  { column_name: 'user_disposition', table: 'SESSION_METRICS' },
  { column_name: 'call_duration', table: 'CALL_METRICS' },
  { column_name: 'state_str', table: 'SESSION_STATES' }
]);

function headers(extra) {
  return {
    Accept: '*/*',
    Origin: 'https://app.trellus.ai',
    Referer: 'https://app.trellus.ai/',
    api_key: '"' + KEY + '"',
    team_id: '"' + TEAM_ID + '"',
    ...extra
  };
}

/**
 * Pull every session with a real conversation in the window, bucketed by phone number.
 * Filtered server-side to duration >= 20s so voicemail drops never reach us.
 */
export async function fetchCallIndex(cfg, { sinceDays = 180 } = {}) {
  if (!trellusEnabled()) return new Map();

  const trackerNames = Object.values((cfg.callIntelligence || {}).trackers || {});
  const startUs = String((Date.now() - sinceDays * 864e5) * 1000);
  const cnf = [
    [{ table: 'SESSION_QUALITY', column_name: 'duration', operator: 'GE', value_safe: 20 }]
  ];

  const byPhone = new Map();
  const seen = new Set();
  let pageEnd = String(Date.now() * 1000);

  for (let page = 1; page <= 40; page++) {
    const res = await fetch(ENDPOINT, {
      method: 'GET',
      signal: AbortSignal.timeout(45000),
      headers: headers({
        cnf: JSON.stringify(cnf),
        start: startUs,
        end: pageEnd,
        select: JSON.stringify(SELECT()),
        limit: '100'
      })
    });

    if (!res.ok) {
      console.warn(`Trellus HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      break;
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    let oldest = null;
    for (const r of rows) {
      const [sessionId, startedAt, resourceId, phoneRaw, prospect, cadence, disposition, duration, stateStr] = r;
      if (oldest === null || startedAt < oldest) oldest = startedAt;
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);

      const phone = normalizePhone(phoneRaw);
      if (!phone) continue;

      const call = {
        id: String(sessionId),
        startedAt: usToIso(startedAt),
        startedAtUs: Number(startedAt) || 0,
        durationSec: Math.round(Number(duration) || 0),
        rep: resourceId || null,
        phone,
        prospect: prospect || '',
        cadence: cadence || '',
        disposition: disposition || '',
        url: `https://app.trellus.ai/transcripts?id=${sessionId}`,
        verdicts: readTrackers(String(stateStr || ''), trackerNames)
      };

      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(call);
    }

    if (rows.length < 50 || oldest === null) break;
    pageEnd = String(oldest - 1);
    await sleep(1500);
  }

  for (const list of byPhone.values()) list.sort((a, b) => b.startedAtUs - a.startedAtUs);
  console.log(`Trellus: ${seen.size} sessions across ${byPhone.size} distinct phone numbers.`);
  return byPhone;
}

/**
 * Pull each configured tracker's verdict out of state_str.
 *
 * state_str is a pipe-delimited blob of `tracker_<hash>_<name>:<value>` pairs, with
 * an accompanying `tracker_<hash>_<name>__explanation:<text>` for most trackers.
 * We match on the name suffix so the hash never has to be looked up or maintained.
 *
 * Returns { <name>: { value, why } } where value is true/false for boolean trackers
 * or the choice string for choice trackers, and null when the tracker did not fire.
 */
function readTrackers(stateStr, names) {
  const out = {};
  for (const name of names) {
    // Trellus slugifies the display name when it builds the tracker id, and we do not
    // know its exact convention, so match on a normalized form: lowercase, with every
    // run of non-alphanumerics collapsed to a single flexible separator.
    const esc = String(name).trim().toLowerCase()
      .split(/[^a-z0-9]+/).filter(Boolean)
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^a-z0-9]*');
    const valMatch = stateStr.match(new RegExp('tracker_[0-9a-f]+_' + esc + ':([^|]*)\\|', 'i'));
    const whyMatch = stateStr.match(new RegExp('tracker_[0-9a-f]+_' + esc + '__explanation:([^|]*)', 'i'));

    let value = null;
    if (valMatch) {
      const raw = valMatch[1].trim();
      if (/^true$/i.test(raw)) value = true;
      else if (/^false$/i.test(raw)) value = false;
      else if (raw) value = raw;
    }
    out[name] = { value, why: whyMatch ? whyMatch[1].trim() : '' };
  }
  return out;
}

/**
 * Diagnostic: probe which PROSPECT_INFO column holds the phone number, and dump one
 * raw state_str so tracker names can be confirmed. Run with `npm run trellus:probe`.
 */
export async function probe() {
  const candidates = ['phone_number', 'phone', 'prospect_phone', 'to_number',
                      'contact_phone', 'number', 'primary_phone'];
  const startUs = String((Date.now() - 7 * 864e5) * 1000);
  const endUs = String(Date.now() * 1000);

  console.log('\nPhone column candidates:\n');
  for (const col of candidates) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'GET',
        signal: AbortSignal.timeout(30000),
        headers: headers({
          cnf: '[]', start: startUs, end: endUs, limit: '5',
          select: JSON.stringify([
            { column_name: 'session_id', table: 'SESSIONS_V2' },
            { column_name: col, table: 'PROSPECT_INFO' }
          ])
        })
      });
      if (!res.ok) { console.log(`  ${col.padEnd(16)} HTTP ${res.status}`); continue; }
      const rows = await res.json();
      const filled = (rows || []).map(r => r[1]).filter(Boolean);
      console.log(`  ${col.padEnd(16)} ${filled.length}/${rows.length} populated` +
                  (filled.length ? `  e.g. ${String(filled[0]).slice(0, 18)}` : ''));
    } catch (err) {
      console.log(`  ${col.padEnd(16)} ${err.message}`);
    }
    await sleep(600);
  }

  console.log('\nRaw state_str from one recent session (confirm your tracker names appear here):\n');
  const res = await fetch(ENDPOINT, {
    method: 'GET',
    signal: AbortSignal.timeout(30000),
    headers: headers({
      cnf: '[]', start: startUs, end: endUs, limit: '1',
      select: JSON.stringify([{ column_name: 'state_str', table: 'SESSION_STATES' }])
    })
  });
  const rows = await res.json();
  const state = String((rows[0] || [])[0] || '');
  console.log(state ? state.split('|').filter(s => s.includes('tracker_')).join('\n') : '  (none)');
  console.log('\nSet TRELLUS_PHONE_COLUMN if the populated column is not phone_number.\n');
}

const usToIso = us => {
  const n = Number(us);
  return n ? new Date(Math.round(n / 1000)).toISOString() : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
