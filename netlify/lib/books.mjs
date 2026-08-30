/* ==========================================================================
   Book metadata: normalising what the catalogues give us.

   Two sources, because neither is complete on its own:
     · Open Library — good coverage of older and non-English editions,
       generous cover art, no key required.
     · Google Books — better on recent titles and descriptions.

   Everything here is pure: it takes a parsed payload and returns our shape.
   The network lives in netlify/functions/books.mjs, so these parsers can be
   tested against recorded responses with no connection at all.

   Our shape (every field optional except `title`):

     { source, title, subtitle, authors[], isbn10, isbn13, publisher,
       publishedYear, pages, language, subjects[], description, coverUrl }
   ========================================================================== */

/* ------------------------------------------------------------- ISBNs -- */

/** Strip formatting. ISBN-10 may end in X, so keep that. */
export function cleanIsbn(value) {
  return String(value ?? '').toUpperCase().replace(/[^0-9X]/g, '');
}

function isbn10Valid(s) {
  if (!/^[0-9]{9}[0-9X]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(s[i]);
  sum += s[9] === 'X' ? 10 : Number(s[9]);
  return sum % 11 === 0;
}

function isbn13Valid(s) {
  if (!/^[0-9]{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

/**
 * True for a well-formed ISBN-10 or ISBN-13, check digit included. Used to
 * decide whether a search box holds a barcode or a title, so a mistyped
 * number falls through to a title search instead of a dead-end lookup.
 */
export function isValidIsbn(value) {
  const s = cleanIsbn(value);
  return isbn10Valid(s) || isbn13Valid(s);
}

/** Widen a valid ISBN-10 to its ISBN-13 form; pass 13s through unchanged. */
export function toIsbn13(value) {
  const s = cleanIsbn(value);
  if (isbn13Valid(s)) return s;
  if (!isbn10Valid(s)) return null;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

/* ------------------------------------------------------------ tidying -- */

const YEAR_RE = /(1[0-9]{3}|20[0-9]{2})/;

/** First plausible four-digit year in a date string of any format. */
export function yearFrom(value) {
  const m = YEAR_RE.exec(String(value ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Catalogue descriptions arrive with HTML (Google), bracketed source notes
 * and trailing boilerplate (Open Library). Strip tags, decode the handful of
 * entities that survive, collapse whitespace, and cut the "([source][1])"
 * citations Open Library appends.
 */
export function cleanText(value, limit = 1200) {
  let s = typeof value === 'string' ? value : (value && value.value) || '';
  if (!s) return '';
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  s = s.replace(/\(\[[^\]]*\]\[\d+\]\)/g, '');       // ([Source][1])
  s = s.replace(/^\s*-{3,}\s*$/gm, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > limit) s = s.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

function uniqueStrings(list, limit) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** Drop empty strings, empty arrays and nulls so merging stays simple. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------- Open Library -- */

/**
 * The `jscmd=data` shape of https://openlibrary.org/api/books, which returns
 * an object keyed by the bibkey we asked for ("ISBN:9780140449136").
 */
export function fromOpenLibraryBooks(payload, askedIsbn) {
  if (!payload || typeof payload !== 'object') return [];
  return Object.values(payload)
    .filter((v) => v && typeof v === 'object' && v.title)
    .map((v) => {
      const ids = v.identifiers || {};
      const isbn13 = (ids.isbn_13 || [])[0] || toIsbn13(askedIsbn) || null;
      const isbn10 = (ids.isbn_10 || [])[0] || null;
      return compact({
        source: 'openlibrary',
        title: String(v.title).trim(),
        subtitle: v.subtitle ? String(v.subtitle).trim() : '',
        authors: uniqueStrings((v.authors || []).map((a) => a && a.name), 8),
        isbn13: isbn13 ? cleanIsbn(isbn13) : null,
        isbn10: isbn10 ? cleanIsbn(isbn10) : null,
        publisher: uniqueStrings((v.publishers || []).map((p) => p && p.name), 1)[0] || '',
        publishedYear: yearFrom(v.publish_date),
        pages: Number.isFinite(v.number_of_pages) ? v.number_of_pages : null,
        subjects: uniqueStrings((v.subjects || []).map((s) => s && s.name), 8),
        description: cleanText(v.description || v.notes),
        coverUrl: (v.cover && (v.cover.medium || v.cover.large || v.cover.small)) || null
      });
    });
}

/** The `docs` array of https://openlibrary.org/search.json. */
export function fromOpenLibrarySearch(payload) {
  const docs = (payload && payload.docs) || [];
  return docs
    .filter((d) => d && d.title)
    .map((d) => {
      const isbn = uniqueStrings(d.isbn || [], 40);
      const isbn13 = isbn.find((i) => cleanIsbn(i).length === 13) || null;
      const isbn10 = isbn.find((i) => cleanIsbn(i).length === 10) || null;
      return compact({
        source: 'openlibrary',
        title: String(d.title).trim(),
        subtitle: d.subtitle ? String(d.subtitle).trim() : '',
        authors: uniqueStrings(d.author_name || [], 8),
        isbn13: isbn13 ? cleanIsbn(isbn13) : null,
        isbn10: isbn10 ? cleanIsbn(isbn10) : null,
        publisher: uniqueStrings(d.publisher || [], 1)[0] || '',
        publishedYear: Number.isFinite(d.first_publish_year)
          ? d.first_publish_year
          : yearFrom((d.publish_date || [])[0]),
        pages: Number.isFinite(d.number_of_pages_median) ? d.number_of_pages_median : null,
        language: (d.language || [])[0] || '',
        subjects: uniqueStrings(d.subject || [], 8),
        coverUrl: d.cover_i
          ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
          : (isbn13 || isbn10)
            ? `https://covers.openlibrary.org/b/isbn/${cleanIsbn(isbn13 || isbn10)}-M.jpg`
            : null
      });
    });
}

/* ------------------------------------------------------- Google Books -- */

/** The `items` array of https://www.googleapis.com/books/v1/volumes. */
export function fromGoogleBooks(payload) {
  const items = (payload && payload.items) || [];
  return items
    .map((item) => item && item.volumeInfo)
    .filter((v) => v && v.title)
    .map((v) => {
      const ids = v.industryIdentifiers || [];
      const pick = (type) => {
        const hit = ids.find((i) => i && i.type === type && i.identifier);
        return hit ? cleanIsbn(hit.identifier) : null;
      };
      // Google serves thumbnails over http in some regions and adds a page
      // curl; https and zoom=1 give a clean image the page can show directly.
      let cover = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || null;
      if (cover) cover = cover.replace(/^http:/, 'https:').replace(/&edge=curl/g, '');
      return compact({
        source: 'google',
        title: String(v.title).trim(),
        subtitle: v.subtitle ? String(v.subtitle).trim() : '',
        authors: uniqueStrings(v.authors || [], 8),
        isbn13: pick('ISBN_13'),
        isbn10: pick('ISBN_10'),
        publisher: v.publisher ? String(v.publisher).trim() : '',
        publishedYear: yearFrom(v.publishedDate),
        pages: Number.isFinite(v.pageCount) ? v.pageCount : null,
        language: v.language ? String(v.language).trim() : '',
        subjects: uniqueStrings(v.categories || [], 8),
        description: cleanText(v.description),
        coverUrl: cover
      });
    });
}

/* ------------------------------------------------------------- merge -- */

/** Two candidates describe the same book when an ISBN matches, else title+author. */
function sameBook(a, b) {
  if (a.isbn13 && b.isbn13) return a.isbn13 === b.isbn13;
  if (a.isbn10 && b.isbn10) return a.isbn10 === b.isbn10;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (norm(a.title) !== norm(b.title)) return false;
  const aa = norm((a.authors || [])[0]);
  const bb = norm((b.authors || [])[0]);
  return !aa || !bb || aa === bb;
}

/**
 * Fold duplicates together, filling gaps rather than overwriting: the first
 * candidate to supply a field keeps it. Callers pass sources in order of
 * preference, so a richer description from Google can complete an Open
 * Library record without replacing its cover.
 */
export function mergeCandidates(lists, limit = 8) {
  const merged = [];
  for (const candidate of [].concat(...lists.filter(Boolean))) {
    if (!candidate || !candidate.title) continue;
    const hit = merged.find((m) => sameBook(m, candidate));
    if (!hit) {
      merged.push({ ...candidate, sources: [candidate.source].filter(Boolean) });
      continue;
    }
    for (const [k, v] of Object.entries(candidate)) {
      if (k === 'source') continue;
      const have = hit[k];
      const missing =
        have === undefined || have === null || have === '' ||
        (Array.isArray(have) && have.length === 0);
      if (missing) hit[k] = v;
    }
    if (candidate.source && !hit.sources.includes(candidate.source)) {
      hit.sources.push(candidate.source);
    }
  }
  return merged.slice(0, limit);
}
