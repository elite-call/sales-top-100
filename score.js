// Scoring model. Pure functions — no network, no filesystem, safe to unit test.
//
// Seven components, each earning a fraction of its weight:
//   revenue     log-scaled first-campaign estimate
//   stage       hand-set probability per pipeline stage
//   engagement  count of populated signals on the record
//   recency     exponential decay on days since last activity
//   industry    historical win rate for that industry, from closed records
//   source      historical win rate for that lead source
//   calls       Trellus transcript quality (neutral 0.5 until connected)

const CLOSED = /^closed/i;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const money = n => '$' + Math.round(n).toLocaleString('en-US');

export function scoreAll(records, cfg, prevRanks = {}, now = new Date()) {
  const closed = records.filter(r => CLOSED.test(r.stage || ''));
  const open = records.filter(r => r.stage && !CLOSED.test(r.stage));

  const industry = winRates(closed, 'industry');
  const source = winRates(closed, 'source');
  const baseRate = industry.base;

  const scored = open.map(r => assess(r, cfg, industry, source, now));

  // The score IS the weighted total expressed out of 100, so the number the page shows and the
  // number stored here are always the same scale — no second normalization to reconcile.
  const totalWeight = Object.values(cfg.weights).reduce((a, b) => a + b, 0) || 1;
  for (const s of scored) s.score = Math.round(s.raw / totalWeight * 100);

  scored.sort((a, b) => b.score - a.score || b.expectedSort - a.expectedSort || b.estimate - a.estimate);

  const rows = scored.slice(0, cfg.rankCount).map((s, i) => {
    const rank = i + 1;
    const prev = prevRanks[s.record.id];
    return {
      rank,
      prevRank: prev == null ? cfg.rankCount + 40 : prev,
      id: s.record.id,
      zohoUrl: s.record.url,
      account: s.record.account,
      contact: s.record.contact || null,
      title: s.record.title || null,
      owner: s.record.owner,
      ae: s.record.ae || null,
      bdr: s.record.bdr || null,
      stage: s.record.stage,
      industry: s.industryKey,
      source: s.sourceKey,
      entity: s.record.entity || null,
      pipeline: s.record.pipeline || null,
      brand: brandOf(s.record, cfg),
      estimate: Math.round(s.estimate),
      estimateInferred: s.inferred,
      closingPct: s.closingPct || null,
      daysSinceActivity: s.days,
      lastActivity: s.record.lastActivity || null,
      created: s.record.created || null,
      phone: s.record.phone || null,
      email: s.record.email || null,
      website: s.record.website || null,
      flags: {
        topPriority: !!s.record.topPriority,
        warboard: !!s.record.warboard,
        inTalks: !!s.record.inTalks
      },
      notes: s.record.description || null,
      nextSteps: s.record.nextSteps || null,
      score: s.score,
      weighted: Math.round(s.raw * 10) / 10,
      tier: band(s.score, cfg.tiers, 'Bronze'),
      grade: band(s.score, cfg.grades, 'C'),
      expected: Math.round(s.estimate * (s.parts.stage * 0.5 + s.industryRate * 0.3 + s.sourceRate * 0.2)),
      engagementSignals: s.hits,
      callIntel: s.callIntel
        ? { state: s.callIntel.state, calls: s.callIntel.calls, reason: s.callIntel.reason,
            lastCallAt: s.callIntel.lastCallAt || null, url: s.callIntel.url || null }
        : null,
      components: Object.keys(cfg.weights).map(k => ({
        key: k,
        label: LABEL[k],
        pct: Math.round(s.parts[k] * 100),
        points: Math.round(s.parts[k] * cfg.weights[k] * 10) / 10,
        max: cfg.weights[k],
        pending: k === 'calls' && s.callsPending
      })),
      summary: summarize(s, cfg)
    };
  });

  return {
    generated: now.toISOString(),
    source: `Zoho CRM — ${cfg.module}, open stages only`,
    universe: { total: records.length, open: open.length, closed: closed.length, ranked: rows.length },
    baseWinRate: Math.round(baseRate * 1000) / 1000,
    weights: cfg.weights,
    stageWeights: cfg.stageWeights,
    brands: cfg.brands,
    gaps: gaps(open, cfg),
    owners: unique(rows.map(r => r.owner)).sort(),
    industries: unique(rows.map(r => r.industry)).sort(),
    stages: unique(rows.map(r => r.stage)),
    sources: unique(rows.map(r => r.source)).sort(),
    rows
  };
}

const LABEL = {
  revenue: 'Revenue potential', stage: 'Pipeline stage', engagement: 'Engagement depth',
  recency: 'Recency of contact', industry: 'Industry fit', source: 'Lead source quality',
  calls: 'Call intelligence'
};

// Laplace-smoothed win rate per category, pulled toward the house average so thin
// categories (one closed deal) cannot spike to 100%.
function winRates(closed, field) {
  const buckets = {};
  for (const r of closed) {
    const k = (r[field] || '').trim() || 'Unspecified';
    buckets[k] = buckets[k] || { won: 0, n: 0 };
    buckets[k].n++;
    if (/won/i.test(r.stage)) buckets[k].won++;
  }
  const base = closed.length ? closed.filter(r => /won/i.test(r.stage)).length / closed.length : 0.4;
  const out = {};
  for (const [k, v] of Object.entries(buckets)) {
    out[k] = { n: v.n, won: v.won, rate: (v.won + base * 8) / (v.n + 8) };
  }
  return { out, base };
}

function assess(record, cfg, industry, source, now) {
  const R = cfg.revenue;
  let estimate = record.estimate || record.amount * R.fallbackMultiplierOnAmount;
  const inferred = !estimate;
  if (inferred) estimate = R.inferredDefault;
  estimate = clamp(estimate, R.floor, R.cap);

  const revenue = clamp(Math.log(estimate / R.floor) / Math.log(R.cap / R.floor));
  const stage = cfg.stageWeights[record.stage] ?? 0.3;
  const closingPct = record.closingPct || record.probability || 0;
  const desc = record.description || '';

  const signals = [
    desc.length > 40, desc.length > 200, !!record.nextSteps, !!record.bdr, !!record.title,
    !!record.inTalks, !!record.topPriority, !!record.warboard, closingPct >= 50,
    !!(record.website && record.email && record.phone)
  ];
  const hits = signals.filter(Boolean).length;
  const engagement = clamp(hits / 7);

  const days = record.lastActivity
    ? Math.max(0, Math.round((now - new Date(String(record.lastActivity).replace(' ', 'T'))) / 864e5))
    : 999;
  const recency = clamp(Math.exp(-days / cfg.recencyHalfLifeDays));

  const industryKey = (record.industry || '').trim() || 'Unspecified';
  const sourceKey = (record.source || '').trim() || 'Unspecified';
  const ir = industry.out[industryKey] || { rate: industry.base, n: 0 };
  const sr = source.out[sourceKey] || { rate: source.base, n: 0 };

  // record.callIntel is attached by build.js before scoring; see scripts/callscore.js.
  const ci = record.callIntel;
  const callsPending = !ci || ci.state === 'nodata';
  const calls = ci ? ci.value : 0.5;

  const parts = {
    revenue, stage, engagement, recency,
    industry: clamp((ir.rate - 0.10) / 0.62),
    source: clamp((sr.rate - 0.10) / 0.68),
    calls
  };
  const raw = Object.keys(cfg.weights).reduce((a, k) => a + parts[k] * cfg.weights[k], 0);

  const expectedSort = estimate * (parts.stage * 0.5 + ir.rate * 0.3 + sr.rate * 0.2);
  return { record, estimate, inferred, parts, raw, hits, days, closingPct, expectedSort, callIntel: ci,
           industryKey, sourceKey, industryRate: ir.rate, sourceRate: sr.rate,
           industryN: ir.n, sourceN: sr.n, callsPending };
}

function brandOf(record, cfg) {
  for (const [key, b] of Object.entries(cfg.brands)) {
    if (b.default) continue;
    const ind = b.industryMatch && new RegExp(b.industryMatch, 'i').test(record.industry || '');
    const ent = b.entityMatch && new RegExp(b.entityMatch, 'i').test(record.entity || '');
    if (ind || ent) return key;
  }
  return Object.keys(cfg.brands).find(k => cfg.brands[k].default) || Object.keys(cfg.brands)[0];
}

function band(score, table, fallback) {
  for (const [name, min] of Object.entries(table)) if (score >= min) return name;
  return fallback;
}

// Deterministic plain-English rationale, assembled from the numbers that drove the score.
function summarize(s, cfg) {
  const contrib = Object.keys(cfg.weights)
    .map(k => ({ k, pts: s.parts[k] * cfg.weights[k], pct: s.parts[k] }))
    .sort((a, b) => b.pts - a.pts);
  const lead = contrib.filter(c => c.k !== 'calls').slice(0, 2);
  const drag = contrib.filter(c => c.k !== 'calls').reverse().find(c => c.pct < 0.45);

  const phrase = {
    revenue: `a ${money(s.estimate)} first-campaign estimate${s.inferred ? ' (inferred from category median — no estimate on record)' : ''}`,
    stage: `sitting at ${s.record.stage}`,
    engagement: `${s.hits} of 10 engagement signals present`,
    recency: s.days <= 7 ? `contact ${s.days <= 1 ? 'today' : s.days + ' days ago'}` : `last touched ${s.days} days ago`,
    industry: `${s.industryKey} converts at ${Math.round(s.industryRate * 100)}% historically (${s.industryN} closed records)`,
    source: `${s.sourceKey} leads convert at ${Math.round(s.sourceRate * 100)}%`
  };

  const out = [`Ranked on ${phrase[lead[0].k]} and ${phrase[lead[1].k]}.`];
  if (drag) out.push(`Held back by ${LABEL[drag.k].toLowerCase()} — ${phrase[drag.k]}.`);

  out.push(
    s.days > 60 ? `No activity in ${s.days} days; re-engagement required before this decays further.`
    : s.record.stage === 'Zoom Sat' ? 'Demo already sat — the next move is a proposal, not another call.'
    : s.record.stage === 'Zoom Booked' ? 'Zoom on the calendar; confirm attendance to protect the slot.'
    : s.record.stage === 'Pending Revenue' ? 'Revenue pending — chase paperwork, not persuasion.'
    : s.record.stage === 'Stale/Re-Engage' ? 'Flagged stale; treat as a warm restart.'
    : 'Info sent and unanswered — next touch should carry a new reason to reply.'
  );

  if (s.callIntel && s.callIntel.state !== 'nodata') {
    out.push(s.callIntel.reason);
  } else if (s.callsPending) {
    out.push(`No call transcripts matched this prospect, so call intelligence holds a neutral ` +
             `${cfg.weights.calls / 2} of ${cfg.weights.calls}.`);
  }
  return out.join(' ');
}

function gaps(open, cfg) {
  const list = [];
  const withEstimate = open.filter(r => r.estimate > 0).length;
  const withAmount = open.filter(r => r.amount > 0).length;
  if (withAmount < open.length * 0.2) {
    list.push(`Amount is populated on only ${withAmount} of ${open.length} open records — ` +
              `Estimate - 1st Campaign (${withEstimate} populated) is used as the revenue signal.`);
  }
  if (!cfg.fields.trellusScore) list.push('Call transcript quality (Trellus) not yet connected.');
  list.push('Company headcount / size is not present in the export, so company-size fit is unscored.');
  const noActivity = open.filter(r => !r.lastActivity).length;
  if (noActivity) list.push(`${noActivity} open records have no last-activity timestamp; recency falls back to zero.`);
  return list;
}

const unique = a => [...new Set(a.filter(Boolean))];
