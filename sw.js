/**
 * AI 影像標記工具 — PWA Service Worker (離線快取與秒開加速)
 * 支援首次開啟後將所有前端核心資源快取於瀏覽器，即使公司產線處於斷網環境仍可 100% 離線運作。
 */
const CACHE_NAME = 'yolo-labeling-pwa-v3';
const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './static/cmc_logo.png',
    './static/cmc_favicon.png',
    './static/cmc_icon_512.png',
    './static/css/style.css',
    './static/js/shared_rules.js',
    './static/js/web_fs_engine.js',
    './static/js/main.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_ASSETS))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.includes('/api/')) return;

    // 採用 Network-First 搭配 Cache Fallback：有網路時自動取得最新版並更新快取，斷網時無縫由離線快取秒開
    event.respondWith(
        fetch(req)
            .then((networkRes) => {
                if (networkRes && networkRes.status === 200) {
                    const copy = networkRes.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
                }
                return networkRes;
            })
            .catch(() =>
                caches.match(req, { ignoreSearch: true }).then((cachedRes) => {
                    if (cachedRes) return cachedRes;
                    if (req.mode === 'navigate') {
                        return caches.match('./index.html', { ignoreSearch: true });
                    }
                    return new Response('Offline', { status: 503 });
                })
            )
    );
});
