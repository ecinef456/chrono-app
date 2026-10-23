// Minimal service worker so Chrono can be installed as its own app window.
// Everything is fetched live from the local server; nothing is cached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
