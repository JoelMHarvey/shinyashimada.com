/* ==========================================================================
   /api/weather — Tokyo forecast from Open-Meteo (free, no API key).

   Returns current conditions, the next 24 hours and a 7-day outlook, plus a
   short list of balcony-plant advisories derived from the forecast (frost,
   heat, wind, heavy rain, strong UV, dry spell).

   Query: ?lat=&lon=  (defaults to central Tokyo)
   ========================================================================== */

const DEFAULT_LAT = 35.6762;
const DEFAULT_LON = 139.6503;
const UPSTREAM = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MS = 10 * 60 * 1000;

/** Per-container memo so repeated hits inside 10 minutes cost nothing. */
const memo = new Map();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200
        ? 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800'
        : 'no-store',
      ...headers
    }
  });
}

/**
 * Balcony advisories. Thresholds are tuned for container plants on an exposed
 * Tokyo balcony, where pots swing far hotter and colder than the ground does.
 */
function buildAdvisories(current, daily) {
  const out = [];
  const minToday = daily?.temperature_2m_min?.[0];
  const maxToday = daily?.temperature_2m_max?.[0];
  const windMax = daily?.wind_speed_10m_max?.[0];
  const rainSum = daily?.precipitation_sum?.[0];
  const uvMax = daily?.uv_index_max?.[0];

  const upcomingMin = Math.min(...(daily?.temperature_2m_min ?? []).slice(0, 3).filter(Number.isFinite));
  const upcomingMax = Math.max(...(daily?.temperature_2m_max ?? []).slice(0, 3).filter(Number.isFinite));

  if (Number.isFinite(upcomingMin) && upcomingMin <= 3) {
    out.push({
      key: upcomingMin <= 0 ? 'frost' : 'cold',
      severity: upcomingMin <= 0 ? 'high' : 'medium',
      value: Math.round(upcomingMin)
    });
  }
  if (Number.isFinite(upcomingMax) && upcomingMax >= 33) {
    out.push({ key: 'heat', severity: upcomingMax >= 36 ? 'high' : 'medium', value: Math.round(upcomingMax) });
  }
  if (Number.isFinite(windMax) && windMax >= 40) {
    out.push({ key: 'wind', severity: windMax >= 60 ? 'high' : 'medium', value: Math.round(windMax) });
  }
  if (Number.isFinite(rainSum) && rainSum >= 25) {
    out.push({ key: 'heavyRain', severity: rainSum >= 60 ? 'high' : 'medium', value: Math.round(rainSum) });
  }
  if (Number.isFinite(uvMax) && uvMax >= 8) {
    out.push({ key: 'uv', severity: uvMax >= 10 ? 'high' : 'medium', value: Math.round(uvMax) });
  }

  // A dry, warm run means pots need water sooner than the calendar suggests.
  const next3Rain = (daily?.precipitation_sum ?? []).slice(0, 3).filter(Number.isFinite);
  const dry = next3Rain.length === 3 && next3Rain.every((mm) => mm < 1);
  if (dry && Number.isFinite(maxToday) && maxToday >= 24) {
    out.push({ key: 'dry', severity: 'low', value: 3 });
  }

  // Nothing alarming: say so explicitly rather than showing an empty panel.
  if (!out.length && Number.isFinite(minToday)) {
    out.push({ key: 'fine', severity: 'none', value: Math.round(current?.temperature_2m ?? maxToday ?? 0) });
  }
  return out;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get('lat')) || DEFAULT_LAT;
  const lon = Number(url.searchParams.get('lon')) || DEFAULT_LON;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;

  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return json({ ...hit.body, cached: true });
  }

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: 'Asia/Tokyo',
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'precipitation', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'is_day'
    ].join(','),
    hourly: ['temperature_2m', 'precipitation_probability', 'weather_code'].join(','),
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'precipitation_sum', 'precipitation_probability_max',
      'wind_speed_10m_max', 'uv_index_max', 'sunrise', 'sunset'
    ].join(','),
    forecast_days: '7',
    forecast_hours: '24'
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${UPSTREAM}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'shinyashimada.com/1.0 (balcony weather)' }
    });
    if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
    const data = await res.json();

    const body = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      timezone: data.timezone,
      current: data.current ?? null,
      currentUnits: data.current_units ?? null,
      hourly: data.hourly ?? null,
      daily: data.daily ?? null,
      dailyUnits: data.daily_units ?? null,
      advisories: buildAdvisories(data.current, data.daily)
    };

    memo.set(key, { at: Date.now(), body });
    return json(body);
  } catch (err) {
    console.error('[weather] fetch failed', err);
    // Serve a stale copy rather than an error screen when we have one.
    if (hit) return json({ ...hit.body, cached: true, stale: true });
    return json({ ok: false, error: 'Could not reach the weather service.', code: 'upstream-failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
}
