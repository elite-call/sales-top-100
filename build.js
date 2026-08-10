// Daily build: pull Zoho -> score -> write data/top100.json + a dated snapshot.
// Usage: node scripts/build.js            (live pull)
//        node scripts/build.js --csv path/to/export.csv   (offline, for testing)
import fs from 'node:fs/promises';
import path from 'node:path';
import { accessToken, fetchAll, recordUrl } from './zoho.js';
import { scoreAll } from './score.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/config.json'), 'utf8'));
const F = cfg.fields;

const csvArg = process.argv.indexOf('--csv');
const records = csvArg > -1 ? await fromCsv(process.argv[csvArg + 1]) : await fromZoho();

const prev = await previousSnapshot();
const built = scoreAll(records, cfg, prev);

// The repo is public, so strip person-level detail from what gets committed. Reps click
// through to Zoho for phone, email and notes, which their Zoho login already protects.
// Set publish.redactPublic to false in scripts/config.json if the repo becomes private.
if (cfg.publish && cfg.publish.redactPublic) {
  const drop = cfg.publish.redactFields || [];
  for (const row of built.rows) for (const key of drop) if (key in row) row[key] = null;
  built.redacted = drop;
  console.log('Redacted for public publishing: ' + drop.join(', '));
}

const today = new Date().toISOString().slice(0, 10);
await fs.mkdir(path.join(ROOT, 'data/snapshots'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'data/top100.json'), JSON.stringify(built, null, 1));
await fs.writeFile(path.join(ROOT, `data/snapshots/${today}.json`), JSON.stringify({
  date: today,
  rows: built.rows.map(r => ({ id: r.id, rank: r.rank, score: r.score, account: r.account }))
}, null, 1));

console.log(`Built ${built.rows.length} ranked rows from ${built.universe.open} open records ` +
            `(${built.universe.closed} closed used for calibration).`);

async function fromZoho() {
  const token = await accessToken();
  const wanted = [...new Set(Object.values(F).filter(Boolean).filter(v => v !== 'id'))];
  const raw = await fetchAll(token, cfg.module, wanted);
  return raw.map(r => ({
    id: String(r.id),
    url: recordUrl(cfg.module, r.id),
    account: text(r[F.account]) || text(r[F.name]),
    name: text(r[F.name]),
    contact: text(r[F.contact]),
    owner: text(r[F.owner]),
    stage: text(r[F.stage]),
    amount: num(r[F.amount]),
    estimate: num(r[F.estimate]),
    industry: text(r[F.industry]),
    source: text(r[F.source]),
    entity: text(r[F.entity]),
    pipeline: text(r[F.pipeline]),
    probability: num(r[F.probability]),
    closingPct: num(r[F.closingPct]),
    lastActivity: text(r[F.lastActivity]) || text(r[F.modified]),
    created: text(r[F.created]),
    description: text(r[F.description]),
    nextSteps: text(r[F.nextSteps]),
    bdr: text(r[F.bdr]),
    ae: text(r[F.ae]),
    title: text(r[F.title]),
    phone: text(r[F.phone]),
    email: text(r[F.email]),
    website: text(r[F.website]),
    topPriority: bool(r[F.topPriority]),
    warboard: bool(r[F.warboard]),
    inTalks: bool(r[F.inTalks]),
    contacted: bool(r[F.contacted]),
    lastConversation: text(r[F.lastConversation]),
    followUpTask: text(r[F.followUpTask]),
    inboundSms: num(r[F.inboundSms]),
    outboundSms: num(r[F.outboundSms]),
    trellus: F.trellusScore ? num(r[F.trellusScore]) : null
  }));
}

// Offline path: accepts the CRM CSV export, matching on column labels.
async function fromCsv(file) {
  const rows = parseCsv(await fs.readFile(path.resolve(file), 'utf8'));
  const hdr = rows[0];
  const pick = (row, ...labels) => {
    for (const l of labels) {
      const i = hdr.indexOf(l);
      if (i > -1 && row[i] != null && String(row[i]).trim()) return String(row[i]).trim();
    }
    return '';
  };
  return rows.slice(1).filter(r => r.length > 5).map(r => ({
    id: pick(r, 'Record Id'),
    url: null,
    account: pick(r, 'Account Name', 'Potential Name'),
    name: pick(r, 'Potential Name'),
    contact: pick(r, 'Contact Name'),
    owner: pick(r, 'Potential Owner', 'Deal Owner'),
    stage: pick(r, 'Stage'),
    amount: num(pick(r, 'Amount')),
    estimate: num(pick(r, 'Estimate - 1st Campaign')),
    industry: pick(r, 'Industry type'),
    source: pick(r, 'Lead Source'),
    entity: pick(r, 'Internal Company'),
    pipeline: pick(r, 'Pipeline'),
    probability: num(pick(r, 'Probability (%)')),
    closingPct: num(pick(r, 'Closing %')),
    lastActivity: pick(r, 'Last Activity Time', 'Modified Time'),
    created: pick(r, 'Original Lead Creation Date', 'Potential Created Date'),
    description: pick(r, 'Description'),
    nextSteps: pick(r, 'Next Steps'),
    bdr: pick(r, 'BDR Agent'),
    ae: pick(r, 'Account Executive'),
    title: pick(r, 'Title'),
    phone: pick(r, 'Phone'),
    email: pick(r, 'Email'),
    website: pick(r, 'Website'),
    topPriority: bool(pick(r, 'Top Priority')),
    warboard: bool(pick(r, 'Warboard')),
    inTalks: bool(pick(r, 'In-Talks')),
    trellus: null
  }));
}

async function previousSnapshot() {
  const dir = path.join(ROOT, 'data/snapshots');
  let files = [];
  try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort(); } catch { return {}; }
  const today = new Date().toISOString().slice(0, 10) + '.json';
  const last = files.filter(f => f !== today).pop();
  if (!last) return {};
  const snap = JSON.parse(await fs.readFile(path.join(dir, last), 'utf8'));
  return Object.fromEntries((snap.rows || []).map(r => [r.id, r.rank]));
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.name ?? v.id ?? '').trim();
  return String(v).trim();
}
function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function bool(v) { return v === true || String(v).toLowerCase() === 'true'; }

function parseCsv(s) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
