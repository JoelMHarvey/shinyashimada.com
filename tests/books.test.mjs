/* Book metadata parsing and the cross-origin allowlist.
 *
 * The catalogues themselves are never called here: the fixtures below are the
 * shapes Open Library and Google Books document, so the normalisers can be
 * exercised offline and a change in our parsing is caught without a network. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const B = await import(join(HERE, '../netlify/lib/books.mjs'));
const C = await import(join(HERE, '../netlify/lib/cors.mjs'));

let pass = 0; const fails = [];
const check = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A}`);
};

/* ------------------------------------------------------------- ISBNs -- */

check('accepts a valid ISBN-13', B.isValidIsbn('978-0-14-044913-6'), true);
check('accepts a valid ISBN-10', B.isValidIsbn('0140449132'), true);
check('accepts an X check digit', B.isValidIsbn('080442957X'), true);
check('rejects a wrong check digit', B.isValidIsbn('9780140449137'), false);
check('rejects a short number', B.isValidIsbn('12345'), false);
check('rejects a title', B.isValidIsbn('The Odyssey'), false);
check('strips punctuation', B.cleanIsbn('978-0-14-044913-6'), '9780140449136');
check('widens a 10 to a 13', B.toIsbn13('0140449132'), '9780140449136');
check('leaves a 13 alone', B.toIsbn13('9780140449136'), '9780140449136');
check('refuses to widen rubbish', B.toIsbn13('nonsense'), null);

/* ------------------------------------------------------------ tidying -- */

check('finds a year in a messy date', B.yearFrom('March 15, 1996'), 1996);
check('finds a year in an ISO date', B.yearFrom('2011-04-01'), 2011);
check('returns null with no year', B.yearFrom('undated'), null);
check('strips HTML from a description', B.cleanText('<p>A <b>fine</b> book.</p>'), 'A fine book.');
check('decodes entities', B.cleanText('Salt &amp; Pepper &quot;quoted&quot;'), 'Salt & Pepper "quoted"');
check(
  'drops Open Library source citations',
  B.cleanText('A classic tale. ([source][1])'),
  'A classic tale.'
);
check(
  'truncates on a word boundary',
  B.cleanText('aaa bbb ccc ddd eee', 12),
  'aaa bbb…'
);
check('handles a description object', B.cleanText({ value: 'Nested value.' }), 'Nested value.');

/* ------------------------------------------------------- Open Library -- */

const OL_BOOKS = {
  'ISBN:9780140449136': {
    title: 'The Odyssey',
    subtitle: 'A New Translation',
    authors: [{ name: 'Homer' }, { name: 'Homer' }],
    publishers: [{ name: 'Penguin Classics' }],
    publish_date: 'November 30, 2006',
    number_of_pages: 541,
    subjects: [{ name: 'Epic poetry' }, { name: 'Odysseus' }],
    identifiers: { isbn_13: ['9780140449136'], isbn_10: ['0140449132'] },
    cover: { small: 'https://covers.openlibrary.org/b/id/1-S.jpg', medium: 'https://covers.openlibrary.org/b/id/1-M.jpg' }
  }
};

{
  const [r] = B.fromOpenLibraryBooks(OL_BOOKS, '9780140449136');
  check('OL: title', r.title, 'The Odyssey');
  check('OL: subtitle', r.subtitle, 'A New Translation');
  check('OL: de-duplicates authors', r.authors, ['Homer']);
  check('OL: publisher', r.publisher, 'Penguin Classics');
  check('OL: year from prose date', r.publishedYear, 2006);
  check('OL: pages', r.pages, 541);
  check('OL: subjects flattened', r.subjects, ['Epic poetry', 'Odysseus']);
  check('OL: isbn13', r.isbn13, '9780140449136');
  check('OL: prefers the medium cover', r.coverUrl, 'https://covers.openlibrary.org/b/id/1-M.jpg');
  check('OL: no empty description key', 'description' in r, false);
}

{
  const empty = B.fromOpenLibraryBooks({}, '9780140449136');
  check('OL: an unknown ISBN yields nothing', empty, []);
  check('OL: a null payload yields nothing', B.fromOpenLibraryBooks(null, 'x'), []);
}

const OL_SEARCH = {
  docs: [
    {
      title: 'Norwegian Wood',
      author_name: ['Haruki Murakami'],
      first_publish_year: 1987,
      publisher: ['Kodansha'],
      isbn: ['0375704027', '9780375704024'],
      language: ['eng'],
      subject: ['Fiction', 'Japan'],
      number_of_pages_median: 296,
      cover_i: 8231856
    },
    { author_name: ['No Title Here'] }
  ]
};

{
  const rows = B.fromOpenLibrarySearch(OL_SEARCH);
  check('OL search: drops entries with no title', rows.length, 1);
  check('OL search: first publish year', rows[0].publishedYear, 1987);
  check('OL search: picks the 13-digit ISBN', rows[0].isbn13, '9780375704024');
  check('OL search: keeps the 10 too', rows[0].isbn10, '0375704027');
  check('OL search: cover from cover_i', rows[0].coverUrl, 'https://covers.openlibrary.org/b/id/8231856-M.jpg');
}

/* ------------------------------------------------------- Google Books -- */

const GOOGLE = {
  items: [
    {
      volumeInfo: {
        title: 'Norwegian Wood',
        authors: ['Haruki Murakami'],
        publisher: 'Vintage',
        publishedDate: '2000-05-02',
        description: '<p>Toru recalls his student days.</p>',
        pageCount: 296,
        categories: ['Fiction / Literary'],
        language: 'en',
        industryIdentifiers: [
          { type: 'ISBN_10', identifier: '0375704027' },
          { type: 'ISBN_13', identifier: '9780375704024' }
        ],
        imageLinks: { thumbnail: 'http://books.google.com/books?id=x&printsec=frontcover&edge=curl' }
      }
    },
    { volumeInfo: { authors: ['Untitled'] } }
  ]
};

{
  const rows = B.fromGoogleBooks(GOOGLE);
  check('Google: drops entries with no title', rows.length, 1);
  check('Google: description is de-HTMLed', rows[0].description, 'Toru recalls his student days.');
  check('Google: year from an ISO date', rows[0].publishedYear, 2000);
  check('Google: isbn13', rows[0].isbn13, '9780375704024');
  check('Google: thumbnail upgraded to https', /^https:/.test(rows[0].coverUrl), true);
  check('Google: page curl removed', /edge=curl/.test(rows[0].coverUrl), false);
}

/* ------------------------------------------------------------- merge -- */

{
  const merged = B.mergeCandidates([B.fromOpenLibrarySearch(OL_SEARCH), B.fromGoogleBooks(GOOGLE)]);
  check('merge: one book, not two', merged.length, 1);
  check('merge: records both sources', merged[0].sources, ['openlibrary', 'google']);
  check('merge: keeps the first cover', merged[0].coverUrl, 'https://covers.openlibrary.org/b/id/8231856-M.jpg');
  check('merge: fills the missing description from Google', merged[0].description, 'Toru recalls his student days.');
  check('merge: keeps the first publisher', merged[0].publisher, 'Kodansha');
  check("merge: keeps the first source's year", merged[0].publishedYear, 1987);
}

{
  // Same title, genuinely different books — different ISBNs must not fold.
  const a = { source: 'openlibrary', title: 'Ulysses', authors: ['James Joyce'], isbn13: '9780199535675' };
  const b = { source: 'google', title: 'Ulysses', authors: ['James Joyce'], isbn13: '9781840226355' };
  check('merge: different ISBNs stay apart', B.mergeCandidates([[a], [b]]).length, 2);
}

{
  const a = { source: 'openlibrary', title: 'The Wind-Up Bird Chronicle', authors: ['Haruki Murakami'] };
  const b = { source: 'google', title: 'the wind up bird chronicle', authors: ['Haruki Murakami'], pages: 607 };
  const m = B.mergeCandidates([[a], [b]]);
  check('merge: matches on title when no ISBN', m.length, 1);
  check('merge: takes the page count from the second', m[0].pages, 607);
}

check('merge: caps the result list', B.mergeCandidates([
  Array.from({ length: 20 }, (_, i) => ({ source: 'google', title: 'Book ' + i }))
]).length, 8);

/* -------------------------------------------------------------- CORS -- */

const withOrigin = (origin) => new Request('https://x/api/books', { headers: origin ? { origin } : {} });
const env = {};

check('allows joelmharvey.com', C.originAllowed('https://joelmharvey.com', env), 'https://joelmharvey.com');
check('allows the www form', C.originAllowed('https://www.joelmharvey.com', env), 'https://www.joelmharvey.com');
check('allows this site', C.originAllowed('https://shinyashimada.com', env), 'https://shinyashimada.com');
check('allows localhost for dev', C.originAllowed('http://localhost:8888', env), 'http://localhost:8888');
check('refuses a stranger', C.originAllowed('https://evil.example', env), null);
check('refuses a lookalike', C.originAllowed('https://joelmharvey.com.evil.example', env), null);
check('refuses plain http on the real domain', C.originAllowed('http://joelmharvey.com', env), null);
check('ignores a trailing slash', C.originAllowed('https://joelmharvey.com/', env), 'https://joelmharvey.com');
check('no origin, no grant', C.originAllowed(undefined, env), null);

check(
  'ALLOWED_ORIGINS replaces the defaults',
  C.originAllowed('https://joelmharvey.com', { ALLOWED_ORIGINS: 'https://elsewhere.example' }),
  null
);
check(
  'ALLOWED_ORIGINS grants what it lists',
  C.originAllowed('https://elsewhere.example', { ALLOWED_ORIGINS: 'https://elsewhere.example' }),
  'https://elsewhere.example'
);

{
  const h = C.corsHeaders(withOrigin('https://joelmharvey.com'), env);
  check('grants the passcode header', h['Access-Control-Allow-Headers'], 'Content-Type, X-Store-Passcode');
  check('always varies on Origin', h.Vary, 'Origin');

  const denied = C.corsHeaders(withOrigin('https://evil.example'), env);
  check('a refused origin gets no allowance', denied['Access-Control-Allow-Origin'], undefined);
  check('but still varies on Origin', denied.Vary, 'Origin');
}

{
  const req = new Request('https://x/api/store', { method: 'OPTIONS', headers: { origin: 'https://joelmharvey.com' } });
  const res = C.preflight(req, env);
  check('preflight is answered', res.status, 204);
  check('preflight carries the allowance', res.headers.get('access-control-allow-origin'), 'https://joelmharvey.com');
  check('a GET is not a preflight', C.preflight(withOrigin('https://joelmharvey.com'), env), null);
}

/* --------------------------------------------------- the function itself -- */

const { default: handler } = await import(join(HERE, '../netlify/functions/books.mjs'));
delete process.env.SITE_PASSCODE;

{
  const res = await handler(new Request('https://x/api/books', { method: 'OPTIONS', headers: { origin: 'https://joelmharvey.com' } }));
  check('function answers preflight', res.status, 204);
}
{
  const res = await handler(new Request('https://x/api/books'));
  check('asks for a query', [res.status, (await res.json()).code], [400, 'no-query']);
}
{
  const res = await handler(new Request('https://x/api/books?isbn=9780140449137'));
  check('rejects a bad check digit', [res.status, (await res.json()).code], [400, 'bad-isbn']);
}
{
  const res = await handler(new Request('https://x/api/books?q=' + 'a'.repeat(201)));
  check('rejects an overlong search', [res.status, (await res.json()).code], [400, 'query-too-long']);
}
{
  const res = await handler(new Request('https://x/api/books?isbn=9780140449136', { method: 'POST' }));
  check('rejects a POST', [res.status, (await res.json()).code], [405, 'bad-method']);
}
process.env.SITE_PASSCODE = 'secret';
{
  const res = await handler(new Request('https://x/api/books?isbn=9780140449136'));
  check('requires the passcode when one is set', [res.status, (await res.json()).code], [401, 'unauthorized']);
}
{
  const res = await handler(new Request('https://x/api/books', {
    method: 'OPTIONS',
    headers: { origin: 'https://joelmharvey.com' }
  }));
  check('preflight is not blocked by the passcode', res.status, 204);
}
delete process.env.SITE_PASSCODE;

/* -------------------------------------------------------------------- */

console.log(`\nbooks: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
