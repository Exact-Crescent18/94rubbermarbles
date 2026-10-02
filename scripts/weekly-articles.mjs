// Publishes one new article per series roughly every 7 days, even in
// weeks where that series doesn't race (update-results.mjs only writes
// a recap when there's an actual result to report, so an off week would
// otherwise mean no new content for that series at all).
//
// "Last published" is tracked in weekly-article-state.json rather than
// parsed from each article's freeform `date` field — existing dates are
// a mix of formats ("20 Sep 2026", "Sun 11 Oct", bot-generated
// "Oct 15, 2026"), some without a year, so round-tripping through
// Date() reliably isn't possible for the older ones. The state file is
// the single source of truth for scheduling and gets committed back
// alongside index.html.
//
// Usage: GROQ_API_KEY=... node scripts/weekly-articles.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { SERIES_META } from './lib/series-meta.mjs';
import { addArticle } from './lib/articles.mjs';
import { parseNamedLiteral } from './lib/html-utils.mjs';

const FILE = new URL('../index.html', import.meta.url);
const STATE_FILE = new URL('./weekly-article-state.json', import.meta.url);
const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = 'groq/compound'; // open-ended "find a story" prompt — worth the real search depth
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

if (!GROQ_KEY) {
  console.error('GROQ_API_KEY is not set.');
  process.exit(1);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function askGroq(prompt, attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    }),
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    const bodyText = await res.text();
    const waitHint = bodyText.match(/try again in ([\d.]+)s/i);
    const waitMs = waitHint ? Math.ceil(parseFloat(waitHint[1]) * 1000) + 500 : 8000;
    await new Promise((r) => setTimeout(r, waitMs));
    return askGroq(prompt, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function draftPrompt(chipText) {
  return `You are writing for ApexWire, a terse, factual motorsport news site (not breathless or promotional). Research real, current, verifiable facts via web search — never invent statistics, quotes, or results.

Series: ${chipText}

Find the single most relevant, timely story angle for this series right now — a preview of the next race, a rules or format explainer, a championship-standings analysis, a track guide, the implications of a recent result, or a calendar/regulation change. Prefer something not already obvious from a results ticker. Write a short article about it.

Write the article as strict JSON, no other text:
{"title": "headline, no clickbait", "dek": "one-sentence subhead", "body": ["paragraph 1", "paragraph 2", "paragraph 3"], "category": "Preview|Feature|Explainer|Race Report|Analysis|Track Guide", "readTime": "N min read"}`;
}

async function main() {
  const state = loadState();
  const now = Date.now();
  let html = readFileSync(FILE, 'utf8');
  const CAL_SERIES = parseNamedLiteral(html, 'CAL_SERIES')?.value || {};

  const due = Object.keys(SERIES_META).filter((view) => {
    const last = state[view];
    return !last || now - new Date(last).getTime() >= WEEK_MS;
  });

  if (!due.length) {
    console.log('No series due for a weekly article.');
    return;
  }

  const published = [];
  for (const view of due) {
    const { chip, chipText } = SERIES_META[view];
    let draft;
    try {
      const reply = await askGroq(draftPrompt(chipText));
      draft = extractJson(reply);
    } catch (e) {
      console.error(`[${view}] Groq request failed, skipping this run:`, e.message);
      continue;
    }
    if (!draft?.title || !draft?.dek || !Array.isArray(draft.body) || !draft.body.length) {
      console.error(`[${view}] draft parse failed, skipping this run.`);
      continue;
    }

    const slug = `${view}-${slugify(draft.title)}-${new Date().toISOString().slice(0, 10)}`;
    const dateLabel = new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

    html = addArticle(html, slug, {
      view,
      chip,
      chipLogo: CAL_SERIES[view]?.logo || '',
      chipText,
      title: draft.title,
      category: draft.category || 'Feature',
      readTime: draft.readTime || '4 min read',
      date: dateLabel,
      track: '',
      dek: draft.dek,
      body: draft.body,
    });

    state[view] = new Date(now).toISOString();
    published.push(`${view}: ${draft.title}`);
  }

  if (!published.length) {
    console.log('Nothing published this run (all drafts failed).');
    return;
  }

  // Validate before writing: JS must still parse, CSS braces still balance.
  const scriptContent = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  try {
    new Function(scriptContent);
  } catch (e) {
    console.error('VALIDATION_FAILED:', e.message);
    process.exit(1);
  }
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open !== close) {
    console.error(`CSS_BRACE_MISMATCH: ${open} vs ${close}`);
    process.exit(1);
  }

  writeFileSync(FILE, html, 'utf8');
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log('Published:\n' + published.map((p) => `  - ${p}`).join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
