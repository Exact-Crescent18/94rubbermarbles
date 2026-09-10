// Client for the Orange Cat Blacktop motorsport data API (ocblacktop.com).
// Free tier: schedules, post-session results, standings. No live/in-race
// data on free tier — that requires a paid plan, intentionally not used
// here. ARCA and Indy NXT are not covered by this API at all; callers
// must fall back to Groq web-search research for those two series.
//
// NOTE: field names in parseResults() are our best reading of the public
// docs, not a confirmed live response — the first real run's log should
// be checked against actual output and this file adjusted if needed.

const BASE = 'https://api.ocblacktop.com/v1';

// Our internal `view` key -> Blacktop series slug. Omitted keys (arca,
// indy-nxt) are intentionally not covered by this provider.
export const SERIES_SLUGS = {
  f1: 'formula1',
  'nascar-cup': 'nascar',
  'nascar-oreilly': 'nascar-xfinity',
  'nascar-truck': 'nascar-truck',
  indycar: 'indycar',
  motogp: 'moto-gp',
  'formula-e': 'formula-e',
  wec: 'wec',
  wrc: 'wrc',
};

export function isBlacktopCovered(view) {
  return Object.prototype.hasOwnProperty.call(SERIES_SLUGS, view);
}

async function blacktopFetch(path, apiKey) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(15000), // never hang indefinitely on a slow/unresponsive endpoint
  });
  if (!res.ok) {
    throw new Error(`Blacktop API error ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}

// Finds the Blacktop event matching our event's date (+/- 1 day for
// timezone slop) and series. Returns null if no match — the calling code
// should fall back to Groq for that event rather than guessing.
export async function findEvent(view, dateStr, apiKey) {
  const slug = SERIES_SLUGS[view];
  if (!slug) return null;
  const data = await blacktopFetch(`/${slug}/events`, apiKey);
  const all = [...(data.upcoming || []), ...(data.completed || []), ...(data.results || [])];
  const target = new Date(dateStr + 'T12:00:00Z').getTime();
  const DAY = 86400000;
  return all.find((ev) => {
    const evDate = new Date((ev.dateStart || ev.date) + 'T12:00:00Z').getTime();
    return Math.abs(evDate - target) <= DAY;
  }) || null;
}

// Returns the real classification for the race session of a Blacktop
// event, or null if the event/session can't be resolved or hasn't run
// yet. Shape (our normalized form): { winner, podium: [names], raw }.
export async function getRaceResult(view, event, apiKey) {
  const slug = SERIES_SLUGS[view];
  if (!slug || !event) return null;

  // Blacktop's public docs don't show a dedicated "list sessions for an
  // event" endpoint, so we try the event object's own session list if
  // present, otherwise fall back to a conventional 'race' session id.
  const sessions = event.sessions || event.sessionList || [];
  const raceSession =
    sessions.find((s) => /race/i.test(s.type || s.name || '') && !/sprint/i.test(s.type || s.name || '')) ||
    sessions.find((s) => /race/i.test(s.type || s.name || ''));
  const sessionId = raceSession?.id || raceSession?.sessionId || 'race';

  let data;
  try {
    data = await blacktopFetch(`/${slug}/events/${event.id}/sessions/${sessionId}/results`, apiKey);
  } catch (e) {
    console.log(`Blacktop results not available yet for ${event.id}/${sessionId}: ${e.message}`);
    return null;
  }

  const classification = data.classification || data.results || data.results?.classification || [];
  if (!Array.isArray(classification) || classification.length === 0) return null;

  const finished = classification.filter((c) => c.position || c.pos);
  finished.sort((a, b) => (a.position || a.pos) - (b.position || b.pos));
  const winnerRow = finished[0];
  if (!winnerRow) return null;

  const nameOf = (row) => row.driver?.name || row.driverName || row.name || row.team?.name || null;

  return {
    winner: nameOf(winnerRow),
    podium: finished.slice(0, 3).map(nameOf).filter(Boolean),
    raw: finished.slice(0, 5),
  };
}

export async function getStandingsSummary(view, apiKey) {
  const slug = SERIES_SLUGS[view];
  if (!slug) return null;
  let data;
  try {
    data = await blacktopFetch(`/${slug}/standings/drivers`, apiKey);
  } catch (e) {
    console.log(`Blacktop standings not available for ${view}: ${e.message}`);
    return null;
  }
  const rows = data.standings || data.drivers || data.results || [];
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const nameOf = (row) => row.driver?.name || row.driverName || row.name || null;
  return {
    leader: nameOf(rows[0]),
    leaderPoints: rows[0].points,
    second: nameOf(rows[1]),
    gap: rows[0].points != null && rows[1].points != null ? rows[0].points - rows[1].points : null,
  };
}
