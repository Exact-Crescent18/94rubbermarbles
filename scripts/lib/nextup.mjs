// Keeps each series' "Next Up" hero panel and "Remaining Schedule" table
// in sync with CAL_EVENTS, instead of the manual one-off rebuilds that
// kept falling behind. Two states per series:
//   - ongoing: next unresolved event -> panel shows venue/sessions/round
//     and a static date/time (no live countdown — see note below).
//   - complete: every CAL_EVENTS entry for that view has a result ->
//     panel shows a season-wrap recap from the real, already-confirmed
//     results.
//
// Deliberately NOT rebuilding a live JS countdown here: parsing session
// time strings back into precise timezone-aware timestamps is exactly
// the class of bug that's bitten this project repeatedly. A static
// "10 Sep 2026 · 9:00 AM ET" is always correct; a countdown risks being
// confidently wrong.

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
const STOPWORDS = new Set([
  'circuit', 'raceway', 'speedway', 'international', 'diagram', 'track', 'map', 'the',
  'street', 'course', 'motor', 'grand', 'prix', 'of', 'at', 'route', 'layout', 'of,',
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

// Builds the full "Next Up" panel (ongoing-season state) as HTML.
export function renderOngoingPanel({ chip, chipLogo, chipText, next, round, total, trackImg, watchText }) {
  const raceSession = next.sessions?.find((s) => s.label === 'Race');
  const dateLine = raceSession ? raceSession.time : next.date;
  return `  <section class="next-up-panel">
    <div class="track">
      <img class="diagram" src="${trackImg.src}" alt="${trackImg.alt}">
      <div class="cap">${trackImg.alt.toUpperCase()}</div>
    </div>
    <div class="info">
      <div class="series-row"><span class="chip ${chip}"><img class="chip-logo" src="${chipLogo}" alt="${chipText} logo">${chipText}</span><span class="round-num">Round ${round} / ${total}</span></div>
      <h3>${next.name}</h3>
      <div class="venue">${next.venue || ''}</div>
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

// Finds the "Sector 02" label + next-up-panel + "Sector 03" label +
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

  const s2Start = html.indexOf('<div class="sector-label">', viewStart);
  if (s2Start === -1 || s2Start >= viewEnd) return null;
  // The S2 label may or may not carry an id="..." — find whichever comes first.
  const s2StartAlt = html.indexOf('<div class="sector-label"', viewStart);
  const s2Real = s2StartAlt !== -1 && s2StartAlt < s2Start ? s2StartAlt : s2Start;

  const panelStart = html.indexOf('<section class="next-up-panel"', s2Real);
  if (panelStart === -1 || panelStart >= viewEnd) return null;
  const panelEnd = html.indexOf('</section>', panelStart) + '</section>'.length;

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

  return { s2Real, panelStart, panelEnd, s3Start, tableStart, tableEnd, currentTitle, currentlyComplete, hasCountdown, currentDate };
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
export async function refreshAllNextUpPanels(html, events, seriesMeta, calSeries, phrase) {
  const changedViews = [];
  const views = [...new Set(events.map((e) => e.view))];

  for (const view of views) {
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
    if (state.mode === 'complete' && loc.currentlyComplete && !loc.hasCountdown) continue;

    // Ongoing season: only rebuild if the panel is actually pointing at
    // a different race, not just worded differently from the same one.
    if (state.mode === 'ongoing' && !loc.currentlyComplete && sameRace(loc.currentTitle, state.next.name, loc.currentDate, state.next.date)) continue;

    const meta = seriesMeta[view];
    const seriesInfo = calSeries[view];
    if (!meta || !seriesInfo) {
      console.log(`No series metadata for "${view}" — skipping.`);
      continue;
    }

    const images = harvestTrackImages(html);
    let panelHTML, sectorLabel2, sectorLabel3;

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
      sectorLabel2 = 'Next Up';
      sectorLabel3 = 'Remaining Schedule';
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
      sectorLabel2 = 'Season Wrap';
      sectorLabel3 = 'Final Races';
    }

    const tableHTML = renderScheduleTable(state);
    const label2HTML = `<div class="sector-label"><span class="num">S2</span><span class="name">Sector 02 — ${sectorLabel2}</span><span class="line"></span></div>`;
    const label3HTML = `<div class="sector-label"><span class="num">S3</span><span class="name">Sector 03 — ${sectorLabel3}</span><span class="line"></span></div>`;

    // Rebuild back-to-front (S3/table, then S2/panel) so offsets earlier
    // in the string — which are untouched by the first splice — stay valid.
    html = html.slice(0, loc.s3Start) + label3HTML + '\n' + tableHTML + html.slice(loc.tableEnd);
    const between = html.slice(loc.panelEnd, loc.s3Start);
    html = html.slice(0, loc.s2Real) + label2HTML + '\n' + panelHTML + between + html.slice(loc.s3Start);

    changedViews.push(view);
    console.log(`Rebuilt Next-Up panel for ${view}: "${loc.currentTitle}" -> "${expectedTitle}"`);
  }

  return { html, changedViews };
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
