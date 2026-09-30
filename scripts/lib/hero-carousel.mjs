// Renders the homepage's "Sector 01 — Lead Stories" carousel from
// LEAD_STORIES (an ordered array of ARTICLES slugs) + ARTICLES itself.
// No Node-only dependencies — importable by both update-results.mjs /
// scripts/lib/articles.mjs (Node) and admin.html (browser, as a static
// ES module via GitHub Pages).
//
// The carousel block is bounded by HTML comment markers rather than
// matched via tag-depth counting: a <div class="hero-carousel"> contains
// arbitrarily nested <div>s (each slide's own hero-meta, hero-art, etc),
// so naively looking for the next </div> would close on the wrong one.
// Comment markers sidestep that entirely.

import { parseNamedLiteral } from './html-utils.mjs';

const START_MARKER = '<!-- HERO_CAROUSEL_START -->';
const END_MARKER = '<!-- HERO_CAROUSEL_END -->';

export function locateCarousel(html) {
  const start = html.indexOf(START_MARKER);
  if (start === -1) return null;
  const end = html.indexOf(END_MARKER, start);
  if (end === -1) return null;
  return { start, end: end + END_MARKER.length };
}

// Image priority: an explicit per-article override (`trackImg` — the
// same field name scripts/lib/articles.mjs's storyCardHTML() already
// reads, though nothing currently sets it, so this is also the first
// real writer of it) beats the TRACKS-lookup key, which beats the
// series logo. Never a guessed URL.
function heroImageFor(article, tracks) {
  return article.trackImg || (article.track && tracks[article.track]?.src) || article.chipLogo || '';
}

// An explicit article.trackCredit (settable via the site editor's image
// modal) always wins. Otherwise, every image currently used here is a
// real Wikimedia Commons upload (verified live before use, per this
// project's standing discipline — see feedback-apexwire-safety-
// discipline in memory), so hostname sniffing is a reasonable fallback
// rather than asserting a specific license variant per image, which
// isn't tracked per-entry in TRACKS/article data.
export function creditFor(article, trackSrc) {
  if (article?.trackCredit) return article.trackCredit;
  if (trackSrc && trackSrc.includes('wikimedia.org')) return 'Wikimedia Commons';
  return '';
}

function slideHTML(slug, article, trackSrc, active) {
  const credit = creditFor(article, trackSrc);
  return `  <section class="hero${active ? ' active' : ''}" data-slug="${slug}">
    <div>
      <div class="hero-tag">${article.category || 'Feature'}</div>
      <h1>${article.title}</h1>
      <p class="deck">${article.dek}</p>
      <div class="hero-meta">
        <span><b>${article.chipText}</b></span>
        <span>${article.date || ''}</span>
      </div>
    </div>
    <div class="hero-art">
      ${trackSrc ? `<img src="${trackSrc}" alt="${article.chipText} art">` : ''}
      ${credit ? `<span class="src">${credit}</span>` : ''}
    </div>
  </section>`;
}

// tracks: the parsed TRACKS object from index.html's own script (venue
// image lookup, keyed by each article's optional `track` field) — falls
// back to the article's chip logo, never a guessed URL.
export function renderCarousel(leadStories, articles, tracks) {
  const slides = leadStories
    .map((slug, i) => {
      const a = articles[slug];
      if (!a) return '';
      return slideHTML(slug, a, heroImageFor(a, tracks), i === 0);
    })
    .filter(Boolean);
  const dots = leadStories
    .map((_, i) => `<button class="hero-dot${i === 0 ? ' active' : ''}" data-index="${i}" aria-label="Story ${i + 1}"></button>`)
    .join('');
  return `${START_MARKER}\n<div class="hero-carousel">\n${slides.join('\n')}\n  <div class="hero-dots">${dots}</div>\n</div>\n${END_MARKER}`;
}

export function replaceCarousel(html, newCarouselHtml) {
  const loc = locateCarousel(html);
  if (!loc) return html; // structure not found — skip rather than corrupt the page
  return html.slice(0, loc.start) + newCarouselHtml + html.slice(loc.end);
}

// LEAD_STORIES itself is a plain `const LEAD_STORIES = [...]` array of
// slugs, read the same way any other named literal in this file is.
export function getLeadStories(html) {
  return parseNamedLiteral(html, 'LEAD_STORIES')?.value || [];
}
export function writeLeadStories(html, slugs) {
  const parsed = parseNamedLiteral(html, 'LEAD_STORIES');
  if (!parsed) throw new Error('Could not locate LEAD_STORIES.');
  const literal = '[' + slugs.map((s) => `'${String(s).replace(/'/g, "\\'")}'`).join(', ') + ']';
  return html.slice(0, parsed.openIdx) + literal + html.slice(parsed.closeIdx + 1);
}

// Moves (or inserts) a slug to the front, capped at maxSlides — newest
// story first, oldest dropped once the cap is exceeded.
export function pushLeadStory(currentSlugs, slug, maxSlides = 5) {
  return [slug, ...currentSlugs.filter((s) => s !== slug)].slice(0, maxSlides);
}

// One-call helper: given the current html, a newly-added/edited slug,
// and the full ARTICLES map, updates LEAD_STORIES and re-renders the
// carousel block in one step. Used by addArticle() so a fresh recap or
// prompted article automatically becomes the featured lead story.
export function addToLeadCarousel(html, slug, articles, maxSlides = 5) {
  if (!locateCarousel(html)) return html; // no carousel present — nothing to update
  const updated = pushLeadStory(getLeadStories(html), slug, maxSlides);
  html = writeLeadStories(html, updated);
  const tracks = parseNamedLiteral(html, 'TRACKS')?.value || {};
  return replaceCarousel(html, renderCarousel(updated, articles, tracks));
}
