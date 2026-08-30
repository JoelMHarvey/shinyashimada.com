/* ==========================================================================
   /api/books — look a book up by ISBN, or search by title and author.

   GET /api/books?isbn=9780140449136
   GET /api/books?q=the odyssey homer
       -> { results: [ { title, authors, publisher, coverUrl, ... } ] }

   Two catalogues are asked at once and their answers folded together, so a
   title Open Library knows the cover for and Google knows the blurb for
   comes back complete. Both are free and need no key.

   Why a function rather than fetching from the page: neither catalogue sends
   CORS headers we can rely on, joelmharvey.com would be a third origin again,
   and going through here means one place to add a timeout and a cache.

   Environment:
     SITE_PASSCODE  when set, required — the same passcode the store uses.
                    Not because titles are secret, but so the endpoint is not
                    left as an open lookup proxy for anyone who finds it.
   ========================================================================== */

import { corsHeaders, preflight } from '../lib/cors.mjs';
import { secretsMatch } from '../lib/records.mjs';
import {
  cleanIsbn,
  isValidIsbn,
  fromOpenLibraryBooks,
  fromOpenLibrarySearch,
  fromGoogleBooks,
  mergeCandidates
} from '../lib/books.mjs';

const LOOKUP_TIMEOUT_MS = 6000;
const MAX_QUERY_LENGTH = 200;

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Catalogue answers barely change; a shared cache spares both APIs a
      // repeat when the other site looks up the same barcode.
      'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
      ...corsHeaders(req)
    }
  });
}

function isAuthed(req) {
  const expected = process.env.SITE_PASSCODE;
  if (!expected) return true;
  return secretsMatch(req.headers.get('x-store-passcode'), expected);
}

/** Fetch and parse JSON, returning null on any failure — one dead catalogue
    must not take the other down with it. */
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // Open Library asks that automated callers identify themselves.
        'User-Agent': 'shinyashimada.com library (+https://shinyashimada.com)'
      }
    });
    if (!res.ok) {
      console.warn('[books] %s returned %s', new URL(url).host, res.status);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[books] %s failed: %s', (() => { try { return new URL(url).host; } catch { return url; } })(), err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupByIsbn(isbn) {
  const bibkey = `ISBN:${isbn}`;
  const [ol, google] = await Promise.all([
    getJson(`https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(bibkey)}&format=json&jscmd=data`),
    getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent('isbn:' + isbn)}&maxResults=5`)
  ]);
  return mergeCandidates([fromOpenLibraryBooks(ol, isbn), fromGoogleBooks(google)]);
}

async function lookupByQuery(q) {
  const fields = [
    'title', 'subtitle', 'author_name', 'first_publish_year', 'publish_date',
    'publisher', 'isbn', 'language', 'subject', 'number_of_pages_median', 'cover_i'
  ].join(',');
  const [ol, google] = await Promise.all([
    getJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8&fields=${fields}`),
    getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`)
  ]);
  return mergeCandidates([fromOpenLibrarySearch(ol), fromGoogleBooks(google)]);
}

export default async function handler(req) {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed.', code: 'bad-method' }, 405, req);
  }
  if (!isAuthed(req)) {
    return json({ error: 'Passcode required.', code: 'unauthorized' }, 401, req);
  }

  const url = new URL(req.url);
  const rawIsbn = url.searchParams.get('isbn');
  const rawQuery = (url.searchParams.get('q') || '').trim();

  try {
    if (rawIsbn) {
      const isbn = cleanIsbn(rawIsbn);
      if (!isValidIsbn(isbn)) {
        return json(
          { error: 'That is not a valid ISBN — check the digits, or search by title instead.', code: 'bad-isbn' },
          400,
          req
        );
      }
      const results = await lookupByIsbn(isbn);
      return json({ results, query: { isbn } }, 200, req);
    }

    if (rawQuery) {
      if (rawQuery.length > MAX_QUERY_LENGTH) {
        return json({ error: 'That search is too long.', code: 'query-too-long' }, 400, req);
      }
      // A barcode pasted into the search box should still take the ISBN path.
      const results = isValidIsbn(rawQuery)
        ? await lookupByIsbn(cleanIsbn(rawQuery))
        : await lookupByQuery(rawQuery);
      return json({ results, query: { q: rawQuery } }, 200, req);
    }

    return json({ error: 'Pass either `isbn` or `q`.', code: 'no-query' }, 400, req);
  } catch (err) {
    console.error('[books] lookup failed', err);
    return json({ error: 'Could not reach the book catalogues.', code: 'lookup-failed' }, 502, req);
  }
}
