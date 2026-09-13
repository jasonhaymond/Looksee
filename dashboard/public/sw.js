// Minimal service worker: exists so the PWA is installable and so 'push'
// events (Web Push alerts from the engine) show a notification even when
// no tab is open. No offline caching yet — this app is useless without a
// live connection to the engine anyway, so there's nothing worth caching
// beyond what the browser's HTTP cache already does.
self.addEventListener("push", (event) => {
  let data = { title: "Looksee", body: "New alert" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    data.body = event.data ? event.data.text() : data.body;
  }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/icon.svg" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/"));
});
