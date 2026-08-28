/* global caches, self */

'use strict';

const CACHE_NAME = 'mizuki-companion-room-v1';
const APP_SHELL = [
  '/companion-room/',
  '/companion-room/app.css',
  '/companion-room/app.js',
  '/companion-room/manifest.webmanifest',
  '/companion-room/icon-192.png',
  '/companion-room/icon-512.png',
  '/companion-room/portrait.webp'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return cache.addAll(APP_SHELL);
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key !== CACHE_NAME && key.startsWith('mizuki-companion-room-');
    }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/companion-room')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(function (response) {
      if (response.ok) caches.open(CACHE_NAME).then(function (cache) { return cache.put('/companion-room/', response.clone()); });
      return response;
    }).catch(function () { return caches.match('/companion-room/'); }));
    return;
  }

  event.respondWith(caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response.ok) caches.open(CACHE_NAME).then(function (cache) { return cache.put(request, response.clone()); });
      return response;
    });
  }));
});
