import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>NHK</title>
<item>
  <title><![CDATA[Tokyo hits 35C as heat &amp; humidity persist]]></title>
  <link>https://example.com/a?utm_source=rss</link>
  <description><![CDATA[<p>The capital saw its <b>hottest</b> day&hellip;</p>]]></description>
  <pubDate>Wed, 26 Aug 2026 04:15:00 +0900</pubDate>
</item>
<item>
  <title>Second story</title>
  <link>https://example.com/b</link>
  <guid isPermaLink="false">xyz</guid>
  <pubDate>Tue, 25 Aug 2026 22:00:00 +0900</pubDate>
</item>
</channel></rss>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
<item rdf:about="https://asahi.com/x">
  <title>朝日のニュース &#12300;見出し&#12301;</title>
  <link>https://asahi.com/x</link>
  <dc:date>2026-08-26T09:30:00+09:00</dc:date>
</item>
</rdf:RDF>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title type="html">Atom &amp;amp; entry</title>
  <link rel="edit" href="https://example.org/edit/1"/>
  <link rel="alternate" type="text/html" href="https://example.org/story-1"/>
  <updated>2026-08-27T01:00:00Z</updated>
  <summary>A summary with &lt;em&gt;markup&lt;/em&gt; inside.</summary>
</entry>
</feed>`;

// Duplicate of story A under a different source, to prove dedupe works.
const DUPE = `<rss><channel><item>
  <title>Tokyo hits 35C as heat &amp; humidity persist</title>
  <link>https://other.com/dup</link>
  <pubDate>Wed, 26 Aug 2026 05:00:00 +0900</pubDate>
</item></channel></rss>`;

const responses = {
  'https://www3.nhk.or.jp/nhkworld/en/news/feeds/rss.xml': RSS2,
  'https://www.japantimes.co.jp/feed/': ATOM,
  'https://english.kyodonews.net/rss/news.xml': DUPE,
  'https://www.nhk.or.jp/rss/news/cat0.xml': RDF,
  'https://www.nhk.or.jp/rss/news/cat1.xml': '<rss><channel></channel></rss>',
  'https://www.asahi.com/rss/asahi/newsheadlines.rdf': RDF,
  'https://www3.nhk.or.jp/nhkworld/es/news/feeds/rss.xml': 'BROKEN'
};

globalThis.fetch = async (url) => {
  const body = responses[url];
  if (body === undefined) return { ok: false, status: 404, text: async () => '' };
  if (body === 'BROKEN') throw new Error('connection reset');
  return { ok: true, status: 200, text: async () => body };
};

const HERE2 = dirname(fileURLToPath(import.meta.url));
const { default: handler } = await import(join(HERE2, '../netlify/functions/news.mjs'));

async function run(lang) {
  const res = await handler(new Request(`https://x/api/news?lang=${lang}`));
  return JSON.parse(await res.text());
}

const en = await run('en');
console.log('--- EN ---');
console.log('items:', en.items.length, '| sources:', en.sources.join(', '));
en.items.forEach(i => console.log(`  [${i.source}] ${i.title}\n     ${i.link}\n     ${i.publishedAt} | ${i.summary || '(no summary)'}`));

const ja = await run('ja');
console.log('--- JA ---');
ja.items.forEach(i => console.log(`  ${i.title} | ${i.publishedAt}`));

const es = await run('es');
console.log('--- ES (broken feed -> should fall back to EN) ---');
console.log('fallbackFrom:', es.fallbackFrom, '| items:', es.items.length);

// Assertions
const fail = [];
if (en.items.length !== 3) fail.push(`EN expected 3 deduped items, got ${en.items.length}`);
if (en.items[0].title !== 'Atom & entry') fail.push('EN not sorted newest-first');
if (!en.items.some(i => i.title === 'Tokyo hits 35C as heat & humidity persist')) fail.push('entity decode failed');
if (en.items.some(i => i.summary.includes('<'))) fail.push('HTML not stripped from summary');
if (en.items.some(i => i.link === 'https://other.com/dup')) fail.push('dedupe by normalised title failed');
if (en.items[0].summary.includes('markup') === false) fail.push('escaped-HTML summary lost its text');
if (ja.items.length !== 1) fail.push(`JA expected 1 deduped item, got ${ja.items.length}`);
if (!ja.items[0].title.includes('「見出し」')) fail.push('numeric entity decode failed: ' + ja.items[0].title);
if (es.fallbackFrom !== 'en') fail.push('ES fallback did not trigger');

console.log(fail.length ? '\nFAILURES:\n' + fail.map(f => ' ✗ ' + f).join('\n') : '\n✓ all parser assertions passed');
process.exit(fail.length ? 1 : 0);
