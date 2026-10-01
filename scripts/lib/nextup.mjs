// Keeps each series' "Next Up" hero panel and "Remaining Schedule" table
// in sync with CAL_EVENTS, instead of the manual one-off rebuilds that
// kept falling behind. Two states per series:
//   - ongoing: next unresolved event -> panel shows venue/sessions/round,
//     a static date/time, and (when the "Race" session's time string
//     resolves to one precise instant — see lib/racetime.mjs) a live
//     countdown.
//   - complete: every CAL_EVENTS entry for that view has a result ->
//     panel shows a season-wrap recap from the real, already-confirmed
//     results.
//
// The countdown only renders when parseSessionDateTime() can turn the
// session's time string into a real UTC-offset instant. Earlier this
// project shipped fabricated/mis-parsed countdowns and had to rip them
// out; the fix wasn't to avoid countdowns, it was to only build one from
// an unambiguous timestamp and render nothing (not a guess) otherwise.

import { parseSessionDateTime } from './racetime.mjs';

const TIMEZONE_ABBR = {
  ET: 'Eastern', CT: 'Central', MT: 'Mountain', PT: 'Pacific', MST: 'Arizona (no DST)',
  CEST: 'Central European Summer', CET: 'Central European', AZT: 'Azerbaijan',
  JST: 'Japan', WITA: 'Central Indonesia', AEDT: 'Australian Eastern (DST)',
  SGT: 'Singapore', BRT: 'Brazil',
};

function seriesEvents(events, view) {
  return events.filter((e) => e.view === view).sort((a, b) => a.date.localeCompare(b.date));
}

// Returns { mode: 'ongoing', next, round, total } or { mode: 'complete', last, all }
export function computeSeriesState(events, view) {
  const all = seriesEvents(events, view);
  if (all.length === 0) return null;
  const next = all.find((e) => !e.result);
  if (next) {
    const round = all.indexOf(next) + 1;
    return { mode: 'ongoing', next, round, total: all.length, all };
  }
  return { mode: 'complete', last: all[all.length - 1], all };
}

// Scans the whole file for previously-used, already-verified track/venue
// images so a newly-featured race can reuse a real one instead of the
// script guessing a URL. Matches loosely on shared significant words
// between the target venue string and each image's alt text.
// Includes not just venue/generic terms but also series-template words
// ("race", "rally", "hours") that recur across every event name in a
// series — without these, e.g. "Race at Salem" and "Race at WWT
// Raceway", "Rally Chile Biobío" and "Rally Italia Sardegna", or WEC's
// "6 Hours of Fuji" and "6 Hours of Barcelona" (which even share the
// numeric token "6", since both are 6-hour races) share only that one
// generic word and sameRace() below would wrongly call them the same
// event. This list has grown reactively as each new series' naming
// template surfaced this same false-positive — if a new series' events
// all follow "<generic word> <venue>", assume its generic word needs
// adding here too rather than assuming the existing list is complete.
const STOPWORDS = new Set([
  'circuit', 'raceway', 'speedway', 'international', 'diagram', 'track', 'map', 'the',
  'street', 'course', 'motor', 'grand', 'prix', 'of', 'at', 'route', 'layout', 'of,',
  'race', 'rally', 'hours',
]);

function significantWords(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => {
      if (w === '') return false;
      // Keep numeric tokens regardless of length — "1" vs "2" is exactly
      // the signal that tells a doubleheader's two races apart.
      if (!Number.isNaN(Number(w))) return true;
      return w.length > 2 && !STOPWORDS.has(w);
    });
}

export function harvestTrackImages(html) {
  const images = [];
  const re = /<img class="diagram" src="([^"]+)" alt="([^"]+)">/g;
  let m;
  while ((m = re.exec(html))) {
    images.push({ src: m[1], alt: m[2] });
  }
  return images;
}

export function findTrackImage(images, venueOrName) {
  const target = new Set(significantWords(venueOrName));
  if (target.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const img of images) {
    const words = significantWords(img.alt);
    const overlap = words.filter((w) => target.has(w)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = img;
    }
  }
  // Require at least one real shared word — otherwise leave it unmatched
  // rather than attaching an unrelated image.
  return bestScore > 0 ? best : null;
}

function sessionsTableHTML(sessions) {
  if (!sessions?.length) return '';
  const rows = sessions
    .map((s) => `          <tr${s.label === 'Race' ? ' class="race"' : ''}><td>${s.label}</td><td>${s.time}</td></tr>`)
    .join('\n');
  return `      <div class="session-schedule">
        <h4>Session Schedule</h4>
        <table>
${rows}
        </table>
      </div>`;
}

// Renders the .countdown block used by both the per-series panel and the
// homepage grid cards. With a real target instant it carries
// data-target for tickCountdowns() (index.html's own client-side timer)
// to pick up; without one — the session time didn't resolve to a single
// precise instant — it renders static "--" cells instead of a live
// countdown, exactly matching tickCountdowns()'s own "finished/unknown"
// display convention rather than a fabricated running clock.
export function countdownHTML(isoTarget) {
  if (!isoTarget) {
    return `      <div class="countdown">
        <div class="cell"><span class="n dd">--</span><span class="u">DAYS</span></div>
        <div class="cell"><span class="n hh">--</span><span class="u">HRS</span></div>
        <div class="cell"><span class="n mm">--</span><span class="u">MIN</span></div>
        <div class="cell"><span class="n ss">--</span><span class="u">SEC</span></div>
      </div>`;
  }
  return `      <div class="countdown" data-target="${isoTarget}">
        <div class="cell"><span class="n dd">00</span><span class="u">DAYS</span></div>
        <div class="cell"><span class="n hh">00</span><span class="u">HRS</span></div>
        <div class="cell"><span class="n mm">00</span><span class="u">MIN</span></div>
        <div class="cell"><span class="n ss">00</span><span class="u">SEC</span></div>
      </div>`;
}

// Builds the full "Next Up" panel (ongoing-season state) as HTML.
export function renderOngoingPanel({ chip, chipLogo, chipText, next, round, total, trackImg, watchText }) {
  const raceSession = next.sessions?.find((s) => s.label === 'Race');
  const dateLine = raceSession ? raceSession.time : next.date;
  const target = raceSession ? parseSessionDateTime(raceSession.time, next.date) : null;
  return `  <section class="next-up-panel">
    <div class="track">
      <img class="diagram" src="${trackImg.src}" alt="${trackImg.alt}">
      <div class="cap">${trackImg.alt.toUpperCase()}</div>
    </div>
    <div class="info">
      <div class="series-row"><span class="chip ${chip}"><img class="chip-logo" src="${chipLogo}" alt="${chipText} logo">${chipText}</span><span class="round-num">Round ${round} / ${total}</span></div>
      <h3>${next.name}</h3>
      <div class="venue">${next.venue || ''}</div>
${countdownHTML(target)}
      <div class="event-date"><span>${dateLine}</span></div>
${sessionsTableHTML(next.sessions)}
      <div class="watch-block">
        <h4>What to Know</h4>
        <p>${watchText}</p>
      </div>
    </div>
  </section>`;
}

// Builds the season-complete "Season Wrap" panel from real, already-
// confirmed results — no invented champion claim unless a clean points
// gap is available from Blacktop standings (passed in as `standings`,
// optional).
export function renderCompletePanel({ chip, chipLogo, chipText, last, trackImg, recapText, standings }) {
  const standingsRows = standings?.leader
    ? `      <div class="session-schedule">
        <h4>Final Standings</h4>
        <table>
          <tr class="race"><td>1. ${standings.leader}</td><td>${standings.leaderPoints != null ? standings.leaderPoints + ' pts' : 'Champion'}</td></tr>
          ${standings.second ? `<tr><td>2. ${standings.second}</td><td>${standings.gap != null ? '−' + standings.gap + ' pts' : ''}</td></tr>` : ''}
        </table>
      </div>`
    : '';
  return `  <section class="next-up-panel">
    <div class="track">
      <img class="diagram" src="${trackImg.src}" alt="${trackImg.alt}">
      <div class="cap">${trackImg.alt.toUpperCase()}</div>
    </div>
    <div class="info">
      <div class="series-row"><span class="chip ${chip}"><img class="chip-logo" src="${chipLogo}" alt="${chipText} logo">${chipText}</span><span class="round-num">Season Complete</span></div>
      <h3>${last.name} — Final Race</h3>
      <div class="venue">${last.venue || ''}</div>
${standingsRows}
      <div class="watch-block">
        <h4>Season Recap</h4>
        <p>${recapText}</p>
      </div>
    </div>
  </section>`;
}

// Finds the "Sector 01" label + next-up-panel + "Sector 02" label +
// schedule-table block within one series' <section id="view-X"> and
// returns their positions, or null if the expected structure isn't
// there (e.g. a hand-customized page shaped differently — skipped
// rather than risking corrupting it).
function locateBlock(html, view) {
  const viewMarker = `id="view-${view}"`;
  const viewStart = html.indexOf(viewMarker);
  if (viewStart === -1) return null;
  const nextViewStart = html.indexOf('id="view-', viewStart + viewMarker.length);
  const viewEnd = nextViewStart === -1 ? html.length : nextViewStart;

  const panelStart = html.indexOf('<section class="next-up-panel"', viewStart);
  if (panelStart === -1 || panelStart >= viewEnd) return null;
  const panelEnd = html.indexOf('</section>', panelStart) + '</section>'.length;

  // The sector-label immediately preceding the panel — found by
  // searching backward from the panel, not just "the view's first
  // sector-label". A few series (indycar, formula-e) have their own
  // series-hero intro living under the same Sector 01 ahead of the
  // panel; searching forward from viewStart would grab that intro's
  // label instead, and a rebuild would then splice the intro section
  // itself out as if it were part of "between panel and label".
  const s2Real = html.lastIndexOf('<div class="sector-label"', panelStart);
  if (s2Real === -1 || s2Real < viewStart) return null;
  const s2LabelEnd = html.indexOf('</div>', s2Real) + '</div>'.length;

  const tableStart = html.indexOf('<table class="schedule-table">', panelEnd);
  if (tableStart === -1 || tableStart >= viewEnd) return null;
  const tableEnd = html.indexOf('</table>', tableStart) + '</table>'.length;

  const s3Start = html.lastIndexOf('<div class="sector-label"', tableStart);

  const panelText = html.slice(panelStart, panelEnd);
  const currentTitleMatch = panelText.match(/<h3>([^<]*)<\/h3>/);
  const currentTitle = currentTitleMatch ? currentTitleMatch[1] : null;
  const currentlyComplete = /Season Complete|Season Wrap/i.test(panelText);
  const hasCountdown = panelText.includes('class="countdown"');
  // The countdown's data-target (when present) is an exact, unambiguous
  // date for whichever race the panel currently features — far more
  // reliable than fuzzy-matching names for telling apart same-venue
  // doubleheaders ("Milwaukee — R1" vs "R2").
  const dateMatch = panelText.match(/data-target="(\d{4}-\d{2}-\d{2})/);
  const currentDate = dateMatch ? dateMatch[1] : null;

  return { s2Real, s2LabelEnd, panelStart, panelEnd, s3Start, tableStart, tableEnd, currentTitle, currentlyComplete, hasCountdown, currentDate };
}

// Loose "is this still the same race" check — cosmetic differences like
// a parenthetical venue suffix or a sponsor-name prefix shouldn't count
// as stale. An exact date match is trusted immediately. Otherwise (dates
// can legitimately differ for a multi-day rally/double-header stored
// under slightly different "the" date in CAL_EVENTS vs. a hand-written
// countdown target): require shared non-numeric words as evidence of
// the same event, AND — the key guard against conflating a doubleheader's
// "Race 1" with "Race 2" — if both titles also carry numeric tokens
// (race numbers, lap counts, sponsor numbers), at least one of those
// numbers must match too.
function sameRace(titleA, titleB, dateA, dateB) {
  if (dateA && dateB && dateA === dateB) return true;
  if (!titleA || !titleB) return false;

  const words = (t) => significantWords(t);
  const isNum = (w) => !Number.isNaN(Number(w));
  const wordsA = words(titleA);
  const wordsB = words(titleB);

  const nonNumA = wordsA.filter((w) => !isNum(w));
  const nonNumB = wordsB.filter((w) => !isNum(w));
  const sharedText = nonNumA.some((w) => nonNumB.includes(w));
  if (!sharedText) return false;

  const numA = wordsA.filter(isNum);
  const numB = wordsB.filter(isNum);
  if (numA.length && numB.length && !numA.some((n) => numB.includes(n))) return false;

  return true;
}

// Main entry point. Rebuilds any series whose panel is out of sync with
// the real "next race" (or season-complete state) in CAL_EVENTS. Returns
// { html, changedViews }.
// force=true skips every "already correct" staleness check and rebuilds
// every panel unconditionally — meant for a one-time template migration
// (e.g. adding the countdown block below), not for the normal hourly run.
export async function refreshAllNextUpPanels(html, events, seriesMeta, calSeries, phrase, force = false, skipViews = []) {
  const changedViews = [];
  const views = [...new Set(events.map((e) => e.view))];

  for (const view of views) {
    if (skipViews.includes(view)) continue;
    const state = computeSeriesState(events, view);
    if (!state) continue;
    const expectedTitle = state.mode === 'ongoing' ? state.next.name : `${state.last.name} — Final Race`;

    const loc = locateBlock(html, view);
    if (!loc) {
      console.log(`Next-Up panel for "${view}" doesn't match the expected structure — skipping (won't risk corrupting a custom layout).`);
      continue;
    }

    // Season already wrapped up and the panel already reflects that
    // (no live countdown left over) — trust whatever's there, even if
    // it doesn't textually match our generated title. A hand-written
    // recap is not "stale" just because it's not our template's wording.
    // force only applies to the ongoing branch below (it's the only one
    // the countdown-template migration touches) — a season-wrap recap is
    // never force-regenerated, so a hand-curated one is never clobbered.
    if (state.mode === 'complete' && loc.currentlyComplete && !loc.hasCountdown) continue;

    // Ongoing season: only rebuild if the panel is actually pointing at
    // a different race, not just worded differently from the same one.
    if (!force && state.mode === 'ongoing' && !loc.currentlyComplete && sameRace(loc.currentTitle, state.next.name, loc.currentDate, state.next.date)) continue;

    const meta = seriesMeta[view];
    const seriesInfo = calSeries[view];
    if (!meta || !seriesInfo) {
      console.log(`No series metadata for "${view}" — skipping.`);
      continue;
    }

    const images = harvestTrackImages(html);
    let panelHTML, sectorLabel1, sectorLabel2;

    if (state.mode === 'ongoing') {
      const trackImg = findTrackImage(images, state.next.venue || state.next.name) || {
        src: seriesInfo.logo,
        alt: `${meta.chipText} logo`,
      };
      let watchText = `${state.next.name} is next up for ${meta.chipText}.`;
      try {
        const prev = state.all[state.all.indexOf(state.next) - 1];
        const prompt = `Write one or two terse, factual sentences previewing this upcoming real race, in the style of a factual motorsport news site. Do not invent anything beyond what's given.
Series: ${meta.chipText}. Upcoming race: ${state.next.name} at ${state.next.venue || 'TBA'}.${prev?.result ? ` Previous race: ${prev.name}, won by ${prev.result.winner} — ${prev.result.note}` : ''}
Respond with ONLY the sentence(s), no preamble.`;
        watchText = (await phrase(prompt)).trim() || watchText;
      } catch (e) {
        console.log(`Phrasing failed for ${view} next-up panel, using plain fallback:`, e.message);
      }
      panelHTML = renderOngoingPanel({
        chip: meta.chip, chipLogo: seriesInfo.logo, chipText: meta.chipText,
        next: state.next, round: state.round, total: state.total, trackImg, watchText,
      });
      sectorLabel1 = 'Next Up';
      sectorLabel2 = 'Remaining Schedule';
    } else {
      const trackImg = findTrackImage(images, state.last.venue || state.last.name) || {
        src: seriesInfo.logo,
        alt: `${meta.chipText} logo`,
      };
      let recapText = `${state.last.result?.winner || 'The field'} took the final race of the season at ${state.last.venue || state.last.name}.`;
      try {
        const prompt = `Write one or two terse, factual sentences recapping the end of this real motorsport season. Do not invent a champion or any detail beyond what's given.
Series: ${meta.chipText}. Final race: ${state.last.name} at ${state.last.venue || 'TBA'}, won by ${state.last.result?.winner || 'unknown'} — ${state.last.result?.note || ''}
Respond with ONLY the sentence(s), no preamble.`;
        recapText = (await phrase(prompt)).trim() || recapText;
      } catch (e) {
        console.log(`Phrasing failed for ${view} season-wrap panel, using plain fallback:`, e.message);
      }
      panelHTML = renderCompletePanel({
        chip: meta.chip, chipLogo: seriesInfo.logo, chipText: meta.chipText,
        last: state.last, trackImg, recapText, standings: null,
      });
      sectorLabel1 = 'Season Wrap';
      sectorLabel2 = 'Final Races';
    }

    const tableHTML = renderScheduleTable(state);
    const label1HTML = `<div class="sector-label"><span class="num">S1</span><span class="name">Sector 01 — ${sectorLabel1}</span><span class="line"></span></div>`;
    const label2HTML = `<div class="sector-label"><span class="num">S2</span><span class="name">Sector 02 — ${sectorLabel2}</span><span class="line"></span></div>`;

    // Rebuild back-to-front (S2/table, then S1/panel) so offsets earlier
    // in the string — which are untouched by the first splice — stay
    // valid. `preamble` is whatever sits between the shared Sector 01
    // label and the panel itself — empty for most series, but indycar/
    // formula-e keep a real series-hero intro there under the same
    // Sector 01, which a rebuild must not silently delete.
    html = html.slice(0, loc.s3Start) + label2HTML + '\n' + tableHTML + html.slice(loc.tableEnd);
    const preamble = html.slice(loc.s2LabelEnd, loc.panelStart);
    const between = html.slice(loc.panelEnd, loc.s3Start);
    html = html.slice(0, loc.s2Real) + label1HTML + preamble + panelHTML + between + html.slice(loc.s3Start);

    changedViews.push(view);
    console.log(`Rebuilt Next-Up panel for ${view}: "${loc.currentTitle}" -> "${expectedTitle}"`);
  }

  return { html, changedViews };
}

// The homepage's "On Track Next" grid is a separate, hand-authored
// section (4 <div class="event-card"> blocks, different markup than the
// per-series next-up-panel) that refreshAllNextUpPanels above never
// touches — it only looks inside id="view-X" sections. That gap is why
// it can sit stale (e.g. still showing a series whose season already
// ended) even while every per-series page is current. This picks the
// first 4 series from HOME_FEATURED_PRIORITY that still have a genuine
// upcoming race, so a season ending automatically rotates it out instead
// of leaving a dead card behind.
const HOME_FEATURED_PRIORITY = [
  'f1', 'nascar-cup', 'motogp', 'indycar', 'wec', 'nascar-oreilly',
  'wrc', 'nascar-truck', 'arca', 'formula-e', 'indy-nxt',
];

export function renderEventCard({ chip, chipLogo, chipText, roundLabel, next, trackImg }) {
  const raceSession = next.sessions?.find((s) => s.label === 'Race');
  const dateLine = raceSession ? raceSession.time : '';
  const target = raceSession ? parseSessionDateTime(raceSession.time, next.date) : null;
  return `    <div class="event-card">
      <div class="series-row"><span class="chip ${chip}"><img class="chip-logo" src="${chipLogo}" alt="${chipText} logo">${chipText}</span><span class="round-num">${roundLabel}</span></div>
      <div class="track-svg"><img class="diagram" src="${trackImg.src}" alt="${trackImg.alt}"></div>
      <h3>${next.name}</h3>
      <div class="venue">${next.venue || ''}</div>
${countdownHTML(target)}
      <div class="event-date"><span>${next.date}</span><span>${dateLine}</span></div>
    </div>`;
}

function splitEventCards(gridHtml) {
  const marker = '<div class="event-card">';
  const idxs = [];
  let i = gridHtml.indexOf(marker);
  while (i !== -1) {
    idxs.push(i);
    i = gridHtml.indexOf(marker, i + marker.length);
  }
  return idxs.map((start, n) => gridHtml.slice(start, idxs[n + 1] ?? gridHtml.length));
}

// Rebuilds the homepage grid only if what's currently there doesn't
// match the 4 series/races it should be showing right now — same
// sameRace() staleness check used for the per-series panels, so a purely
// cosmetic difference (sponsor suffix, etc.) doesn't trigger a rebuild.
export function refreshHomeEventsGrid(html, events, seriesMeta, calSeries, force = false) {
  const gridMarker = '<section class="events-grid">';
  const gridStart = html.indexOf(gridMarker);
  if (gridStart === -1) return { html, changed: false };
  const gridEnd = html.indexOf('</section>', gridStart) + '</section>'.length;
  const oldGrid = html.slice(gridStart, gridEnd);

  const featured = [];
  for (const view of HOME_FEATURED_PRIORITY) {
    const state = computeSeriesState(events, view);
    if (state?.mode === 'ongoing') featured.push({ view, state });
    if (featured.length === 4) break;
  }

  const existingCards = splitEventCards(oldGrid).map((chunk) => {
    const title = chunk.match(/<h3>([^<]*)<\/h3>/)?.[1] || null;
    const date = chunk.match(/data-target="(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    return { title, date };
  });

  const allCurrent = !force && featured.length > 0 && featured.every(({ state }) =>
    existingCards.some((c) => sameRace(c.title, state.next.name, c.date, state.next.date))
  ) && existingCards.length === featured.length;

  if (allCurrent) return { html, changed: false };

  const images = harvestTrackImages(html);
  const cards = featured.map(({ view, state }) => {
    const meta = seriesMeta[view];
    const seriesInfo = calSeries[view];
    const trackImg = findTrackImage(images, state.next.venue || state.next.name) || {
      src: seriesInfo?.logo || '',
      alt: `${meta?.chipText || view} logo`,
    };
    return renderEventCard({
      chip: meta?.chip || view,
      chipLogo: seriesInfo?.logo || '',
      chipText: meta?.chipText || view,
      roundLabel: `Round ${state.round} / ${state.total}`,
      next: state.next,
      trackImg,
    });
  });

  const newGrid = `${gridMarker}\n${cards.join('\n')}\n  </section>`;
  const newHtml = html.slice(0, gridStart) + newGrid + html.slice(gridEnd);
  return { html: newHtml, changed: true, featuredViews: featured.map((f) => f.view) };
}

export function renderScheduleTable(state) {
  if (state.mode === 'ongoing') {
    const rows = state.all
      .map((e) => {
        const tag = e === state.next ? ' <span class="tag-next">NEXT</span>' : '';
        const cls = e === state.next ? ' class="next"' : '';
        const status = e.result ? e.result.winner : e.date;
        return `<tr${cls}><td class="name">${e.name}${tag}</td><td>${e.venue || ''}</td><td>${status}</td></tr>`;
      })
      .join('\n');
    return `  <table class="schedule-table">
    <thead><tr><th>Race</th><th>Venue</th><th>Date / Winner</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
  }
  const rows = state.all
    .map((e) => `<tr><td class="name">${e.name}</td><td>${e.venue || ''}</td><td>${e.result?.winner || ''}</td></tr>`)
    .join('\n');
  return `  <table class="schedule-table">
    <thead><tr><th>Race</th><th>Venue</th><th>Winner</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}
