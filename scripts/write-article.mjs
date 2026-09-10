// Drafts one article from a GitHub Issue opened via the "Write an
// article" template, using Groq Compound (full, real web search — these
// prompts are open-ended, unlike the terse recap lookups in
// update-results.mjs, so the larger model is worth the extra latency).
// Publishes immediately, or schedules for later if the issue specified
// a publishAt time.
//
// Usage: GROQ_API_KEY=... ISSUE_BODY=... node scripts/write-article.mjs
// Prints "SLUG=<slug>" and "SCHEDULED=<iso-or-empty>" on success for the
// workflow to pick up when composing its issue comment.

import { readFileSync, writeFileSync } from 'node:fs';
import { SERIES_META } from './lib/series-meta.mjs';
import { addArticle } from './lib/articles.mjs';
import { parseNamedLiteral } from './lib/html-utils.mjs';

const FILE = new URL('../index.html', import.meta.url);
const GROQ_KEY = process.env.GROQ_API_KEY;
const ISSUE_BODY = process.env.ISSUE_BODY || '';
const MODEL = 'groq/compound'; // full Compound: open-ended prompt, worth the extra search depth

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

// GitHub issue-form bodies render as a sequence of "### <label>\n\n<value>\n\n"
// blocks in field order. Parse by label text rather than position, so
// template field reordering doesn't silently break this.
function parseIssueForm(body) {
  const fields = {};
  const re = /### (.+?)\n+([\s\S]*?)(?=\n### |$)/g;
  let m;
  while ((m = re.exec(body))) {
    fields[m[1].trim()] = m[2].trim();
  }
  return fields;
}

async function askGroq(prompt, attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(60000), // full Compound can search more deeply than Mini, allow longer
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

  // 429/5xx are transient, worth one retry. 413 ("request too large") is a
  // known Groq-side Compound issue — its own web search results can
  // balloon the request server-side — and retrying the identical prompt
  // just reproduces it, so fail that one immediately.
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

async function main() {
  const fields = parseIssueForm(ISSUE_BODY);
  const series = (fields['Series'] || '').trim();
  const userPrompt = (fields['What should the article say?'] || '').trim();
  const publishAtRaw = (fields['Publish at (optional)'] || '').trim();

  if (!SERIES_META[series]) {
    console.error(`SERIES_INVALID=${series}`);
    process.exit(1);
  }
  if (!userPrompt) {
    console.error('EMPTY_PROMPT');
    process.exit(1);
  }

  let publishAt = null;
  if (publishAtRaw && publishAtRaw !== '_No response_') {
    const ts = new Date(publishAtRaw);
    if (!Number.isNaN(ts.getTime())) publishAt = ts.toISOString();
  }

  const { chip, chipText } = SERIES_META[series];

  const draftPrompt = `You are writing for ApexWire, a terse, factual motorsport news site (not breathless or promotional). Research real, current, verifiable facts via web search — never invent statistics, quotes, or results.

Series: ${chipText}
Editor's brief: ${userPrompt}

Write the article as strict JSON, no other text:
{"title": "headline, no clickbait", "dek": "one-sentence subhead", "body": ["paragraph 1", "paragraph 2", "paragraph 3"], "category": "Preview|Feature|Explainer|Race Report|Analysis", "readTime": "N min read"}`;

  const reply = await askGroq(draftPrompt);
  const draft = extractJson(reply);
  if (!draft?.title || !draft?.dek || !Array.isArray(draft.body) || !draft.body.length) {
    console.error('DRAFT_FAILED');
    console.error(reply);
    process.exit(1);
  }

  let html = readFileSync(FILE, 'utf8');
  const CAL_SERIES = parseNamedLiteral(html, 'CAL_SERIES')?.value || {};

  const slug = `${series}-${slugify(draft.title)}`;
  const dateLabel = new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

  html = addArticle(html, slug, {
    view: series,
    chip,
    chipLogo: CAL_SERIES[series]?.logo || '',
    chipText,
    title: draft.title,
    category: draft.category || 'Feature',
    readTime: draft.readTime || '4 min read',
    date: dateLabel,
    track: '',
    dek: draft.dek,
    body: draft.body,
    ...(publishAt ? { publishAt } : {}),
  });

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
  console.log(`SLUG=${slug}`);
  console.log(`TITLE=${draft.title}`);
  console.log(`SCHEDULED=${publishAt || ''}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
