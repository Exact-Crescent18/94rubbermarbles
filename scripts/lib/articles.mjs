// Shared helpers for inserting new ARTICLES entries and their "On the
// Wire" story cards into index.html. Used by both the post-event
// auto-recap flow and the issue-triggered prompted-article flow.
//
// Parses ARTICLES the same safe way update-results.mjs parses
// CAL_EVENTS: evaluate the object literal as real JS (trusted,
// self-authored content), mutate in memory, re-serialize deterministically.

const ARTICLES_START = 'const ARTICLES = {';
const ARTICLES_CLOSE = '\n};\n\nfunction renderArticle(slug){';

function dq(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function sq(s) {
  return `'${String(s).replace(/'/g, "\\'")}'`;
}

function locate(html) {
  const start = html.indexOf(ARTICLES_START);
  const end = html.indexOf(ARTICLES_CLOSE, start);
  if (start === -1 || end === -1) throw new Error('Could not locate ARTICLES block.');
  return { start, end };
}

export function parseArticles(html) {
  const { start, end } = locate(html);
  const literal = html.slice(start + 'const ARTICLES = '.length, end + 2);
  const articles = new Function(`return ${literal}`)();
  return articles;
}

function serializeOne(slug, a) {
  const bodyLines = a.body.map((p) => `      ${dq(p)},`).join('\n');
  const publishLine = a.publishAt ? `\n    publishAt:${sq(a.publishAt)},` : '';
  return `  ${sq(slug)}: {
    view:${sq(a.view)}, chip:${sq(a.chip)}, chipLogo:${sq(a.chipLogo)}, chipText:${sq(a.chipText)},
    title:${dq(a.title)}, category:${sq(a.category)}, readTime:${sq(a.readTime)}, date:${sq(a.date)},
    track:${sq(a.track || '')},
    dek:${dq(a.dek)},${publishLine}
    body:[
${bodyLines}
    ],
  }`;
}

export function writeArticles(html, articles) {
  const { start, end } = locate(html);
  const entries = Object.entries(articles).map(([slug, a]) => serializeOne(slug, a));
  const newLiteral = `{\n${entries.join(',\n')},\n}`;
  return html.slice(0, start) + 'const ARTICLES = ' + newLiteral + html.slice(end + 2);
}

function storyCardHTML(slug, a) {
  return `    <a class="story" href="#article:${slug}" data-view="article">
      <div class="art"><img class="diagram" src="${a.trackImg || a.chipLogo}" alt="${a.trackAlt || a.chipText + ' art'}"></div>
      <div class="story-body">
        <span class="chip ${a.chip}"><img class="chip-logo" src="${a.chipLogo}" alt="${a.chipText} logo">${a.chipText}</span>
        <h4>${a.title}</h4>
        <p>${a.dek}</p>
        <div class="meta"><span>${a.category}</span><span>${a.readTime.replace(' read', '')}</span></div>
      </div>
    </a>
`;
}

// Inserts a story card at the top of the given series view's own
// "On the Wire" (S5) grid. Best-effort: logs and returns html unchanged
// if that section can't be found, rather than failing the whole run.
export function insertStoryCard(html, slug, a) {
  const viewMarker = `id="view-${a.view}"`;
  const viewIdx = html.indexOf(viewMarker);
  if (viewIdx === -1) {
    console.log(`Could not find view section for "${a.view}", skipping story card placement.`);
    return html;
  }
  const wireIdx = html.indexOf('On the Wire</span><span class="line"></span></div>', viewIdx);
  if (wireIdx === -1) {
    console.log(`Could not find "On the Wire" section for "${a.view}", skipping story card placement.`);
    return html;
  }
  const gridOpen = html.indexOf('<section class="news-grid flat"', wireIdx);
  if (gridOpen === -1) {
    console.log(`Could not find wire grid markup for "${a.view}", skipping story card placement.`);
    return html;
  }
  const insertAt = html.indexOf('>', gridOpen) + 1;
  return html.slice(0, insertAt) + '\n' + storyCardHTML(slug, a) + html.slice(insertAt);
}

// Adds one new article. If `article.publishAt` is set and in the future,
// only the data record is written (no story card yet — it appears when
// publishDueArticles() later flips it). Otherwise it's published now.
export function addArticle(html, slug, article) {
  const articles = parseArticles(html);
  articles[slug] = article;
  html = writeArticles(html, articles);
  if (!article.publishAt || new Date(article.publishAt).getTime() <= Date.now()) {
    delete articles[slug].publishAt;
    html = writeArticles(html, articles);
    html = insertStoryCard(html, slug, article);
  }
  return html;
}

// Scans ARTICLES for entries with a `publishAt` timestamp that has now
// passed, strips the field, and places their story card.
export function publishDueArticles(html) {
  const articles = parseArticles(html);
  const now = Date.now();
  const due = Object.entries(articles).filter(
    ([, a]) => a.publishAt && new Date(a.publishAt).getTime() <= now
  );
  if (due.length === 0) return { html, publishedSlugs: [] };

  for (const [, a] of due) delete a.publishAt;
  html = writeArticles(html, articles);
  for (const [slug, a] of due) {
    html = insertStoryCard(html, slug, a);
  }
  return { html, publishedSlugs: due.map(([slug]) => slug) };
}
