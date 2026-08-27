/* ==========================================================================
   /api/news — Tokyo / Japan headlines in English, Japanese or Spanish.

   Public RSS feeds are fetched in parallel, parsed with a small tolerant
   reader (RSS 2.0, RSS 1.0/RDF and Atom all use the same shapes), then
   deduped and merged newest-first. A feed that fails is skipped rather than
   failing the request, so one dead source never blanks the page.

   Query: ?lang=en|ja|es
   ========================================================================== */

const FEEDS = {
  en: [
    { name: 'NHK World-Japan', url: 'https://www3.nhk.or.jp/nhkworld/en/news/feeds/rss.xml' },
    { name: 'The Japan Times', url: 'https://www.japantimes.co.jp/feed/' },
    { name: 'Kyodo News',      url: 'https://english.kyodonews.net/rss/news.xml' }
  ],
  ja: [
    { name: 'NHK ニュース',    url: 'https://www.nhk.or.jp/rss/news/cat0.xml' },
    { name: 'NHK 社会',        url: 'https://www.nhk.or.jp/rss/news/cat1.xml' },
    { name: '朝日新聞',        url: 'https://www.asahi.com/rss/asahi/newsheadlines.rdf' }
  ],
  es: [
    { name: 'NHK World-Japan', url: 'https://www3.nhk.or.jp/nhkworld/es/news/feeds/rss.xml' }
  ]
};

const PER_FEED = 10;
const TOTAL = 24;
const CACHE_MS = 10 * 60 * 1000;
const FEED_TIMEOUT_MS = 7000;

const memo = new Map();

/* ------------------------------------------------------------- parsing -- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”'
};

function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Feed text arrives in three overlapping disguises: wrapped in CDATA, with
 * real markup, and with markup *escaped* into entities (very common in
 * <description>). Decoding before stripping — and once more afterwards —
 * unwraps all three, and also resolves the double-encoded titles some
 * publishers emit (`&amp;amp;` -> `&`).
 */
function clean(raw) {
  if (!raw) return '';
  let out = String(raw);
  out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');   // unwrap CDATA
  out = decodeEntities(out);                                 // reveal escaped markup
  out = out.replace(/<[^>]+>/g, ' ');                        // drop all markup
  out = decodeEntities(out);                                 // resolve what it hid
  out = out.replace(/<[^>]+>/g, ' ');                        // and anything that exposed
  return out.replace(/\s+/g, ' ').trim();
}

function tagContent(block, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function itemLink(block) {
  // Atom: <link rel="alternate" href="…"/> — prefer alternate, accept any href.
  const atomAlt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (atomAlt) return decodeEntities(atomAlt[1]).trim();

  const rss = clean(tagContent(block, 'link'));
  if (rss) return rss;

  const guid = block.match(/<guid[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i);
  return guid ? clean(guid[1]) : '';
}

function itemDate(block) {
  const raw = tagContent(block, 'pubDate')
    || tagContent(block, 'updated')
    || tagContent(block, 'published')
    || tagContent(block, 'dc:date')
    || tagContent(block, 'date');
  const text = clean(raw);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function parseFeed(xml, sourceName) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const items = [];

  for (const block of blocks) {
    const title = clean(tagContent(block, 'title'));
    const link = itemLink(block);
    if (!title || !link) continue;

    let summary = clean(
      tagContent(block, 'description') ||
      tagContent(block, 'summary') ||
      tagContent(block, 'content:encoded')
    );
    if (summary.length > 260) summary = summary.slice(0, 257).trimEnd() + '…';
    if (summary === title) summary = '';

    items.push({
      title,
      link,
      summary,
      publishedAt: itemDate(block),
      source: sourceName
    });

    if (items.length >= PER_FEED) break;
  }
  return items;
}

/* ------------------------------------------------------------ fetching -- */

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        // Some publishers reject requests without a plausible agent.
        'User-Agent': 'Mozilla/5.0 (compatible; shinyashimada.com/1.0; +https://shinyashimada.com)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`${feed.name} responded ${res.status}`);
    return parseFeed(await res.text(), feed.name);
  } catch (err) {
    console.error('[news] feed failed:', feed.name, err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function normaliseTitle(t) {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function merge(groups) {
  const seenLink = new Set();
  const seenTitle = new Set();
  const out = [];

  for (const item of groups.flat()) {
    const linkKey = item.link.replace(/[?#].*$/, '');
    const titleKey = normaliseTitle(item.title);
    if (seenLink.has(linkKey) || (titleKey && seenTitle.has(titleKey))) continue;
    seenLink.add(linkKey);
    if (titleKey) seenTitle.add(titleKey);
    out.push(item);
  }

  out.sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
    if (a.publishedAt) return -1;
    if (b.publishedAt) return 1;
    return 0;
  });

  return out.slice(0, TOTAL);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200
        ? 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600'
        : 'no-store'
    }
  });
}

export default async function handler(req) {
  const url = new URL(req.url);
  const requested = (url.searchParams.get('lang') || 'en').toLowerCase();
  const lang = FEEDS[requested] ? requested : 'en';

  const hit = memo.get(lang);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return json({ ...hit.body, cached: true });
  }

  const results = await Promise.all(FEEDS[lang].map(fetchFeed));
  let items = merge(results);
  let fallbackFrom = null;

  // Spanish coverage of Japan is thin; rather than show an empty page, fall
  // back to the English wire and tell the client what happened.
  if (!items.length && lang !== 'en') {
    const enResults = await Promise.all(FEEDS.en.map(fetchFeed));
    items = merge(enResults);
    if (items.length) fallbackFrom = 'en';
  }

  if (!items.length) {
    if (hit) return json({ ...hit.body, cached: true, stale: true });
    return json({ ok: false, error: 'No headlines available right now.', code: 'no-items' }, 502);
  }

  const body = {
    ok: true,
    lang,
    fallbackFrom,
    fetchedAt: new Date().toISOString(),
    sources: (fallbackFrom ? FEEDS.en : FEEDS[lang]).map((f) => f.name),
    items
  };

  memo.set(lang, { at: Date.now(), body });
  return json(body);
}
