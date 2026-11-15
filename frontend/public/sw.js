/* FAVA service worker: offline app shell + downloaded albums.
 *
 * - /api/stream/<id>  served from the "audio" cache when the album was
 *                     downloaded (with HTTP Range support, so seeking works)
 * - /api/covers/...   cache-first
 * - other /api GETs   network-first, falling back to the last response
 * - app shell         network-first for pages, cache-first for hashed assets
 */
const AUDIO = "fava-audio-v1";
const IMG = "fava-img-v1";
const API = "fava-api-v1";
const SHELL = "fava-shell-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"]).catch(() => {})));
});

self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const NO_CACHE = ["/api/import", "/api/uploads", "/api/covers/candidates"];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (path.startsWith("/api/stream/")) {
    event.respondWith(streamFromCache(req, path));
  } else if (path.startsWith("/api/covers/") && !path.startsWith("/api/covers/candidates")) {
    event.respondWith(cacheFirst(req, IMG));
  } else if (path.startsWith("/api/")) {
    if (NO_CACHE.some((p) => path.startsWith(p))) return;
    event.respondWith(networkFirst(req, API));
  } else if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return r;
        })
        .catch(() => caches.match("/", { cacheName: SHELL })),
    );
  } else if (path.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req, SHELL));
  }
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

async function streamFromCache(req, path) {
  const cache = await caches.open(AUDIO);
  const hit = await cache.match(path);
  if (!hit) return fetch(req);
  const blob = await hit.blob();
  const size = blob.size;
  const range = req.headers.get("range");
  const headers = { "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes" };
  if (!range) {
    return new Response(blob, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
  if (m && !m[1] && m[2]) {
    start = Math.max(0, size - parseInt(m[2], 10));
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}
