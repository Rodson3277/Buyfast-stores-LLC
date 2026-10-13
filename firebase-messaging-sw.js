// Firebase Messaging Service Worker for BuyFast TopUp
// Version: 7.0 — robust background push with requireInteraction

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyDdOdHWDXaNMuprHJLePO9ej95gnKgA63s",
  authDomain: "buyfast-topup-1948a.firebaseapp.com",
  projectId: "buyfast-topup-1948a",
  storageBucket: "buyfast-topup-1948a.firebasestorage.app",
  messagingSenderId: "893318423787",
  appId: "1:893318423787:web:e9e6bf26d7cd09af764aae"
};

firebase.initializeApp(firebaseConfig);

// Force this service worker to activate immediately on install/update
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

// Primary push handler — intercepts ALL push events before Firebase can interfere.
// When webpush.notification is set in the FCM payload, this fires synchronously
// and calls showNotification() directly, preventing Samsung from showing raw JSON.
self.addEventListener('push', function(event) {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch(e) {
    console.warn('[SW v6.0] Non-JSON push, skipping:', e);
    return;
  }

  // Support both data-only and notification+data payloads
  const d = payload.data || {};
  const n = payload.notification || {};

  const title       = d.title       || n.title       || 'BuyFast TopUp';
  const body        = d.body        || n.body        || '';
  const icon        = d.icon        || n.icon        || '/logo-buyfast-favicon.jpg';
  const badge       = '/logo-buyfast-favicon.jpg';
  const clickAction = d.clickAction || d.click_action || n.click_action || '/';
  const tag         = d.tag         || 'buyfast-notification';

  if (!body) body = 'Ou gen yon nouvo notifikasyon BuyFast';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      requireInteraction: true,
      renotify:           true,
      vibrate:            [200, 100, 200],
      data:               { clickAction }
    }).catch((err) => {
      console.error('[SW v7.0] showNotification failed:', err);
      return self.registration.showNotification('BuyFast TopUp', { body, icon, badge });
    })
  );
});

// Handle notification click — open / focus the app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'close') return;

  const clickAction = event.notification.data?.clickAction || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (const client of clientList) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          if ('navigate' in client) client.navigate(clickAction);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(clickAction);
      }
    })
  );
});

self.addEventListener('notificationclose', function() {});

console.log('[SW] BuyFast Firebase Service Worker v7.0 initialized');
