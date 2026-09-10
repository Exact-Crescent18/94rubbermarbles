// Hourly automation for ApexWire:
//  1. Checks CAL_EVENTS for races with no `result` yet. Tries Orange Cat
//     Blacktop (real structured data, free tier) first for the 9 series
//     it covers; falls back to Groq Compound Mini's web search for the
//     rest (ARCA, Indy NXT aren't covered by Blacktop at all) and for
//     anything Blacktop can't resolve yet.
//  2. When a result is newly confirmed, drafts a short recap article via
//     Groq from the real facts and posts it to that series' "On the
//     Wire" section.
//  3. Refreshes the news ticker with current headlines.
//  4. Publishes any scheduled (publishAt) articles whose time has come.
//
// Usage: GROQ_API_KEY=... [BLACKTOP_API_KEY=...] node scripts/update-results.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { isBlacktopCovered, findEvent, getRaceResult } from './lib/blacktop.mjs';
import { addArticle, publishDueArticles } from './lib/articles.mjs';
import { parseNamedLiteral } from './lib/html-utils.mjs';

const FILE = new URL('../index.html', import.meta.url);
const GROQ_KEY = process.env.GROQ_API_KEY;
const BLACKTOP_KEY = process.env.BLACKTOP_API_KEY; // optional — falls back to Groq-only if absent
const MODEL = 'groq/compound-mini';
const CALL_SPACING_MS = 4000; // spread requests out so we don't burst the free-tier TPM limit

if (!GROQ_KEY) {
  console.error('GROQ_API_KEY is not set.');
  process.exit(1);
}
if (!BLACKTOP_KEY) {
  console.log('BLACKTOP_API_KEY not set — using Groq web search for all series.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function askGroq(prompt, attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });

  // Transient errors (rate limit, oversized request, server hiccup): back
  // off and retry a couple of times before giving up on this one call.
  if ((res.status === 429 || res.status === 413 || res.status >= 500) && attempt < 3) {
    const bodyText = await res.text();
    const waitHint = bodyText.match(/try again in ([\d.]+)s/i);
    const waitMs = waitHint ? Math.ceil(parseFloat(waitHint[1]) * 1000) + 500 : 8000 * attempt;
    console.log(`Groq ${res.status}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})...`);
    await sleep(waitMs);
    return askGroq(prompt, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function daysSince(dateStr) {
  const eventDate = new Date(dateStr + 'T12:00:00Z'); // midday UTC, avoids TZ edge cases
  return (Date.now() - eventDate.getTime()) / 86400000;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Serializes a single CAL_EVENTS object back to the file's existing
// single-quote JS-literal style. Keeps key order stable and predictable.
function serializeEvent(ev) {
  const q = (s) => `'${String(s).replace(/'/g, "\\'")}'`;
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

// Tries Blacktop (real data) first for covered series; returns
// { winner, note } or null. Never guesses — a miss just returns null so
// the caller can fall back to Groq.
async function resultFromBlacktop(ev) {
  if (!BLACKTOP_KEY || !isBlacktopCovered(ev.view)) return null;
  try {
    const event = await findEvent(ev.view, ev.date, BLACKTOP_KEY);
    if (!event) return null;
    const result = await getRaceResult(ev.view, event, BLACKTOP_KEY);
    if (!result?.winner) return null;

    // Blacktop gives us the real facts; ask Groq (no search needed, just
    // phrasing) for one terse sentence in the site's existing style.
    const notePrompt = `Write one terse, factual news-ticker-style sentence (margin of victory, notable storyline, or standings implication) about this real race result. Do not invent anything beyond what's given.
Series: ${ev.series}. Race: ${ev.name}. Winner: ${result.winner}. Podium: ${result.podium.join(', ')}.
Respond with ONLY the sentence, no preamble.`;
    let note = `Winner: ${result.podium.join(', ')}.`;
    try {
      const reply = (await askGroq(notePrompt)).trim();
      if (reply && reply.length < 300) note = reply;
    } catch (e) {
      console.log(`Groq note-phrasing failed for ${ev.name}, using plain podium line:`, e.message);
    }
    return { winner: result.winner, note, podium: result.podium, source: 'blacktop' };
  } catch (e) {
    console.log(`Blacktop lookup failed for ${ev.name}:`, e.message);
    return null;
  }
}

async function resultFromGroq(ev) {
  const prompt = `Real-world race lookup. Series: ${ev.series}. Race: ${ev.name}. Venue: ${ev.venue || 'unknown'}. Scheduled date: ${ev.date}.
Has this specific real race actually taken place yet, and if so, who won? Search for it.
Respond with ONLY strict JSON, no other text:
{"happened": true, "winner": "Full Name", "note": "one terse factual sentence — margin of victory, notable storyline, or standings implication"}
or if it hasn't happened yet, or you cannot find a clearly confirmed result from a reliable source:
{"happened": false}
Never guess or invent a winner. Only report "happened": true if you found a real, verifiable result.`;

  const reply = await askGroq(prompt);
  const parsed = extractJson(reply);
  if (parsed?.happened && parsed.winner && parsed.note) {
    return { winner: parsed.winner, note: parsed.note, podium: [parsed.winner], source: 'groq' };
  }
  return null;
}

async function draftRecapArticle(ev, result) {
  const prompt = `Write a short motorsport recap article as strict JSON, in the style of a terse, factual racing news site (not breathless or promotional). Base it ONLY on these confirmed real facts — do not invent additional details, quotes, or statistics beyond them.
Series: ${ev.series}. Race: ${ev.name}. Venue: ${ev.venue || 'unknown'}. Date: ${ev.date}.
Winner: ${result.winner}. Podium: ${result.podium.join(', ')}. Key fact: ${result.note}

Respond with ONLY this JSON shape:
{"title": "short headline, no clickbait", "dek": "one-sentence subhead", "body": ["paragraph 1", "paragraph 2", "paragraph 3"], "category": "Race Report", "readTime": "4 min read"}`;

  try {
    const reply = await askGroq(prompt);
    const parsed = extractJson(reply);
    if (parsed?.title && parsed?.dek && Array.isArray(parsed.body) && parsed.body.length) {
      return parsed;
    }
  } catch (e) {
    console.log(`Groq recap drafting failed for ${ev.name}:`, e.message);
  }
  return null;
}

async function main() {
  let html = readFileSync(FILE, 'utf8');

  const startMarker = 'const CAL_EVENTS = [';
  const start = html.indexOf(startMarker);
  const end = html.indexOf('\n];\n\nconst CAL_EVENTS_BY_DATE', start);
  if (start === -1 || end === -1) {
    console.error('Could not locate CAL_EVENTS block.');
    process.exit(1);
  }

  const arrayLiteral = html.slice(start + 'const CAL_EVENTS = '.length, end + 2);
  // Trusted, self-authored content (this project's own data file) — not
  // third-party input — so evaluating it as JS is safe here.
  const events = new Function(`return ${arrayLiteral}`)();

  const CAL_SERIES = parseNamedLiteral(html, 'CAL_SERIES')?.value || {};

  let changed = 0;
  const changedNames = [];

  for (const ev of events) {
    if (ev.result) continue;
    if (daysSince(ev.date) < 0.5) continue; // too soon, don't even ask

    let result = await resultFromBlacktop(ev);
    if (!result) {
      try {
        result = await resultFromGroq(ev);
      } catch (e) {
        console.error(`Groq call failed for ${ev.name}:`, e.message);
      }
    }
    await sleep(CALL_SPACING_MS);

    if (result) {
      ev.result = { winner: result.winner, note: result.note };
      delete ev.sessions;
      delete ev.watch;
      changed++;
      changedNames.push(ev.name);
      console.log(`Updated (${result.source}): ${ev.name} — ${result.winner}`);

      // Rewrite CAL_EVENTS now so the recap-article step below (which
      // touches ARTICLES/HTML separately) works off up-to-date content.
      const newLiteral = `[\n${events.map(serializeEvent).join(',\n')}\n]`;
      html = html.slice(0, start) + 'const CAL_EVENTS = ' + newLiteral + html.slice(end + 2);
      writeFileSync(FILE, html, 'utf8');

      const draft = await draftRecapArticle(ev, result);
      await sleep(CALL_SPACING_MS);
      if (draft) {
        const slug = `${ev.view}-${slugify(ev.name)}-${ev.date}`;
        const dateLabel = new Date(ev.date + 'T12:00:00Z').toLocaleDateString('en-US', {
          day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
        });
        html = addArticle(html, slug, {
          view: ev.view,
          chip: ev.chip,
          chipLogo: CAL_SERIES[ev.view]?.logo || '',
          chipText: ev.series,
          title: draft.title,
          category: draft.category || 'Race Report',
          readTime: draft.readTime || '4 min read',
          date: dateLabel,
          track: '',
          dek: draft.dek,
          body: draft.body,
        });
        writeFileSync(FILE, html, 'utf8');
        console.log(`Posted recap article: ${slug}`);
      }
    }
  }

  // --- Ticker refresh: one current headline per series, best-effort ---
  const tickerStart = html.indexOf('<div class="ticker-inner">');
  const tickerEnd = html.indexOf('</div>', tickerStart);
  if (tickerStart !== -1 && tickerEnd !== -1) {
    const tickerBlock = html.slice(tickerStart, tickerEnd);
    const seriesMatches = [...tickerBlock.matchAll(/alt="([^"]+)">\s*\n\s*([^<]+?)<\/span>/g)];
    let tickerChanged = false;
    let newTickerBlock = tickerBlock;

    for (const m of seriesMatches) {
      const [full, seriesAlt, oldLine] = m;
      const prompt = `Give me one current, verifiable, real racing news headline about ${seriesAlt} as of today — a race result, standings shift, or notable development. One short factual sentence, no preamble, suitable for a news ticker. If you can't confirm anything current, respond with exactly: NO_UPDATE`;
      let reply;
      try {
        reply = (await askGroq(prompt)).trim();
      } catch (e) {
        console.error(`Groq ticker call failed for ${seriesAlt}:`, e.message);
        await sleep(CALL_SPACING_MS);
        continue;
      }
      if (reply && reply !== 'NO_UPDATE' && reply.length <= 220 && reply !== oldLine.trim()) {
        newTickerBlock = newTickerBlock.replace(full, full.replace(oldLine, reply));
        tickerChanged = true;
        console.log(`Ticker updated: ${seriesAlt}`);
      }
      await sleep(CALL_SPACING_MS);
    }

    if (tickerChanged) {
      html = html.slice(0, tickerStart) + newTickerBlock + html.slice(tickerEnd);
      writeFileSync(FILE, html, 'utf8');
      changed++;
    }
  }

  // --- Publish any scheduled articles whose time has come ---
  const { html: publishedHtml, publishedSlugs } = publishDueArticles(html);
  if (publishedSlugs.length) {
    html = publishedHtml;
    writeFileSync(FILE, html, 'utf8');
    changed++;
    console.log(`Published scheduled articles: ${publishedSlugs.join(', ')}`);
  }

  if (changed === 0) {
    console.log('Nothing to update this run.');
    return;
  }

  // Validate before letting the workflow commit: JS must still parse and
  // <style> braces must still balance, or we bail without writing.
  const scriptContent = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  try {
    new Function(scriptContent);
  } catch (e) {
    console.error('Validation failed after edit, aborting without commit:', e.message);
    process.exit(1);
  }
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open !== close) {
    console.error(`CSS brace mismatch after edit (${open} vs ${close}), aborting without commit.`);
    process.exit(1);
  }

  console.log(`Validation passed. ${changedNames.length ? 'Results: ' + changedNames.join(', ') : 'Ticker/articles refreshed.'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
