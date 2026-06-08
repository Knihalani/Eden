/**
 * Eden Portal Service Worker
 * Provides offline caching and network resilience.
 */

const CACHE_NAME = "eden-portal-v1";
const STATIC_ASSETS = [
  "/",
  "/dashboard",
  "/jobs",
  "/settings",
  "/login",
];

const API_CACHE_NAME = "eden-api-v1";
const API_ROUTES = ["/api/"];

// Install: pre-cache static assets individually so one failure doesn't abort all
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          fetch(url, { credentials: "same-origin" })
            .then((response) => {
              if (response.ok) {
                return cache.put(url, response);
              }
              console.warn("SW pre-cache skipped (non-200):", url);
            })
            .catch((err) => {
              console.warn("SW pre-cache failed:", url, err);
            })
        )
      );
    })
  );
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME && name !== API_CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch: serve from cache, fall back to network
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and non-HTTP(S) requests
  if (request.method !== "GET" || !url.protocol.startsWith("http")) {
    return;
  }

  // API routes: network-first with short cache
  if (API_ROUTES.some((route) => url.pathname.startsWith(route))) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(API_CACHE_NAME).then((cache) => {
              cache.put(request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            if (cached) {
              return cached;
            }
            return new Response(
              JSON.stringify({ error: "Offline — API unavailable" }),
              {
                status: 503,
                headers: { "Content-Type": "application/json" },
              }
            );
          });
        })
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Revalidate in background
        fetch(request)
          .then((response) => {
            if (response.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, response);
              });
            }
          })
          .catch(() => {});
        return cached;
      }

      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline fallback for navigation
          if (request.mode === "navigate") {
            return caches.match("/");
          }
          return new Response("Offline", { status: 503 });
        });
    })
  );
});

// Push notifications (future)
self.addEventListener("push", (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || "Eden", {
        body: data.body || "New notification",
        icon: "/icon-192x192.png",
        badge: "/icon-72x72.png",
        tag: data.tag || "default",
        requireInteraction: data.requireInteraction || false,
      })
    );
  } catch {
    // Ignore malformed push messages
  }
});

// Notification click
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/dashboard") && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("/dashboard");
      }
    })
  );
});
