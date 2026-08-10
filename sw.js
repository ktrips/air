/**
 * Service Worker – air travel diary
 * 戦略:
 *   - コアアプリファイル（app.js/index.html/CSS）: network-first
 *     （デプロイ直後から即座に最新版が反映されるよう、まずネットワークを優先する。
 *      オフライン時のみキャッシュにフォールバックする）
 *   - その他の同一オリジン静的アセット（アイコン等）: stale-while-revalidate
 *     （即キャッシュ返却 + バックグラウンド更新。滅多に変わらないため許容できる）
 *   - CDN スクリプト/スタイル: cache-first（変更が少ないため）
 *   - Firestore / Firebase API / Storage: スキップ（キャッシュ不可）
 *   - GPX ファイル: cache-first（IndexedDB とは別の HTTP キャッシュ層）
 */

const CACHE_VERSION = 'air-v7'; // コアアプリファイルをnetwork-firstに変更（stale-while-revalidateによる反映遅延を解消）

// network-first で扱うコアアプリファイル（デプロイのたびに変わり得るもの）
const NETWORK_FIRST_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/map-trip-name.css',
];

// インストール時に事前キャッシュする同一オリジンアセット
const PRECACHE_ASSETS = [
  ...NETWORK_FIRST_ASSETS,
  '/manifest.json',
  '/icon.svg',
  '/favicon-16.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

// CDN / 外部オリジン – cache-first
const CDN_PATTERNS = [
  'unpkg.com/leaflet',
  'api.mapbox.com/mapbox-gl-js',
  'cdn.jsdelivr.net/npm/exifr',
  'www.gstatic.com/firebasejs',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// キャッシュ対象外とする URL パターン（Firestore / Auth / Storage API 等）
const BYPASS_PATTERNS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebasestorage.googleapis.com',
  'googleapis.com/identitytoolkit',
  'generativelanguage.googleapis.com',  // Gemini API
  'api.openai.com',
  'api.anthropic.com',
  'maps.googleapis.com',
];

// ─── Install ────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('[SW] 事前キャッシュ開始');
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] 一部アセットの事前キャッシュに失敗（続行）:', err);
      });
    })
  );
  self.skipWaiting(); // 即座に有効化
});

// ─── Activate ───────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => {
            console.log('[SW] 古いキャッシュを削除:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim(); // 既存タブをこの SW で即管理
});

// ─── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // GET 以外・chrome-extension はスキップ
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  // Firestore / Auth / AI API などはキャッシュしない
  if (BYPASS_PATTERNS.some((p) => request.url.includes(p))) return;

  // CDN リソース: cache-first（ライブラリは不変に近い）
  if (CDN_PATTERNS.some((p) => request.url.includes(p))) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // GPX ファイル: cache-first（IndexedDB とは独立した HTTP キャッシュ層）
  if (request.url.match(/\.gpx(\?|$)/i)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin === self.location.origin) {
    // コアアプリファイル: network-first（デプロイを即座に反映させる）
    if (NETWORK_FIRST_ASSETS.includes(requestUrl.pathname)) {
      event.respondWith(networkFirst(request));
      return;
    }
    // その他の同一オリジン静的アセット: stale-while-revalidate
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});

// ─── キャッシュ戦略ヘルパー ─────────────────────────────────────────────────

/**
 * network-first: まずネットワークから取得（常に最新を優先）。
 * オフライン等でネットワークが失敗した場合のみキャッシュにフォールバックする。
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    console.warn('[SW] network-first: ネットワーク・キャッシュ共に失敗:', request.url);
    return new Response('Network error', { status: 503 });
  }
}

/** cache-first: キャッシュにあればそれを返す。なければネットワーク取得してキャッシュに保存 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[SW] cache-first ネットワーク失敗:', request.url);
    return new Response('Network error', { status: 503 });
  }
}

/** stale-while-revalidate: キャッシュを即返しつつバックグラウンドで更新 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await networkPromise) || new Response('Network error', { status: 503 });
}
