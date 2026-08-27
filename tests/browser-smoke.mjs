import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const pages = process.argv.slice(2);
const browser = await chromium.launch();
let failures = 0;

for (const path of pages) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // Google Fonts is unreachable from this sandbox; the pages are designed to
  // fall back to system fonts, so that failure is expected here.
  const ignorable = t => /fonts\.(googleapis|gstatic)\.com/.test(t) ||
                         /ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(t);
  page.on('console', m => { if (m.type() === 'error' && !ignorable(m.text())) errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => { if (!ignorable(r.url())) errors.push('request failed: ' + r.url()); });
  // The API routes only exist on Netlify; stub them so the page logic still runs.
  await page.route('**/api/weather*', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, current: { temperature_2m: 31.4, weather_code: 2, relative_humidity_2m: 70, apparent_temperature: 35, wind_speed_10m: 12, is_day: 1 },
      daily: { time: ['2026-08-27','2026-08-28','2026-08-29','2026-08-30','2026-08-31','2026-09-01','2026-09-02'],
        weather_code: [2,3,61,80,0,1,2], temperature_2m_max: [34,33,29,28,31,32,33], temperature_2m_min: [26,25,24,23,24,25,26],
        precipitation_sum: [0,0.2,12,30,0,0,0], precipitation_probability_max: [10,20,80,90,5,5,10],
        wind_speed_10m_max: [18,20,35,44,15,14,16], uv_index_max: [9,8,5,4,10,10,9],
        sunrise: ['2026-08-27T05:10'], sunset: ['2026-08-27T18:12'] },
      hourly: { time: Array.from({length:24},(_,i)=>`2026-08-27T${String(i).padStart(2,'0')}:00`),
        temperature_2m: Array.from({length:24},(_,i)=>26+Math.round(8*Math.sin(i/24*Math.PI))),
        precipitation_probability: Array.from({length:24},(_,i)=>i*3%100), weather_code: Array(24).fill(2) },
      advisories: [{ key:'heat', severity:'high', value:34 }, { key:'uv', severity:'medium', value:9 }] })
  }));
  await page.route('**/api/news*', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, lang: 'en', sources: ['NHK World-Japan'], fetchedAt: new Date().toISOString(),
      items: [{ title: 'Test headline about Tokyo', link: 'https://example.com/1', summary: 'A summary.', publishedAt: new Date().toISOString(), source: 'NHK World-Japan' },
              { title: 'Second headline', link: 'https://example.com/2', summary: '', publishedAt: new Date(Date.now()-3600e3).toISOString(), source: 'NHK World-Japan' }] })
  }));
  await page.route('**/api/store*', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, database: false, authRequired: false, records: [] })
  }));

  const res = await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // Check each language renders without leaving raw i18n keys on screen.
  const langIssues = [];
  for (const lang of ['en', 'ja', 'es']) {
    await page.evaluate(l => window.I18N && window.I18N.set(l), lang);
    await page.waitForTimeout(250);
    const raw = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-i18n],[data-i18n-html]').forEach(el => {
        const t = (el.textContent || '').trim();
        if (/^[a-z]+\.[a-zA-Z0-9.]+$/.test(t)) out.push(t);
      });
      return out;
    });
    if (raw.length) langIssues.push(`${lang}: untranslated keys ${[...new Set(raw)].join(', ')}`);
  }
  await page.evaluate(() => window.I18N && window.I18N.set('en'));

  // Sanity: the shell actually painted.
  const shell = await page.evaluate(() => ({
    nav: document.querySelectorAll('.site-nav a').length,
    brand: !!document.querySelector('.brand'),
    footer: !!document.querySelector('.site-footer'),
    text: document.body.innerText.replace(/\s+/g, ' ').trim().length
  }));
  if (shell.nav !== 6) errors.push('nav links: ' + shell.nav + ' (expected 6)');
  if (!shell.brand) errors.push('no brand rendered');
  if (!shell.footer) errors.push('no footer rendered');
  if (shell.text < 120) errors.push('page text suspiciously short: ' + shell.text);

  const status = res ? res.status() : 0;
  const title = await page.title();
  const bad = errors.length || langIssues.length || status !== 200;
  if (bad) failures++;
  console.log(`${bad ? '✗' : '✓'} ${path}  [${status}] "${title}"`);
  errors.slice(0, 6).forEach(e => console.log('    ! ' + e.slice(0, 190)));
  langIssues.forEach(e => console.log('    ! ' + e.slice(0, 190)));
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} page(s) with problems` : '\nAll pages clean');
process.exit(failures ? 1 : 0);
