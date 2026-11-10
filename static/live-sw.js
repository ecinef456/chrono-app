// Service worker of the phone live page (static/live.html): it makes the page open without a
// network, which is what a classroom often offers. The files below are fetched once and kept;
// after that the kept copy is shown at once and refreshed in the background, so an update
// arrives on the second opening. The timetable itself is never here: it lives in the link and
// in the page's local storage.
// .github/workflows/pages.yml publishes this same list of files: keep the two in step.
const CACHE = "chrono-live-v1";
const FILES = [
  "live.html", "live.css", "live.js", "live.webmanifest", "style.css",
  "i18n.js", "i18n.json", "teach.js", "teach-live.js", "vendor/alpine.min.js",
  "fonts/atkinson-hyperlegible-next-wght.ttf", "fonts/atkinson-hyperlegible-next-italic-wght.ttf",
  "fonts/hanken-grotesk-latin-wght-normal.woff2", "fonts/hanken-grotesk-latin-ext-wght-normal.woff2",
  "icon.svg", "icon-192.png", "icon-512.png",
];

self.addEventListener("install", e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())
));

self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("chrono-live-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const kept = await cache.match(e.request, { ignoreSearch: true });   // files are asked for as name?v=3
    const fresh = fetch(e.request).then(res => {
      if (res.ok) { url.search = ""; cache.put(url.href, res.clone()); }
      return res;
    });
    if (!kept) return fresh;
    e.waitUntil(fresh.catch(() => {}));
    return kept;
  }));
});
