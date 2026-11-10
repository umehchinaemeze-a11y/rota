// Rota Offline Service Worker
const CACHE_NAME = "rota-offline-v1";
const STATIC_ASSETS = [
  "/",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Continue even if initial precaching is partial
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Invalidate cached API data on logout or account change message
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_USER_CACHE") {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.keys().then((requests) => {
          const deletions = requests
            .filter((req) => req.url.includes("/api/"))
            .map((req) => cache.delete(req));
          return Promise.all(deletions);
        });
      })
    );
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  // Security & Isolation Policy:
  // Never persist authenticated user API data into shared Cache Storage.
  // Dynamic user data (/api/) is handled by client-side scoped offline storage
  // with strict userId and workspace isolation.
  if (event.request.url.includes("/api/")) {
    return;
  }

  // Static shell assets: Network-first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// Background Push Notification handling
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: "Rota Notification",
      body: event.data.text(),
      deepLink: "/?tab=Schedule",
    };
  }

  const title = payload.title || "Rota Notification";
  const options = {
    body: payload.body || "Schedule update received.",
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    data: {
      url: payload.deepLink || payload.url || "/?tab=Schedule",
    },
    tag: payload.idempotencyKey || payload.category || "rota-shift-notification",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Deep link navigation on notification interaction
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : "/?tab=Schedule";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if (client.url.includes(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

