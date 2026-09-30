// Shared CAL_EVENTS read/write helpers — used by scripts/update-results.mjs
// (Node) and admin.html (browser, imported directly as a static file via
// GitHub Pages, since this module has no Node-only dependencies). Single
// source of truth for the serialization format, so a manual edit made
// through the admin editor and an automated edit made by the hourly bot
// always produce byte-identical formatting.

const START_MARKER = 'const CAL_EVENTS = [';
const END_MARKER = '\n];\n\nconst CAL_EVENTS_BY_DATE';

export function locateCalEvents(html) {
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER, start);
  if (start === -1 || end === -1) throw new Error('Could not locate CAL_EVENTS block.');
  return { start, end };
}

export function parseCalEvents(html) {
  const { start, end } = locateCalEvents(html);
  const literal = html.slice(start + 'const CAL_EVENTS = '.length, end + 2);
  return new Function(`return ${literal}`)();
}

function q(s) {
  return `'${String(s).replace(/'/g, "\\'")}'`;
}

export function serializeEvent(ev) {
  const parts = [`date:${q(ev.date)}`, `view:${q(ev.view)}`, `chip:${q(ev.chip)}`, `series:${q(ev.series)}`, `name:${q(ev.name)}`];
  if (ev.venue) parts.push(`venue:${q(ev.venue)}`);
  if (ev.result) {
    parts.push(`result:{winner:${q(ev.result.winner)}, note:${q(ev.result.note)}}`);
  } else {
    if (ev.sessions) {
      const sessions = ev.sessions.map((s) => `{label:${q(s.label)},time:${q(s.time)}}`).join(',');
      parts.push(`sessions:[${sessions}]`);
    }
    if (ev.watch) parts.push(`watch:${q(ev.watch)}`);
  }
  return `  {${parts.join(', ')}}`;
}

export function writeCalEvents(html, events) {
  const { start, end } = locateCalEvents(html);
  const newLiteral = `[\n${events.map(serializeEvent).join(',\n')}\n]`;
  return html.slice(0, start) + 'const CAL_EVENTS = ' + newLiteral + html.slice(end + 2);
}

// Sets (or overwrites) the result for one event, matched by view+date+name
// (the same composite key used elsewhere in this codebase to disambiguate
// same-name doubleheaders). Clears sessions/watch to match the
// convention update-results.mjs already uses once a race is resolved.
// Returns the updated html, or throws if no matching event is found.
export function setEventResult(html, { view, date, name }, result) {
  const events = parseCalEvents(html);
  const ev = events.find((e) => e.view === view && e.date === date && e.name === name);
  if (!ev) throw new Error(`No CAL_EVENTS entry matched view=${view} date=${date} name="${name}".`);
  ev.result = { winner: result.winner, note: result.note };
  delete ev.sessions;
  delete ev.watch;
  return writeCalEvents(html, events);
}
