const GCS_BASE = 'https://storage.googleapis.com/storage/v1/b/p-2-cen1/o';
const TELEMETRY_OBJECTS = {
  orion: 'October/1/October_105_1.txt',
  icps: 'Io/2/Io_108_2.txt',
};
const CACHE_TTL_SECONDS = 2;

async function fetchGCSObject(objPath) {
  const encoded = encodeURIComponent(objPath);
  const metaUrl = `${GCS_BASE}/${encoded}`;
  const metaResp = await fetch(metaUrl);
  if (!metaResp.ok) throw new Error(`GCS metadata fetch failed: ${metaResp.status}`);
  const meta = await metaResp.json();
  const gen = meta.generation;

  const dataUrl = `${metaUrl}?alt=media&generation=${gen}`;
  const dataResp = await fetch(dataUrl);
  if (!dataResp.ok) throw new Error(`GCS data fetch failed: ${dataResp.status}`);
  return dataResp.json();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== '/api/telemetry') {
      // Let the assets system handle everything else
      return env.ASSETS.fetch(request);
    }

    // Check cache first
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Fetch both telemetry objects in parallel
    const results = {};
    const entries = Object.entries(TELEMETRY_OBJECTS);
    const fetches = entries.map(async ([name, path]) => {
      try {
        results[name] = await fetchGCSObject(path);
      } catch (e) {
        console.error(`Error fetching ${name}:`, e);
      }
    });
    await Promise.all(fetches);

    const response = new Response(JSON.stringify(results), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });

    // Cache internally for CACHE_TTL_SECONDS
    const cachedResponse = new Response(response.clone().body, response);
    cachedResponse.headers.set('Cache-Control', `s-maxage=${CACHE_TTL_SECONDS}`);
    ctx.waitUntil(cache.put(cacheKey, cachedResponse));

    return response;
  },
};
