// Service worker of the installable app (PWA). It caches nothing: documents and the archive are
// always loaded fresh. Being there makes the app installable and enables the share target.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
