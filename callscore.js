// Call intelligence scoring.
//
// Trellus evaluates each call against the trackers you defined and stores the verdicts
// per session. This module only reads those verdicts and turns them into a 0-1 value
// plus a plain-English reason. No AI, no API key, no cache — the same calls always
// produce the same score, and the weighting lives in config.json where you can change it.
//
// Deliberate behaviors, taken from how the team actually reads a call:
//   - Non-substantive calls (voicemail, bad time, wrong person, logistics) are SKIPPED,
//     not penalized. An unanswered call is an absence of signal, not a bad signal.
//   - A requested pause pushes the score down but never to zero. Dormant is not dead.
//   - Discovering we have been talking to the wrong person is the heaviest penalty,
//     because every prior commitment on the record came from someone who cannot sign.
//   - No calls at all returns neutral, so a prospect is never punished for being new.

const DEFAULT_WEIGHTS = {
  next_step_agreed: 0.20,
  scope_discussed: 0.12,
  timeline_given: 0.12,
  decision_maker_confirmed: 0.10,
  wrong_contact: -0.28
};

const PAUSE_PENALTY = { weeks: 0.12, months: 0.24, indefinite: 0.34 };

const PHRASE = {
  next_step_agreed: 'a specific next step agreed',
  scope_discussed: 'scope discussed',
  timeline_given: 'a timeline named',
  decision_maker_confirmed: 'the decision maker confirmed',
  wrong_contact: 'the contact turning out not to be the decision maker'
};

export function scoreCallHistory(calls, cfg) {
  const ci = cfg.callIntelligence || {};
  const names = ci.trackers || {};
  const weights = { ...DEFAULT_WEIGHTS, ...(ci.trackerWeights || {}) };
  const maxCalls = ci.callsConsidered || 3;

  const nameOf = key => names[key] || key;
  const verdict = (call, key) => (call.verdicts || {})[nameOf(key)] || { value: null, why: '' };

  if (!calls.length) {
    return { value: 0.5, state: 'nodata', calls: 0,
             reason: 'No Trellus calls matched this prospect\u2019s phone number.' };
  }

  const substantive = calls
    .filter(c => verdict(c, 'substantive').value === true)
    .slice(0, maxCalls);

  if (!substantive.length) {
    const n = calls.length;
    return {
      value: 0.5, state: 'nocontact', calls: n,
      reason: `${n} call attempt${n === 1 ? '' : 's'} logged but no substantive conversation ` +
              `yet, so call intelligence stays neutral.`
    };
  }

  // Recency weighting: the most recent substantive call counts double the one before it.
  let total = 0, weightSum = 0;
  const positives = [], negatives = [];
  let latestWhy = '';

  substantive.forEach((call, i) => {
    const w = Math.pow(0.5, i);
    let v = 0.5;

    for (const [key, delta] of Object.entries(weights)) {
      if (verdict(call, key).value !== true) continue;
      v += delta;
      if (i === 0) (delta >= 0 ? positives : negatives).push(PHRASE[key] || key);
    }

    const pause = verdict(call, 'pause_requested').value;
    if (pause && PAUSE_PENALTY[pause]) {
      v -= PAUSE_PENALTY[pause];
      if (i === 0) negatives.push(`a pause requested for ${pause}`);
    }

    if (i === 0) latestWhy = bestExplanation(call, names);

    total += Math.max(0.05, Math.min(1, v)) * w;
    weightSum += w;
  });

  const value = Math.max(0, Math.min(1, total / weightSum));
  const latest = substantive[0];
  const paused = verdict(latest, 'pause_requested').value;

  const state = paused ? 'dormant'
              : verdict(latest, 'wrong_contact').value === true ? 'rework'
              : value >= 0.68 ? 'advancing'
              : value <= 0.38 ? 'receding'
              : 'holding';

  return {
    value, state, calls: substantive.length,
    lastCallAt: latest.startedAt,
    url: latest.url,
    reason: buildReason(state, positives, negatives, substantive.length, latestWhy)
  };
}

// Prefer the explanation attached to whichever tracker actually decided the outcome.
function bestExplanation(call, names) {
  const order = ['wrong_contact', 'pause_requested', 'next_step_agreed',
                 'timeline_given', 'scope_discussed', 'substantive'];
  for (const key of order) {
    const v = (call.verdicts || {})[names[key] || key];
    if (v && v.value && v.why) return v.why;
  }
  return '';
}

function buildReason(state, positives, negatives, count, why) {
  const opener = {
    advancing: 'Calls are moving this forward',
    holding: 'Calls are holding steady',
    receding: 'Calls are losing ground',
    dormant: 'The prospect asked to pause',
    rework: 'The relationship needs rebuilding with the actual decision maker'
  }[state];

  const parts = [];
  if (positives.length) parts.push(`the last conversation had ${list(positives)}`);
  if (negatives.length) parts.push(`against ${list(negatives)}`);

  const body = parts.length ? `${opener} \u2014 ${parts.join(', ')}.` : `${opener}.`;
  const scope = ` Read from ${count} substantive call${count === 1 ? '' : 's'}.`;
  const note = why ? ` Trellus noted: ${trim(why)}` : '';
  return body + scope + note;
}

function trim(s) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > 180 ? clean.slice(0, 177) + '\u2026' : clean;
}

function list(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
