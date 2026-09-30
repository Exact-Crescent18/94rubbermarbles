// Turns a session time string like "Sun 25 Oct · 3:00 PM CT" or
// "Sun 4 Oct · 14:00 JST" into a real ISO-8601 datetime with a UTC
// offset, so countdowns can target an actual instant instead of being
// left out entirely (the prior approach, adopted after this exact class
// of parsing produced confidently-wrong countdowns).
//
// Deliberately returns null — no countdown, not a guess — for anything
// that doesn't reduce to one precise instant: "time TBC (...)", "night"
// (Formula E), or multi-day rally windows ("Thu–Sun 1–4 Oct"). A missing
// countdown is honest; a fabricated one from a fuzzy string is not.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// Fixed UTC offsets in minutes. US zones are split into their explicit
// standard/daylight forms (EST/EDT etc) — those are unambiguous by
// construction. The bare "ET"/"CT"/"MT"/"PT" forms actually used in this
// file's data are resolved through usDstWindow() below instead, since
// the data uses them for both DST and standard dates without
// distinguishing (see usDstWindow's doc comment for why that's still
// correct). AZT (Arizona) and MST-written-explicitly never observe DST,
// so they're fixed like any other non-US zone.
const FIXED_OFFSET_MIN = {
  EST: -5 * 60, EDT: -4 * 60,
  CST: -6 * 60, CDT: -5 * 60,
  MST: -7 * 60, MDT: -6 * 60,
  PST: -8 * 60, PDT: -7 * 60,
  AZT: -7 * 60,
  CEST: 2 * 60, CET: 1 * 60,
  JST: 9 * 60, WITA: 8 * 60,
  AEDT: 11 * 60, AEST: 10 * 60,
  SGT: 8 * 60, BRT: -3 * 60,
};

// generic US abbreviation -> [daylight form, standard form]
const US_GENERIC = { ET: ['EDT', 'EST'], CT: ['CDT', 'CST'], MT: ['MDT', 'MST'], PT: ['PDT', 'PST'] };

// US DST: 2nd Sunday of March through 1st Sunday of November (the rule
// since 2007). Computed from the calendar, not hardcoded per year, so it
// stays correct for any event date in CAL_EVENTS.
function usDstWindow(year) {
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(year, month, 1));
    const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
    return new Date(Date.UTC(year, month, firstSunday + 7 * (n - 1)));
  };
  return { start: nthSunday(2, 2), end: nthSunday(10, 1) };
}

function offsetMinutesFor(abbr, year, monthIdx, day) {
  if (FIXED_OFFSET_MIN[abbr] != null) return FIXED_OFFSET_MIN[abbr];
  const generic = US_GENERIC[abbr];
  if (!generic) return null;
  const { start, end } = usDstWindow(year);
  const target = new Date(Date.UTC(year, monthIdx, day));
  const isDst = target >= start && target < end;
  return FIXED_OFFSET_MIN[isDst ? generic[0] : generic[1]];
}

function formatOffset(totalMinutes) {
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

const SESSION_TIME_RE = /(\d{1,2}) ([A-Z][a-z]{2}) · (\d{1,2}):(\d{2})(?:\s*(AM|PM))? ([A-Z]{2,5})$/;

// eventDateISO ('YYYY-MM-DD', from the CAL_EVENTS entry) supplies the
// year, since session strings don't carry one. Returns an ISO-8601
// string with UTC offset, or null if no single precise instant exists.
export function parseSessionDateTime(timeStr, eventDateISO) {
  if (!timeStr || !eventDateISO) return null;
  const m = timeStr.match(SESSION_TIME_RE);
  if (!m) return null;
  const [, dayStr, monStr, hourStr, minStr, ampm, abbr] = m;
  const monthIdx = MONTHS[monStr];
  if (monthIdx == null) return null;

  const year = Number(eventDateISO.slice(0, 4));
  const day = Number(dayStr);
  let hour = Number(hourStr);
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  const offsetMin = offsetMinutesFor(abbr, year, monthIdx, day);
  if (offsetMin == null) return null;

  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(monthIdx + 1)}-${pad(day)}T${pad(hour)}:${minStr}:00${formatOffset(offsetMin)}`;
}
