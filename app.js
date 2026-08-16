/* Air — 地図と写真でエア旅行（Firebase + Firestore） */

// Mapbox GL JS（約330KB）は自動再生の3D地図でしか使わないため、
// 初期表示をブロックしないよう必要になった時点で読み込む。
const MAPBOX_GL_JS_URL = 'https://api.mapbox.com/mapbox-gl-js/v3.0.1/mapbox-gl.js';
const MAPBOX_GL_CSS_URL = 'https://api.mapbox.com/mapbox-gl-js/v3.0.1/mapbox-gl.css';
let mapboxLoadPromise = null;

/**
 * Mapbox GL JS を動的に読み込む。
 * 読み込み済み・トークン未設定・失敗のいずれでも解決し、成否を boolean で返す
 * （3D地図が使えない場合も自動再生は2Dで継続させるため）。
 */
function loadMapboxGl() {
  if (mapboxLoadPromise) return mapboxLoadPromise;

  mapboxLoadPromise = new Promise((resolve) => {
    if (window.mapboxgl) {
      if (window.MAPBOX_TOKEN) mapboxgl.accessToken = window.MAPBOX_TOKEN;
      resolve(true);
      return;
    }
    if (!window.MAPBOX_TOKEN) {
      console.warn('Mapbox アクセストークン未設定 - 3D地図の読み込みをスキップ');
      resolve(false);
      return;
    }

    if (!document.querySelector(`link[href="${MAPBOX_GL_CSS_URL}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = MAPBOX_GL_CSS_URL;
      link.crossOrigin = '';
      document.head.appendChild(link);
    }

    const script = document.createElement('script');
    script.src = MAPBOX_GL_JS_URL;
    script.crossOrigin = '';
    script.async = true;
    script.onload = () => {
      if (window.mapboxgl) {
        mapboxgl.accessToken = window.MAPBOX_TOKEN;
        resolve(true);
      } else {
        console.warn('Mapbox GL JS の読み込みに失敗 - 2D地図で続行');
        resolve(false);
      }
    };
    script.onerror = () => {
      console.warn('Mapbox GL JS の読み込みに失敗 - 2D地図で続行');
      // 再試行できるようキャッシュを破棄する
      mapboxLoadPromise = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });

  return mapboxLoadPromise;
}

// 15色: ピンク〜シアンのレインボー順＋緑系（地図マーカー・ルート線の色分け用）
const TRIP_COLORS = ['#e1306c', '#fd1d1d', '#f56040', '#ffdc80', '#fcaf45', '#f77737', '#17bf63', '#2ecc71', '#1abc9c', '#c13584', '#833ab4', '#5851db', '#405de6', '#4facfe', '#00f2fe'];

let map = null;
let travelogueMap = null;
let searchMarker = null;
let currentTrip = null;
let currentPhotoIndex = 0;
let markers = [];
let gpxLayers = [];
let tripLeaderLayers = [];
// 写真マーカーの遅延読み込み用: 画面外のマーカーは地図に追加せず保留しておく
let pendingPhotoMarkers = [];
let photoMarkerLazyBound = false;
let playbackPulseMarker = null; // 自動再生中の現在ポイントパルスマーカー
let playTimer = null;
let playIntervalMs = 5000;
let playbackPhotos = []; // 再生中の写真配列
let playbackVideoEndCallback = null;
let playbackVideoTimer = null; // 動画再生時の30秒タイマー
let videoSequenceTimer = null; // 動画シーケンス再生時のタイマー
let currentAutoplayTick = null; // 自動再生のtick関数参照（jumpPlaybackで使用）
let map3d = null;
let photoPopup = null;
let myTrips = [];
let myTripsMap = new Map(); // O(1)ルックアップ用（myTrips更新時に同期）
let tripOrder = [];
let draggedTripId = null;
let thumbnailsVisible = false;
let mapLayers = {};
let currentMapLayer = 'satellite'; // デフォルトを衛星写真に設定
const gpxCache = {};
const LAST_TRIP_ID_KEY = 'air-last-trip-id';
let corsWarningShown = false;
let characterImageData = null; // キャラクター画像（Base64形式・メモリキャッシュ）
let pendingMarkerDrag = null; // マーカードラッグ中の保留データ { tripRef, photoIdx, originalLat, originalLng, originalPlaceName }

// ─── Phase 1: パフォーマンス最適化ユーティリティ ──────────────────────────

/**
 * debounce: 連続呼び出しをまとめて 1 回に抑制する
 * @param {Function} fn  実行したい関数
 * @param {number}   wait ミリ秒
 */
function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// updateMapMarkers の連続呼び出しを 300ms にまとめる（fire-and-forget 用）
// 重要なパス（await が必要な箇所）では引き続き updateMapMarkers() を直接呼ぶ
const scheduleMapMarkersUpdate = debounce(() => updateMapMarkers(), 300);

// ─── IndexedDB GPX キャッシュ ─────────────────────────────────────────────

const GPX_IDB_NAME    = 'air-gpx-cache';
const GPX_IDB_STORE   = 'gpx';
const GPX_IDB_VERSION = 1;
const GPX_CACHE_TTL   = 24 * 60 * 60 * 1000; // 24時間

/** IndexedDB を開く（なければ作成） */
function _openGpxDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GPX_IDB_NAME, GPX_IDB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(GPX_IDB_STORE);
    };
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}

/** IndexedDB から GPX を取得（期限切れの場合は null を返す） */
async function getGpxFromIDB(url) {
  try {
    const db = await _openGpxDB();
    return new Promise((resolve) => {
      const tx  = db.transaction(GPX_IDB_STORE, 'readonly');
      const req = tx.objectStore(GPX_IDB_STORE).get(url);
      req.onsuccess = (e) => {
        const cached = e.target.result;
        if (cached && Date.now() - cached.ts < GPX_CACHE_TTL) {
          resolve(cached.text);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null; // IndexedDB 非対応環境はスキップ
  }
}

/** GPX テキストを IndexedDB に保存（失敗しても無視） */
async function saveGpxToIDB(url, text) {
  try {
    const db = await _openGpxDB();
    await new Promise((resolve) => {
      const tx = db.transaction(GPX_IDB_STORE, 'readwrite');
      tx.objectStore(GPX_IDB_STORE).put({ text, ts: Date.now() }, url);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve(); // エラーでも続行
    });
  } catch {
    // 書き込み失敗は無視（メモリキャッシュのみで動作継続）
  }
}

/** 期限切れ GPX エントリを IDB から一括削除（起動時に 1 回呼ぶ） */
async function purgeExpiredGpxIDB() {
  try {
    const db = await _openGpxDB();
    await new Promise((resolve) => {
      const tx    = db.transaction(GPX_IDB_STORE, 'readwrite');
      const store = tx.objectStore(GPX_IDB_STORE);
      const req   = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        if (Date.now() - (cursor.value?.ts || 0) >= GPX_CACHE_TTL) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    });
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────

// パフォーマンス最適化: Firestoreクエリのキャッシュ
const tripsCache = {
  data: null,
  timestamp: 0,
  userId: null
};
const CACHE_DURATION = 5 * 60 * 1000; // 5分間キャッシュ（onSnapshot が無効な環境向けのフォールバック）

// onAuthStateChanged 内でのURLパラメータ由来トリップ読み込みを初回発火時のみに限定するフラグ。
// 無いと、ユーザーがアプリ内で別トリップに移動した後にトークンリフレッシュ等で
// onAuthStateChanged が再発火した際、URLロード時点のトリップへ強制的に戻ってしまう。
let _urlTripLoadHandled = false;
// Firestore onSnapshot リスナーの解除関数（null = 未設定）
let _tripsUnsubscribe = null;
// 同じユーザーに対する loadMyTrips() のセットアップが進行中の場合、二重リスナーを防ぐために共有する Promise
let _tripsLoadPromise = null;
let _tripsLoadPromiseUserId = null;

// getOrderedTrips() メモ化キャッシュ
let _orderedTripsCache = null;
let _orderedTripsCacheKey = '';
/** キャッシュを無効化する（myTrips / tripOrder が変わった時に呼ぶ） */
function invalidateOrderedTripsCache() {
  _orderedTripsCache = null;
  _orderedTripsCacheKey = '';
  // myTripsMapをmyTripsと同期（find→O(1)ルックアップ）
  myTripsMap = new Map(myTrips.map(t => [t.id, t]));
}

// ─── 共通ヘルパー（重複ロジックを一元化） ─────────────────────────────────────

/** トリップに旅行記が存在するか判定 */
function tripHasTravelogue(trip) {
  return !!(
    (trip.travelogueHtml && trip.travelogueHtml.trim()) ||
    trip.travelogueUrl ||
    (trip.travelogueHistory?.length > 0)
  );
}

/**
 * travelogueHistory から最新エントリを取得する
 * @returns {{ url?: string, html?: string, timestamp?: number } | null}
 */
function getLatestTravelogueEntry(trip) {
  if (!trip.travelogueHistory?.length) return null;
  return [...trip.travelogueHistory].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
}

/** 親トリップIDに属する子トリップ一覧を返す */
function getChildTrips(parentId) {
  return getOrderedTrips().filter(t => t.parentId === parentId);
}

/** トリップ名が「Plan」または「P」で始まる場合は計画段階の旅として扱い、ルート線を点線で表示する */
function isPlanTrip(trip) {
  return /^p/i.test((trip?.name || '').trim());
}

/** そのトリップをアプリ内で開き直せる共有URLを組み立てる（QRコード埋め込み用） */
function buildTripShareUrl(trip) {
  const base = window.location.origin + window.location.pathname;
  if (!trip?.id) return base;
  return `${base}?t=${encodeURIComponent(trip.id)}`;
}

/** トリップ内の特定ポイント（写真）に直接ジャンプできる共有URLを組み立てる（御朱印QR埋め込み用） */
function buildPhotoShareUrl(trip, photoIdx) {
  const base = buildTripShareUrl(trip);
  if (photoIdx == null || photoIdx < 0) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}p=${photoIdx}`;
}

/**
 * canvasの右下に、指定URLのQRコードを白い余白（クワイエットゾーン）付きで描画する。
 * assets/js/qrcode.js（kazuhikoarase/qrcode-generator、MIT）が提供するグローバルqrcodeを使う。
 * 下に何が描かれていても確実にスキャンできるよう、QR本体の前に白背景を敷く。
 */
function drawQrCodeCorner(ctx, url, canvasW, canvasH, opts = {}) {
  if (!window.qrcode || !url) return;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const count = qr.getModuleCount();

    const qrSize = opts.size || Math.round(Math.min(canvasW, canvasH) * 0.12);
    const margin = opts.margin ?? 16; // クワイエットゾーン
    const edgeMargin = opts.edgeMargin ?? 22; // キャンバス端からの余白
    const boxSize = qrSize + margin * 2;
    const x = canvasW - boxSize - edgeMargin;
    const y = canvasH - boxSize - edgeMargin;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, boxSize, boxSize);
    if (opts.border !== false) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, boxSize, boxSize);
    }

    // セル境界をピクセル単位に丸めて隙間（アンチエイリアスによる白い筋）が出ないようにする
    const cell = qrSize / count;
    ctx.fillStyle = '#000000';
    for (let r = 0; r < count; r++) {
      const py0 = Math.round(y + margin + r * cell);
      const py1 = Math.round(y + margin + (r + 1) * cell);
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c)) continue;
        const px0 = Math.round(x + margin + c * cell);
        const px1 = Math.round(x + margin + (c + 1) * cell);
        ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
      }
    }
  } catch (err) {
    console.warn('QRコードの描画に失敗（スキップ）:', err);
  }
}

/**
 * AI生成済みの画像（dataURL）にQRコードを合成する。data:URLはCORSタイントの
 * 対象にならないため、Canvasへの読み込み・再書き出しは安全に行える。
 */
async function overlayQrCodeOnDataUrl(dataUrl, url) {
  if (!dataUrl) return dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    drawQrCodeCorner(ctx, url, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('QRコードの合成に失敗（元画像をそのまま使用）:', err);
    return dataUrl;
  }
}

/**
 * canvas左下に、御朱印のような柔らかな四角の枠を持つ朱色のQRコードを、
 * 目立たせすぎず全体に自然と馴染むように描画する。
 * 枠線などのくっきりした境界線は使わず、ぼかした四角い下地の
 * フェードだけで「柔らかな四角の枠」を表現し、絵の中の文字・朱印などの
 * 意匠にさりげなく溶け込ませる。QR直下はスキャン用コントラストを確保する。
 * 装飾で読み取り率が落ちないよう誤り訂正レベルは高め（Q）にしている。
 */
function drawGoshuinQrSeal(ctx, url, canvasW, canvasH, opts = {}) {
  if (!window.qrcode || !url) return;
  try {
    const qr = window.qrcode(0, 'Q');
    qr.addData(url);
    qr.make();
    const count = qr.getModuleCount();

    // 目立たせすぎないよう控えめなサイズにする
    const qrSize = opts.size || Math.round(Math.min(canvasW, canvasH) * 0.18);
    const margin = opts.margin ?? Math.round(qrSize * 0.16);
    const plateSize = qrSize + margin * 2;
    // 中央ではなく左下（御朱印帳の朱印がよく押される位置に近い）
    const cx = opts.cx ?? canvasW * 0.20;
    const cy = opts.cy ?? canvasH * 0.78;
    const plateX = cx - plateSize / 2;
    const plateY = cy - plateSize / 2;
    const vermillionDark = '#7a1220';

    // QR下地: 角丸の四角形をぼかしてフェードさせるだけで、くっきりした枠線は作らない。
    // このフェードそのものが「柔らかな四角の枠」として機能する。
    ctx.save();
    ctx.filter = `blur(${Math.max(3, Math.round(plateSize * 0.09))}px)`;
    ctx.fillStyle = 'rgba(253, 248, 236, 0.85)';
    const pad = plateSize * 0.14;
    roundRectPath(ctx, plateX - pad, plateY - pad, plateSize + pad * 2, plateSize + pad * 2, Math.round(plateSize * 0.12));
    ctx.fill();
    ctx.restore();

    // QRモジュール（朱色。読み取り精度を保つため不透明で描画）
    const qx = plateX + margin, qy = plateY + margin;
    const cell = qrSize / count;
    ctx.fillStyle = vermillionDark;
    for (let r = 0; r < count; r++) {
      const py0 = Math.round(qy + r * cell), py1 = Math.round(qy + (r + 1) * cell);
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c)) continue;
        const px0 = Math.round(qx + c * cell), px1 = Math.round(qx + (c + 1) * cell);
        ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
      }
    }
  } catch (err) {
    console.warn('御朱印風QRコードの描画に失敗（スキップ）:', err);
  }
}

/**
 * canvas上部中央に、ポイント名を趣のある明朝体（毛筆に近い字面の
 * 明朝系フォント）で描画する。AIにテキスト描画を任せると崩れ字になる
 * ことがあるため、正確な文字を確実に読める形で重ねる。
 * 背景を選ばず読めるよう、文字の縁取り（ハロー）で下地を柔らかくなじませ、
 * 硬い帯や枠は使わない。
 */
function drawGoshuinPointNameCaption(ctx, name, canvasW, canvasH, opts = {}) {
  const text = (name || '').trim();
  if (!text) return;
  try {
    const fontSize = opts.fontSize || Math.round(canvasH * 0.06);
    ctx.save();
    ctx.font = `${fontSize}px "Hiragino Mincho ProN", "Yu Mincho", "游明朝", "Noto Serif JP", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const cx = opts.cx ?? canvasW * 0.5;
    const baselineY = opts.y ?? canvasH * 0.11;

    // 読みやすさ確保のための柔らかい縁取り（硬い帯・枠は使わない）
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.18));
    ctx.strokeStyle = 'rgba(253, 248, 236, 0.88)';
    ctx.strokeText(text, cx, baselineY);

    ctx.fillStyle = '#2a2118';
    ctx.fillText(text, cx, baselineY);
    ctx.restore();
  } catch (err) {
    console.warn('ポイント名キャプションの描画に失敗（スキップ）:', err);
  }
}

/**
 * canvas下部（左下のQRコードと重ならない右寄り）に、ポイント説明を
 * 趣のある明朝体で複数行に折り返して描画する。日本語には単語区切りが
 * ないため1文字ずつ計測して折り返す。収まりきらない場合は末尾を省略する。
 */
function drawGoshuinDescriptionCaption(ctx, description, canvasW, canvasH, opts = {}) {
  const text = (description || '').trim();
  if (!text) return;
  try {
    const fontSize = opts.fontSize || Math.round(canvasH * 0.032);
    const lineHeight = fontSize * 1.45;
    const maxWidth = opts.maxWidth ?? canvasW * 0.42;
    const cx = opts.cx ?? canvasW * 0.72;
    const maxLines = opts.maxLines ?? 3;

    ctx.save();
    ctx.font = `${fontSize}px "Hiragino Mincho ProN", "Yu Mincho", "游明朝", "Noto Serif JP", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    const lines = [];
    let line = '';
    for (const ch of text) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = ch;
        if (lines.length >= maxLines) break;
      } else {
        line = test;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length === maxLines) {
      const last = lines[maxLines - 1];
      if (ctx.measureText(last).width > maxWidth || last.length < text.length - lines.slice(0, -1).join('').length) {
        lines[maxLines - 1] = last.slice(0, Math.max(1, last.length - 1)) + '…';
      }
    }

    const totalHeight = lineHeight * lines.length;
    const baseY = opts.y ?? canvasH * 0.93;
    const startY = baseY - totalHeight + lineHeight;

    lines.forEach((ln, i) => {
      const y = startY + i * lineHeight;
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2.5, Math.round(fontSize * 0.18));
      ctx.strokeStyle = 'rgba(253, 248, 236, 0.88)';
      ctx.strokeText(ln, cx, y);
      ctx.fillStyle = '#3a3128';
      ctx.fillText(ln, cx, y);
    });
    ctx.restore();
  } catch (err) {
    console.warn('ポイント説明キャプションの描画に失敗（スキップ）:', err);
  }
}

/**
 * AI生成済みの画像（dataURL）にポイント名（上部）・ポイント説明（下部）の
 * キャプションと、御朱印のような柔らかな四角の枠を持つQRコード（左下）を
 * 合成する。overlayQrCodeOnDataUrl と同じくdata:URLはCORSタイントの
 * 対象にならないため、Canvasへの読み込み・再書き出しは安全に行える。
 */
async function overlayGoshuinQrSeal(dataUrl, url, pointName, description) {
  if (!dataUrl) return dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    drawGoshuinPointNameCaption(ctx, pointName, canvas.width, canvas.height);
    drawGoshuinDescriptionCaption(ctx, description, canvas.width, canvas.height);
    drawGoshuinQrSeal(ctx, url, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('御朱印風QRコードの合成に失敗（元画像をそのまま使用）:', err);
    return dataUrl;
  }
}

/** 写真ポップアップを安全に閉じる */
function closePhotoPopup() {
  if (!photoPopup) return;
  try { map?.removeLayer(photoPopup); } catch (_) {}
  photoPopup = null;
}

// ─── アプリ共通トースト通知 ───────────────────────────────────────────────────
let _toastTimer = null;

/**
 * 画面中央にトースト通知を表示する（約3秒で自動消去）
 * @param {string} message 表示メッセージ
 * @param {number} durationMs 表示時間 (ms)
 */
function showToast(message, durationMs = 3000) {
  const existing = document.getElementById('appToast');
  if (existing) { existing.remove(); }
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

  const el = document.createElement('div');
  el.id = 'appToast';
  el.className = 'app-toast';
  el.textContent = message;
  document.body.appendChild(el);

  _toastTimer = setTimeout(() => {
    if (el.parentNode) el.remove();
    _toastTimer = null;
  }, durationMs);
}

/** トリップ未選択 / 写真なし時に共通で表示するメッセージ */
const MSG_NO_PHOTOS = '📂 メニューからトリップを\n選んでください';

// ─────────────────────────────────────────────────────────────────────────────

// パフォーマンス最適化: 画像の遅延読み込み用Observer
let imageObserver = null;
if ('IntersectionObserver' in window) {
  imageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
          imageObserver.unobserve(img);
        }
      }
    });
  }, {
    rootMargin: '50px' // 50px手前から読み込み開始
  });
}

/**
 * アニメ生成用のキャラ画像を取得（トリップ保存分またはメモリ）。
 * アップロード時の元ファイル（HEIC・CMYK JPEG等）をそのまま画像生成APIに
 * 送ると「Invalid image file or mode」で失敗することがあるため、
 * 必ずcanvasでJPEGに正規化してから返す。
 */
async function getCharacterImageForGeneration() {
  const raw = characterImageData || await (async () => {
    const url = currentTrip?.characterImageUrl;
    if (!url) return null;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn('キャラ画像の取得に失敗:', err);
      return null;
    }
  })();
  if (!raw) return null;

  const normalized = await resizeImageToBlob(raw, ANIME_REF_PHOTO_DIM, 0.9);
  if (!normalized || normalized.size === 0) {
    console.warn('キャラ画像の正規化に失敗（元データが不正な可能性）。この画像は使用しません。');
    return null;
  }
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(normalized);
  });
}

// アニメ生成に添付する旅行写真の最大枚数（多すぎるとAPIが重く不安定になる）
const ANIME_REF_PHOTO_LIMIT = 4;
// 参照写真は生成の手掛かりになれば十分なので縮小して添付する
const ANIME_REF_PHOTO_DIM = 768;

/**
 * アニメ生成の参照に使う代表写真を選ぶ。
 * ランドマーク（名所）を優先し、足りない分は旅程全体から均等に補って
 * 旅の流れが伝わるようにする。
 */
function selectAnimeReferencePhotos(photos, limit = ANIME_REF_PHOTO_LIMIT) {
  // p.url を持つもの（実際の写真）のみを対象にする。
  // 動画のみのポイント（p.urlなし・p.videoUrlのみ）はここで自動的に除外される。
  const withUrl = (photos || []).filter(p => p && p.url && !p.isStamp);
  if (withUrl.length === 0) return [];

  const picked = [];
  const seen = new Set();
  const take = (p) => {
    if (!p || seen.has(p.url) || picked.length >= limit) return;
    seen.add(p.url);
    picked.push(p);
  };

  // ランドマークを優先（番号順）
  withUrl
    .filter(p => p.landmarkNo)
    .sort((a, b) => (parseInt(a.landmarkNo, 10) || 0) - (parseInt(b.landmarkNo, 10) || 0))
    .forEach(take);

  // 残り枠は旅程全体から等間隔で補完
  if (picked.length < limit) {
    const step = Math.max(1, Math.floor(withUrl.length / limit));
    for (let i = 0; i < withUrl.length && picked.length < limit; i += step) {
      take(withUrl[i]);
    }
  }
  return picked;
}

/** 画像URLを縮小したdataURLに変換する（参照画像の添付用） */
async function fetchImageAsResizedDataUrl(url, maxDim = ANIME_REF_PHOTO_DIM) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    // 動画ファイルなど画像以外が紛れ込んでいないか念のため確認する
    if (!blob.type || !blob.type.startsWith('image/')) {
      console.warn('参照画像が画像形式ではないためスキップ:', url, blob.type);
      return null;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    const resized = await resizeImageToBlob(dataUrl, maxDim, 0.85);
    // canvasでの再エンコードに失敗した場合、元データはHEIC等の不正な
    // 形式である可能性が高く画像生成APIが拒否するため、そのまま
    // フォールバックさせず除外する（Invalid image file or mode対策）
    if (!resized || resized.size === 0) {
      console.warn('参照画像の正規化に失敗（不正な形式の可能性）。スキップ:', url);
      return null;
    }
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(resized);
    });
  } catch (err) {
    console.warn('参照画像の取得に失敗（スキップ）:', url, err);
    return null;
  }
}

/**
 * アニメ生成に渡す参照画像一式を用意する。
 * 先頭をキャラ画像にして「主人公」であることをAIが解釈しやすくする。
 */
async function buildAnimeReferenceImages(charImg, photos, limit = ANIME_REF_PHOTO_LIMIT) {
  const refs = [];
  if (charImg) refs.push({ dataUrl: charImg, kind: 'character' });

  const selected = selectAnimeReferencePhotos(photos, limit);
  // 参照画像は情景を読み取れる必要があるため、サムネイルではなく本体写真を縮小して使う
  const dataUrls = await Promise.all(
    selected.map(p => fetchImageAsResizedDataUrl(p.url))
  );
  selected.forEach((p, i) => {
    if (dataUrls[i]) {
      refs.push({
        dataUrl: dataUrls[i],
        kind: 'photo',
        label: p.name || p.placeName || '',
        description: p.description || ''
      });
    }
  });
  return refs;
}

// 浮世絵風生成のスタイル参照画像（パブリックドメインの実作品）。
// 文章だけで「北斎風」「広重風」と指示するより、実物を見せた方が画風の再現度が上がる。
const UKIYOE_STYLE_REFERENCE_IMAGES = {
  hiroshige: 'assets/ukiyoe/hiroshige.jpg', // 歌川広重「東海道五十三次」
  hokusai: 'assets/ukiyoe/hokusai.jpg'      // 葛飾北斎「冨嶽三十六景」
};
const ukiyoeStyleRefCache = new Map();

/** 浮世絵スタイル参照画像を取得（同一セッション内はキャッシュして再フェッチしない） */
async function getUkiyoeStyleReferenceImage(ukiyoeStyle) {
  const path = UKIYOE_STYLE_REFERENCE_IMAGES[ukiyoeStyle];
  if (!path) return null;
  if (ukiyoeStyleRefCache.has(path)) return ukiyoeStyleRefCache.get(path);
  const dataUrl = await fetchImageAsResizedDataUrl(path, 1024);
  if (dataUrl) ukiyoeStyleRefCache.set(path, dataUrl);
  return dataUrl;
}

/**
 * 旅行記・写真の生情報から、絵に描くべき情景を短く要約した「情景ブリーフ」を作る。
 * 長大な箇条書きプロンプトに全情報を詰め込むより、要点を絞った短い核があった方が
 * 画像生成モデルの指示追従性が高いため、生成前にテキストモデルで一度要約させる。
 * 失敗した場合は呼び出し側で元のテキストを使えるよう null を返す。
 */
async function buildSceneBrief(rawText, cfg, maxChars = 120) {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return null;
  const prompt = [
    `以下の旅の記録から、絵画にするための情景を${maxChars}字以内の日本語で簡潔に要約してください。`,
    '場所の様子・そこで何をしたか・季節や時間帯・印象的なものを優先し、余計な前置きや見出しは付けず要約文のみを出力してください。',
    '',
    trimmed.slice(0, 2000)
  ].join('\n');
  const text = await generateShortTextWithAI(prompt, cfg);
  return text ? text.trim().slice(0, maxChars * 2) : null;
}

/** 短いテキストを生成する軽量ヘルパー（情景ブリーフ用。画像生成とは別の軽量テキストモデルを使う） */
async function generateShortTextWithAI(prompt, cfg) {
  if (!cfg?.apiKey?.trim()) return null;
  const provider = cfg.provider || 'gemini';
  try {
    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 200 }
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    }
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          max_tokens: 200
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.choices?.[0]?.message?.content || '';
    }
    return null;
  } catch (err) {
    console.warn('情景ブリーフの生成に失敗（元テキストで続行）:', err);
    return null;
  }
}

/**
 * 生成した画像をStorageに保存し、トリップに追加してリストを更新する。
 * 保存後は新しい画像をビューアで開いてその場でプレビューできるようにする
 * （気に入らなければ入力欄の内容はそのままなので、同じ設定でもう一度生成ボタンを押すだけで良い）。
 */
async function finalizeGeneratedAnime(trip, generatedDataUrl, animeData, filePrefix) {
  const storageUrl = await uploadAnimeImageToStorage(trip.id, generatedDataUrl, filePrefix);
  const entry = { url: storageUrl, timestamp: Date.now(), ...animeData };
  if (!trip.generatedAnimes) trip.generatedAnimes = [];
  trip.generatedAnimes.push(entry);
  await saveTrip({ silent: true });
  renderGeneratedAnimesList();
  showAnimeImageViewer([entry], trip.name || '');
  return entry;
}

let addingGpsPointMode = false; // GPSポイント追加モード

// トリップ所在フィルタ: 'all' | 'japan' | 'global'（URLパラメータ ?region=japan または ?region=global で指定可能）
let tripRegionFilter = 'all';

// 特定ドメイン用: 親トリップ名でフィルタ（ohenro/henro.ktrips.net では「しまなみ・淡路と四国遍路」とその子のみ表示）
let tripFilterParentName = null;

// ohenro/henro.ktrips.net のデフォルトトリップ（「しまなみ・淡路と四国遍路」）。
// トリップ名は改名され得るためIDで固定する（名前でハードコードすると改名時に一致しなくなる）。
const OHENRO_DEFAULT_TRIP_ID = 'trip_1773618081995';

/** 日本の大まかな範囲（緯度・経度） */
const JAPAN_BOUNDS = { latMin: 24.2, latMax: 45.5, lngMin: 122.9, lngMax: 153.9 };

/** 座標が日本国内かどうかを判定 */
function isCoordInJapan(lat, lng) {
  if (lat == null || lng == null) return false;
  return lat >= JAPAN_BOUNDS.latMin && lat <= JAPAN_BOUNDS.latMax &&
         lng >= JAPAN_BOUNDS.lngMin && lng <= JAPAN_BOUNDS.lngMax;
}

/** ドメインに応じたアプリ表題を取得 */
function getAppTitle() {
  const host = window.location.hostname || '';
  if (/^airj\.ktrips\.net$|^air\.jp\.ktrips\.net$/.test(host)) return 'Air.Jp';
  if (/^airg\.ktrips\.net$|^air\.gl\.ktrips\.net$/.test(host)) return 'Air.Global';
  if (/^ohenro\.ktrips\.net$/.test(host)) return 'Ohenro';
  return 'Air';
}

/** アプリ表題をDOMに反映（タイトル・ヘッダーロゴ） */
function applyAppTitle() {
  const title = getAppTitle();
  document.title = title + ' — 地図と写真でエア旅行';
  const headerLogoText = document.getElementById('headerLogo')?.querySelector('.header-logo-text');
  if (headerLogoText) headerLogoText.textContent = title;
}

/** URLパラメータとドメインからフィルタを設定 */
function initRegionFilterFromUrl() {
  try {
    const host = window.location.hostname || '';
    const params = new URLSearchParams(window.location.search);

    // URLパラメータで トリップ ID または トリップ名を指定
    // ?trip_id=xxx（ID指定） または ?trip=トリップ名（名前指定）
    const tripIdParam = params.get('trip_id');
    const tripNameParam = params.get('trip');

    if (tripIdParam) {
      // ID ベースの指定：そのまま使用
      window.appUrlTripId = tripIdParam;
      console.log('🔗 URLパラメータ: trip_id =', tripIdParam);
    } else if (tripNameParam) {
      // 名前ベースの指定：正規化して保存（後で検索）
      window.appUrlTripName = decodeURIComponent(tripNameParam).trim();
      console.log('🔗 URLパラメータ: trip =', window.appUrlTripName);
    }
    // trip_id/trip のいずれも無い場合はここでは何もしない。
    // ドメインごとのデフォルトトリップ選択・?t=/?id=/?tripId=/?n= 等の他形式パラメータの解決は
    // init() 側の loadTripsAndRender が一手に担う（そちらの方が対応形式が多く正確）。
    // 以前はここで ohenro/henro ドメインに OHENRO_DEFAULT_TRIP_ID（親トリップ）を無条件セット
    // していたため、?t=/?id=/?n= 等で子トリップを指定した URL では trip_id/trip が
    // 見つからずこの分岐に入り、window.appUrlTripId に親トリップIDが入った状態のまま
    // onAuthStateChanged 側の処理が発火して、init() 側が正しく読み込んだ子トリップを
    // 親トリップで上書きしてしまう不具合の原因になっていた。

    let region = params.get('region');
    if (region === 'japan' || region === 'global') {
      tripRegionFilter = region;
    } else if (!region) {
      if (/^airj\.ktrips\.net$|^air\.jp\.ktrips\.net$/.test(host)) tripRegionFilter = 'japan';
      else if (/^airg\.ktrips\.net$|^air\.gl\.ktrips\.net$/.test(host)) tripRegionFilter = 'global';
    }
  } catch (_) {}
}

/** トリップの所在を判定: 'japan' | 'global' | null（判定不可の場合はnull＝両方に表示） */
function getTripRegion(trip, allTrips) {
  const photos = trip.photos || [];
  // 1回のループでjapan/global両フラグを決定（some()2回走査を排除）
  let hasJapan = false, hasGlobal = false;
  for (const p of photos) {
    if (p.lat == null || p.lng == null) continue;
    if (isCoordInJapan(p.lat, p.lng)) hasJapan = true;
    else hasGlobal = true;
    if (hasJapan && hasGlobal) break; // 早期終了
  }
  if (trip.isParent && photos.length === 0 && allTrips) {
    const childIds = new Set(allTrips.filter(t => t.parentId === trip.id).map(t => t.id));
    if (childIds.size > 0) {
      let childJapan = false, childGlobal = false;
      for (const t of allTrips) {
        if (childIds.has(t.id)) {
          const r = getTripRegion(t, allTrips);
          if (r === 'japan') childJapan = true;
          if (r === 'global') childGlobal = true;
        }
      }
      if (childJapan && !childGlobal) return 'japan';
      if (childGlobal && !childJapan) return 'global';
      if (childJapan && childGlobal) return 'japan'; // 混在時は日本優先で表示
    }
  }
  if (hasJapan && !hasGlobal) return 'japan';
  if (hasGlobal && !hasJapan) return 'global';
  if (hasJapan && hasGlobal) return 'japan'; // 混在時は日本として扱う
  return null; // 写真なし or GPSなし → 両方に表示
}

function isEditor() {
  return !!(window.firebaseAuth?.currentUser);
}

function showCorsWarning() {
  if (corsWarningShown) return;
  corsWarningShown = true;

  console.warn('='.repeat(60));
  console.warn('Firebase Storage の CORS 設定が必要です');
  console.warn('='.repeat(60));
  console.warn('');
  console.warn('GPX ファイルやアニメ画像の読み込みに失敗しています（CORS の可能性）。');
  console.warn('プロジェクトルートで以下を実行してください：');
  console.warn('');
  console.warn('  ./setup-cors.sh');
  console.warn('');
  console.warn('または手動で：');
  console.warn('  gsutil cors set cors.json gs://airgo-trip.firebasestorage.app');
  console.warn('');
  console.warn('詳しい手順は CORS_SETUP.md を参照してください。');
  console.warn('='.repeat(60));

  // ユーザーにも通知（1回のみ）
  if (isEditor()) {
    setTimeout(() => {
      if (confirm('Firebase Storage の CORS 設定が必要です。\n\nアニメ画像・GPX ファイルの読み込みに失敗している可能性があります。\n設定手順を確認しますか？')) {
        alert('ターミナルでプロジェクトフォルダに移動し、以下を実行してください：\n\n  cd (プロジェクトのパス)\n  ./setup-cors.sh\n\n詳しくは CORS_SETUP.md を参照してください。');
      }
    }, 1000);
  }
}

function checkFirebaseStatus() {
  const status = {
    firebaseLoaded: typeof firebase !== 'undefined',
    firebaseApp: !!window.firebaseApp,
    firebaseAuth: !!window.firebaseAuth,
    firebaseDb: !!window.firebaseDb,
    firebaseStorage: !!window.firebaseStorage,
    currentUser: window.firebaseAuth?.currentUser?.email || null,
    online: navigator.onLine
  };
  console.log('Firebase 状態:', status);
  return status;
}

function closeMenu() {
  document.getElementById('menuPanel')?.classList.remove('open');
  document.getElementById('menuOverlay')?.classList.remove('open');
}

function updateEditorUI() {
  document.body.classList.toggle('editor', isEditor());
  const authBtn = document.getElementById('authBtn');
  if (authBtn) {
    if (window.firebaseAuth?.currentUser) {
      authBtn.textContent = `ログアウト (${window.firebaseAuth.currentUser.email || 'Google'})`;
    } else {
      authBtn.textContent = 'Googleでログイン';
    }
  }

  // アップロードセクションの表示/非表示
  const uploadSection = document.getElementById('uploadSection');
  if (uploadSection) {
    uploadSection.style.display = isEditor() ? '' : 'none';
  }
}

async function signInWithGoogle() {
  if (window.location.protocol === 'file:') {
    alert('file:// では動作しません。ターミナルで以下を実行してから http://localhost:8080 を開いてください:\n\ncd air\npython3 -m http.server 8080');
    return;
  }
  if (!window.firebaseAuth) {
    alert('Firebase が読み込まれていません。\n\n1. firebase-config.js が air フォルダにあるか確認\n2. ローカルサーバーで起動: cd air && python3 -m http.server 8080\n3. ブラウザのコンソール（F12）でエラーを確認');
    return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    // ログイン前に永続化を確実に設定（モバイル対策）
    await window.firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    console.log('認証の永続化（LOCAL）を設定しました');

    if (isMobileView()) {
      // モバイルではリダイレクトを使用
      console.log('モバイル: リダイレクトログインを開始');
      await window.firebaseAuth.signInWithRedirect(provider);
    } else {
      console.log('デスクトップ: ポップアップログインを開始');
      await window.firebaseAuth.signInWithPopup(provider);
    }
  } catch (err) {
    console.error('ログインエラー:', err);
    if (err.code === 'auth/web-storage-unsupported') {
      alert('ログインに失敗しました: ブラウザのプライベートモードを解除するか、Cookieを有効にしてください。');
    } else {
      alert('ログインに失敗しました: ' + (err.message || err));
    }
  }
}

// モバイルでリダイレクト後の結果を取得
async function handleRedirectResult() {
  if (!window.firebaseAuth) return;
  try {
    console.log('リダイレクト結果を確認中...');
    const result = await window.firebaseAuth.getRedirectResult();
    if (result && result.user) {
      console.log('リダイレクトログイン成功:', {
        email: result.user.email,
        uid: result.user.uid,
        displayName: result.user.displayName
      });
      // 認証状態を確認
      const currentUser = window.firebaseAuth.currentUser;
      console.log('現在の認証状態:', currentUser ? 'ログイン中' : '未ログイン');
    } else {
      console.log('リダイレクト結果: ログイン処理なし（通常のページアクセス）');
    }
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') {
      console.error('リダイレクト結果取得エラー:', err);
      if (err.code === 'auth/web-storage-unsupported') {
        console.error('→ ブラウザのプライベートモードまたはCookie制限が原因の可能性があります');
      }
    }
  }
}

function signOut() {
  if (window.firebaseAuth) {
    window.firebaseAuth.signOut();
  }
}

function isMobileView() {
  return window.innerWidth <= 768;
}

function initMap() {
  map = L.map('map', { zoomControl: false }).setView([35.6812, 139.7671], 5);

  // ズームコントロールを右上に配置
  L.control.zoom({ position: 'topright' }).addTo(map);

  // 各種マップレイヤーの定義（高解像度対応）
  mapLayers = {
    terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap, © OpenTopoMap',
      maxZoom: 17,
      detectRetina: true,
      className: 'map-tiles-crisp'
    }),
    standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
      detectRetina: true,
      className: 'map-tiles-crisp'
    }),
    satellite: L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '© Esri, Maxar, Earthstar Geographics',
        maxZoom: 19,
        detectRetina: true,
        className: 'map-tiles-crisp'
      }),
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap, © CartoDB',
        maxZoom: 19,
        detectRetina: true,
        subdomains: 'abcd',
        pane: 'overlayPane'
      })
    ])
  };

  // デフォルトレイヤー（地形）を追加
  mapLayers[currentMapLayer].addTo(map);

  // レイヤー切り替えコントロールを追加
  addLayerControl();

  // 親トリップ表示時の地図上の旅行記・動画・アニメボタン、トリップ名クリック用イベント委譲
  const mapContainer = map.getContainer();
  if (mapContainer) {
    mapContainer.addEventListener('click', (e) => {
      // トリップ名のクリック（子トリップへの遷移）
      const tripNameEl = e.target.closest('.map-trip-action-name-clickable');
      if (tripNameEl) {
        const card = e.target.closest('.map-trip-action-card');
        if (!card) return;
        const tripId = card.dataset.tripId;
        if (!tripId) return;
        const trip = (myTrips || []).find(t => t.id === tripId);
        if (!trip) return;
        e.preventDefault();
        e.stopPropagation();
        loadTripById(tripId);
        return;
      }

      // ボタンのクリック（旅行記・動画・アニメ表示）
      const btn = e.target.closest('.map-trip-action-travelogue, .map-trip-action-video, .map-trip-action-anime');
      if (!btn) return;
      const card = e.target.closest('.map-trip-action-card');
      if (!card) return;
      const tripId = card.dataset.tripId;
      if (!tripId) return;
      const trip = (myTrips || []).find(t => t.id === tripId);
      if (!trip) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains('map-trip-action-travelogue')) {
        showTravelogueModal(trip);
      } else if (btn.classList.contains('map-trip-action-video')) {
        playVideoSequence(getTripVideoUrlsForTrip(trip));
      } else if (btn.classList.contains('map-trip-action-anime')) {
        let animes = [];
        if (trip.isParent) {
          // 親トリップの場合、全ての子トリップのアニメを取得
          const childTrips = getChildTrips(trip.id);
          childTrips.forEach(child => {
            const childAnimes = child.generatedAnimes || child.animes || [];
            animes = animes.concat(childAnimes);
          });
        } else {
          animes = trip.generatedAnimes || trip.animes || [];
        }
        if (animes.length > 0) {
          showAnimeImageViewer(animes, trip.name);
        }
      }
    });
  }
}

function addLayerControl() {
  const layerControl = L.control({ position: 'topright' });

  layerControl.onAdd = function() {
    const container = L.DomUtil.create('div', 'gmap-layer-control');

    // トグルボタン（レイヤーアイコン）
    const toggleBtn = L.DomUtil.create('div', 'gmap-layer-toggle', container);
    toggleBtn.innerHTML = '🗺️';
    toggleBtn.title = 'レイヤーを選択';

    // レイヤーパネル（初期は非表示）
    const panel = L.DomUtil.create('div', 'gmap-layer-panel', container);
    panel.style.display = 'none';

    const layers = [
      { key: 'standard', label: '地図', icon: '🗺️' },
      { key: 'terrain', label: '地形', icon: '⛰️' },
      { key: 'satellite', label: '航空写真', icon: '🛰️' }
    ];

    layers.forEach(({ key, label, icon }) => {
      const btn = L.DomUtil.create('div', 'gmap-layer-btn', panel);
      btn.dataset.layer = key;

      const iconEl = L.DomUtil.create('div', 'gmap-layer-icon', btn);
      iconEl.textContent = icon;

      const labelEl = L.DomUtil.create('div', 'gmap-layer-label', btn);
      labelEl.textContent = label;

      if (key === currentMapLayer) {
        btn.classList.add('active');
      }

      L.DomEvent.on(btn, 'click', function(e) {
        L.DomEvent.preventDefault(e);
        L.DomEvent.stopPropagation(e);

        // すべてのボタンからactiveクラスを削除
        panel.querySelectorAll('.gmap-layer-btn').forEach(b => {
          b.classList.remove('active');
        });

        // クリックされたボタンにactiveクラスを追加
        btn.classList.add('active');

        // トグルボタンのアイコンを更新
        toggleBtn.innerHTML = icon;

        switchMapLayer(key);
        panel.style.display = 'none';
      });
    });

    // トグルボタンのクリックイベント
    L.DomEvent.on(toggleBtn, 'click', function(e) {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    // マップクリック時にパネルを閉じる
    map.on('click', function() {
      panel.style.display = 'none';
    });

    // クリックイベントがマップに伝播しないようにする
    L.DomEvent.disableClickPropagation(container);

    return container;
  };

  layerControl.addTo(map);
}

function switchMapLayer(layerKey) {
  if (!mapLayers[layerKey] || layerKey === currentMapLayer) return;

  // 現在のレイヤーを削除
  if (mapLayers[currentMapLayer]) {
    map.removeLayer(mapLayers[currentMapLayer]);
  }

  // 新しいレイヤーを追加
  mapLayers[layerKey].addTo(map);
  currentMapLayer = layerKey;

  console.log(`マップレイヤー切り替え: ${layerKey}`);
}

async function initMap3d() {
  if (map3d) return;
  // 3D地図が必要になった時点でMapbox GL JSを読み込む（失敗時は2Dで続行）
  const mapboxReady = await loadMapboxGl();
  if (!mapboxReady) return;

  return new Promise((resolve) => {
    if (map3d) {
      resolve();
      return;
    }
    if (!window.mapboxgl) {
      console.warn('Mapbox GL JS未読み込み');
      resolve();
      return;
    }
    if (!mapboxgl.accessToken) {
      console.warn('Mapbox アクセストークン未設定 - 3D地図なしで自動再生を続行');
      resolve();
      return;
    }
    const el = document.getElementById('map3d');
    if (!el) {
      resolve();
      return;
    }

    let resolved = false;
    const safeResolve = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    // 15秒タイムアウト: 3D地図が読み込めなくても自動再生を続行
    const timeoutId = setTimeout(() => {
      console.warn('Mapbox 3D地図の読み込みタイムアウト - 3D地図なしで続行');
      safeResolve();
    }, 15000);

    try {
      const center = map.getCenter();

      // 航空写真モードの場合（Mapbox Satellite Streets スタイル）
      if (currentMapLayer === 'satellite') {
        map3d = new mapboxgl.Map({
          container: 'map3d',
          zoom: 17,
          center: [center.lng, center.lat],
          pitch: 60,
          bearing: 0,
          antialias: false,
          preserveDrawingBuffer: false,
          style: 'mapbox://styles/mapbox/satellite-streets-v12',
          maxZoom: 20,
          maxPitch: 85,
          minPitch: 0,
          renderWorldCopies: false,
          fadeDuration: 0,
          attributionControl: false,
          refreshExpiredTiles: false
        });
      } else {
        // ベクトル地図モード（Mapbox標準スタイル + 3D建物表示）
        map3d = new mapboxgl.Map({
          container: 'map3d',
          zoom: 17,
          center: [center.lng, center.lat],
          pitch: 60,
          bearing: 0,
          antialias: false,
          preserveDrawingBuffer: false,
          style: 'mapbox://styles/mapbox/streets-v12',
          maxZoom: 20,
          maxPitch: 85,
          minPitch: 0,
          renderWorldCopies: false,
          fadeDuration: 0,
          attributionControl: false,
          refreshExpiredTiles: false
        });
      }
      map3d.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');

      map3d.on('error', (e) => {
        console.error('Mapbox 3D地図エラー:', e);
        clearTimeout(timeoutId);
        map3d = null;
        safeResolve();
      });

      map3d.on('load', () => {
        clearTimeout(timeoutId);
        try {
          // 地形を設定（衛星モードのみ）
          if (currentMapLayer === 'satellite') {
            if (map3d.getSource('mapbox-dem')) {
              map3d.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
            }
          }

          // 3D建物を有効化（すべてのモードで）
          const layers = map3d.getStyle().layers;
          const buildingLayer = layers.find(layer => layer.id === 'building');
          if (buildingLayer) {
            map3d.removeLayer('building');
            map3d.addLayer({
              id: 'building-3d',
              type: 'fill-extrusion',
              source: buildingLayer.source,
              'source-layer': buildingLayer['source-layer'] || 'building',
              minzoom: 15.5,
              paint: {
                'fill-extrusion-color': [
                  'case',
                  ['==', ['get', 'type'], 'building:part'],
                  '#d0d0d0',
                  '#c0c0c0'
                ],
                'fill-extrusion-height': [
                  'interpolate', ['linear'], ['zoom'],
                  15.5, 0, 16, ['get', 'height']
                ],
                'fill-extrusion-base': [
                  'interpolate', ['linear'], ['zoom'],
                  15.5, 0, 16, ['get', 'min_height']
                ],
                'fill-extrusion-opacity': 0.8
              }
            });
          }

          // 霧効果で遠景に深みを追加
          map3d.setFog({
            range: [1.0, 12],
            color: '#E8F0F8',
            'horizon-blend': 0.05,
            'high-color': '#C8DCF0',
            'space-color': '#A0C0E0',
            'star-intensity': 0.1
          });

          map3d.resize();
        } catch (e) {
          console.warn('Mapbox 3D地図セットアップエラー:', e);
        }
        safeResolve();
      });
    } catch (e) {
      console.error('Mapbox 3D地図初期化エラー:', e);
      clearTimeout(timeoutId);
      map3d = null;
      safeResolve();
    }
  });
}

/** 自動再生中の現在ポイントのパルスマーカーだけを軽量に更新（再生成せずsetLatLngで移動） */
function updatePlaybackPulseMarker() {
  if (!map) return;
  if (!document.body.classList.contains('app-playing')) {
    if (playbackPulseMarker) {
      try { map.removeLayer(playbackPulseMarker); } catch (e) { /* ignore */ }
      playbackPulseMarker = null;
    }
    return;
  }
  if (!playbackPhotos || !playbackPhotos.length) return;
  const p = playbackPhotos[currentPhotoIndex];
  if (!p || p.lat == null || p.lng == null) return;
  const coord = ensureLatLng(p.lat, p.lng);
  if (!coord) return;
  const color = currentTrip?.color || '#e1306c';

  if (playbackPulseMarker) {
    // 既存マーカーを座標移動のみで再利用（DOM生成・アニメーション再起動コスト排除）
    playbackPulseMarker.setLatLng([coord.lat, coord.lng]);
    // カラーが変わった場合のみアイコンを更新
    const el = playbackPulseMarker.getElement();
    if (el) el.querySelector('.playback-pulse-marker')?.style.setProperty('--pulse-color', color);
  } else {
    const pulseHtml = `<div class="playback-pulse-marker" style="--pulse-color:${color}"></div>`;
    playbackPulseMarker = L.marker([coord.lat, coord.lng], {
      icon: L.divIcon({
        className: '',
        html: pulseHtml,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
      }),
      zIndexOffset: 2000
    }).addTo(map);
  }
}

async function add3dMapRouteAndMarkers() {
  if (!map3d || !currentTrip) return;

  // 既存のレイヤーとソースをクリア
  if (map3d.getLayer('route-glow')) map3d.removeLayer('route-glow');
  if (map3d.getLayer('route')) map3d.removeLayer('route');
  if (map3d.getSource('route')) map3d.removeSource('route');
  if (map3d.getLayer('points-glow')) map3d.removeLayer('points-glow');
  if (map3d.getLayer('points')) map3d.removeLayer('points');
  if (map3d.getSource('points')) map3d.removeSource('points');

  const photos = getDisplayPhotos();
  const color = currentTrip.color || '#e1306c';

  // GPXルートを取得
  let routeCoords = [];
  try {
    const gpxText = await getGpxContent(currentTrip);
    if (gpxText) {
      const pts = parseGpxPoints(gpxText);
      routeCoords = pts.map(pt => [pt[1], pt[0]]); // [lng, lat]
    }
  } catch (e) {
    console.warn('GPX取得エラー:', e);
  }

  // GPXがない場合は写真の位置を線でつなぐ
  if (routeCoords.length === 0 && photos.length > 0) {
    routeCoords = photos
      .filter(p => p.lat != null && p.lng != null)
      .map(p => [p.lng, p.lat]);
  }

  // ルートを追加
  if (routeCoords.length >= 2) {
    map3d.addSource('route', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: routeCoords
        }
      }
    });

    // グロー（発光）レイヤー — ルートを目立たせる
    map3d.addLayer({
      id: 'route-glow',
      type: 'line',
      source: 'route',
      paint: {
        'line-color': color,
        'line-width': 22,
        'line-opacity': 0.25,
        'line-blur': 6
      }
    });
    map3d.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      paint: {
        'line-color': color,
        'line-width': 10,
        'line-opacity': 1.0
      }
    });
  }

  // ポイントマーカーを追加
  const pointFeatures = photos
    .filter(p => p.lat != null && p.lng != null)
    .map((p, i) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [p.lng, p.lat]
      },
      properties: {
        name: p.name || `#${i + 1}`,
        landmarkNo: p.landmarkNo || '',
        isLandmark: !!(p.landmarkNo)
      }
    }));

  if (pointFeatures.length > 0) {
    map3d.addSource('points', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: pointFeatures
      }
    });

    // グロー（発光）レイヤー — ポイントを目立たせる
    map3d.addLayer({
      id: 'points-glow',
      type: 'circle',
      source: 'points',
      paint: {
        'circle-radius': 22,
        'circle-color': color,
        'circle-opacity': 0.2,
        'circle-blur': 1
      }
    });
    map3d.addLayer({
      id: 'points',
      type: 'circle',
      source: 'points',
      paint: {
        'circle-radius': 11,
        'circle-color': color,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
        'circle-opacity': 1.0
      }
    });
  }

  // 全ポイントが収まるようにカメラを調整
  const allCoords = [...routeCoords];
  if (pointFeatures.length > 0) {
    pointFeatures.forEach(f => allCoords.push(f.geometry.coordinates));
  }

  if (allCoords.length > 0) {
    if (allCoords.length === 1) {
      // 単一ポイントの場合
      const [lng, lat] = allCoords[0];
      map3d.flyTo({
        center: [lng, lat],
        zoom: 16,
        pitch: 60,
        duration: 1000
      });
    } else {
      // 複数ポイントの場合、bounds を計算
      const lngs = allCoords.map(c => c[0]);
      const lats = allCoords.map(c => c[1]);
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);

      map3d.fitBounds(
        [[minLng, minLat], [maxLng, maxLat]],
        {
          padding: { top: 50, bottom: 50, left: 50, right: 50 },
          maxZoom: 17,
          pitch: 60,
          duration: 1000
        }
      );
    }
  }
}

function setMap3dView(lat, lng, zoom) {
  if (map3d && playTimer) {
    map3d.setCenter([lng, lat]);
    map3d.setZoom(zoom ?? 17);
    if (map3d.getPitch() < 70) map3d.setPitch(78);
  }
}

function initMapSearch() {
  const input = document.getElementById('mapSearchInput');
  if (!input) return;
  input.addEventListener('keypress', async (e) => {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data[0]) {
        const { lat, lon, display_name } = data[0];
        const searchLat = parseFloat(lat);
        const searchLon = parseFloat(lon);

        // 前の検索マーカーを削除
        if (searchMarker) {
          map.removeLayer(searchMarker);
          searchMarker = null;
        }

        // 新しい検索マーカーを追加
        const searchIcon = L.divIcon({
          html: '<div style="background:#ff4444;width:32px;height:32px;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;">📍</div>',
          className: 'search-marker-icon',
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        });

        searchMarker = L.marker([searchLat, searchLon], { icon: searchIcon }).addTo(map);
        searchMarker.bindPopup(`<div style="text-align:center;"><strong>${display_name}</strong></div>`).openPopup();

        map.setView([searchLat, searchLon], 14);
      } else {
        alert('場所が見つかりませんでした');
      }
    } catch (err) {
      console.warn('検索エラー:', err);
      alert('検索に失敗しました');
    }
  });
}

const MAX_PHOTO_DIM = 1920;
const PHOTO_JPEG_QUALITY = 0.85;
// サムネイル: 地図マーカー(50px)・一覧(100px前後)向け。Retinaを考慮して320pxに縮小する
const THUMB_PHOTO_DIM = 320;
const THUMB_JPEG_QUALITY = 0.75;
// 写真はパスにタイムスタンプを含み上書きされないため、長期キャッシュを許可する
const PHOTO_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** dataUrl を指定の最大辺まで縮小した JPEG Blob を返す */
function resizeImageToBlob(dataUrl, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round(h * maxDim / w);
          w = maxDim;
        } else {
          w = Math.round(w * maxDim / h);
          h = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob || new Blob()), 'image/jpeg', quality);
    };
    img.onerror = () => resolve(new Blob());
    img.src = dataUrl;
  });
}

function compressImageToBlob(dataUrl) {
  return resizeImageToBlob(dataUrl, MAX_PHOTO_DIM, PHOTO_JPEG_QUALITY);
}

/** 一覧・マーカー表示用のサムネイル Blob を生成する */
function createThumbnailBlob(dataUrl) {
  return resizeImageToBlob(dataUrl, THUMB_PHOTO_DIM, THUMB_JPEG_QUALITY);
}

async function uploadPhotoToStorage(tripId, photoIndex, blob) {
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');
  const path = `trips/${tripId}/photos/${photoIndex}_${Date.now()}.jpg`;
  const ref = window.firebaseStorage.ref(path);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ref.put(blob, { contentType: 'image/jpeg', cacheControl: PHOTO_CACHE_CONTROL });
      return await ref.getDownloadURL();
    } catch (e) {
      const isRetryable = e?.message?.includes('Failed to fetch') || e?.message?.includes('NetworkError');
      if (attempt < 3 && isRetryable) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      } else {
        throw e;
      }
    }
  }
}

/**
 * サムネイルをStorageにアップロードしURLを返す。
 * 失敗しても本体写真の登録は続行させたいため、エラー時は null を返す。
 */
async function uploadThumbnailToStorage(tripId, photoIndex, blob) {
  if (!blob || blob.size === 0) return null;
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) return null;
  try {
    const path = `trips/${tripId}/thumbs/${photoIndex}_${Date.now()}.jpg`;
    const ref = window.firebaseStorage.ref(path);
    await ref.put(blob, { contentType: 'image/jpeg', cacheControl: PHOTO_CACHE_CONTROL });
    return await ref.getDownloadURL();
  } catch (e) {
    console.warn('サムネイルのアップロードに失敗（本体写真で代替）:', e);
    return null;
  }
}

/** 表示用の画像URL: サムネイルがあればそれを、無ければ本体写真を返す */
function getPhotoThumbUrl(p) {
  return p?.thumbUrl || p?.url || '';
}

async function deletePhotoFromStorage(photoUrl) {
  if (!photoUrl || !window.firebaseStorage) return;
  try {
    const ref = window.firebaseStorage.refFromURL(photoUrl);
    await ref.delete();
  } catch (e) {
    console.warn('写真の削除に失敗:', photoUrl, e);
  }
}

async function deleteAllTripFiles(trip) {
  if (!trip || !window.firebaseStorage) return;
  const deletePromises = [];

  // 全ての写真（本体・サムネイル）を削除
  if (trip.photos && Array.isArray(trip.photos)) {
    for (const photo of trip.photos) {
      if (photo.url) {
        deletePromises.push(deletePhotoFromStorage(photo.url));
      }
      if (photo.thumbUrl) {
        deletePromises.push(deletePhotoFromStorage(photo.thumbUrl));
      }
    }
  }

  // GPXファイルを削除
  if (trip.gpxUrl) {
    deletePromises.push((async () => {
      try {
        const ref = window.firebaseStorage.refFromURL(trip.gpxUrl);
        await ref.delete();
      } catch (e) {
        console.warn('GPXの削除に失敗:', trip.gpxUrl, e);
      }
    })());
  }

  // 旅行記HTMLファイルを削除
  if (trip.travelogueUrl) {
    deletePromises.push((async () => {
      try {
        const ref = window.firebaseStorage.refFromURL(trip.travelogueUrl);
        await ref.delete();
      } catch (e) {
        console.warn('旅行記の削除に失敗:', trip.travelogueUrl, e);
      }
    })());
  }

  // アニメ画像を削除（フィールド名は generatedAnimes が現行、animes は旧データの後方互換）
  const animes = [...(trip.generatedAnimes || []), ...(trip.animes || [])];
  for (const anime of animes) {
    if (anime.url) {
      deletePromises.push((async () => {
        try {
          const ref = window.firebaseStorage.refFromURL(anime.url);
          await ref.delete();
        } catch (e) {
          console.warn('アニメ画像の削除に失敗:', anime.url, e);
        }
      })());
    }
  }

  // 旅行記履歴（過去バージョン）のHTMLファイルも削除
  if (trip.travelogueHistory && Array.isArray(trip.travelogueHistory)) {
    for (const entry of trip.travelogueHistory) {
      if (entry.url && entry.url !== trip.travelogueUrl) {
        deletePromises.push((async () => {
          try {
            const ref = window.firebaseStorage.refFromURL(entry.url);
            await ref.delete();
          } catch (e) {
            console.warn('旅行記履歴の削除に失敗:', entry.url, e);
          }
        })());
      }
    }
  }

  await Promise.all(deletePromises);
}

/** 1トリップ1GPX。同じpathで上書きし、最後にアップロードしたGPXのみ保持 */
async function uploadGpxToStorage(tripId, gpxText) {
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');
  const path = `trips/${tripId}/gpx/route.gpx`;
  const ref = window.firebaseStorage.ref(path);
  const blob = new Blob([gpxText], { type: 'application/gpx+xml' });
  await ref.put(blob, { contentType: 'application/gpx+xml' });
  const url = await ref.getDownloadURL();
  gpxCache[url] = gpxText;
  return url;
}

async function uploadTravelogueToStorage(tripId, htmlContent) {
  if (!tripId) {
    throw new Error('tripIdが指定されていません');
  }
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) {
    throw new Error('Storage not ready');
  }
  const path = `trips/${tripId}/travelogue/content.html`;
  const ref = window.firebaseStorage.ref(path);
  const blob = new Blob([htmlContent], { type: 'text/html; charset=utf-8' });
  await ref.put(blob, { contentType: 'text/html; charset=utf-8' });
  const url = await ref.getDownloadURL();
  return url;
}

async function uploadAnimeImageToStorage(tripId, imageDataUrl, filePrefix = 'anime') {
  if (!tripId) {
    throw new Error('tripIdが指定されていません');
  }
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) {
    throw new Error('Storage not ready');
  }

  // Data URLからBase64データとMIMEタイプを抽出
  const matches = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid image data URL');

  const mimeType = matches[1];
  const base64Data = matches[2];

  // Base64をBlobに変換
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });

  // ユニークなファイル名を生成（cover/detailのプリフィックス対応）
  const timestamp = Date.now();
  const extension = mimeType.split('/')[1] || 'jpg';
  const path = `trips/${tripId}/animes/${filePrefix}_${timestamp}.${extension}`;
  const ref = window.firebaseStorage.ref(path);

  await ref.put(blob, { contentType: mimeType });
  const url = await ref.getDownloadURL();
  return url;
}

async function saveCharacterToTrip(tripId, characterImageUrl) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) throw new Error('Not logged in');
  const trip = myTripsMap.get(tripId) || currentTrip;
  if (!trip || trip.id !== tripId) throw new Error('Trip not found');
  const uid = window.firebaseAuth.currentUser.uid;
  if (trip.userId && trip.userId !== uid) throw new Error('Permission denied');

  const update = {
    characterImageUrl: characterImageUrl || null,
    updatedAt: Date.now(),
    userId: uid
  };
  if (trip.name) update.name = trip.name;
  if (trip.createdAt) update.createdAt = trip.createdAt;

  await window.firebaseDb.collection('trips').doc(tripId).set(update, { merge: true });

  const updated = myTripsMap.get(tripId);
  if (updated) updated.characterImageUrl = characterImageUrl;
  if (currentTrip?.id === tripId) currentTrip.characterImageUrl = characterImageUrl;

  if (!tripOrder.includes(tripId)) {
    try {
      const res = await saveTripOrder([...tripOrder, tripId]);
      if (!res.ok) console.warn('順序の保存に失敗:', res.err);
    } catch (_) {}
  }
  await loadMyTrips();
  const saved = myTripsMap.get(tripId);
  if (saved && currentTrip?.id === tripId) {
    currentTrip = { ...saved, id: saved.id };
  }
}

async function uploadCharacterImageToStorage(tripId, imageDataUrl) {
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');
  const matches = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid image data URL');
  const mimeType = matches[1];
  const base64Data = matches[2];
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });
  const extension = mimeType.split('/')[1] || 'jpg';
  const path = `trips/${tripId}/character.${extension}`;
  const ref = window.firebaseStorage.ref(path);
  await ref.put(blob, { contentType: mimeType });
  return await ref.getDownloadURL();
}

async function deleteAnimeImageFromStorage(imageUrl) {
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');
  try {
    const ref = window.firebaseStorage.refFromURL(imageUrl);
    await ref.delete();
  } catch (err) {
    console.error('画像削除エラー:', err);
    // URLが既に削除されている場合はエラーを無視
    if (err.code !== 'storage/object-not-found') {
      throw err;
    }
  }
}

/** GPXのgpxDataUrlをFirestoreに即時保存（トリップと紐づけ） */
async function persistGpxToTrip(tripId, gpxDataUrl, gpxFileName) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return;
  const uid = window.firebaseAuth.currentUser.uid;
  const data = { gpxDataUrl, updatedAt: Date.now(), userId: uid };
  if (gpxFileName) data.gpxFileName = gpxFileName;
  await window.firebaseDb.collection('trips').doc(tripId).set(data, { merge: true });
}

async function fetchGpxFromUrl(url) {
  // 1. メモリキャッシュ（最速）
  if (gpxCache[url]) return gpxCache[url];

  // 2. IndexedDB キャッシュ（ページリロード後も有効・24時間）
  const idbCached = await getGpxFromIDB(url);
  if (idbCached) {
    gpxCache[url] = idbCached; // メモリにも載せる
    console.log('✓ GPX IndexedDBキャッシュから取得:', url.slice(-40));
    return idbCached;
  }

  // 3. ネットワーク取得 → 両キャッシュに保存
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`GPX 取得失敗: ${url} (ステータス: ${res.status})`);
      throw new Error(`GPX fetch failed: ${res.status}`);
    }
    const text = await res.text();
    gpxCache[url] = text;
    saveGpxToIDB(url, text); // 非同期・fire-and-forget（失敗しても無視）
    return text;
  } catch (err) {
    console.error('GPX 取得エラー:', url, err);
    if (err.message?.includes('Failed to fetch') || err.name === 'TypeError') {
      showCorsWarning();
    }
    throw err;
  }
}

async function getGpxContent(trip) {
  if (trip?.gpxData) return trip.gpxData;
  if (trip?.gpxDataUrl) {
    try {
      return await fetchGpxFromUrl(trip.gpxDataUrl);
    } catch (err) {
      console.warn('GPX 取得失敗（CORS エラーの可能性）:', trip.name || trip.id);
      return null;
    }
  }
  return null;
}

function ensureLatLng(lat, lng) {
  const la = parseFloat(lat);
  const lo = parseFloat(lng);
  if (isNaN(la) || isNaN(lo)) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { lat: la, lng: lo };
}

async function loadPhotoWithExif(file) {
  const data = await file.arrayBuffer();
  let lat = null, lng = null, date = null;
  try {
    const exif = await exifr.parse(data, { pick: ['latitude', 'longitude', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef', 'DateTimeOriginal'] });
    if (exif?.latitude != null && exif?.longitude != null) {
      const r = ensureLatLng(exif.latitude, exif.longitude);
      if (r) { lat = r.lat; lng = r.lng; }
    }
    if ((lat == null || lng == null) && exif?.GPSLatitude && exif?.GPSLongitude) {
      const gpsLat = Array.isArray(exif.GPSLatitude) ? exif.GPSLatitude[0] + exif.GPSLatitude[1] / 60 + (exif.GPSLatitude[2] || 0) / 3600 : exif.GPSLatitude;
      const gpsLon = Array.isArray(exif.GPSLongitude) ? exif.GPSLongitude[0] + exif.GPSLongitude[1] / 60 + (exif.GPSLongitude[2] || 0) / 3600 : exif.GPSLongitude;
      const signLat = (exif.GPSLatitudeRef || '') === 'S' ? -1 : 1;
      const signLon = (exif.GPSLongitudeRef || '') === 'W' ? -1 : 1;
      const r = ensureLatLng(signLat * gpsLat, signLon * gpsLon);
      if (r) { lat = r.lat; lng = r.lng; }
    }
    if (exif?.DateTimeOriginal) {
      date = new Date(exif.DateTimeOriginal).toISOString();
    }
  } catch (_) {}
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve) => {
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  let blob = await compressImageToBlob(dataUrl);
  if (!blob || blob.size === 0) {
    blob = new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
  }
  const thumbBlob = await createThumbnailBlob(dataUrl);
  return {
    blob,
    thumbBlob,
    mime: 'image/jpeg',
    lat,
    lng,
    name: file.name,
    placeName: '',
    description: '',
    landmarkNo: '',
    isStamp: false,
    date: date || new Date().toISOString()
  };
}

/** Wikipediaから場所の詳しい情報を取得（座標または地名で検索） */
async function fetchWikipediaForPlace(lat, lng, placeName) {
  const wikiCache = window._wikiCache || (window._wikiCache = new Map());
  const cacheKey = lat != null && lng != null ? `${lat.toFixed(4)}_${lng.toFixed(4)}` : (placeName || '');
  if (wikiCache.has(cacheKey)) return wikiCache.get(cacheKey);
  try {
    let title = null;
    if (lat != null && lng != null) {
      const url = `https://ja.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lng}&gsradius=500&gslimit=1&format=json&origin=*`;
      const res = await fetch(url);
      const data = await res.json();
      const item = data?.query?.geosearch?.[0];
      if (item?.title) title = item.title;
    }
    if (!title && placeName && placeName.trim()) {
      const searchUrl = `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(placeName.trim())}&srlimit=1&format=json&origin=*`;
      const res = await fetch(searchUrl);
      const data = await res.json();
      const item = data?.query?.search?.[0];
      if (item?.title) title = item.title;
    }
    if (!title) {
      wikiCache.set(cacheKey, null);
      return null;
    }
    try {
      const summaryUrl = `https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const sumRes = await fetch(summaryUrl);
      const sumData = await sumRes.json();
      const extract = sumData?.extract || (sumData?.extract_html ? sumData.extract_html.replace(/<[^>]+>/g, '').trim() : null);
      if (extract) {
        const result = { title, extract };
        wikiCache.set(cacheKey, result);
        return result;
      }
    } catch (_) {}
    try {
      const extUrl = `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&exchars=800&format=json&origin=*&titles=${encodeURIComponent(title)}`;
      const extRes = await fetch(extUrl);
      const extData = await extRes.json();
      const pages = extData?.query?.pages || {};
      const page = Object.values(pages)[0];
      const extract = page?.extract?.trim() || null;
      if (extract) {
        const result = { title, extract };
        wikiCache.set(cacheKey, result);
        return result;
      }
    } catch (_) {}
    wikiCache.set(cacheKey, null);
  } catch (_) {}
  return wikiCache.get(cacheKey) ?? null;
}

/** 逆ジオコーディング：町名・市名までを取得（アップロード時に1回だけ呼ぶ） */
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`);
    const data = await res.json();
    const addr = data.address || {};
    const parts = [];
    if (addr.village) parts.push(addr.village);
    if (addr.town) parts.push(addr.town);
    if (addr.city) parts.push(addr.city);
    if (addr.district) parts.push(addr.district);
    if (addr.county && !parts.includes(addr.county)) parts.push(addr.county);
    if (addr.state && parts.length < 2) parts.push(addr.state);
    if (parts.length > 0) return parts.slice(0, 2).join(', ');
    return (data.display_name || '').split(',').map(s => s.trim()).filter(p => p && p !== '日本' && p !== 'Japan').slice(0, 2).join(', ') || '';
  } catch (_) {
    return '';
  }
}

async function getDefaultPhotoLocation() {
  if (currentTrip) {
    try {
      const gpxText = await getGpxContent(currentTrip);
      if (gpxText) {
        const pts = parseGpxPoints(gpxText);
        if (pts.length > 0) return { lat: pts[0][0], lng: pts[0][1] };
      }
    } catch (e) {
      console.warn('GPX取得スキップ（デフォルト位置を使用）:', e);
    }
  }
  if (map) {
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }
  return { lat: 35.6812, lng: 139.7671 };
}

async function handleFiles(files, options = {}) {
  if (!isEditor()) {
    alert('ログインしてください');
    return;
  }
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) {
    alert('Firebase の準備ができていません。ログインを確認してください。');
    return;
  }
  if (!currentTrip) {
    currentTrip = createNewTrip();
  }
  syncFormToCurrentTrip();
  currentTrip.photos = currentTrip.photos || [];
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    alert('画像ファイルを選択してください');
    return;
  }
  try {
    const defaultLoc = await getDefaultPhotoLocation();
    let added = 0;
    for (const file of imageFiles) {
      try {
        const photoData = await loadPhotoWithExif(file);
        if (!photoData?.blob || photoData.blob.size === 0) {
          console.warn('画像の読み込みに失敗しました:', file.name);
          continue;
        }
        let lat = null, lng = null;
        const coord = ensureLatLng(photoData.lat, photoData.lng);
        if (coord) {
          lat = coord.lat;
          lng = coord.lng;
        }
        let placeName = photoData.placeName || '';
        if (lat != null && lng != null) {
          placeName = await reverseGeocode(lat, lng);
        } else {
          lat = defaultLoc.lat;
          lng = defaultLoc.lng;
        }
        const idx = currentTrip.photos.length;
        const url = await uploadPhotoToStorage(currentTrip.id, idx, photoData.blob);
        const thumbUrl = await uploadThumbnailToStorage(currentTrip.id, idx, photoData.thumbBlob);
        const photo = {
          url,
          thumbUrl,
          mime: photoData.mime,
          lat,
          lng,
          name: photoData.name,
          placeName,
          description: photoData.description,
          landmarkNo: photoData.landmarkNo,
          isStamp: photoData.isStamp,
          date: photoData.date
        };
        currentTrip.photos.push(photo);
        added++;
      } catch (err) {
        console.error('写真アップロードエラー:', file.name, err);
        const msg = err.message || String(err);
        let hint = '';
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
          hint = '\n\nネットワーク接続を確認してください。file:// で開いている場合は、ローカルサーバー（python3 -m http.server 8080）で起動してください。';
        }
        alert(`「${file.name}」のアップロードに失敗しました: ${msg}${hint}`);
      }
    }

    // GPS地名からトリップ名・説明を自動セット（どちらも未入力の場合）
    const nameEl = document.getElementById('tripNameInput');
    const descEl = document.getElementById('tripDescInput');
    if (nameEl && descEl && added > 0) {
      const firstGeo = currentTrip.photos.find(p => p.placeName);
      if (firstGeo?.placeName) {
        if (!nameEl.value.trim()) {
          nameEl.value = firstGeo.placeName;
          currentTrip.name = firstGeo.placeName;
        }
        if (!descEl.value.trim()) {
          descEl.value = firstGeo.placeName;
          currentTrip.description = firstGeo.placeName;
        }
      }
    }

    renderThumbnails();
    await updateMapMarkers();
    await updateTripInputs();
    await renderTripDetailPane();
    if (added > 0 && options.autoSave) {
      const nameEl = document.getElementById('tripNameInput');
      if (nameEl && !nameEl.value.trim()) nameEl.value = '無題';
      await saveTrip();
      setStatus(`写真 ${added} 枚を追加して保存しました`);
    } else {
      setStatus(added > 0 ? `写真 ${added} 枚を追加しました` : '写真を追加できませんでした');
    }
  } catch (err) {
    console.error('写真処理エラー:', err);
    const msg = err.message || String(err);
    let hint = '';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      hint = window.location.protocol === 'file:'
        ? '\n\nfile:// では動作しません。ターミナルで:\ncd air && python3 -m http.server 8080\nを実行し、http://localhost:8080 で開いてください。'
        : '\n\nネットワーク接続を確認してください。VPN・ファイアウォール・広告ブロッカーが通信をブロックしている可能性があります。';
    }
    alert('写真の処理に失敗しました: ' + msg + hint);
  }
}

function createNewTrip(parentId = null) {
  const id = 'trip_' + Date.now();
  const color = TRIP_COLORS[Math.floor(Math.random() * TRIP_COLORS.length)];
  return {
    id,
    name: '',
    description: '',
    url: '',
    videoUrl: null,
    public: false,
    color,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    parentId: parentId || null,
    isParent: false,
    date: null,
    photos: [],
    gpxData: null,
    gpxDataUrl: null,
    userId: window.firebaseAuth?.currentUser?.uid || ''
  };
}

function syncFormToCurrentTrip() {
  if (!currentTrip) return;
  const nameEl = document.getElementById('tripNameInput');
  const descEl = document.getElementById('tripDescInput');
  const urlEl = document.getElementById('tripUrlInput');
  const videoUrlEl = document.getElementById('tripVideoUrlInput');
  const publicEl = document.getElementById('tripPublicInput');
  const parentInput = document.getElementById('tripParentInput');
  const parentSelect = document.getElementById('tripParentSelect');
  const colorEl = document.getElementById('tripColorInput');
  if (nameEl) currentTrip.name = nameEl.value.trim();
  if (descEl) currentTrip.description = descEl.value.trim() || '';
  if (urlEl) currentTrip.url = urlEl.value.trim() || '';
  if (videoUrlEl) currentTrip.videoUrl = videoUrlEl.value.trim() || null;
  if (publicEl) currentTrip.public = publicEl.checked;
  if (parentInput) currentTrip.isParent = parentInput.checked;
  if (parentSelect) currentTrip.parentId = currentTrip.isParent ? null : (parentSelect.value?.trim() || null);
  if (colorEl) currentTrip.color = colorEl.value || TRIP_COLORS[0];
}

function updateTripMenuThumbnail() {
  const wrap = document.getElementById('tripThumbnailWrap');
  const container = document.getElementById('tripMenuThumbnails');
  const gpsBtn = document.getElementById('tripMenuGpsBtn');
  if (!wrap || !container || !gpsBtn) return;

  // ログイン中かつトリップがあり、写真がある場合のみ表示
  const isEditor = document.body.classList.contains('editor');
  const photos = isEditor && currentTrip ? (currentTrip.photos || []).filter(p => p.url) : [];

  if (!isEditor || photos.length === 0) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = '';
  container.innerHTML = photos
    .map((photo, idx) => `
      <div class="trip-menu-thumbnail-item" draggable="true" data-index="${idx}">
        <img src="${escapeHtml(getPhotoThumbUrl(photo))}" alt="写真${idx + 1}" loading="lazy" decoding="async" title="${escapeHtml(photo.name || photo.placeName || '写真')}">
        <button type="button" class="trip-menu-thumbnail-delete" title="削除">✕</button>
      </div>
    `)
    .join('');

  // GPS button state sync
  const isActive = typeof addingGpsPointMode !== 'undefined' && addingGpsPointMode;
  gpsBtn.classList.toggle('active', isActive);
  gpsBtn.onclick = () => toggleAddGpsPointMode();

  // ドラッグ&ドロップで並び替え
  let draggedIndex = null;
  container.querySelectorAll('.trip-menu-thumbnail-item').forEach((item, idx) => {
    item.ondragstart = (e) => {
      draggedIndex = idx;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    };
    item.ondragend = () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.trip-menu-thumbnail-item').forEach(i => i.classList.remove('drag-over'));
    };
    item.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const overIdx = parseInt(item.dataset.index);
      if (draggedIndex !== null && draggedIndex !== overIdx) {
        item.classList.add('drag-over');
      }
    };
    item.ondragleave = () => {
      item.classList.remove('drag-over');
    };
    item.ondrop = (e) => {
      e.preventDefault();
      if (draggedIndex !== null && draggedIndex !== idx) {
        const draggedPhoto = currentTrip.photos[draggedIndex];
        currentTrip.photos.splice(draggedIndex, 1);
        currentTrip.photos.splice(idx, 0, draggedPhoto);
        saveTrip({ silent: true });
        updateTripMenuThumbnail();
      }
    };
  });

  // 写真クリックで該当写真を表示
  container.querySelectorAll('img').forEach(img => {
    img.onclick = () => {
      const item = img.closest('.trip-menu-thumbnail-item');
      const idx = parseInt(item.dataset.index);
      showPhotoAtIndex(idx, true);
    };
  });

  // 削除ボタンイベント
  container.querySelectorAll('.trip-menu-thumbnail-delete').forEach((deleteBtn, btnIdx) => {
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (confirm('この写真を削除しますか？')) {
        const item = deleteBtn.closest('.trip-menu-thumbnail-item');
        const idx = parseInt(item.dataset.index);
        currentTrip.photos.splice(idx, 1);
        saveTrip({ silent: true });
        updateTripMenuThumbnail();
        scheduleMapMarkersUpdate();
        renderThumbnails();
      }
    };
  });
}

async function updateTripInputs() {
  await updateHeaderInfo();
  const gpxZone = document.getElementById('gpxZone');
  const gpxLabel = gpxZone?.querySelector('span:last-of-type');
  if (!currentTrip) {
    if (gpxLabel) gpxLabel.textContent = 'GPXファイル';
    updateCharacterPreview();
    return;
  }
  document.getElementById('tripNameInput').value = currentTrip.name || '';
  document.getElementById('tripDescInput').value = currentTrip.description || '';
  document.getElementById('tripUrlInput').value = currentTrip.url || '';
  document.getElementById('tripVideoUrlInput').value = currentTrip.videoUrl || '';
  document.getElementById('tripPublicInput').checked = !!currentTrip.public;
  document.getElementById('tripParentInput').checked = !!currentTrip.isParent;
  document.getElementById('tripColorInput').value = currentTrip.color || TRIP_COLORS[0];
  const parentWrap = document.getElementById('tripParentSelectWrap');
  const childrenWrap = document.getElementById('tripParentChildrenWrap');
  if (parentWrap) parentWrap.style.display = currentTrip.isParent ? 'none' : '';
  if (childrenWrap) childrenWrap.style.display = currentTrip.isParent && isEditor() ? '' : 'none';
  refreshTripParentSelectOptions();

  // 親トリップIDを設定（親トリップでない場合のみ）
  const parentSelect = document.getElementById('tripParentSelect');
  if (parentSelect && !currentTrip.isParent) {
    parentSelect.value = currentTrip.parentId || '';
  }

  if (currentTrip.isParent && isEditor()) renderParentTripChildren(currentTrip.id);
  renderColorSwatches();
  if (gpxLabel && currentTrip.gpxDataUrl) {
    gpxLabel.textContent = currentTrip.gpxFileName || 'GPXファイル（アップロード済み）';
  } else if (gpxLabel && currentTrip?.gpxData) {
    gpxLabel.textContent = currentTrip.gpxFileName || 'GPXファイル（未アップロード）';
  } else if (gpxLabel) {
    gpxLabel.textContent = 'GPXファイル';
  }
  updateCharacterPreview();
  updateViewerSection();
  updateTripMenuThumbnail();
}

function updateCharacterPreview() {
  const characterPreview = document.getElementById('characterPreview');
  const characterPreviewImg = document.getElementById('characterPreviewImg');
  const characterImageInput = document.getElementById('characterImageInput');
  if (!characterPreview || !characterPreviewImg) return;
  if (!currentTrip || currentTrip.isParent) {
    characterImageData = null;
    characterPreview.style.display = 'none';
    if (characterImageInput) characterImageInput.value = '';
    return;
  }
  if (currentTrip.characterImageUrl) {
    characterPreviewImg.src = currentTrip.characterImageUrl;
    characterPreview.style.display = 'flex';
    characterImageData = null;
  } else if (characterImageData) {
    characterPreviewImg.src = characterImageData;
    characterPreview.style.display = 'flex';
  } else {
    characterPreview.style.display = 'none';
    if (characterImageInput) characterImageInput.value = '';
  }
}

function updateViewerSection() {
  const viewerSection = document.getElementById('viewerTripSection');
  if (!viewerSection) return;

  // ログイン時は表示しない
  if (isEditor()) {
    viewerSection.style.display = 'none';
    return;
  }

  // トリップが選択されていない場合は非表示
  if (!currentTrip) {
    viewerSection.style.display = 'none';
    return;
  }

  // トリップ情報を表示
  viewerSection.style.display = '';

  const nameEl = document.getElementById('viewerTripName');
  const descEl = document.getElementById('viewerTripDesc');
  const descWrap = document.getElementById('viewerTripDescWrap');
  const parentTripWrap = document.getElementById('viewerParentTripWrap');
  const parentTripEl = document.getElementById('viewerParentTrip');
  const childTripsWrap = document.getElementById('viewerChildTripsWrap');
  const childTripsEl = document.getElementById('viewerChildTrips');
  const travelogueBtn = document.getElementById('viewerTravelogueBtn');
  const videoBtn = document.getElementById('viewerVideoBtn');
  const stampBtn = document.getElementById('viewerStampBtn');
  const animeWrap = document.getElementById('viewerAnimeWrap');
  const animesList = document.getElementById('viewerAnimesList');

  // 親トリップの表示
  if (parentTripWrap && parentTripEl) {
    if (currentTrip.parentId) {
      const parentTrip = getOrderedTrips().find(t => t.id === currentTrip.parentId);
      if (parentTrip) {
        parentTripEl.textContent = `📁 ${parentTrip.name || '（無題）'}`;
        parentTripEl.onclick = async () => {
          await loadTripById(parentTrip.id);
        };
        parentTripWrap.style.display = '';
      } else {
        parentTripWrap.style.display = 'none';
      }
    } else {
      parentTripWrap.style.display = 'none';
    }
  }

  // 子トリップの表示（親トリップの場合）
  if (childTripsWrap && childTripsEl) {
    if (currentTrip.isParent) {
      const childTrips = getChildTrips(currentTrip.id);
      if (childTrips.length > 0) {
        childTripsEl.innerHTML = '';
        childTrips.forEach(child => {
          const item = document.createElement('div');
          item.className = 'viewer-child-trip-item';
          item.textContent = child.name || '（無題）';
          item.onclick = async () => {
            await loadTripById(child.id);
          };
          childTripsEl.appendChild(item);
        });
        childTripsWrap.style.display = '';
      } else {
        childTripsWrap.style.display = 'none';
      }
    } else {
      childTripsWrap.style.display = 'none';
    }
  }

  // トリップ名
  if (nameEl) {
    const tripName = currentTrip.name || '（無題）';
    nameEl.textContent = tripName;
  }

  // トリップ説明（ブログURLがある場合は説明自体をリンク化）
  if (descEl && descWrap) {
    const desc = currentTrip.description || '';
    if (desc) {
      if (currentTrip.url) {
        // ブログURLがある場合は説明自体をリンクにする
        descEl.innerHTML = `<a href="${escapeHtml(currentTrip.url)}" target="_blank" rel="noopener" class="viewer-trip-desc-link">${escapeHtml(desc)}</a>`;
      } else {
        descEl.textContent = desc;
      }
      descWrap.style.display = '';
    } else if (currentTrip.url) {
      // 説明がなくてもブログURLがあれば表示
      descEl.innerHTML = `<a href="${escapeHtml(currentTrip.url)}" target="_blank" rel="noopener" class="viewer-trip-link">📝 ブログを見る</a>`;
      descWrap.style.display = '';
    } else {
      descWrap.style.display = 'none';
    }
  }

  // 旅行記ボタン（直近の旅行記があれば表示: travelogueUrl/Html または履歴の最新）
  if (travelogueBtn) {
    const hasTravelogue = tripHasTravelogue(currentTrip);
    travelogueBtn.style.display = hasTravelogue ? '' : 'none';
  }

  // 動画ボタン（トリップまたはポイントに動画URLがあれば表示）
  if (videoBtn) {
    videoBtn.style.display = getTripVideoUrls().length > 0 ? '' : 'none';
  }

  // スタンプボタン
  if (stampBtn) {
    let hasStamps = false;
    if (currentTrip.isParent) {
      // 親トリップの場合は子トリップのスタンプをチェック
      const childTrips = getChildTrips(currentTrip.id);
      hasStamps = childTrips.some(child => (child.photos || []).some(p => p.isStamp));
    } else {
      hasStamps = (currentTrip.photos || []).some(p => p.isStamp);
    }
    stampBtn.style.display = hasStamps ? '' : 'none';
  }

  // アニメ画像
  if (animeWrap && animesList) {
    const animes = currentTrip.animes || [];
    if (animes.length > 0) {
      animesList.innerHTML = '';
      animes.forEach((anime, idx) => {
        const img = document.createElement('img');
        img.src = anime.url;
        img.loading = 'lazy';
        img.style.width = '100px';
        img.style.height = '100px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.style.border = '2px solid var(--border)';
        img.title = anime.style || 'アニメ画像';
        img.onclick = () => {
          const list = currentTrip.animes || [];
          showAnimeImageViewer(list, idx, currentTrip?.name);
        };
        animesList.appendChild(img);
      });
      animeWrap.style.display = '';
    } else {
      animeWrap.style.display = 'none';
    }
  }
}

function getDisplayPhotos() {
  if (!currentTrip) return [];
  if (currentTrip.isParent) {
    const children = getChildTrips(currentTrip.id);
    const result = [];
    children.forEach(t => {
      (t.photos || []).forEach((p, i) => result.push({ ...p, _tripId: t.id, _tripName: t.name, _photoIndexInTrip: i }));
    });
    return result;
  }
  return (currentTrip.photos || []).map((p, i) => ({ ...p, _photoIndexInTrip: i }));
}

function reorderThumbnail(fromIndex, toIndex) {
  if (!currentTrip?.photos?.length || currentTrip.isParent) return;
  const photos = [...currentTrip.photos];
  const [removed] = photos.splice(fromIndex, 1);
  photos.splice(toIndex, 0, removed);
  currentTrip.photos = photos;
  currentPhotoIndex = toIndex;
  renderThumbnails();
  scheduleMapMarkersUpdate();
  setStatus('表示順を変更しました。保存してください');
}

async function deleteThumbnail(index) {
  if (!currentTrip?.photos?.length || currentTrip.isParent) return;
  if (!confirm('この写真を削除しますか？')) return;

  // Storageから写真を削除
  const photoUrl = currentTrip.photos[index]?.url;
  if (photoUrl) {
    await deletePhotoFromStorage(photoUrl);
  }

  currentTrip.photos.splice(index, 1);
  currentPhotoIndex = Math.min(index, Math.max(0, currentTrip.photos.length - 1));
  renderThumbnails();
  scheduleMapMarkersUpdate();
  renderTripDetailPane();
  setStatus('写真を削除しました。保存してください');
}

function renderThumbnails() {
  const strip = document.getElementById('thumbnailStrip');
  strip.innerHTML = '';

  // 親トリップの場合はサムネイルを表示しない（地図上のマーカーは表示）
  if (currentTrip?.isParent) {
    strip.style.display = 'none';
    return;
  }

  // thumbnailsVisible が false の場合は非表示
  if (!thumbnailsVisible) {
    strip.style.display = 'none';
    return;
  }
  strip.style.display = '';

  // 閉じるボタンを追加
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'thumbnail-close-btn';
  closeBtn.title = 'サムネイルを閉じる';
  closeBtn.innerHTML = '×';
  closeBtn.onclick = () => {
    thumbnailsVisible = false;
    renderThumbnails();
  };
  strip.appendChild(closeBtn);

  const photos = getDisplayPhotos();
  const canEditOrder = isEditor() && currentTrip && !currentTrip.isParent;
  if (photos.length > 0) {
    photos.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'thumbnail-item' + (canEditOrder ? ' thumbnail-draggable' : '');
      item.dataset.index = String(i);
      if (canEditOrder) {
        item.draggable = true;
        item.ondragstart = (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
          e.dataTransfer.setData('application/json', JSON.stringify({ index: i }));
          item.classList.add('thumbnail-dragging');
        };
        item.ondragend = () => item.classList.remove('thumbnail-dragging');
        item.ondragover = (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (from !== i) item.classList.add('thumbnail-drag-over');
        };
        item.ondragleave = () => item.classList.remove('thumbnail-drag-over');
        item.ondrop = (e) => {
          e.preventDefault();
          item.classList.remove('thumbnail-drag-over');
          const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (from !== i && !isNaN(from)) reorderThumbnail(from, i);
        };
      }
      if (p.url) {
        // 写真がある場合（遅延読み込み対応 / 一覧はサムネイルを使用）
        const img = document.createElement('img');
        const thumbSrc = getPhotoThumbUrl(p);
        if (imageObserver && i > 5) {
          // パフォーマンス最適化: 最初の6枚以降は遅延読み込み
          img.dataset.src = thumbSrc;
          img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3C/svg%3E';
          imageObserver.observe(img);
        } else {
          img.src = thumbSrc;
        }
        img.alt = p.name;
        img.onclick = () => showPhotoAtIndex(i);
        item.appendChild(img);
      } else if (p.videoUrl) {
        // 写真はないが動画URLがある場合（遅延読み込み対応）
        const videoThumbnailUrl = getVideoThumbnailUrl(p.videoUrl);
        if (videoThumbnailUrl) {
          const img = document.createElement('img');
          if (imageObserver && i > 5) {
            // パフォーマンス最適化: 最初の6枚以降は遅延読み込み
            img.dataset.src = videoThumbnailUrl;
            img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3C/svg%3E';
            imageObserver.observe(img);
          } else {
            img.src = videoThumbnailUrl;
          }
          img.alt = p.name || '動画';
          img.onclick = () => showPhotoAtIndex(i);
          // 動画アイコンを追加
          const videoIcon = document.createElement('div');
          videoIcon.className = 'thumbnail-video-icon';
          videoIcon.innerHTML = '▶️';
          item.appendChild(img);
          item.appendChild(videoIcon);
        } else {
          // 動画URLがあるがサムネイルが取得できない場合
          const placeholder = document.createElement('div');
          placeholder.className = 'thumbnail-video-placeholder';
          placeholder.innerHTML = '🎬';
          placeholder.title = '動画ポイント';
          placeholder.onclick = () => showPhotoAtIndex(i);
          item.appendChild(placeholder);
        }
      } else {
        // 写真なしのGPSポイント
        const placeholder = document.createElement('div');
        placeholder.className = 'thumbnail-gps-placeholder';
        placeholder.innerHTML = '📍';
        placeholder.title = p.placeName || 'GPSポイント';
        placeholder.onclick = () => showPhotoAtIndex(i);
        item.appendChild(placeholder);
      }
      if (canEditOrder) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'thumbnail-delete-btn';
        delBtn.title = '削除';
        delBtn.innerHTML = '×';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          deleteThumbnail(i);
        };
        item.appendChild(delBtn);
      }
      strip.appendChild(item);
    });
  }
  if (isEditor() && currentTrip && !currentTrip.isParent) {
    const uploadZone = document.createElement('div');
    uploadZone.className = photos.length > 0 ? 'thumbnail-strip-upload-compact' : 'thumbnail-strip-upload';
    uploadZone.innerHTML = '<span class="upload-icon">＋</span>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.hidden = true;
    uploadZone.title = '写真をアップロード（GPS情報があれば地図にポイント追加）';
    uploadZone.onclick = () => fileInput.click();
    uploadZone.appendChild(fileInput);
    fileInput.onchange = async (e) => {
      const files = e.target.files;
      if (!files?.length) return;
      await handleFiles(files, { autoSave: true });
      fileInput.value = '';
    };
    strip.appendChild(uploadZone);
  }
}

function toggleThumbnails() {
  thumbnailsVisible = !thumbnailsVisible;
  renderThumbnails();
}

/** デフォルト表示用: トリップ一覧の全GPS情報を持つトリップを取得 */
function getTripsWithGpsForOverview() {
  // getTripsForDisplay()は親トリップの子を(tripRegionFilter/tripFilterParentNameで)
  // 個別にフィルタ済みで返す。ここで親IDから子を再取得すると、そのフィルタを素通りして
  // 無関係な地域の子トリップまで地図に出てしまうため、displayItemsの中身をそのまま使う
  // （親トリップ自体はGPS/写真を持たない入れ物のため除外し、子・単独トリップだけを対象にする）。
  const result = getTripsForDisplay()
    .filter(item => item.isChild || !item.trip.isParent)
    .map(item => item.trip);
  return result.filter(t => t.gpxData || t.gpxDataUrl || ((t.photos || []).some(p => p.lat != null && p.lng != null)));
}

/**
 * 保留中の写真マーカーのうち、現在の表示範囲（少し余裕を持たせた範囲）に入ったものだけを地図に追加する。
 * 画面外のマーカーはDOM生成も画像読み込みも行わないため、写真が多いトリップでの初期表示が軽くなる。
 */
function flushVisiblePhotoMarkers() {
  if (!map || pendingPhotoMarkers.length === 0) return;

  /** 判定できない場合は取りこぼしを防ぐため全て表示する（表示漏れよりは描画コストを取る） */
  const addAllPending = () => {
    for (const item of pendingPhotoMarkers) {
      item.marker.addTo(map);
      markers.push(item.marker);
    }
    pendingPhotoMarkers = [];
  };

  let bounds;
  try {
    // 地図がまだレイアウトされていない場合、getBoundsは1点に縮退し
    // どのマーカーも範囲外と判定されて永久に表示されなくなる。
    // getSize()はキャッシュを返すことがあるためDOMの実寸で判定する。
    const el = map.getContainer();
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) {
      addAllPending();
      return;
    }
    // 画面外に少し余裕を持たせ、スクロール直後に空白が見えないようにする
    bounds = map.getBounds().pad(0.5);
    // 縮退した境界（幅または高さが0）も範囲判定に使えないため全て表示する
    if (!bounds || !bounds.isValid() ||
        bounds.getEast() === bounds.getWest() ||
        bounds.getNorth() === bounds.getSouth()) {
      addAllPending();
      return;
    }
  } catch (_) {
    addAllPending();
    return;
  }

  const stillPending = [];
  for (const item of pendingPhotoMarkers) {
    if (bounds.contains(item.latLng)) {
      item.marker.addTo(map);
      markers.push(item.marker);
    } else {
      stillPending.push(item);
    }
  }
  pendingPhotoMarkers = stillPending;
}

/** 地図の移動・ズーム・リサイズ時に、表示範囲に入った写真マーカーを読み込む（初回のみ購読） */
function bindPhotoMarkerLazyLoading() {
  if (photoMarkerLazyBound || !map) return;
  photoMarkerLazyBound = true;
  // resizeも購読する: 地図が後からサイズを得た場合に保留分を取りこぼさないため
  map.on('moveend zoomend resize', flushVisiblePhotoMarkers);
}

async function updateMapMarkers() {
  if (!map) {
    console.warn('地図が初期化されていません');
    return;
  }

  // 写真ポップアップをクリア
  closePhotoPopup();

  try {
    markers.forEach(m => map.removeLayer(m));
  } catch (e) {
    console.warn('マーカー削除エラー:', e);
  }
  markers = [];
  // 前回の未表示マーカーは破棄（地図未追加のためremoveLayerは不要）
  pendingPhotoMarkers = [];

  try {
    gpxLayers.forEach(l => map.removeLayer(l));
  } catch (e) {
    console.warn('GPXレイヤー削除エラー:', e);
  }
  gpxLayers = [];
  try {
    tripLeaderLayers.forEach(l => map.removeLayer(l));
  } catch (e) {
    console.warn('引き出し線レイヤー削除エラー:', e);
  }
  tripLeaderLayers = [];

  const tripsToShow = [];
  if (currentTrip?.isParent) {
    // 親トリップ選択時は常に子トリップのルート・写真を地図に表示する
    tripsToShow.push(...getChildTrips(currentTrip.id));
  } else if (currentTrip) {
    tripsToShow.push(currentTrip);
  } else {
    tripsToShow.push(...getTripsWithGpsForOverview());
  }

  if (tripsToShow.length === 0) return;

  const allLatLngs = []; // 地図の表示範囲決定用（写真マーカーのみ）
  const placedTripCards = []; // 親トリップ時: 各旅行記ボタンの配置位置（かぶり回避用）
  const routePolylines = []; // 親トリップ時: 他トリップのルート（かぶり回避用）
  let globalIdx = 0;

  // GPXを全トリップ分まとめて並列取得（直列待ちを解消）
  const gpxTexts = await Promise.all(
    tripsToShow.map(trip => getGpxContent(trip).catch(err => {
      console.warn('GPX取得失敗:', trip.name || trip.id, err);
      return null;
    }))
  );

  for (let tripIdx = 0; tripIdx < tripsToShow.length; tripIdx++) {
    const trip = tripsToShow[tripIdx];
    const color = trip.color || TRIP_COLORS[tripIdx % TRIP_COLORS.length];
    let pts = [];
    const gpxText = gpxTexts[tripIdx];
    if (gpxText) {
      pts = parseGpxPoints(gpxText);
    }
    if (pts.length <= 1 && (trip.photos || []).length > 0) {
      const photoPts = (trip.photos || [])
        .map(p => ensureLatLng(p.lat, p.lng))
        .filter(Boolean)
        .map(c => [c.lat, c.lng]);
      if (photoPts.length > 1) pts = photoPts;
    }
    // GPXルートを地図に表示（表示範囲の計算には含めない）
    if (pts.length > 1) {
      const isPlayback = document.body.classList.contains('app-playing');
      const routeWeight = isPlayback ? 7 : 4;
      const routeOpacity = isPlayback ? 1.0 : 0.8;
      // トリップ名が「Plan」で始まる場合は計画段階の旅として点線で表示する
      const dashArray = isPlanTrip(trip) ? '12, 10' : null;
      if (isPlayback) {
        // 自動再生中: 外側グロー + 内側ルートの二重線で目立たせる
        const glowLayer = L.polyline(pts, {
          color, weight: 18, opacity: 0.2, smoothFactor: 1.5, lineCap: 'round', lineJoin: 'round', dashArray
        }).addTo(map);
        gpxLayers.push(glowLayer);
        const shadowLayer = L.polyline(pts, {
          color: '#ffffff', weight: 10, opacity: 0.5, smoothFactor: 1.5, lineCap: 'round', lineJoin: 'round', dashArray
        }).addTo(map);
        gpxLayers.push(shadowLayer);
      }
      const layer = L.polyline(pts, {
        color, weight: routeWeight, opacity: routeOpacity, smoothFactor: 1.5, lineCap: 'round', lineJoin: 'round', dashArray
      }).addTo(map);
      gpxLayers.push(layer);
      // allLatLngsには追加しない（写真マーカーのみで範囲を決定）
    }

    // 親トリップ表示時の写真マーカー表示判定
    // デスクトップ: 子トリップの写真マーカーを表示しない
    // モバイル: 子トリップの最初のランドマーク写真だけ表示
    const isParentShowingChild = currentTrip?.isParent && trip.parentId === currentTrip.id;
    const shouldShowPhotoMarkers = !isParentShowingChild || isMobileView();

    if (shouldShowPhotoMarkers) {
      // マーカーを2つの配列に分類（通常マーカーとランドマーク/スタンプ）
      const normalMarkers = [];
      const landmarkMarkers = [];

      (trip.photos || []).forEach((p, i) => {
        // 親トリップ表示時（子トリップの写真マーカーを間引く場合）のみ最初と最後の写真に絞る
        // 子トリップを直接選択した場合は、全ての写真をマーカーとして表示する
        if (isParentShowingChild) {
          const photoCount = trip.photos.length;
          const isFirstPhoto = i === 0;
          const isLastPhoto = i === photoCount - 1;
          if (!isFirstPhoto && !isLastPhoto) return;

          // モバイルで親トリップ表示時は最初のランドマークのみ
          if (isMobileView()) {
            const isFirstLandmark = !!(p.landmarkNo) && !trip.photos.slice(0, i).some(prevP => prevP.landmarkNo);
            if (!isFirstLandmark) return;
          }
        }
        const coord = ensureLatLng(p.lat, p.lng);
        if (coord) {
          const { lat: plat, lng: plng } = coord;
        const isLandmark = !!(p.landmarkNo);
        const isStamp = !!(p.isStamp);

        // スタンプは番号のみ、ランドマークは小さい写真（スタンプでない場合）、その他は小さい丸
        // モバイルで親トリップ表示時はさらに小さく
        const isParentMobileView = isParentShowingChild && isMobileView();
        let photoIconHtml, iconSize, iconAnchor;
        if (isStamp) {
          // スタンプは番号のみの丸（写真を表示しない）
          const no = String(p.landmarkNo || '?').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          photoIconHtml = `<div style="background:${color};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:16px;border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.5)">${no}</div>`;
          iconSize = [34, 34];
          iconAnchor = [17, 17];
        } else if (isLandmark && p.url) {
          const no = String(p.landmarkNo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          if (isParentMobileView) {
            // モバイルで親トリップ表示時は小さく
            photoIconHtml = `
              <div style="position:relative;width:35px;height:35px;">
                <img src="${getPhotoThumbUrl(p)}" decoding="async" style="width:35px;height:35px;border-radius:4px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);object-fit:cover;display:block;" />
                <span style="position:absolute;top:0;left:0;background:${color};color:#fff;font-weight:bold;font-size:9px;padding:1px 3px;border-radius:2px 0 3px 0;box-shadow:0 1px 3px rgba(0,0,0,0.4);">${no}</span>
              </div>
            `;
            iconSize = [35, 35];
            iconAnchor = [17, 35];
          } else {
            photoIconHtml = `
              <div style="position:relative;width:50px;height:50px;">
                <img src="${getPhotoThumbUrl(p)}" decoding="async" style="width:50px;height:50px;border-radius:6px;border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.5);object-fit:cover;display:block;" />
                <span style="position:absolute;top:0;left:0;background:${color};color:#fff;font-weight:bold;font-size:11px;padding:2px 5px;border-radius:3px 0 4px 0;box-shadow:0 2px 4px rgba(0,0,0,0.4);">${no}</span>
              </div>
            `;
            iconSize = [50, 50];
            iconAnchor = [25, 50];
          }
        } else if (isLandmark) {
          // 写真がない場合は番号付きの丸
          const no = String(p.landmarkNo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          photoIconHtml = `<div style="background:${color};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:16px;border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.5)">${no}</div>`;
          iconSize = [34, 34];
          iconAnchor = [17, 17];
        } else if (p.videoUrl) {
          const videoThumbUrl = getVideoThumbnailUrl(p.videoUrl);
          if (videoThumbUrl) {
            if (isParentMobileView) {
              photoIconHtml = `
                <div style="position:relative;width:40px;height:40px;">
                  <img src="${videoThumbUrl}" decoding="async" style="width:40px;height:40px;border-radius:5px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);object-fit:cover;display:block;" />
                  <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.25);border-radius:5px;">
                    <div style="background:rgba(255,255,255,0.9);width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;padding-left:2px;">▶</div>
                  </div>
                </div>
              `;
              iconSize = [40, 40];
              iconAnchor = [20, 40];
            } else {
              photoIconHtml = `
                <div style="position:relative;width:56px;height:56px;">
                  <img src="${videoThumbUrl}" decoding="async" style="width:56px;height:56px;border-radius:7px;border:2px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.5);object-fit:cover;display:block;" />
                  <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.25);border-radius:7px;">
                    <div style="background:rgba(255,255,255,0.9);width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;padding-left:2px;">▶</div>
                  </div>
                </div>
              `;
              iconSize = [56, 56];
              iconAnchor = [28, 56];
            }
          } else {
            photoIconHtml = `<div style="background:${color};width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);font-size:11px;line-height:1;">▶</div>`;
            iconSize = [24, 24];
            iconAnchor = [12, 12];
          }
        } else {
          photoIconHtml = `<span style="background:${color};border:2px solid #fff;width:12px;height:12px;border-radius:50%;display:block;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></span>`;
          iconSize = [12, 12];
          iconAnchor = [6, 6];
        }

        const m = isEditor()
          ? L.marker([plat, plng], {
              draggable: true,
              icon: L.divIcon({
                className: 'photo-marker-draggable map-photo-marker',
                html: photoIconHtml,
                iconSize: iconSize,
                iconAnchor: iconAnchor
              })
            })
          : L.marker([plat, plng], {
              icon: L.divIcon({
                className: 'map-photo-marker',
                html: photoIconHtml,
                iconSize: iconSize,
                iconAnchor: iconAnchor
              })
            });
        // ツールチップを設定
        const tooltipParts = [];
        if (p.landmarkNo) tooltipParts.push('📍 ' + p.landmarkNo);
        if (p.name) tooltipParts.push(p.name);
        if (p.description) tooltipParts.push(p.description);
        const tooltipLabel = tooltipParts.length ? tooltipParts.join(' — ') : `#${i + 1}`;
        m.bindTooltip(tooltipLabel, { direction: 'top', offset: [0, -10] });

        const tripRef = trip;
        const photoIdx = i;
        const idx = globalIdx++;
        // 写真マーカーはログインの有無に関わらずクリックで写真を表示
        m.on('click', async () => {
          if (!currentTrip) {
            await loadTripById(tripRef.id);
            currentPhotoIndex = photoIdx;
          } else {
            currentPhotoIndex = idx;
          }
          showPhotoAtIndex(currentPhotoIndex);
        });
        if (isEditor() && m.dragging) {
          m.on('dragend', () => {
            const pos = m.getLatLng();
            if (tripRef.photos?.[photoIdx]) {
              const originalLat = tripRef.photos[photoIdx].lat;
              const originalLng = tripRef.photos[photoIdx].lng;
              const originalPlaceName = tripRef.photos[photoIdx].placeName;
              tripRef.photos[photoIdx].lat = parseFloat(pos.lat.toFixed(6));
              tripRef.photos[photoIdx].lng = parseFloat(pos.lng.toFixed(6));
              showMarkerSaveBar({ tripRef, photoIdx, originalLat, originalLng, originalPlaceName });
              updateHeaderInfo();
            }
          });
        }

        // ランドマークまたはスタンプの場合は landmarkMarkers に、それ以外は normalMarkers に追加
        if (isLandmark || isStamp) {
          landmarkMarkers.push({ marker: m, latLng: [plat, plng] });
        } else {
          normalMarkers.push({ marker: m, latLng: [plat, plng] });
        }
      }
    });

      // 遅延読み込み: 地図への追加は表示範囲に入ってから行う（flushVisiblePhotoMarkers）
      // 追加順に依存せず重なり順を保つため、zIndexOffsetで階層を明示する
      // 通常マーカーは背面
      normalMarkers.forEach(({ marker, latLng }) => {
        marker.setZIndexOffset(0);
        pendingPhotoMarkers.push({ marker, latLng });
        allLatLngs.push(latLng);
      });

      // ランドマーク/スタンプマーカーは最前面
      landmarkMarkers.forEach(({ marker, latLng }) => {
        marker.setZIndexOffset(1000);
        pendingPhotoMarkers.push({ marker, latLng });
        allLatLngs.push(latLng);
      });

    }

    // 親トリップ表示時: 各子トリップの旅行記・動画ボタンをGPSから少し離し、引き出し線で表示（デスクトップのみ）
    if (currentTrip?.isParent && trip.parentId === currentTrip.id && !isMobileView()) {
      const hasTravelogue = tripHasTravelogue(trip);
      const hasVideo = getTripVideoUrlsForTrip(trip).length > 0;
      const hasAnime = trip.animes && trip.animes.length > 0;
      if (hasTravelogue || hasVideo || hasAnime) {
        let anchorLat, anchorLng;
        if (pts.length > 0) {
          anchorLat = pts[0][0];
          anchorLng = pts[0][1];
        } else {
          const firstPhoto = (trip.photos || []).find(p => p.lat != null && p.lng != null);
          if (firstPhoto) {
            const c = ensureLatLng(firstPhoto.lat, firstPhoto.lng);
            if (c) {
              anchorLat = c.lat;
              anchorLng = c.lng;
            }
          }
        }
        if (anchorLat != null && anchorLng != null) {
          const offsetDeg = 0.06;
          const minCardDist = 0.08;
          const minRouteDist = 0.035;

          const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
          const distToSegment = (p, a, b) => {
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
            const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)));
            const proj = [a[0] + t * dx, a[1] + t * dy];
            return dist(p, proj);
          };
          const tooCloseToRoute = (clat, clng) => {
            const p = [clat, clng];
            if (pts.length >= 2) {
              for (let i = 0; i < pts.length - 1; i++) {
                if (distToSegment(p, pts[i], pts[i + 1]) < minRouteDist) return true;
              }
            } else if (pts.length === 1 && dist(p, pts[0]) < minRouteDist) return true;
            for (const r of routePolylines) {
              for (let i = 0; i < r.length - 1; i++) {
                if (distToSegment(p, r[i], r[i + 1]) < minRouteDist) return true;
              }
            }
            return false;
          };
          const tooCloseToCards = (clat, clng) => placedTripCards.some(c => dist([clat, clng], c) < minCardDist);

          let cardLat, cardLng;
          const dirs = [];
          if (pts.length >= 2) {
            const dx = pts[1][1] - pts[0][1], dy = pts[1][0] - pts[0][0];
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            dirs.push([dy / len, -dx / len], [-dy / len, dx / len]);
          }
          for (const [dlat, dlng] of [[1, 1], [-1, 1], [-1, -1], [1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (dirs.every(d => d[0] !== dlat || d[1] !== dlng)) dirs.push([dlat, dlng]);
          }
          for (const [dlat, dlng] of dirs) {
            const clat = anchorLat + dlat * offsetDeg;
            const clng = anchorLng + dlng * offsetDeg;
            if (!tooCloseToRoute(clat, clng) && !tooCloseToCards(clat, clng)) {
              cardLat = clat;
              cardLng = clng;
              break;
            }
          }
          if (cardLat == null) {
            cardLat = anchorLat + 0.065;
            cardLng = anchorLng + 0.065;
          }
          placedTripCards.push([cardLat, cardLng]);
          if (pts.length >= 2) routePolylines.push(pts);

          const tripName = escapeHtml(trip.name || '（無題）');
          const tripId = trip.id;
          const tripMarkerHtml = `
            <div class="map-trip-action-card" style="--trip-color:${color}" data-trip-id="${escapeHtml(tripId)}">
              <div class="map-trip-action-name map-trip-action-name-clickable" style="cursor:pointer;" title="このトリップを表示">${tripName}</div>
              <div class="map-trip-action-btns">
                ${hasTravelogue ? '<button type="button" class="map-trip-action-btn map-trip-action-travelogue" title="旅行記">📖</button>' : ''}
                ${hasVideo ? '<button type="button" class="map-trip-action-btn map-trip-action-video" title="動画">🎬</button>' : ''}
              </div>
            </div>`;
          const leaderLine = L.polyline([[anchorLat, anchorLng], [cardLat, cardLng]], {
            color: color,
            weight: 3,
            opacity: 0.7,
            dashArray: '5, 5'
          });
          leaderLine.addTo(map);
          tripLeaderLayers.push(leaderLine);

          const tripMarker = L.marker([cardLat, cardLng], {
            icon: L.divIcon({
              className: 'map-trip-action-marker',
              html: tripMarkerHtml,
              iconSize: [120, 60],
              iconAnchor: [60, 50]
            })
          });
          tripMarker.addTo(map);
          markers.push(tripMarker);
          allLatLngs.push([cardLat, cardLng]);
          allLatLngs.push([anchorLat, anchorLng]);
        }
      }
    }
  }
  if (allLatLngs.length > 0 && !document.body.classList.contains('app-playing')) {
    if (allLatLngs.length === 1) {
      map.setView(allLatLngs[0], 15);
    } else {
      // 全てのポイントが見えるように余裕を持って表示
      map.fitBounds(allLatLngs, { padding: [60, 60] });
    }
  }

  // 写真マーカーの遅延読み込み: 表示範囲内の分を描画し、以降は移動・ズームに追従させる
  bindPhotoMarkerLazyLoading();
  flushVisiblePhotoMarkers();

  // 自動再生中のパルスマーカーを更新
  updatePlaybackPulseMarker();
}

// パース済みGPX座標のキャッシュ（GPXテキスト → [lat,lon]配列）。
// 同じGPXがupdateMapMarkers等から何度も再パースされるのを避ける。
// 際限なく増えないよう、最大件数を超えたら最も古いエントリから削除する簡易LRU。
const gpxPointsCache = new Map();
const GPX_POINTS_CACHE_MAX = 50;

function parseGpxPoints(xmlStr) {
  if (!xmlStr) return [];
  const cached = gpxPointsCache.get(xmlStr);
  if (cached) return cached.slice(); // 呼び出し側の誤った破壊的変更からキャッシュ本体を守る

  const pts = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');

  // XMLパースエラーをチェック
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.error('GPX XML解析エラー:', parseError.textContent);
  }

  const ns1 = 'http://www.topografix.com/GPX/1/1';
  const ns0 = 'http://www.topografix.com/GPX/1/0';
  const tags = ['trkpt', 'rtept', 'wpt'];
  const collect = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const lat = parseFloat(el.getAttribute('lat'));
      const lon = parseFloat(el.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        pts.push([lat, lon]);
      }
    }
  };

  // 各タグタイプで検索
  for (const tag of tags) {
    let nodes = doc.getElementsByTagNameNS?.(ns1, tag);
    if (!nodes?.length) nodes = doc.getElementsByTagNameNS?.(ns0, tag);
    if (!nodes?.length) nodes = doc.getElementsByTagName(tag);
    if (nodes?.length) {
      collect(nodes);
    }
  }

  // 名前空間なしでも試行
  if (pts.length === 0) {
    const re = /(?:trkpt|rtept|wpt)[^>]*(?:lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["']|lon=["']([^"']+)["'][^>]*lat=["']([^"']+)["'])/gi;
    let m;
    while ((m = re.exec(xmlStr)) !== null) {
      const lat = parseFloat(m[1] || m[4]);
      const lon = parseFloat(m[2] || m[3]);
      if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        pts.push([lat, lon]);
      }
    }
  }

  if (gpxPointsCache.size >= GPX_POINTS_CACHE_MAX) {
    const oldestKey = gpxPointsCache.keys().next().value;
    gpxPointsCache.delete(oldestKey);
  }
  gpxPointsCache.set(xmlStr, pts);

  return pts.slice();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getGpxStats(gpxData) {
  if (!gpxData) return null;
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxData, 'application/xml');
  const ns1 = 'http://www.topografix.com/GPX/1/1';
  const ns0 = 'http://www.topografix.com/GPX/1/0';
  let trkpts = [];
  for (const tag of ['trkpt', 'rtept']) {
    let n = doc.getElementsByTagNameNS?.(ns1, tag);
    if (!n?.length) n = doc.getElementsByTagNameNS?.(ns0, tag);
    if (!n?.length) n = doc.getElementsByTagName(tag);
    for (let i = 0; i < (n?.length || 0); i++) trkpts.push(n[i]);
  }
  if (trkpts.length < 2) return null;
  let totalKm = 0;
  let firstTime = null;
  let lastTime = null;
  let prevLat = null, prevLon = null;
  trkpts.forEach(el => {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    let timeEl = el.getElementsByTagNameNS?.(ns1, 'time')?.[0] || el.getElementsByTagNameNS?.(ns0, 'time')?.[0] || el.getElementsByTagName('time')?.[0];
    const timeStr = timeEl?.textContent?.trim();
    if (!isNaN(lat) && !isNaN(lon)) {
      if (prevLat != null) totalKm += haversineKm(prevLat, prevLon, lat, lon);
      prevLat = lat;
      prevLon = lon;
    }
    if (timeStr) {
      const t = new Date(timeStr);
      if (!isNaN(t.getTime())) {
        if (!firstTime) firstTime = t;
        lastTime = t;
      }
    }
  });
  if (totalKm <= 0) return null;
  const date = firstTime ? `${firstTime.getFullYear()}/${String(firstTime.getMonth() + 1).padStart(2, '0')}/${String(firstTime.getDate()).padStart(2, '0')}` : '';
  const hours = (firstTime && lastTime && lastTime > firstTime) ? (lastTime - firstTime) / 3600000 : 0;
  const velocityKmh = hours > 0 ? totalKm / hours : 0;
  return { date, moveKm: totalKm, velocityKmh };
}


function showPhotoAtIndex(i, viewOnly = true, opts = {}) {
  const photos = getDisplayPhotos();
  if (!photos.length) return;
  currentPhotoIndex = ((i % photos.length) + photos.length) % photos.length;
  const p = photos[currentPhotoIndex];

  // モバイルでヘッダーを隠す
  if (isMobileView() && viewOnly) {
    markMobileHeaderInteracted();
  }
  const lat = p.lat != null ? p.lat : map.getCenter().lat;
  const lng = p.lng != null ? p.lng : map.getCenter().lng;
  const flyDuration = opts.flyDuration != null ? opts.flyDuration : 0;
  const flyZoom = opts.flyZoom != null ? opts.flyZoom : 16;
  if (p.lat != null && p.lng != null) {
    if (flyDuration > 0 && !playTimer) {
      // 自動再生中は2D地図の更新をスキップ（パフォーマンス向上）
      map.flyTo([p.lat, p.lng], { zoom: flyZoom, duration: flyDuration / 1000, easeLinearity: 0.15 });
    } else if (!playTimer) {
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14));
    }
    // 自動再生中の3D地図更新は別で行うのでここではスキップ
  }

  // 自動再生中は専用オーバーレイに表示（写真または動画）
  if (playTimer) {
    showPlaybackPhotoOverlay(p);
    return;
  }

  // 写真を表示する際にサムネイルも表示
  if (!thumbnailsVisible) {
    thumbnailsVisible = true;
    renderThumbnails();
  }

  closePhotoPopup();
  if (isEditor() && !viewOnly) {
    showPhotoPopupEditMode(lat, lng);
  } else {
    showPhotoViewMode(p, lat, lng);
  }
}

let lastPlaybackPhotoUrl = null;

async function showPlaybackPhotoOverlay(p, onVideoEnd = null) {
  const overlay = document.getElementById('playbackPhotoOverlay');
  const card = document.getElementById('playbackPhotoCard');
  if (!overlay || !card) return;

  // 動画URLがある場合は動画優先
  const hasVideo = p.videoUrl && p.videoUrl.trim();
  const contentKey = hasVideo ? p.videoUrl : p.url;

  // 同じコンテンツなら更新しない（パフォーマンス最適化）
  if (lastPlaybackPhotoUrl === contentKey && !hasVideo) {
    overlay.classList.remove('hidden');
    return;
  }
  lastPlaybackPhotoUrl = contentKey;

  // 写真/動画コンテナ
  let photoWrap = card.querySelector('.playback-photo-wrap');
  if (!photoWrap) {
    photoWrap = document.createElement('div');
    photoWrap.className = 'playback-photo-wrap';
    card.appendChild(photoWrap);
  }

  // コンテナをクリア
  photoWrap.innerHTML = '';

  if (hasVideo) {
    // 動画の縦横を判定してクラスを設定
    const orientation = await detectVideoOrientation(p.videoUrl);
    overlay.classList.add('playback-video-fullscreen');
    card.classList.add('playback-video-card');
    overlay.classList.remove('playback-photo-landscape', 'playback-photo-portrait');
    if (orientation === 'portrait') {
      overlay.classList.add('playback-video-portrait');
    } else {
      overlay.classList.remove('playback-video-portrait');
    }

    playbackVideoEndCallback = onVideoEnd || null;

    // YouTube/Vimeo/その他の動画をiframeで埋め込み（autoplay + muted で自動再生を確保）
    const youtubeId = getYouTubeVideoId(p.videoUrl);
    const embedUrl = youtubeId
      ? `https://www.youtube.com/embed/${youtubeId}?autoplay=1&mute=1&controls=1&modestbranding=1&rel=0&playsinline=1&enablejsapi=1`
      : getVideoEmbedUrl(p.videoUrl);

    if (embedUrl) {
      const isYouTube = !!youtubeId;
      const isVimeo = embedUrl.includes('vimeo.com');
      let iframeSrc = embedUrl;
      if (!isYouTube) {
        iframeSrc += (iframeSrc.includes('?') ? '&' : '?') + 'autoplay=1&muted=1';
        if (isVimeo) iframeSrc += '&api=1';
      }

      const iframe = document.createElement('iframe');
      iframe.src = iframeSrc;
      // 縦長動画（portrait）はより大きく表示するため、アスペクト比を自動調整
      iframe.style.cssText = 'width:100%;height:100%;border:none;object-fit:contain;';
      iframe.allow = 'autoplay; encrypted-media; accelerometer; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      // 動画容器を柔軟に対応（縦長動画を大きく表示）
      photoWrap.style.display = 'flex';
      photoWrap.style.alignItems = 'center';
      photoWrap.style.justifyContent = 'center';
      photoWrap.appendChild(iframe);

      // YouTube: postMessage で動画終了を検知
      if (isYouTube && onVideoEnd) {
        const ytHandler = (e) => {
          if (!e.origin.includes('youtube.com')) return;
          try {
            const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (data?.event === 'onStateChange' && data?.info === 0) {
              console.log('YouTube動画終了を検知: 次へ進みます');
              window.removeEventListener('message', ytHandler);
              if (playbackVideoTimer) { clearTimeout(playbackVideoTimer); playbackVideoTimer = null; }
              if (playbackVideoEndCallback) {
                const cb = playbackVideoEndCallback;
                playbackVideoEndCallback = null;
                cb();
              }
            }
          } catch (_) {}
        };
        window.addEventListener('message', ytHandler);
        iframe.onload = () => {
          try {
            iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*');
          } catch (_) {}
        };
      }

      // Vimeo: postMessage で終了検知
      if (isVimeo && onVideoEnd) {
        const vimeoHandler = (e) => {
          try {
            const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (data && data.event === 'finish') {
              console.log('Vimeo動画終了を検知: 次へ進みます');
              window.removeEventListener('message', vimeoHandler);
              if (playbackVideoTimer) { clearTimeout(playbackVideoTimer); playbackVideoTimer = null; }
              if (playbackVideoEndCallback) {
                const cb = playbackVideoEndCallback;
                playbackVideoEndCallback = null;
                cb();
              }
            }
          } catch (_) {}
        };
        window.addEventListener('message', vimeoHandler);
        iframe.onload = () => {
          try { iframe.contentWindow.postMessage(JSON.stringify({ method: 'addEventListener', value: 'finish' }), '*'); } catch (_) {}
        };
      }

      // フォールバック: 動画終了イベントが取れない場合に備えて60秒後に次へ
      if (onVideoEnd) {
        playbackVideoTimer = setTimeout(() => {
          console.log('動画フォールバックタイマー: 次へ進みます');
          if (playbackVideoEndCallback) {
            const cb = playbackVideoEndCallback;
            playbackVideoEndCallback = null;
            cb();
          }
        }, 60000);
      }
    }
  } else {
    playbackVideoEndCallback = null;
    // 写真の場合は通常表示モードに
    overlay.classList.remove('playback-video-fullscreen');
    overlay.classList.remove('playback-video-portrait');
    card.classList.remove('playback-video-card');
    // 写真を表示
    const img = document.createElement('img');
    img.loading = 'eager';
    img.decoding = 'async';
    img.alt = p.name || '';
    // 写真の縦横比を判定してクラスを設定（横長は幅広く、縦長は大きく表示）
    img.onload = () => {
      const isLandscape = img.naturalWidth >= img.naturalHeight;
      overlay.classList.toggle('playback-photo-landscape', isLandscape);
      overlay.classList.toggle('playback-photo-portrait', !isLandscape);
    };
    img.src = p.url || '';
    photoWrap.appendChild(img);
  }

  // 写真上部のオーバーレイ（写真ポップアップと同様のフォーマット: ランドマーク番号・ポイント名）
  let topOverlay = photoWrap.querySelector('.photo-popup-overlay-top');
  if (!topOverlay) {
    topOverlay = document.createElement('div');
    topOverlay.className = 'photo-popup-overlay-top';
    photoWrap.appendChild(topOverlay);
  }
  let overlayHTML = '';
  if (p.landmarkNo) {
    overlayHTML += `<span class="photo-popup-landmark">${escapeHtml(String(p.landmarkNo))}</span>`;
  }
  if (p.name) {
    overlayHTML += `<span class="photo-popup-name">${escapeHtml(p.name)}</span>`;
  }
  topOverlay.innerHTML = overlayHTML;
  topOverlay.style.display = overlayHTML ? '' : 'none';

  // 下部の説明
  let info = card.querySelector('.playback-photo-info');
  if (!info) {
    info = document.createElement('div');
    info.className = 'playback-photo-info';
    card.appendChild(info);
  }
  if (p.description) {
    info.innerHTML = `<div class="playback-photo-desc">${escapeHtml(p.description)}</div>`;
    info.style.display = '';
  } else {
    info.innerHTML = '';
    info.style.display = 'none';
  }

  document.getElementById('playbackPhotoOverlay').classList.remove('hidden');
}

function hidePlaybackPhotoOverlay() {
  const overlay = document.getElementById('playbackPhotoOverlay');
  if (overlay) {
    // 動画のiframeを明示的に削除して完全に停止
    const videoWrap = overlay.querySelector('.playback-photo-wrap');
    if (videoWrap) {
      const iframe = videoWrap.querySelector('iframe');
      if (iframe) {
        // iframeのsrcを空にして動画を停止
        iframe.src = '';
        // iframeを削除
        iframe.remove();
      }
    }

    // video-fullscreenクラスも削除
    overlay.classList.remove('playback-video-fullscreen');
    overlay.classList.remove('playback-video-portrait');
    overlay.classList.remove('playback-photo-landscape');
    overlay.classList.remove('playback-photo-portrait');

    // カードのvideo-cardクラスも削除
    const card = document.getElementById('playbackPhotoCard');
    if (card) {
      card.classList.remove('playback-video-card');
    }

    // オーバーレイを非表示
    overlay.classList.add('hidden');
  }

  // パルスマーカーを削除
  if (playbackPulseMarker && map) {
    try { map.removeLayer(playbackPulseMarker); } catch (e) { /* ignore */ }
    playbackPulseMarker = null;
  }
}

function showPhotoViewMode(p, lat, lng) {
  const div = document.createElement('div');
  div.className = 'photo-popup photo-popup-view';
  const photoWrap = document.createElement('div');
  photoWrap.className = 'photo-popup-photo-wrap';
  const img = document.createElement('img');

  // 写真がある場合は写真を表示、なければ動画サムネイルを表示
  if (p.url) {
    img.src = p.url;
    img.alt = p.name || '';
    img.title = 'クリックでオリジナルを表示';
    img.loading = 'eager';
    img.decoding = 'async';
    img.onclick = () => window.open(p.url, '_blank', 'noopener');
  } else if (p.videoUrl) {
    const videoThumbnailUrl = getVideoThumbnailUrl(p.videoUrl);
    if (videoThumbnailUrl) {
      img.src = videoThumbnailUrl;
      img.alt = p.name || '動画';
      img.title = 'クリックで動画を表示';
      img.loading = 'eager';
      img.decoding = 'async';
      img.onclick = () => window.open(p.videoUrl, '_blank', 'noopener');
      // 動画アイコンを追加
      const videoIcon = document.createElement('div');
      videoIcon.className = 'photo-popup-video-icon';
      videoIcon.innerHTML = '▶️';
      videoIcon.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:48px;opacity:0.9;pointer-events:none;';
      photoWrap.appendChild(videoIcon);
    } else {
      img.src = '';
      img.alt = '動画';
    }
  } else {
    img.src = '';
    img.alt = p.name || '';
  }

  photoWrap.appendChild(img);
  if (p.landmarkNo || p.name) {
    const overlayTop = document.createElement('div');
    overlayTop.className = 'photo-popup-overlay-top';
    if (p.landmarkNo) {
      const landmarkEl = document.createElement('span');
      landmarkEl.className = 'photo-popup-landmark';
      landmarkEl.textContent = p.landmarkNo;
      overlayTop.appendChild(landmarkEl);
    }
    if (p.name) {
      const nameEl = document.createElement('span');
      nameEl.className = 'photo-popup-name';
      nameEl.textContent = p.name;
      overlayTop.appendChild(nameEl);
    }
    photoWrap.appendChild(overlayTop);
  }
  if (p.placeName) {
    const overlayBottom = document.createElement('div');
    overlayBottom.className = 'photo-popup-overlay-bottom-right';
    overlayBottom.textContent = p.placeName;
    photoWrap.appendChild(overlayBottom);
  }
  div.appendChild(photoWrap);
  const infoEl = document.createElement('div');
  infoEl.className = 'photo-popup-info photo-popup-info-structured';
  if (p.description) {
    const descDiv = document.createElement('div');
    descDiv.className = 'photo-popup-description';
    descDiv.textContent = p.description;
    infoEl.appendChild(descDiv);
  } else {
    infoEl.textContent = '（説明なし）';
  }
  div.appendChild(infoEl);

  // 動画ボタン（動画URLがある場合）
  if (p.videoUrl) {
    const videoBtn = document.createElement('button');
    videoBtn.type = 'button';
    videoBtn.className = 'photo-popup-video-btn';
    videoBtn.title = '動画を見る';
    videoBtn.innerHTML = '🎬';
    videoBtn.onclick = (e) => {
      e.stopPropagation();
      closePhotoPopup();
      // 現在のポイントから次の動画を収集して連続再生
      const { urls, names } = collectVideoUrlsFromCurrentPoint();
      if (urls.length > 0) {
        playVideoSequenceWithNames(urls, names);
      } else {
        showVideoOverlay(p.videoUrl);
      }
    };
    div.appendChild(videoBtn);
  }

  if (isEditor()) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'photo-popup-edit photo-popup-edit-inline';
    editBtn.title = '編集';
    editBtn.innerHTML = '✏️';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      closePhotoPopup();
      showPhotoPopupEditMode(lat, lng);
    };
    div.appendChild(editBtn);
  }
  photoPopup = L.popup({
      maxWidth: 1000,
      minWidth: 0,
      className: 'photo-popup-container',
      autoPan: true,
      autoPanPaddingTopLeft: [20, 20],
      autoPanPaddingBottomRight: [20, 20],
      keepInView: true,
      offset: [0, -30]
    })
    .setLatLng([lat, lng])
    .setContent(div)
    .openOn(map);

  // ポップアップが開いた後、写真全体が見えるように地図を調整
  setTimeout(() => {
    const popupElement = photoPopup.getElement();
    if (popupElement) {
      const popupHeight = popupElement.offsetHeight;
      const point = map.latLngToContainerPoint([lat, lng]);
      const targetX = point.x;
      const targetY = point.y - (popupHeight / 2) + 20;
      const targetLatLng = map.containerPointToLatLng([targetX, targetY]);
      map.panTo(targetLatLng, { animate: true, duration: 0.3 });
    }
  }, 50);
}

function showPhotoPopupEditMode(lat, lng) {
  if (!currentTrip || currentTrip.isParent) return;
  const photos = currentTrip.photos || [];
  const idx = Math.min(currentPhotoIndex, photos.length - 1);
  const p = photos[idx] || {};
  closePhotoPopup();
  const div = document.createElement('div');
  div.className = 'photo-popup photo-popup-edit-mode';
  const photoWrap = document.createElement('div');
  photoWrap.className = 'photo-popup-photo-wrap';
  const img = document.createElement('img');

  // 写真がある場合は写真を表示、なければ動画サムネイルを表示
  if (p.url) {
    img.src = p.url;
    img.alt = p.name || '';
    img.title = 'クリックでオリジナルを表示';
    img.onclick = () => window.open(p.url, '_blank', 'noopener');
  } else if (p.videoUrl) {
    const videoThumbnailUrl = getVideoThumbnailUrl(p.videoUrl);
    if (videoThumbnailUrl) {
      img.src = videoThumbnailUrl;
      img.alt = p.name || '動画';
      img.title = 'クリックで動画を表示';
      img.onclick = () => window.open(p.videoUrl, '_blank', 'noopener');
      // 動画アイコンを追加
      const videoIcon = document.createElement('div');
      videoIcon.className = 'photo-popup-video-icon';
      videoIcon.innerHTML = '▶️';
      videoIcon.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:48px;opacity:0.9;pointer-events:none;';
      photoWrap.appendChild(videoIcon);
    } else {
      img.src = '';
      img.alt = '動画';
    }
  } else {
    img.src = '';
    img.alt = p.name || '';
  }

  photoWrap.appendChild(img);
  if (p.landmarkNo || p.name) {
    const overlayTop = document.createElement('div');
    overlayTop.className = 'photo-popup-overlay-top';
    if (p.landmarkNo) {
      const landmarkEl = document.createElement('span');
      landmarkEl.className = 'photo-popup-landmark';
      landmarkEl.textContent = p.landmarkNo;
      overlayTop.appendChild(landmarkEl);
    }
    if (p.name) {
      const nameEl = document.createElement('span');
      nameEl.className = 'photo-popup-name';
      nameEl.textContent = p.name;
      overlayTop.appendChild(nameEl);
    }
    photoWrap.appendChild(overlayTop);
  }
  if (p.placeName) {
    const overlayBottom = document.createElement('div');
    overlayBottom.className = 'photo-popup-overlay-bottom-right';
    overlayBottom.textContent = p.placeName;
    photoWrap.appendChild(overlayBottom);
  }
  div.appendChild(photoWrap);
  const form = document.createElement('div');
  form.className = 'photo-popup-edit-form';

  const landmarkRow = document.createElement('div');
  landmarkRow.className = 'photo-popup-landmark-row';

  const landmarkWrap = document.createElement('label');
  landmarkWrap.className = 'photo-popup-checkbox';
  const landmarkCheck = document.createElement('input');
  landmarkCheck.type = 'checkbox';
  landmarkCheck.checked = !!(p.landmarkNo);
  const landmarkSpan = document.createElement('span');
  landmarkSpan.textContent = 'ランドマーク';
  landmarkWrap.appendChild(landmarkCheck);
  landmarkWrap.appendChild(landmarkSpan);
  landmarkRow.appendChild(landmarkWrap);

  const landmarkNoWrap = document.createElement('div');
  landmarkNoWrap.className = 'photo-popup-landmark-no-inline';
  const landmarkNoInput = document.createElement('input');
  landmarkNoInput.type = 'text';
  landmarkNoInput.className = 'photo-popup-input photo-popup-input-inline';
  landmarkNoInput.placeholder = '番号: 1';
  landmarkNoInput.value = p.landmarkNo || '';
  landmarkNoWrap.appendChild(landmarkNoInput);
  landmarkRow.appendChild(landmarkNoWrap);

  // スタンプチェック
  const stampWrap = document.createElement('label');
  stampWrap.className = 'photo-popup-checkbox';
  stampWrap.style.marginLeft = 'auto';
  const stampCheck = document.createElement('input');
  stampCheck.type = 'checkbox';
  stampCheck.checked = !!(p.isStamp);
  const stampSpan = document.createElement('span');
  stampSpan.textContent = 'スタンプ';
  stampWrap.appendChild(stampCheck);
  stampWrap.appendChild(stampSpan);
  landmarkRow.appendChild(stampWrap);

  // 画像生成（スタンプ投稿のみ）: 写真をカラーE-Ink風アートに変換し、
  // 左下に控えめな御朱印風QRコードを合成した1枚の画像を生成する。スタンプの右横に小さく配置。
  const goshuinBtn = document.createElement('button');
  goshuinBtn.type = 'button';
  goshuinBtn.className = 'btn btn-stamp btn-xs';
  goshuinBtn.textContent = '🖼️ 画像生成';
  goshuinBtn.title = '写真をカラーE-Ink風アートに変換し、左下に控えめな御朱印風QRコードを合成した画像を生成します';
  goshuinBtn.style.display = p.isStamp ? '' : 'none';
  landmarkRow.appendChild(goshuinBtn);

  form.appendChild(landmarkRow);

  // ポイント名（幅を狭め、生成された御朱印風画像があればその右に小さく表示）
  const nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:flex;align-items:flex-end;gap:8px;';

  const nameWrap = document.createElement('div');
  nameWrap.className = 'photo-popup-field';
  nameWrap.style.maxWidth = '140px';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'ポイント名';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'photo-popup-input';
  nameInput.placeholder = '地名・スポット名';
  nameInput.value = p.name || '';
  nameWrap.appendChild(nameLabel);
  nameWrap.appendChild(nameInput);
  nameRow.appendChild(nameWrap);

  // 生成された御朱印風画像のプレビュー（あれば小さく表示。ダウンロードボタンなし）
  const goshuinPreview = document.createElement('img');
  goshuinPreview.className = 'photo-popup-goshuin-preview';
  goshuinPreview.style.cssText = 'display:none;height:56px;width:auto;border-radius:6px;box-shadow:0 2px 4px rgba(0,0,0,0.25);cursor:pointer;';
  goshuinPreview.title = 'クリックで拡大表示';
  goshuinPreview.alt = '生成された御朱印風画像';
  nameRow.appendChild(goshuinPreview);

  form.appendChild(nameRow);

  const renderGoshuinPreview = (url) => {
    if (!url) { goshuinPreview.style.display = 'none'; return; }
    goshuinPreview.src = url;
    goshuinPreview.onclick = () => window.open(url, '_blank', 'noopener');
    goshuinPreview.style.display = 'block';
  };
  renderGoshuinPreview(p.generatedGoshuinUrl);

  const descWrap = document.createElement('div');
  descWrap.className = 'photo-popup-field';
  const descLabel = document.createElement('label');
  descLabel.textContent = 'ポイント説明';
  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.className = 'photo-popup-input';
  descInput.placeholder = '説明（任意）';
  descInput.maxLength = 200;
  descInput.value = (p.description || '').slice(0, 200);
  descWrap.appendChild(descLabel);
  descWrap.appendChild(descInput);
  form.appendChild(descWrap);

  // URL（任意）: 動画リンクとして使われるほか、スタンプ画像生成時のQRコードの飛び先にもなる
  const videoUrlWrap = document.createElement('div');
  videoUrlWrap.className = 'photo-popup-field';
  const videoUrlLabel = document.createElement('label');
  videoUrlLabel.textContent = 'URL（任意）';
  const videoUrlInput = document.createElement('input');
  videoUrlInput.type = 'url';
  videoUrlInput.className = 'photo-popup-input';
  videoUrlInput.placeholder = 'YouTube/Vimeo等の動画URL、またはリンク先URL';
  videoUrlInput.value = p.videoUrl || '';
  videoUrlWrap.appendChild(videoUrlLabel);
  videoUrlWrap.appendChild(videoUrlInput);
  form.appendChild(videoUrlWrap);

  goshuinBtn.onclick = async () => {
    if (!photos[idx]?.url) { alert('先に写真を登録してください'); return; }
    const originalText = goshuinBtn.textContent;
    goshuinBtn.disabled = true;
    goshuinBtn.textContent = '生成中...';
    setStatus('御朱印風QR画像を生成中...');
    try {
      // フォームの最新のURLを反映してから生成する（QRコードの飛び先に使う）
      photos[idx].videoUrl = videoUrlInput.value.trim();
      const { dataUrl } = await generateStampGoshuinImage(currentTrip, idx);
      const storageUrl = await uploadAnimeImageToStorage(currentTrip.id, dataUrl, `goshuin_${idx}`);
      photos[idx].generatedGoshuinUrl = storageUrl;
      if (!currentTrip.generatedAnimes) currentTrip.generatedAnimes = [];
      currentTrip.generatedAnimes.push({
        url: storageUrl,
        timestamp: Date.now(),
        style: 'stamp-goshuin',
        name: photos[idx].name || ''
      });
      await saveTrip({ silent: true });
      renderGoshuinPreview(storageUrl);
      renderGeneratedAnimesList();
      setStatus('✓ 御朱印風QR画像を生成しました');
    } catch (err) {
      console.error('御朱印画像生成エラー:', err);
      alert('画像の生成に失敗しました: ' + (err.message || String(err)));
      setStatus('❌ 画像の生成に失敗しました');
    } finally {
      goshuinBtn.disabled = false;
      goshuinBtn.textContent = originalText;
    }
  };

  const saveDeleteRow = document.createElement('div');
  saveDeleteRow.className = 'photo-popup-save-delete-row';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = '保存';
  const duplicateBtn = document.createElement('button');
  duplicateBtn.type = 'button';
  duplicateBtn.className = 'btn btn-secondary btn-sm';
  duplicateBtn.textContent = '📋 複製';
  duplicateBtn.title = 'このポイントを複製して次の位置に作成';
  const deletePhotoBtn = document.createElement('button');
  deletePhotoBtn.type = 'button';
  deletePhotoBtn.className = 'btn photo-popup-delete-photo-only';
  deletePhotoBtn.textContent = '📷 写真削除';
  deletePhotoBtn.title = 'ポイントは残して写真のみ削除';
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn photo-popup-delete-small';
  deleteBtn.textContent = '🗑️ 全削除';
  deleteBtn.title = 'ポイントごと削除';
  saveDeleteRow.appendChild(saveBtn);
  saveDeleteRow.appendChild(duplicateBtn);
  saveDeleteRow.appendChild(deletePhotoBtn);
  saveDeleteRow.appendChild(deleteBtn);
  form.appendChild(saveDeleteRow);

  const changeInput = document.createElement('input');
  changeInput.type = 'file';
  changeInput.accept = 'image/*';
  changeInput.hidden = true;
  const changeOverlay = document.createElement('div');
  changeOverlay.className = 'photo-popup-change-overlay';
  changeOverlay.innerHTML = '<span class="upload-icon">🔄</span><span>写真を変更</span>';
  changeOverlay.onclick = () => changeInput.click();
  changeOverlay.appendChild(changeInput);
  photoWrap.appendChild(changeOverlay);

  div.appendChild(form);

  landmarkCheck.onchange = () => {
    landmarkNoWrap.style.display = landmarkCheck.checked ? 'flex' : 'none';
    if (!landmarkCheck.checked) {
      landmarkNoInput.value = '';
    } else if (!landmarkNoInput.value.trim()) {
      // 番号未入力のままチェックした場合は次の番号を自動採番（地図に番号が出ない不具合を防止）
      const nums = photos
        .map(ph => parseInt(ph.landmarkNo, 10))
        .filter(n => !isNaN(n));
      const nextNo = nums.length > 0 ? Math.max(...nums) + 1 : 1;
      landmarkNoInput.value = String(nextNo);
    }
  };
  landmarkNoWrap.style.display = landmarkCheck.checked ? 'flex' : 'none';

  stampCheck.onchange = () => {
    goshuinBtn.style.display = stampCheck.checked ? '' : 'none';
  };

  changeInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file?.type.startsWith('image/')) {
      alert('画像ファイルを選択してください');
      return;
    }

    // 認証状態を確認
    if (!window.firebaseAuth?.currentUser) {
      alert('写真をアップロードするには、Googleアカウントでログインしてください。\n\n右上のメニューから「ログイン」を選択してください。');
      changeInput.value = '';
      return;
    }

    try {
      setStatus('写真をアップロード中...');
      const photoData = await loadPhotoWithExif(file);

      // オリジナルのGPS位置を保持（新しい写真のGPSは使用しない）
      const originalLat = photos[idx].lat;
      const originalLng = photos[idx].lng;
      const originalPlaceName = photos[idx].placeName;
      const originalName = photos[idx].name;

      // 古い写真をStorageから削除（ただし、他のポイントが同じURLを使っている場合は削除しない）
      const oldPhotoUrl = photos[idx].url;
      const oldThumbUrl = photos[idx].thumbUrl;
      if (oldPhotoUrl) {
        // 同じURLを持つ他のポイントがあるかチェック
        const otherPhotosWithSameUrl = photos.filter((p, i) => i !== idx && p.url === oldPhotoUrl);
        if (otherPhotosWithSameUrl.length === 0) {
          // 他に使っているポイントがない場合のみStorageから削除
          await deletePhotoFromStorage(oldPhotoUrl);
          if (oldThumbUrl) await deletePhotoFromStorage(oldThumbUrl);
        } else {
          console.log('他のポイントが同じ写真を使用しているため、Storageから削除しません:', oldPhotoUrl);
        }
      }

      // Storageにアップロード
      const url = await uploadPhotoToStorage(currentTrip.id, idx, photoData.blob);
      const thumbUrl = await uploadThumbnailToStorage(currentTrip.id, idx, photoData.thumbBlob);

      // 写真データを更新（GPS位置は元のまま維持）
      photos[idx].url = url;
      photos[idx].thumbUrl = thumbUrl;
      photos[idx].mime = photoData.mime;
      photos[idx].lat = originalLat;
      photos[idx].lng = originalLng;
      photos[idx].placeName = originalPlaceName;
      photos[idx].name = originalName;

      // UI更新（画像のみ更新、地図は移動しない）
      img.src = url;
      await updateTripInputs();

      // 保存
      try {
        await saveTrip({ silent: true });
        renderThumbnails();
        // マーカー更新は呼ばない（現在のポップアップ位置を維持）
        setStatus('写真を変更しました');
      } catch (err) {
        console.error('保存エラー:', err);
        setStatus('写真をアップロードしました（保存は手動で）');
      }
    } catch (err) {
      console.error('写真追加エラー:', err);
      const errorMsg = err?.message || String(err);

      // 認証エラーの場合は特別なメッセージを表示
      if (errorMsg.includes('unauthorized') || errorMsg.includes('permission')) {
        alert('写真のアップロード権限がありません。\n\n以下を確認してください：\n1. Googleアカウントでログインしているか\n2. ブラウザを再読み込みして再度ログインしてみてください\n3. Firebase Storage Rulesが正しく設定されているか');
      } else {
        alert(`写真の追加に失敗しました:\n${errorMsg}\n\nブラウザのコンソール（F12）で詳細を確認してください。`);
      }
      setStatus('写真の追加に失敗しました');
    }
    changeInput.value = '';
  };

  const performSave = async (closeAfter = false) => {
    if (photos[idx]) {
      photos[idx].name = nameInput.value.trim();
      photos[idx].description = descInput.value.trim();
      photos[idx].landmarkNo = landmarkCheck.checked ? landmarkNoInput.value.trim() : '';
      photos[idx].isStamp = stampCheck.checked;
      photos[idx].videoUrl = videoUrlInput.value.trim();
    }
    // フォームが空の場合（メニュー未表示時など）は currentTrip をフォームに反映してから保存
    const nameEl = document.getElementById('tripNameInput');
    if (!nameEl?.value?.trim() && currentTrip?.name) updateTripInputs();
    syncFormToCurrentTrip();
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await saveTrip({ silent: true });
        renderThumbnails();
        scheduleMapMarkersUpdate();
        if (closeAfter) {
          closePhotoPopup();
          showPhotoAtIndex(currentPhotoIndex, true);
        }
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
        setStatus('✓ 写真の詳細を保存しました');
        return;
      } catch (err) {
        const isRetryable = err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError');
        if (attempt < 5 && isRetryable) {
          saveBtn.textContent = `保存中... (${attempt}/5)`;
          await new Promise(r => setTimeout(r, 1500 * attempt));
        } else {
          setStatus('保存に失敗しました');
          console.error('保存エラー:', err);
          saveBtn.disabled = false;
          saveBtn.textContent = '保存';
          // 保存失敗をポップアップ表示
          alert('✗ 保存に失敗しました: ' + (err?.message || '不明なエラー'));
          return;
        }
      }
    }
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
  };

  // 自動保存を削除し、手動保存のみに変更
  saveBtn.onclick = () => performSave(true);

  // 複製ボタン
  duplicateBtn.onclick = async () => {
    if (!photos[idx]) return;

    const photoName = photos[idx].name || '（無題）';
    const message = `このポイントを複製しますか？\n\n${photoName}\n\n同じGPS位置と情報を持つポイントがこの次に作成されます。`;
    if (!confirm(message)) return;

    // ボタンを無効化
    duplicateBtn.disabled = true;
    duplicateBtn.textContent = '複製中...';
    setStatus('ポイントを複製中...');

    try {
      // 元のポイントをそのままディープコピー（フォームの内容は反映しない）
      const duplicatedPhoto = structuredClone(photos[idx]);

      // ランドマークとスタンプのチェックを外す
      duplicatedPhoto.isLandmark = false;
      duplicatedPhoto.isStamp = false;
      // 生成済みの御朱印風画像はこのポイント固有のものなので複製しない
      delete duplicatedPhoto.generatedGoshuinUrl;

      // ポイント名に「2」を追加
      if (duplicatedPhoto.name) {
        duplicatedPhoto.name = `${duplicatedPhoto.name}2`;
      } else {
        duplicatedPhoto.name = '2';
      }

      // ポイント説明に「2」を追加
      if (duplicatedPhoto.description) {
        duplicatedPhoto.description = `${duplicatedPhoto.description}2`;
      } else {
        duplicatedPhoto.description = '2';
      }

      // 写真関連の情報を削除（写真はコピーしない）
      delete duplicatedPhoto.url;
      delete duplicatedPhoto.storagePath;
      delete duplicatedPhoto.file;

      // 次の位置に挿入
      photos.splice(idx + 1, 0, duplicatedPhoto);

      // ポップアップを閉じる
      closePhotoPopup();

      // UI更新
      updateTripInputs();
      renderThumbnails();
      await updateMapMarkers();

      // 保存
      await saveTrip({ silent: true });

      // 複製したポイントを表示
      currentPhotoIndex = idx + 1;
      showPhotoAtIndex(currentPhotoIndex, true);

      setStatus('✓ ポイントを複製しました');
    } catch (err) {
      console.error('複製エラー:', err);
      alert('ポイントの複製に失敗しました: ' + (err.message || String(err)));
      duplicateBtn.disabled = false;
      duplicateBtn.textContent = '📋 複製';
      setStatus('❌ 複製に失敗しました');
    }
  };

  // 写真のみ削除（ポイントは残す）
  deletePhotoBtn.onclick = async () => {
    if (!photos[idx]) return;
    const photoName = photos[idx].name || '（無題）';
    const message = `写真のみを削除しますか？\n\n${photoName}\n\nポイント情報は残ります。`;
    if (!confirm(message)) return;

    // ボタンを無効化して状態を表示
    deletePhotoBtn.disabled = true;
    deletePhotoBtn.textContent = '削除中...';
    setStatus('写真を削除中...');

    // Storageから写真を削除（ただし、他のポイントが同じURLを使っている場合は削除しない）
    const photoUrl = photos[idx]?.url;
    if (photoUrl) {
      // 同じURLを持つ他のポイントがあるかチェック
      const otherPhotosWithSameUrl = photos.filter((p, i) => i !== idx && p.url === photoUrl);
      if (otherPhotosWithSameUrl.length === 0) {
        // 他に使っているポイントがない場合のみStorageから削除
        await deletePhotoFromStorage(photoUrl);
      } else {
        console.log('他のポイントが同じ写真を使用しているため、Storageから削除しません:', photoUrl);
      }
    }

    // 写真URLのみ削除、ポイント情報は保持
    if (photos[idx]) {
      photos[idx].url = '';
      photos[idx].mime = '';
      // name, description, lat, lng, landmarkNo などは保持
    }

    closePhotoPopup();

    updateTripInputs();
    let saved = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await saveTrip({ silent: true });
        saved = true;
        break;
      } catch (err) {
        const isRetryable = err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError');
        if (attempt < 3 && isRetryable) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          setStatus('❌ 削除の保存に失敗しました');
          console.error(err);
          alert('削除の保存に失敗しました。\n\nもう一度お試しください。');
          deletePhotoBtn.disabled = false;
          deletePhotoBtn.textContent = '📷 写真削除';
          return;
        }
      }
    }
    if (saved) {
      renderThumbnails();
      scheduleMapMarkersUpdate();
      showPhotoAtIndex(currentPhotoIndex, true);
      setStatus('✓ 写真を削除しました（ポイントは残っています）');
    }
  };

  // ポイントごと削除
  deleteBtn.onclick = async () => {
    if (!photos[idx]) return;
    const photoName = photos[idx].name || '（無題）';
    const message = `ポイントごと削除しますか？\n\n${photoName}\n\nこの操作は元に戻せません。`;
    if (!confirm(message)) return;

    // 削除ボタンを無効化して状態を表示
    deleteBtn.disabled = true;
    deleteBtn.textContent = '削除中...';
    setStatus('ポイントを削除中...');

    // Storageから写真を削除（ただし、他のポイントが同じURLを使っている場合は削除しない）
    const photoUrl = photos[idx]?.url;
    if (photoUrl) {
      // 同じURLを持つ他のポイントがあるかチェック
      const otherPhotosWithSameUrl = photos.filter((p, i) => i !== idx && p.url === photoUrl);
      if (otherPhotosWithSameUrl.length === 0) {
        // 他に使っているポイントがない場合のみStorageから削除
        await deletePhotoFromStorage(photoUrl);
      } else {
        console.log('他のポイントが同じ写真を使用しているため、Storageから削除しません:', photoUrl);
      }
    }

    photos.splice(idx, 1);
    closePhotoPopup();
    currentPhotoIndex = Math.min(idx, Math.max(0, photos.length - 1));
    updateTripInputs();
    let saved = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await saveTrip({ silent: true });
        saved = true;
        break;
      } catch (err) {
        const isRetryable = err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError');
        if (attempt < 3 && isRetryable) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          setStatus('❌ 削除の保存に失敗しました');
          console.error(err);
          alert('削除の保存に失敗しました。\n\nもう一度お試しください。');
          deleteBtn.disabled = false;
          deleteBtn.textContent = '🗑️ 全削除';
          return;
        }
      }
    }
    if (saved) {
      renderThumbnails();
      scheduleMapMarkersUpdate();
      if (photos.length > 0) {
        showPhotoAtIndex(currentPhotoIndex, true);
      } else {
        renderTripDetailPane();
        updateHeaderInfo();
      }
      setStatus('✓ ポイントを削除しました');
    }
  };

  photoPopup = L.popup({
      maxWidth: 1000,
      minWidth: 0,
      className: 'photo-popup-container photo-popup-edit-container',
      closeButton: false,
      autoPan: true,
      autoPanPaddingTopLeft: [20, 20],
      autoPanPaddingBottomRight: [20, 20],
      keepInView: true,
      offset: [0, -30]
    })
    .setLatLng([lat, lng])
    .setContent(div)
    .openOn(map);

  // ポップアップが開いた後、編集フォーム全体が見えるように地図を調整
  setTimeout(() => {
    const popupElement = photoPopup.getElement();
    if (popupElement) {
      const popupHeight = popupElement.offsetHeight;
      const point = map.latLngToContainerPoint([lat, lng]);
      const targetX = point.x;
      const targetY = point.y - (popupHeight / 2) + 20;
      const targetLatLng = map.containerPointToLatLng([targetX, targetY]);
      map.panTo(targetLatLng, { animate: true, duration: 0.3 });
    }
  }, 50);
}

// GPSポイント追加モードの切り替え
function toggleAddGpsPointMode() {
  addingGpsPointMode = !addingGpsPointMode;
  const btn = document.getElementById('addGpsPointBtn');
  if (btn) {
    btn.classList.toggle('active', addingGpsPointMode);
  }
  const tripMenuGpsBtn = document.getElementById('tripMenuGpsBtn');
  if (tripMenuGpsBtn) {
    tripMenuGpsBtn.classList.toggle('active', addingGpsPointMode);
  }

  if (addingGpsPointMode) {
    setStatus('地図上をクリックしてGPSポイントを追加してください');
    map.getContainer().style.cursor = 'crosshair';
  } else {
    setStatus('GPSポイント追加モードを終了しました');
    map.getContainer().style.cursor = '';
  }
}

// 地図クリックでGPSポイントを追加
async function addGpsPointAtLocation(lat, lng) {
  if (!currentTrip) {
    alert('トリップを選択してください');
    return;
  }

  if (!isEditor()) {
    alert('編集権限がありません');
    return;
  }

  try {
    // 逆ジオコーディングで場所名を取得
    const placeName = await reverseGeocode(lat, lng);

    // 写真なしのGPSポイントを追加
    const newPoint = {
      lat: parseFloat(lat.toFixed(6)),
      lng: parseFloat(lng.toFixed(6)),
      placeName: placeName || `GPS: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      name: '',
      description: '',
      url: null, // 写真なし
      timestamp: Date.now()
    };

    if (!currentTrip.photos) {
      currentTrip.photos = [];
    }
    currentTrip.photos.push(newPoint);

    // 保存
    await saveTrip({ silent: true });

    // UI更新
    renderThumbnails();
    await updateMapMarkers();

    // 追加したポイントを表示
    currentPhotoIndex = currentTrip.photos.length - 1;
    showPhotoAtIndex(currentPhotoIndex);

    setStatus(`GPSポイントを追加しました: ${placeName}`);

    // モード継続（複数追加できるように）
  } catch (err) {
    console.error('GPSポイント追加エラー:', err);
    alert('GPSポイントの追加に失敗しました: ' + (err.message || ''));
  }
}

function hidePlayOverlay() {
  closePhotoPopup();
}

/** 自動再生中の停止ボタン: 動画再生中なら動画を止めて次へ、そうでなければ再生を停止 */
function handlePlaybackStop() {
  if (playbackVideoEndCallback) {
    const cb = playbackVideoEndCallback;
    playbackVideoEndCallback = null;
    if (playbackVideoTimer) {
      clearTimeout(playbackVideoTimer);
      playbackVideoTimer = null;
    }
    cb();
  } else {
    stopPlay();
    showTripOverview().catch(err => console.error('トリップ全体表示エラー:', err));
  }
}

/** トリップ全体を地図に表示 */
async function showTripOverview() {
  try {
    if (!currentTrip) return;

    await updateMapMarkers();

    // 全てのポイントが見えるように地図を調整
    const photos = getDisplayPhotos();
    if (photos.length > 0 && map) {
      const bounds = [];
      photos.forEach(p => {
        if (p.lat != null && p.lng != null) {
          bounds.push([p.lat, p.lng]);
        }
      });
      if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
      }
    }

    // サムネイルを表示
    if (!thumbnailsVisible) {
      thumbnailsVisible = true;
      renderThumbnails();
    }
  } catch (err) {
    console.error('showTripOverview エラー:', err);
  }
}

/** 再生完了時: 全ポイントを含む地図に戻る */
async function onPlaybackComplete() {
  if (playTimer) {
    clearTimeout(playTimer);
    clearInterval(playTimer);
    playTimer = null;
  }
  playbackVideoEndCallback = null;
  currentAutoplayTick = null;
  if (playbackVideoTimer) {
    clearTimeout(playbackVideoTimer);
    playbackVideoTimer = null;
  }
  hidePlaybackPhotoOverlay();

  // 再生完了時の停止処理（最初には戻らない）
  playbackPhotos = [];
  const playBtn = document.getElementById('playBtn');
  if (playBtn) playBtn.textContent = '▶ 再生';
  const mapPlayBtn = document.getElementById('mapPlayBtn');
  if (mapPlayBtn) mapPlayBtn.textContent = '▶ 再生';
  const mobilePlayBtn = document.getElementById('mobilePlayBtn');
  if (mobilePlayBtn) mobilePlayBtn.textContent = '▶';
  document.querySelector('.map-container')?.classList.remove('map-playback-cinematic');
  document.body.classList.remove('app-playing');
  hidePlayOverlay();
  lastPlaybackPhotoUrl = null;

  // 3D地図のレイヤーをクリア
  if (map3d) {
    try {
      if (map3d.getLayer('route')) map3d.removeLayer('route');
      if (map3d.getSource('route')) map3d.removeSource('route');
      if (map3d.getLayer('points')) map3d.removeLayer('points');
      if (map3d.getSource('points')) map3d.removeSource('points');
    } catch (e) {
      console.warn('3D地図レイヤークリアエラー:', e);
    }
  }

  await updateMapMarkers();
  await updateHeaderInfo();

  // トリップ全体のマップに戻る
  showTripOverview().catch(err => console.error('トリップ全体表示エラー:', err));

  if (!thumbnailsVisible) {
    thumbnailsVisible = true;
    renderThumbnails();
  }
}

function stopPlay() {
  const isAutoPlaying = document.body.classList.contains('app-playing');

  // 自動再生中で動画が表示されている場合は、動画を停止してウィンドウを閉じる
  if (isAutoPlaying) {
    const overlay = document.getElementById('playbackPhotoOverlay');
    const isVideoDisplayed = overlay && !overlay.classList.contains('hidden') &&
                             overlay.classList.contains('playback-video-fullscreen');

    // または、現在のポイントが動画の場合
    const currentP = playbackPhotos && playbackPhotos[currentPhotoIndex];
    const isCurrentVideo = currentP && currentP.videoUrl && currentP.videoUrl.trim();

    if (isVideoDisplayed || (isCurrentVideo && currentAutoplayTick)) {
      console.log('動画再生中に停止ボタン押下: 動画を停止してウィンドウを閉じる');

      // 動画を停止
      playbackVideoEndCallback = null;
      if (playbackVideoTimer) {
        clearTimeout(playbackVideoTimer);
        playbackVideoTimer = null;
      }
      if (playTimer) {
        clearTimeout(playTimer);
        playTimer = null;
      }

      // 自動再生を完全に停止
      currentAutoplayTick = null;

      // 再生ボタンのテキストを「再生」に戻す
      const playBtn = document.getElementById('playBtn');
      if (playBtn) playBtn.textContent = '▶ 再生';
      const mapPlayBtn = document.getElementById('mapPlayBtn');
      if (mapPlayBtn) mapPlayBtn.textContent = '▶ 再生';
      const mobilePlayBtn = document.getElementById('mobilePlayBtn');
      if (mobilePlayBtn) mobilePlayBtn.textContent = '▶';

      // app-playingクラスを削除
      document.querySelector('.map-container')?.classList.remove('map-playback-cinematic');
      document.body.classList.remove('app-playing');

      // 動画ウィンドウを閉じる（iframe内の動画も停止される）
      hidePlaybackPhotoOverlay();
      hidePlayOverlay();

      // ルート表示を通常モードに戻す
      scheduleMapMarkersUpdate();

      // 現在の位置を保持したまま停止（playbackPhotos・currentPhotoIndexはクリアしない）
      // 次回再生ボタンを押すと、この位置から継続再生される
      return;
    }
  }

  // 通常の停止処理
  playbackVideoEndCallback = null;
  currentAutoplayTick = null;
  if (playTimer) {
    clearTimeout(playTimer);
    clearInterval(playTimer); // 念のため両方
    playTimer = null;
  }

  // 動画再生タイマーをクリア
  if (playbackVideoTimer) {
    clearTimeout(playbackVideoTimer);
    playbackVideoTimer = null;
  }

  playbackPhotos = []; // 再生用配列をクリア
  const playBtn = document.getElementById('playBtn');
  if (playBtn) playBtn.textContent = '▶ 再生';
  const mapPlayBtn = document.getElementById('mapPlayBtn');
  if (mapPlayBtn) mapPlayBtn.textContent = '▶ 再生';
  const mobilePlayBtn = document.getElementById('mobilePlayBtn');
  if (mobilePlayBtn) mobilePlayBtn.textContent = '▶';
  document.querySelector('.map-container')?.classList.remove('map-playback-cinematic');
  document.body.classList.remove('app-playing');
  hidePlaybackPhotoOverlay();
  hidePlayOverlay();
  // ルート表示を通常モードに戻す
  scheduleMapMarkersUpdate();
  // キャッシュクリア
  lastPlaybackPhotoUrl = null;
  // 3D地図のレイヤーをクリア
  if (map3d) {
    try {
      if (map3d.getLayer('route')) map3d.removeLayer('route');
      if (map3d.getSource('route')) map3d.removeSource('route');
      if (map3d.getLayer('points')) map3d.removeLayer('points');
      if (map3d.getSource('points')) map3d.removeSource('points');
    } catch (e) {
      console.warn('3D地図レイヤークリアエラー:', e);
    }
  }

  // トリップ全体のマップに戻る
  showTripOverview().catch(err => console.error('トリップ全体表示エラー:', err));
}

let cachedGpxPoints = null;
let cachedGpxTripId = null;

async function getRouteSegmentBetweenPhotos(fromIdx, toIdx) {
  const photos = getDisplayPhotos();
  const fromP = photos[fromIdx];
  const toP = photos[toIdx];
  if (!fromP?.lat || !toP?.lat) return null;
  const fromPt = [fromP.lat, fromP.lng];
  const toPt = [toP.lat, toP.lng];

  // GPXポイントをキャッシュから取得（自動再生中のパフォーマンス向上）
  let gpxPts;
  if (currentTrip && currentTrip.id === cachedGpxTripId && cachedGpxPoints) {
    gpxPts = cachedGpxPoints;
  } else {
    const gpxText = currentTrip ? await getGpxContent(currentTrip) : null;
    if (!gpxText) return [fromPt, toPt];
    gpxPts = parseGpxPoints(gpxText);
    if (currentTrip) {
      cachedGpxPoints = gpxPts;
      cachedGpxTripId = currentTrip.id;
    }
  }

  if (gpxPts.length < 2) return [fromPt, toPt];
  let bestFrom = 0, bestTo = gpxPts.length - 1;
  let dFrom = Infinity, dTo = Infinity;
  for (let j = 0; j < gpxPts.length; j++) {
    const df = haversineKm(fromP.lat, fromP.lng, gpxPts[j][0], gpxPts[j][1]);
    const dt = haversineKm(toP.lat, toP.lng, gpxPts[j][0], gpxPts[j][1]);
    if (df < dFrom) { dFrom = df; bestFrom = j; }
    if (dt < dTo) { dTo = dt; bestTo = j; }
  }
  const segment = [fromPt];
  if (bestFrom <= bestTo) {
    for (let j = bestFrom; j <= bestTo; j++) segment.push(gpxPts[j]);
  } else {
    for (let j = bestFrom; j >= bestTo; j--) segment.push(gpxPts[j]);
  }
  segment.push(toPt);
  return segment;
}

async function startPlay() {
  if (playTimer) {
    handlePlaybackStop();
    return;
  }

  const allPhotos = getDisplayPhotos();

  // playbackPhotosが既にある場合は継続再生、ない場合は新規再生
  const isContinuingPlayback = playbackPhotos && playbackPhotos.length > 0;

  if (!isContinuingPlayback) {
    // 新規再生: 写真または動画URLがあるポイントを再生対象にする
    playbackPhotos = allPhotos.filter(p => (p.url && p.url.trim()) || (p.videoUrl && p.videoUrl.trim()));
    if (!playbackPhotos.length) {
      showToast(currentTrip ? '📷 再生できる写真・動画がありません' : MSG_NO_PHOTOS);
      return;
    }
  }

  // モバイルでヘッダーを隠す
  if (isMobileView()) {
    markMobileHeaderInteracted();
  }

  // 処理中であることを示すため、先に playTimer をセット（二重実行防止）
  const startingPlay = true; // 開始中フラグ

  try {
    // 継続再生の場合は現在のインデックスから、新規再生の場合は1枚目から
    if (!isContinuingPlayback) {
      currentPhotoIndex = 0;
    }

    // 前回の再生状態をリセット
    lastPlaybackPhotoUrl = null;

    const intervalSec = 5;
    playIntervalMs = intervalSec * 1000;
    const playBtn = document.getElementById('playBtn');
    if (playBtn) playBtn.textContent = '■ 停止';
    const mapPlayBtn = document.getElementById('mapPlayBtn');
    if (mapPlayBtn) mapPlayBtn.textContent = '■ 停止';
    const mobilePlayBtn = document.getElementById('mobilePlayBtn');
    if (mobilePlayBtn) mobilePlayBtn.textContent = '■';

    // 3D地図で自動再生
    document.querySelector('.map-container')?.classList.add('map-playback-cinematic');
    document.body.classList.add('app-playing');

    // 3D地図を初期化
    await initMap3d();

    // 3D地図の読み込み結果に応じてモードを切り替え
    if (!map3d) {
      // 3D地図に失敗した場合は2Dマップをそのまま使用（cinematicクラスを外す）
      document.querySelector('.map-container')?.classList.remove('map-playback-cinematic');
    } else {
      // 3D地図が有効な場合はルートとマーカーを追加
      add3dMapRouteAndMarkers().catch(e => console.warn('3Dルート描画エラー:', e));
    }

    // ルート表示を目立つモードに切り替え（2D Leaflet マップ）
    await updateMapMarkers();

    // 自動再生時はサムネイルを非表示
    thumbnailsVisible = false;
    renderThumbnails();

    // 継続再生の場合は現在のインデックス、新規再生の場合は最初から
    const startP = playbackPhotos[currentPhotoIndex];
    if (startP?.lat != null && startP?.lng != null) {
      map.setView([startP.lat, startP.lng], 17);
      // 3D地図の初期位置を設定
      if (map3d) {
        map3d.flyTo({
          center: [startP.lng, startP.lat],
          zoom: 17,
          pitch: 60,
          bearing: 0,
          duration: 1500
        });
      }
    }

    const tick = async () => {
      try {
        if (!playTimer || currentPhotoIndex >= playbackPhotos.length - 1) {
          onPlaybackComplete();
          return;
        }

        currentPhotoIndex++;
        const nextP = playbackPhotos[currentPhotoIndex];

        // 3D地図で次のポイントにスムーズに移動
        if (nextP?.lat != null && nextP?.lng != null) {
          map.panTo([nextP.lat, nextP.lng], { animate: true, duration: 1.0 });
          // 3D地図も同時に移動
          if (map3d) {
            map3d.flyTo({
              center: [nextP.lng, nextP.lat],
              zoom: 17,
              pitch: 60,
              duration: 1500
            });
          }
        }

        // パルスマーカーを現在ポイントに更新
        updatePlaybackPulseMarker();

        // 動画がある場合は動画終了まで待つ
        if (nextP.videoUrl && nextP.videoUrl.trim()) {
          console.log(`自動再生: 動画ポイントを再生 (${currentPhotoIndex + 1}/${playbackPhotos.length}) - ${nextP.name || 'ポイント名なし'}`);
          await showPlaybackPhotoOverlay(nextP, () => {
            console.log('自動再生: 動画終了、次のポイントへ');
            playTimer = setTimeout(tick, 500);
          });
        } else {
          console.log(`自動再生: 写真ポイントを表示 (${currentPhotoIndex + 1}/${playbackPhotos.length}) - ${nextP.name || 'ポイント名なし'}`);
          await showPlaybackPhotoOverlay(nextP);
          playTimer = setTimeout(tick, 2500);
        }
      } catch (err) {
        console.error('自動再生tickエラー:', err);
        if (currentPhotoIndex < playbackPhotos.length - 1) {
          playTimer = setTimeout(tick, 2500);
        } else {
          onPlaybackComplete();
        }
      }
    };
    currentAutoplayTick = tick;

    // 継続再生の場合は現在のポイントから、新規再生の場合は最初から表示
    if (startP.videoUrl && startP.videoUrl.trim()) {
      console.log(`自動再生開始: ${isContinuingPlayback ? '継続' : '最初の'}ポイントは動画です (${startP.name || 'ポイント名なし'})`);
      await showPlaybackPhotoOverlay(startP, () => {
        console.log('動画終了: 次のポイントへ移動します');
        playTimer = setTimeout(tick, 500);
      });
    } else {
      console.log(`自動再生開始: ${isContinuingPlayback ? '継続' : '最初の'}ポイントは写真です (${startP.name || 'ポイント名なし'})`);
      await showPlaybackPhotoOverlay(startP);
      playTimer = setTimeout(tick, 2500);
    }
  } catch (err) {
    console.error('自動再生の開始エラー:', err);
    stopPlay(); // エラー発生時は停止
    alert('自動再生の開始に失敗しました。ページを再読み込みしてください。');
  }
}

/** 自動再生中に前後の写真・動画へジャンプ */
async function jumpPlayback(delta) {
  if (!document.body.classList.contains('app-playing')) return;
  if (!playbackPhotos || !playbackPhotos.length) return;

  // 現在の動画・タイマーをキャンセル
  playbackVideoEndCallback = null;
  if (playbackVideoTimer) { clearTimeout(playbackVideoTimer); playbackVideoTimer = null; }
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }

  const newIdx = currentPhotoIndex + delta;
  if (newIdx < 0 || newIdx >= playbackPhotos.length) return;
  currentPhotoIndex = newIdx;
  const p = playbackPhotos[currentPhotoIndex];

  // 地図をジャンプ先に移動（2D地図を使用）
  if (p?.lat != null && p?.lng != null) {
    map.panTo([p.lat, p.lng], { animate: true, duration: 1.0 });
  }

  if (!currentAutoplayTick) return;
  const tickFn = currentAutoplayTick;
  if (p.videoUrl && p.videoUrl.trim()) {
    await showPlaybackPhotoOverlay(p, () => {
      playTimer = setTimeout(tickFn, 500);
    });
  } else {
    await showPlaybackPhotoOverlay(p);
    playTimer = setTimeout(tickFn, 2500);
  }
}

function prevPhoto() {
  if (document.body.classList.contains('app-playing')) {
    jumpPlayback(-1);
    return;
  }
  const photos = getDisplayPhotos();
  if (!photos.length) { showToast(MSG_NO_PHOTOS); return; }
  currentPhotoIndex = (currentPhotoIndex - 1 + photos.length) % photos.length;
  if (!thumbnailsVisible) {
    thumbnailsVisible = true;
    renderThumbnails();
  }
  showPhotoAtIndex(currentPhotoIndex);
}

function nextPhoto() {
  if (document.body.classList.contains('app-playing')) {
    jumpPlayback(1);
    return;
  }
  const photos = getDisplayPhotos();
  if (!photos.length) { showToast(MSG_NO_PHOTOS); return; }
  if (thumbnailsVisible) {
    currentPhotoIndex = (currentPhotoIndex + 1) % photos.length;
  } else {
    currentPhotoIndex = 0;
    thumbnailsVisible = true;
    renderThumbnails();
  }
  showPhotoAtIndex(currentPhotoIndex);
}

function sanitizeForFirestore(obj) {
  if (obj == null || typeof obj === 'number' || typeof obj === 'boolean' || typeof obj === 'string') return obj;
  if (typeof obj === 'function' || typeof obj === 'symbol') return undefined;
  if (Array.isArray(obj)) return obj.map(sanitizeForFirestore).filter(v => v !== undefined);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      const s = sanitizeForFirestore(v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

async function saveTrip(opts = {}) {
  const silent = !!opts.silent;
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) {
    if (!silent) alert('ログインしてください');
    throw new Error('Not logged in');
  }
  const uid = window.firebaseAuth.currentUser.uid;
  if (currentTrip?.id && currentTrip?.userId && currentTrip.userId !== uid) {
    if (!silent) alert('このトリップは他のユーザーのため編集できません');
    throw new Error('Permission denied');
  }
  const nameInputEl = document.getElementById('tripNameInput');
  let name = (nameInputEl?.value?.trim() || currentTrip?.name?.trim() || '無題').trim();
  if (!name) {
    if (!silent) alert('トリップ名を入力してください');
    throw new Error('Trip name required');
  }
  const parentInputEl = document.getElementById('tripParentInput');
  const isParent = parentInputEl ? parentInputEl.checked : !!currentTrip?.isParent;
  const parentSelectEl = document.getElementById('tripParentSelect');
  const parentId = (parentSelectEl?.value?.trim() || currentTrip?.parentId || null) || null;
  const colorInputEl = document.getElementById('tripColorInput');
  const color = colorInputEl?.value || currentTrip?.color || TRIP_COLORS[0];

  if (isParent && currentTrip?.photos?.length > 0 && !confirm('親トリップには写真を保存できません。写真は破棄されます。続行しますか？')) {
    throw new Error('Cancelled');
  }
  const hasContent = (currentTrip?.photos?.length) || currentTrip?.gpxData || currentTrip?.gpxDataUrl || currentTrip?.characterImageUrl;
  if (!isParent && !parentId && !hasContent) {
    if (!silent) alert('写真、GPX、またはキャラクター画像を追加するか、「親トリップ」にチェックを入れてください');
    throw new Error('Photos or GPX required');
  }

  currentTrip = currentTrip || createNewTrip();
  currentTrip.name = name;
  const descEl = document.getElementById('tripDescInput');
  currentTrip.description = (descEl?.value?.trim() || currentTrip?.description || '') || '';
  const urlEl = document.getElementById('tripUrlInput');
  currentTrip.url = (urlEl?.value?.trim() || currentTrip?.url || '') || '';
  const videoUrlEl = document.getElementById('tripVideoUrlInput');
  currentTrip.videoUrl = (videoUrlEl?.value?.trim() || currentTrip?.videoUrl || null) || null;
  const publicEl = document.getElementById('tripPublicInput');
  currentTrip.public = publicEl ? publicEl.checked : !!currentTrip?.public;
  currentTrip.userId = window.firebaseAuth.currentUser.uid;
  currentTrip.updatedAt = Date.now();
  currentTrip.isParent = isParent;
  currentTrip.parentId = isParent ? null : parentId;
  currentTrip.color = color;
  if (!currentTrip.createdAt) currentTrip.createdAt = currentTrip.updatedAt;
  const hasNoPhotosOrGpx = !(currentTrip.photos?.length) && !currentTrip.gpxData && !currentTrip.gpxDataUrl;
  const useMinimal = isParent || hasNoPhotosOrGpx;

  let data;
  if (isParent) {
    currentTrip.photos = [];
    currentTrip.gpxData = null;
    currentTrip.gpxDataUrl = null;
    data = sanitizeForFirestore({
      id: currentTrip.id,
      name: currentTrip.name,
      description: currentTrip.description || '',
      url: currentTrip.url || '',
      videoUrl: currentTrip.videoUrl || null,
      public: currentTrip.public,
      color: currentTrip.color,
      createdAt: currentTrip.createdAt,
      updatedAt: currentTrip.updatedAt,
      parentId: null,
      isParent: true,
      userId: currentTrip.userId,
      photos: [],
      gpxData: null,
      gpxDataUrl: null,
      // travelogueHtmlは保存しない（Storageに保存済み）
      travelogueHtml: null,
      travelogueUrl: currentTrip.travelogueUrl || null,
      travelogueGeneratedAt: currentTrip.travelogueGeneratedAt || null,
      travelogueHistory: currentTrip.travelogueHistory || [],
      generatedAnimes: currentTrip.generatedAnimes || [],
      characterImageUrl: null
    });
  } else if (useMinimal) {
    data = sanitizeForFirestore({
      id: currentTrip.id,
      name: currentTrip.name,
      description: currentTrip.description || '',
      url: currentTrip.url || '',
      videoUrl: currentTrip.videoUrl || null,
      public: currentTrip.public,
      color: currentTrip.color,
      createdAt: currentTrip.createdAt,
      updatedAt: currentTrip.updatedAt,
      parentId: currentTrip.parentId,
      isParent: false,
      userId: currentTrip.userId,
      photos: [],
      gpxData: null,
      gpxDataUrl: null,
      // travelogueHtmlは保存しない（Storageに保存済み）
      travelogueHtml: null,
      travelogueUrl: currentTrip.travelogueUrl || null,
      travelogueGeneratedAt: currentTrip.travelogueGeneratedAt || null,
      travelogueHistory: currentTrip.travelogueHistory || [],
      generatedAnimes: currentTrip.generatedAnimes || [],
      characterImageUrl: currentTrip.characterImageUrl || null
    });
  } else {
    const tripForSave = { ...currentTrip };
    if (tripForSave.gpxData && !tripForSave.gpxDataUrl) {
      try {
        tripForSave.gpxDataUrl = await uploadGpxToStorage(currentTrip.id, tripForSave.gpxData);
      } catch (err) {
        console.error('GPXアップロードエラー:', err);
        alert('GPXのアップロードに失敗しました。' + (err.message || ''));
        return;
      }
    }
    delete tripForSave.gpxData;
    // travelogueHtmlは削除（Storageに保存済み、URLだけ保持）
    delete tripForSave.travelogueHtml;
    // 写真データから不要なフィールドを削除
    if (tripForSave.photos?.length) {
      tripForSave.photos = tripForSave.photos.map(p => {
        // Storageに保存済みの画像データやblobは削除
        const { data, blob, gpxData, file, ...rest } = p;
        return rest;
      });
    }
    data = sanitizeForFirestore(tripForSave);
  }

  const size = JSON.stringify(data).length;

  // 各フィールドのサイズを詳細にログ出力
  const fieldSizes = {};
  for (const [key, value] of Object.entries(data)) {
    fieldSizes[key] = JSON.stringify(value).length;
  }

  console.log('トリップ保存データ詳細:', {
    id: currentTrip.id,
    totalSize: size,
    fieldSizes: fieldSizes,
    hasGeneratedAnimes: !!data.generatedAnimes,
    generatedAnimesCount: data.generatedAnimes?.length || 0,
    hasTravelogueUrl: !!data.travelogueUrl,
    hasTravelogueHtml: !!data.travelogueHtml,
    photosCount: data.photos?.length || 0
  });

  if (size > 900000) {
    const largestFields = Object.entries(fieldSizes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, size]) => `${key}: ${(size / 1024).toFixed(2)}KB`)
      .join('\n');

    alert(`データが大きすぎます（Firestore 1MB制限）。\n\n現在のサイズ: ${(size / 1024).toFixed(2)}KB\n\n最も大きいフィールド:\n${largestFields}\n\nGPXデータを短くするか、トリップを分割してください。`);
    console.error('データサイズ超過。最大フィールド:', fieldSizes);
    return;
  }
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await window.firebaseDb.collection('trips').doc(currentTrip.id).set(data, { merge: true });
        console.log('Firestoreへの保存成功');
        break;
      } catch (e) {
        const isRetryable = e?.message?.includes('Failed to fetch') || e?.message?.includes('NetworkError');
        if (attempt < 3 && isRetryable) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          throw e;
        }
      }
    }
    if (!tripOrder.includes(currentTrip.id)) {
      const res = await saveTripOrder([...tripOrder, currentTrip.id]);
      if (!res.ok) console.warn('順序の保存に失敗:', res.err);
    }
    // 親トリップの公開設定を変更した場合、既存の子トリップにも同じ公開設定を反映
    // （子トリップが非公開のままだと、未ログインユーザーから中身が見えなくなるため）
    if (isParent) {
      const children = myTrips.filter(t => t.parentId === currentTrip.id && t.public !== currentTrip.public);
      if (children.length > 0) {
        try {
          const batch = window.firebaseDb.batch();
          children.forEach(c => {
            batch.update(window.firebaseDb.collection('trips').doc(c.id), { public: currentTrip.public });
          });
          await batch.commit();
        } catch (err) {
          console.warn('子トリップの公開設定同期に失敗:', err);
        }
      }
    }
    setStatus('保存しました');
    closeMenu();
    const travelogueBeforeReload = {
      travelogueUrl: currentTrip.travelogueUrl,
      travelogueHistory: currentTrip.travelogueHistory,
      travelogueGeneratedAt: currentTrip.travelogueGeneratedAt
    };
    // onSnapshot リスナーが Firestore 書き込みを即時検知して myTrips を自動更新するため、
    // キャッシュ無効化・loadMyTrips() 再呼び出しは不要。
    // ただし onSnapshot が未設定の環境（テスト等）のために呼び出しは残す（即返るだけ）。
    await loadMyTrips();
    const saved = myTripsMap.get(currentTrip.id);
    if (saved) {
      currentTrip = { ...saved, id: saved.id };
      // Firestoreのクエリが遅延する場合、直近保存した旅行記データを優先して保持
      const savedHasTravelogue = saved.travelogueUrl || (saved.travelogueHistory?.length > 0);
      const beforeHadTravelogue = travelogueBeforeReload.travelogueUrl || (travelogueBeforeReload.travelogueHistory?.length > 0);
      if (!savedHasTravelogue && beforeHadTravelogue) {
        currentTrip.travelogueUrl = travelogueBeforeReload.travelogueUrl;
        currentTrip.travelogueHistory = travelogueBeforeReload.travelogueHistory;
        currentTrip.travelogueGeneratedAt = travelogueBeforeReload.travelogueGeneratedAt;
      }
    }
    renderThumbnails();
    await updateMapMarkers();
    await renderTripDetailPane(); // → updateHeaderInfo() + renderTripList() を内包
    // updateHeaderInfo / renderTripList は renderTripDetailPane() 内で呼ばれるため除去
    refreshTripSelect();
    refreshTripParentSelectOptions();

    // URLにトリップ名パラメータを更新
    if (currentTrip && currentTrip.name) {
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('trip', encodeURIComponent(currentTrip.name));
      window.history.replaceState({}, '', newUrl.toString());
    }
  } catch (err) {
    console.error('保存エラー:', err);
    if (silent) throw err;
    const code = err?.code || err?.name || '';
    const msg = err?.message || String(err);
    if (code === 'permission-denied' || msg.includes('PERMISSION_DENIED')) {
      alert('保存に失敗しました: 権限がありません。このトリップを編集する権限がないか、ログインを確認してください。');
    } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      const hint = window.location.protocol === 'file:'
        ? 'file:// では動作しません。ターミナルで python3 -m http.server 8080 を実行し、http://localhost:8080 で開いてください。'
        : 'ネットワーク接続を確認してください。VPN・ファイアウォール・広告ブロッカーが通信をブロックしている可能性があります。';
      setStatus('保存に失敗しました: ' + hint);
    } else {
      alert('保存に失敗しました: ' + msg);
    }
  }
}

/**
 * Firestore からトリップ一覧を読み込む。
 *
 * 初回呼び出し時に onSnapshot リスナーを設定し、
 * 以降はリスナーが myTrips を自動更新するためこの関数は即返す。
 * 認証ユーザーが変わった場合は _tripsUnsubscribe を null にしてから呼ぶこと。
 */
async function loadMyTrips() {
  if (!window.firebaseDb) {
    console.warn('Firebase DB が初期化されていません');
    myTrips = [];
    return;
  }

  const currentUserId = window.firebaseAuth?.currentUser?.uid || 'public';

  // リスナーが同じユーザーで既に稼働中: myTrips は最新なので即返す
  if (_tripsUnsubscribe && tripsCache.userId === currentUserId) {
    console.log('✓ onSnapshot リスナー稼働中 – myTrips は最新です');
    return;
  }

  // 同じユーザーへのリスナーセットアップが既に進行中（初回スナップショット未到着）:
  // ここで新規リスナーを張ると、先発のリスナーが解除されて誰にも resolve されない
  // Promise が残ってしまうため、進行中の Promise をそのまま共有して待つ
  if (_tripsLoadPromise && _tripsLoadPromiseUserId === currentUserId) {
    return _tripsLoadPromise;
  }

  // ユーザー変更または初回: 既存リスナーを解除してから新規設定
  if (_tripsUnsubscribe) {
    _tripsUnsubscribe();
    _tripsUnsubscribe = null;
  }

  // onSnapshot で初回データ到着を Promise で待つ
  _tripsLoadPromiseUserId = currentUserId;
  const host = window.location.hostname || '';
  const isOhenroDomain = /^ohenro\.ktrips\.net$|^henro\.ktrips\.net$/.test(host);

  _tripsLoadPromise = new Promise((resolve, reject) => {
    let firstFire = true;

    // ohenro/henro.ktrips.net は「しまなみ・淡路と四国遍路」専用サイトのため、
    // 全公開トリップを読み込まず、対象の親トリップとその子トリップだけを
    // ピンポイントでクエリして無関係なトリップの読み込みを避ける（パフォーマンス改善）
    if (isOhenroDomain) {
      let parentDoc, childDocs = [];
      let parentReady = false, childrenReady = false;

      const mergeAndCache = () => {
        myTrips = parentDoc ? [parentDoc, ...childDocs] : [...childDocs];
        invalidateOrderedTripsCache();
        tripsCache.data     = myTrips;
        tripsCache.timestamp = Date.now();
        tripsCache.userId   = currentUserId;
      };
      const maybeFirstFire = () => {
        if (firstFire && parentReady && childrenReady) {
          firstFire = false;
          renderTripList();
          refreshTripSelect();
          refreshTripParentSelectOptions();
          resolve();
        }
      };
      const onErr = (label) => (err) => {
        console.error(`Firestore onSnapshot エラー (${label}):`, err);
        if (firstFire) {
          firstFire = false;
          myTrips = [];
          _tripsUnsubscribe = null;
          reject(err);
        }
      };

      const parentUnsub = window.firebaseDb.collection('trips').doc(OHENRO_DEFAULT_TRIP_ID)
        .onSnapshot((doc) => {
          parentDoc = doc.exists ? { ...doc.data(), id: doc.id } : null;
          parentReady = true;
          mergeAndCache();
          maybeFirstFire();
        }, onErr('ohenro親'));

      // parentId 単独の where では Firestore セキュリティルール上パーミッションエラーになるため、
      // ルールが直接参照する public/userId も併せて絞り込む（等価条件のみなので複合インデックス不要）
      const childrenQueryBase = window.firebaseAuth?.currentUser
        ? window.firebaseDb.collection('trips').where('userId', '==', window.firebaseAuth.currentUser.uid)
        : window.firebaseDb.collection('trips').where('public', '==', true);

      const childrenUnsub = childrenQueryBase
        .where('parentId', '==', OHENRO_DEFAULT_TRIP_ID)
        .onSnapshot((snapshot) => {
          childDocs = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
          childrenReady = true;
          mergeAndCache();
          maybeFirstFire();
        }, onErr('ohenro子'));

      _tripsUnsubscribe = () => { parentUnsub(); childrenUnsub(); };
      return;
    }

    const query = window.firebaseAuth?.currentUser
      ? window.firebaseDb.collection('trips')
          .where('userId', '==', window.firebaseAuth.currentUser.uid)
      : window.firebaseDb.collection('trips')
          .where('public', '==', true);

    _tripsUnsubscribe = query.onSnapshot(
      (snapshot) => {
        myTrips = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
        invalidateOrderedTripsCache(); // myTrips 更新時にキャッシュ無効化
        tripsCache.data     = myTrips;
        tripsCache.timestamp = Date.now();
        tripsCache.userId   = currentUserId;

        if (firstFire) {
          firstFire = false;
          const label = window.firebaseAuth?.currentUser ? '自分のトリップ' : '公開トリップ';
          renderTripList();
          refreshTripSelect();
          refreshTripParentSelectOptions();
          resolve();
        }
      },
      (err) => {
        console.error('Firestore onSnapshot エラー:', err);
        if (err.code === 'unavailable') {
          console.error('→ ネットワークエラー: インターネット接続を確認してください');
        } else if (err.code === 'permission-denied') {
          console.error('→ アクセス権限エラー: Firestore のセキュリティルールを確認してください');
        }
        if (firstFire) {
          firstFire = false;
          myTrips = [];
          _tripsUnsubscribe = null;
          reject(err);
        }
      }
    );
  }).finally(() => {
    _tripsLoadPromise = null;
    _tripsLoadPromiseUserId = null;
  });
  return _tripsLoadPromise;
}

async function loadTripOrder() {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) {
    tripOrder = [];
    invalidateOrderedTripsCache();
    return;
  }
  try {
    const doc = await window.firebaseDb.collection('users').doc(window.firebaseAuth.currentUser.uid).get();
    tripOrder = (doc.exists && doc.data()?.tripOrder) ? [...doc.data().tripOrder] : [];
  } catch (err) {
    console.warn('トリップ順序読み込みエラー:', err);
    tripOrder = [];
  }
  invalidateOrderedTripsCache(); // tripOrder 更新時にキャッシュ無効化
}

async function saveTripOrder(ids) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return { ok: false, err: 'ログインが必要です' };
  try {
    await window.firebaseDb.collection('users').doc(window.firebaseAuth.currentUser.uid).set(
      { tripOrder: ids },
      { merge: true }
    );
    tripOrder = [...ids];
    invalidateOrderedTripsCache(); // tripOrder 保存時にキャッシュ無効化
    // バッチ書き込みで一括更新（N回のAPI呼び出し→1回に削減）
    const batch = window.firebaseDb.batch();
    for (let i = 0; i < ids.length; i++) {
      const docRef = window.firebaseDb.collection('trips').doc(ids[i]);
      batch.set(docRef, { order: i }, { merge: true });
    }
    await batch.commit();
    return { ok: true };
  } catch (err) {
    console.warn('トリップ順序保存エラー:', err);
    return { ok: false, err: err.message || String(err) };
  }
}

function getOrderedTrips() {
  // メモ化: myTrips の長さ・先頭 ID・末尾 ID・tripOrder・フィルタが同じなら再計算不要
  const cacheKey = `${myTrips.length}|${myTrips[0]?.id || ''}|${myTrips[myTrips.length - 1]?.id || ''}|${tripOrder.join(',')}|${tripFilterParentName || ''}`;
  if (_orderedTripsCache && _orderedTripsCacheKey === cacheKey) {
    return _orderedTripsCache;
  }

  let trips = myTrips;
  if (tripFilterParentName) {
    const parent = myTrips.find(t => (t.name || '').trim() === tripFilterParentName && t.isParent);
    if (parent) {
      const childIds = new Set(myTrips.filter(t => t.parentId === parent.id).map(t => t.id));
      trips = myTrips.filter(t => t.id === parent.id || childIds.has(t.id));
    }
  }
  const byId = new Map(trips.map(t => [t.id, t]));
  let result;
  if (tripOrder.length > 0) {
    const ordered = [];
    for (const id of tripOrder) {
      if (byId.has(id)) {
        ordered.push(byId.get(id));
        byId.delete(id);
      }
    }
    const rest = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    result = [...ordered, ...rest];
  } else {
    const list = [...byId.values()];
    result = list.sort((a, b) => {
      const uidA = a.userId || '';
      const uidB = b.userId || '';
      if (uidA !== uidB) return uidA.localeCompare(uidB);
      const oa = a.order ?? Infinity;
      const ob = b.order ?? Infinity;
      if (oa !== ob) return oa - ob;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  _orderedTripsCache = result;
  _orderedTripsCacheKey = cacheKey;
  return result;
}

/** 表示用: 親→子の順、子はインデント対象。regionフィルタ（japan/global）を適用 */
function getTripsForDisplay() {
  const ordered = getOrderedTrips();
  const parentIds = new Set(ordered.map(t => t.id));
  const roots = ordered.filter(t => !t.parentId || !parentIds.has(t.parentId));
  const childrenByParent = new Map();
  const orderIdx = new Map(ordered.map((t, i) => [t.id, i]));
  for (const t of ordered) {
    if (t.parentId && parentIds.has(t.parentId)) {
      const arr = childrenByParent.get(t.parentId) || [];
      arr.push(t);
      childrenByParent.set(t.parentId, arr);
    }
  }

  // regionフィルタ適用
  const matchesRegion = (trip) => {
    if (tripRegionFilter === 'all') return true;
    const region = getTripRegion(trip, ordered);
    if (region === null) return true; // 判定不可は両方に表示
    return region === tripRegionFilter;
  };

  const filteredRoots = roots.filter(r => {
    if (r.isParent) {
      const children = childrenByParent.get(r.id) || [];
      const matchingChildren = children.filter(c => matchesRegion(c));
      if (matchingChildren.length === 0) return matchesRegion(r); // 子がいない親は自身で判定
      return true; // 親は子が1件でもマッチすれば表示（子は個別にフィルタ）
    }
    return matchesRegion(r);
  });

  const result = [];
  filteredRoots.forEach(r => {
    const children = (childrenByParent.get(r.id) || []).filter(c => matchesRegion(c))
      .sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));
    if (r.isParent && children.length === 0 && !matchesRegion(r)) return; // 親のみで子がマッチしない場合は非表示
    result.push({ trip: r, isChild: false });
    // 親トリップの下には常に子トリップをメニューに一覧表示する
    children.forEach(c => result.push({ trip: c, isChild: true }));
  });
  return result;
}

function renderTripList() {
  const list = document.getElementById('tripList');
  if (!list) return;

  // dragイベントをリスト全体で委譲（初回のみ設定、N個→6個に削減）
  if (!list._dragDelegationSetup) {
    list._dragDelegationSetup = true;
    list.addEventListener('dragstart', (e) => {
      if (!isEditor()) return;
      const row = e.target.closest('.trip-item-row');
      if (!row) return;
      draggedTripId = row.dataset.tripId;
      e.dataTransfer.setData('text/plain', draggedTripId);
      e.dataTransfer.setData('application/x-trip-id', draggedTripId);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('trip-item-dragging');
    });
    list.addEventListener('dragend', (e) => {
      const row = e.target.closest('.trip-item-row');
      if (row) row.classList.remove('trip-item-dragging');
      list.querySelectorAll('.trip-item-drag-over').forEach(el => el.classList.remove('trip-item-drag-over'));
      draggedTripId = null;
    });
    list.addEventListener('dragenter', (e) => { e.preventDefault(); });
    list.addEventListener('dragover', (e) => {
      if (!isEditor()) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const row = e.target.closest('.trip-item-row');
      if (row) {
        list.querySelectorAll('.trip-item-drag-over').forEach(el => { if (el !== row) el.classList.remove('trip-item-drag-over'); });
        row.classList.add('trip-item-drag-over');
      }
    });
    list.addEventListener('dragleave', (e) => {
      const row = e.target.closest('.trip-item-row');
      if (row) {
        const rt = e.relatedTarget;
        if (!rt || !row.contains(rt)) row.classList.remove('trip-item-drag-over');
      }
    });
    list.addEventListener('drop', (e) => {
      if (!isEditor()) return;
      e.preventDefault();
      e.stopPropagation();
      const row = e.target.closest('.trip-item-row');
      if (!row) return;
      row.classList.remove('trip-item-drag-over');
      const targetId = row.dataset.tripId;
      const id = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('application/x-trip-id') || draggedTripId;
      if (id && id !== targetId) handleTripDrop(id, targetId);
    });
  }

  list.innerHTML = '';
  const displayItems = getTripsForDisplay();
  if (displayItems.length === 0) {
    list.innerHTML = '<p class="trip-list-empty">' + (window.firebaseAuth?.currentUser ? 'トリップがありません' : '公開トリップがありません') + '</p>';
    return;
  }
  displayItems.forEach(({ trip: t, isChild }) => {
    const isSelected = currentTrip?.id === t.id;
    const row = document.createElement('div');
    row.className = 'trip-item-row' + (t.isParent ? ' trip-item-parent' : '') + (isChild ? ' trip-item-child' : '') + (isSelected ? ' trip-item-selected' : '');
    row.dataset.tripId = t.id;
    if (isSelected && t.color) {
      row.style.setProperty('--trip-selected-color', t.color);
    }
    if (isEditor()) {
      row.draggable = true;
    }
    const label = document.createElement('span');
    label.className = 'trip-item-label';
    label.textContent = (t.isParent ? '📁 ' : '') + (t.name || t.id);
    label.onclick = async (e) => {
      e.stopPropagation();
      try {
        await loadTripById(t.id);
        if (isMobileView()) {
          document.getElementById('tripPanel')?.classList.remove('open');
          document.getElementById('tripSheetOverlay')?.classList.remove('open');
        }
      } catch (err) {
        console.error('トリップ読み込みエラー:', err);
        const status = checkFirebaseStatus();
        let msg = 'トリップの読み込みに失敗しました\n\n';
        msg += '【エラー】\n' + (err.message || err) + '\n\n';
        msg += '【状態】\n';
        msg += `・Firebase: ${status.firebaseDb ? '✓' : '✗'}\n`;
        msg += `・ネットワーク: ${status.online ? '✓' : '✗ オフライン'}\n`;
        msg += `・ログイン: ${status.currentUser || '未ログイン'}\n\n`;
        msg += 'ブラウザのコンソール（F12）で詳細を確認できます';
        alert(msg);
      }
    };
    const actions = document.createElement('div');
    actions.className = 'trip-item-actions';

    // Travelogue button "旅行記" if trip has travelogue
    if (tripHasTravelogue(t)) {
      const travelogueBtn = document.createElement('button');
      travelogueBtn.textContent = '📖';
      travelogueBtn.className = 'trip-item-travelogue-btn';
      travelogueBtn.title = '旅行記';
      travelogueBtn.onclick = (e) => {
        e.stopPropagation();
        showTravelogueModal(t);
      };
      actions.appendChild(travelogueBtn);
    }

    if (isEditor()) {
      const dragHandle = document.createElement('span');
      dragHandle.className = 'trip-item-drag-handle';
      dragHandle.title = 'ドラッグで順番変更・親にドロップで子に';
      dragHandle.textContent = '⋮⋮';
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.className = 'delete-btn';
      delBtn.title = '削除';
      delBtn.onclick = (e) => { e.stopPropagation(); deleteTripFromList(t.id); };
      actions.appendChild(dragHandle);
      actions.appendChild(delBtn);
    }
    row.appendChild(label);
    row.appendChild(actions);
    list.appendChild(row);
    // モバイルでは詳細を展開しない
    if (isSelected && !isMobileView()) {
      const detail = document.createElement('div');
      detail.className = 'trip-detail-inline';
      if (t.color) detail.style.setProperty('--trip-selected-color', t.color);
      const photos = t.isParent ? [] : (t.photos || []);
      const children = t.isParent ? getChildTrips(t.id) : [];
      let html = '';
      if (t.description) {
        html += `<p class="trip-detail-desc">`;
        // ブログURLがある場合は説明にリンクをつける
        if (t.url) {
          html += `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener" class="trip-detail-link">${escapeHtml(t.description)}</a>`;
        } else {
          html += escapeHtml(t.description);
        }
        if (photos.length > 0) html += ` <span class="trip-photo-count-toggle">（${photos.length}枚）</span>`;
        html += `</p>`;
      } else if (photos.length > 0) {
        html += `<p class="trip-detail-desc"><span class="trip-photo-count-toggle">（${photos.length}枚）</span></p>`;
      }
      const hasVideos = getTripVideoUrlsForTrip(t).length > 0;
      const hasTravelogue = tripHasTravelogue(t);
      // スタンプの有無: 親トリップは全子トリップの写真を対象に集約して判定する
      const hasStamps = t.isParent
        ? children.some(c => (c.photos || []).some(p => p.isStamp))
        : (t.photos || []).some(p => p.isStamp);
      // ブログボタンは表示しない（説明にリンクをつけるため）
      if (hasVideos || hasTravelogue || hasStamps) {
        html += '<div class="trip-detail-btns">';
        if (hasTravelogue) html += `<button type="button" class="btn btn-travelogue btn-sm trip-detail-btn trip-detail-travelogue-btn">📖 ${t.isParent ? 'トリップまとめ' : '旅行記'}</button>`;
        if (hasVideos) html += `<button type="button" class="btn btn-primary btn-xs trip-detail-btn trip-detail-video-btn">🎬 動画</button>`;
        if (hasStamps) html += `<button type="button" class="btn btn-stamp btn-xs trip-detail-btn trip-detail-stamp-rally-btn">🎫 スタンプ</button>`;
        html += '</div>';
      }
      detail.innerHTML = html;
      list.appendChild(detail);

      // 子トリップリンクにクリックイベントを追加
      detail.querySelectorAll('.child-trip-link').forEach(link => {
        link.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const childTripId = link.getAttribute('data-trip-id');
          if (childTripId) {
            try {
              await loadTripById(childTripId);
              if (isMobileView()) {
                document.getElementById('tripPanel')?.classList.remove('open');
                document.getElementById('tripSheetOverlay')?.classList.remove('open');
              }
            } catch (err) {
              console.error('子トリップ読み込みエラー:', err);
              alert('子トリップの読み込みに失敗しました: ' + (err.message || err));
            }
          }
        };
      });
      detail.querySelectorAll('.trip-detail-video-btn').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); playVideoSequence(getTripVideoUrlsForTrip(t)); };
      });
      detail.querySelectorAll('.trip-detail-travelogue-btn').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); showTravelogueModal(t); };
      });
      detail.querySelectorAll('.trip-detail-stamp-rally-btn').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); showStampRallyModal(t); };
      });
      detail.querySelectorAll('.trip-photo-count-toggle').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); toggleThumbnails(); };
      });
      // アニメ一覧: 親トリップは自身に生成したアニメ画像＋各子トリップの表紙画像を1枚ずつ表示する
      const animes = t.isParent
        ? [
            ...(t.generatedAnimes || t.animes || []).map(a => ({ ...a, _tripName: t.name })),
            ...children
              .map(c => {
                const cover = getAnimeCoverForTrip(c);
                return cover ? { ...cover, _tripName: c.name } : null;
              })
              .filter(Boolean)
          ]
        : (t.generatedAnimes || t.animes || []);
      if (animes.length > 0) {
        const thumbsWrap = document.createElement('div');
        thumbsWrap.className = 'trip-detail-anime-thumbs';
        animes.forEach((anime, idx) => {
          const img = document.createElement('img');
          img.src = anime.url;
          img.loading = 'lazy';
          img.alt = anime.style || '';
          img.title = anime._tripName ? `${anime._tripName} - ${anime.style || 'アニメ'}` : (anime.style || '');
          img.className = 'trip-detail-thumb';
          img.onclick = (e) => {
            e.stopPropagation();
            showAnimeImageViewer(animes.map(a => ({ url: a.url, style: a.style })), t.name);
          };
          thumbsWrap.appendChild(img);
        });
        detail.appendChild(thumbsWrap);
      }
    } else if (isSelected && t.isParent && !isMobileView()) {
      try {
      // 親トリップ選択時: アニメサムネイル表示、トリップ名の横に旅行記・動画ボタン
      const children = getChildTrips(t.id);
      const animeChildren = children.filter(c => ((c.generatedAnimes || c.animes || []).length > 0));
      const hasStamps = children.some(c => (c.photos || []).some(p => p.isStamp));

      if (animeChildren.length > 0 || hasStamps) {
        const detail = document.createElement('div');
        detail.className = 'trip-detail-inline trip-detail-parent';
        if (t.color) detail.style.setProperty('--trip-selected-color', t.color);

        // ボタン行（スタンプ・アニメ）
        const buttonRow = document.createElement('div');
        buttonRow.style.marginBottom = '0.75rem';
        buttonRow.style.display = 'flex';
        buttonRow.style.gap = '0.5rem';

        // スタンプボタン
        if (hasStamps) {
          const stampBtn = document.createElement('button');
          stampBtn.type = 'button';
          stampBtn.className = 'btn btn-stamp btn-sm trip-detail-btn';
          stampBtn.textContent = '🎫 スタンプ一覧';
          stampBtn.title = 'スタンプラリー';
          stampBtn.onclick = (e) => { e.stopPropagation(); showStampRallyModal(t); };
          buttonRow.appendChild(stampBtn);
        }

        // アニメ一覧ボタン
        if (animeChildren.length > 0) {
          const animeBtn = document.createElement('button');
          animeBtn.type = 'button';
          animeBtn.className = 'btn btn-secondary btn-sm trip-detail-btn';
          animeBtn.textContent = '🖼️ アニメ一覧';
          animeBtn.title = 'アニメ画像を表示';
          const allAnimes = animeChildren.flatMap(c =>
            (c.generatedAnimes || c.animes || []).map(a => ({ ...a, _tripName: c.name, _tripId: c.id }))
          );
          animeBtn.onclick = (e) => {
            e.stopPropagation();
            showAnimeImageViewer(allAnimes.map(a => ({ url: a.url, style: a.style })), t.name || '');
          };
          buttonRow.appendChild(animeBtn);
        }

        if (hasStamps || animeChildren.length > 0) {
          detail.appendChild(buttonRow);
        }

        if (animeChildren.length > 0) {
          const allAnimes = animeChildren
            .map(c => {
              const first = (c.generatedAnimes || c.animes || [])[0];
              return first ? { ...first, _tripName: c.name, _tripId: c.id } : null;
            })
            .filter(Boolean);
          const thumbsWrap = document.createElement('div');
          thumbsWrap.className = 'trip-detail-parent-anime-thumbs';
          allAnimes.forEach((anime) => {
            const img = document.createElement('img');
            img.src = anime.url;
            img.loading = 'lazy';
            img.alt = anime.style || '';
            img.title = anime._tripName ? `${anime._tripName} - ${anime.style || 'アニメ'}` : (anime.style || 'アニメ');
            img.onclick = (e) => {
              e.stopPropagation();
              showAnimeImageViewer(allAnimes.map(a => ({ url: a.url, style: a.style })), t.name || '');
            };
            thumbsWrap.appendChild(img);
          });
          detail.appendChild(thumbsWrap);
        }
        list.appendChild(detail);
      }
      } catch (err) {
        console.error('親トリップインライン詳細エラー:', err);
      }
    }
  });

  // モバイル用トリップシートトリガーのラベルを更新
  updateTripSheetTriggerLabel();
}

async function handleTripDrop(draggedId, targetId) {
  if (!isEditor()) return;
  const dragged = myTripsMap.get(draggedId);
  const target = myTripsMap.get(targetId);
  if (!dragged || !target) return;
  if (target.isParent) {
    await setTripParent(draggedId, targetId);
  } else {
    await reorderTripByDrop(draggedId, targetId);
  }
}

async function setTripParent(childId, parentId) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return;
  const child = myTripsMap.get(childId);
  if (!child || child.userId !== window.firebaseAuth.currentUser.uid) return;
  const parent = myTripsMap.get(parentId);
  if (!parent || !parent.isParent) return;
  try {
    const updated = { ...child, parentId, isParent: false, updatedAt: Date.now() };
    if (updated.gpxData && !updated.gpxDataUrl) {
      try {
        updated.gpxDataUrl = await uploadGpxToStorage(childId, updated.gpxData);
      } catch (err) {
        console.error('GPXアップロードエラー:', err);
      }
    }
    delete updated.gpxData;
    if (updated.photos?.length) {
      updated.photos = updated.photos.map(p => {
        const { data, blob, gpxData, ...rest } = p;
        return rest;
      });
    }
    await window.firebaseDb.collection('trips').doc(childId).set(sanitizeForFirestore(updated), { merge: true });
    await loadMyTrips();
    const displayItems = getTripsForDisplay();
    const displayIds = displayItems.map(x => x.trip.id);
    const targetIdx = displayIds.indexOf(parentId);
    const newOrder = displayIds.filter(id => id !== childId);
    const insertIdx = targetIdx + 1;
    newOrder.splice(Math.min(insertIdx, newOrder.length), 0, childId);
    const res = await saveTripOrder(newOrder);
    if (!res.ok) throw new Error(res.err || '順序の保存に失敗しました');
    renderTripList();
    refreshTripSelect();
    refreshTripParentSelectOptions();
    if (currentTrip?.isParent) renderParentTripChildren(currentTrip.id);
    setStatus('親トリップの子にしました');
  } catch (err) {
    console.error(err);
    alert('更新に失敗しました: ' + (err.message || err));
  }
}

async function reorderTripByDrop(draggedId, targetId) {
  if (!isEditor()) return;
  const displayIds = getTripsForDisplay().map(x => x.trip.id);
  const fromIdx = displayIds.indexOf(draggedId);
  const toIdx = displayIds.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
  const newOrder = [...displayIds];
  newOrder.splice(fromIdx, 1);
  const newToIdx = newOrder.indexOf(targetId);
  newOrder.splice(newToIdx, 0, draggedId);
  const res = await saveTripOrder(newOrder);
  if (res.ok) {
    renderTripList();
    refreshTripSelect();
    refreshTripParentSelectOptions();
    if (currentTrip?.isParent) renderParentTripChildren(currentTrip.id);
    setStatus('順番を変更しました');
  } else {
    const msg = res.err || '';
    const hint = /permission|Permission/i.test(msg)
      ? '\n\nFirestoreルールをデプロイしてください: firebase deploy --only firestore:rules'
      : '';
    alert('順番の保存に失敗しました: ' + msg + hint);
  }
}

async function deleteTripFromList(id) {
  if (!isEditor()) return;
  const t = myTripsMap.get(id);
  if (!t || !window.firebaseDb || !window.firebaseAuth?.currentUser || t.userId !== window.firebaseAuth.currentUser.uid) return;
  if (!confirm(`本当に「${t.name || id}」を削除しますか？\nこの操作は取り消せません。`)) return;
  try {
    // Storageから全ての関連ファイルを削除
    await deleteAllTripFiles(t);

    await window.firebaseDb.collection('trips').doc(id).delete();
    const newOrder = tripOrder.filter(x => x !== id);
    await saveTripOrder(newOrder);
    if (currentTrip?.id === id) {
      currentTrip = null;
      currentPhotoIndex = 0;
      thumbnailsVisible = false;

      // URLパラメータを削除
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('trip');
      window.history.replaceState({}, '', newUrl.toString());

      renderThumbnails();
      scheduleMapMarkersUpdate();
      updateTripInputs();
      renderTripDetailPane();
    }
    await loadMyTrips();
    renderTripList();
    refreshTripSelect();
    setStatus('削除しました');
  } catch (err) {
    alert('削除に失敗しました: ' + (err.message || err));
  }
}

function refreshTripSelect() {
  const sel = document.getElementById('tripSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">— 読み込む —</option>';
  const ordered = getOrderedTrips();
  const parentIds = new Set(ordered.map(t => t.id));
  const roots = ordered.filter(t => !t.parentId || !parentIds.has(t.parentId));
  const childrenByParent = new Map();
  const orderIdx = new Map(ordered.map((t, i) => [t.id, i]));
  for (const t of ordered) {
    if (t.parentId && parentIds.has(t.parentId)) {
      const arr = childrenByParent.get(t.parentId) || [];
      arr.push(t);
      childrenByParent.set(t.parentId, arr);
    }
  }
  roots.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = (t.isParent ? '📁 ' : '') + (t.name || t.id);
    sel.appendChild(opt);
    (childrenByParent.get(t.id) || []).sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0)).forEach(c => {
      const copt = document.createElement('option');
      copt.value = c.id;
      copt.textContent = '　└ ' + (c.name || c.id);
      sel.appendChild(copt);
    });
  });
  if (currentTrip?.id) sel.value = currentTrip.id;
}

function refreshTripParentSelectOptions() {
  const sel = document.getElementById('tripParentSelect');
  if (!sel) return;
  // 現在のトリップのparentIdを保持（select.valueより優先）
  const prevVal = currentTrip?.parentId || sel.value;
  const ordered = getOrderedTrips();
  const parentIds = new Set(ordered.map(t => t.id));
  const parents = ordered.filter(t => t.isParent);
  sel.innerHTML = '<option value="">— なし —</option>';
  parents.forEach(t => {
    if (t.id === currentTrip?.id) return;
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name || t.id;
    sel.appendChild(opt);
  });
  if (prevVal && parentIds.has(prevVal)) sel.value = prevVal;
}

function renderParentTripChildren(parentId) {
  const listEl = document.getElementById('tripParentChildrenList');
  const addBtn = document.getElementById('addChildTripBtn');
  if (!listEl || !addBtn) return;
  const orderIdx = new Map(getOrderedTrips().map((t, i) => [t.id, i]));
  const children = getChildTrips(parentId).sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));
  listEl.innerHTML = '';
  children.forEach(c => {
    const div = document.createElement('div');
    div.className = 'trip-child-item';
    div.textContent = c.name || c.id;
    div.onclick = async () => {
      try {
        await loadTripById(c.id);
      } catch (err) {
        console.error('子トリップ読み込みエラー:', err);
      }
    };
    listEl.appendChild(div);
  });
  addBtn.onclick = () => addChildTripUnder(parentId);

  // 子トリップの旅行記・動画・アニメ一覧を表示
  try {
  const traveloguesWrap = document.getElementById('tripParentTraveloguesWrap');
  const traveloguesEl = document.getElementById('tripParentTravelogues');
  const videosWrap = document.getElementById('tripParentVideosWrap');
  const videosEl = document.getElementById('tripParentVideos');
  const animesWrap = document.getElementById('tripParentAnimesWrap');
  const animesEl = document.getElementById('tripParentAnimes');

  const travelogueChildren = children.filter(c =>
    tripHasTravelogue(c)
  );
  if (traveloguesWrap && traveloguesEl) {
    if (travelogueChildren.length > 0) {
      traveloguesEl.innerHTML = '';
      travelogueChildren.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-travelogue btn-sm trip-parent-detail-travelogue-btn';
        const tName = (c.name || '（無題）').replace(/\s/g, '').slice(0, 9);
        btn.textContent = '📖 ' + tName;
        btn.title = c.name || '（無題）';
        btn.onclick = () => showTravelogueModal(c);
        traveloguesEl.appendChild(btn);
      });
      traveloguesWrap.style.display = '';
    } else {
      traveloguesWrap.style.display = 'none';
    }
  }

  const videoChildren = children.filter(c => getTripVideoUrlsForTrip(c).length > 0);
  if (videosWrap && videosEl) {
    if (videoChildren.length > 0) {
      videosEl.innerHTML = '';
      videoChildren.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary btn-sm trip-parent-detail-video-btn';
        const vName = c.name || '（無題）';
        btn.textContent = '🎬 ' + vName.slice(0, 5);
        btn.title = vName;
        btn.onclick = () => playVideoSequence(getTripVideoUrlsForTrip(c));
        videosEl.appendChild(btn);
      });
      videosWrap.style.display = '';
    } else {
      videosWrap.style.display = 'none';
    }
  }

  const animeChildren = children.filter(c => {
    const animes = c.generatedAnimes || c.animes || [];
    return animes.length > 0;
  });
  if (animesWrap && animesEl) {
    if (animeChildren.length > 0) {
      animesEl.innerHTML = '';
      const allAnimes = animeChildren
        .map(c => {
          const first = (c.generatedAnimes || c.animes || [])[0];
          return first ? { ...first, _tripName: c.name } : null;
        })
        .filter(Boolean);
      const thumbs = document.createElement('div');
      thumbs.className = 'trip-parent-detail-anime-thumbs';
      allAnimes.forEach((anime) => {
        const img = document.createElement('img');
        img.src = anime.url;
        img.loading = 'lazy';
        img.alt = anime.style || '';
        img.title = anime._tripName ? `${anime._tripName} - ${anime.style || 'アニメ'}` : (anime.style || 'アニメ');
        img.onclick = (e) => {
          e.stopPropagation();
          showAnimeImageViewer(allAnimes.map(a => ({ url: a.url, style: a.style })), currentTrip?.name || '');
        };
        thumbs.appendChild(img);
      });
      animesEl.appendChild(thumbs);
      animesWrap.style.display = '';
    } else {
      animesWrap.style.display = 'none';
    }
  }
  } catch (err) {
    console.error('親トリップ子一覧表示エラー:', err);
  }
}

async function addChildTripUnder(parentId) {
  if (!isEditor()) return;
  const parent = myTripsMap.get(parentId);
  currentTrip = createNewTrip(parentId);
  currentTrip.color = parent?.color || TRIP_COLORS[0];
  currentTrip.public = !!parent?.public;
  await updateTripInputs();
  document.getElementById('tripParentInput').checked = false;
  document.getElementById('tripParentSelectWrap').style.display = '';
  document.getElementById('tripParentSelect').value = parentId;
  document.getElementById('tripParentChildrenWrap').style.display = 'none';
  renderThumbnails();
  await updateMapMarkers();
  await renderTripDetailPane();
}

function renderColorSwatches() {
  const wrap = document.getElementById('tripColorSwatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  const current = document.getElementById('tripColorInput')?.value || TRIP_COLORS[0];
  TRIP_COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'trip-color-swatch' + (c.toLowerCase() === current.toLowerCase() ? ' active' : '');
    sw.style.background = c;
    sw.title = c;
    sw.onclick = () => {
      document.getElementById('tripColorInput').value = c;
      wrap.querySelectorAll('.trip-color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
    };
    wrap.appendChild(sw);
  });
}

/**
 * 地図コンテナの幅が確定してから fitBounds を実行する。
 * ページ初回ロード直後は #map のレイアウト幅が一瞬 0 のままになる区間があり、
 * その状態で fitBounds を呼ぶと（bounds が正しくても）異常なズームで確定してしまい、
 * 以降なにをしても自然には直らない。コンテナ幅が実際に付くまで待ってから調整する。
 * requestAnimationFrame はタブが非アクティブだと止まるため setTimeout でポーリングする。
 */
function fitMapBoundsWhenReady(bounds, options, attemptsLeft = 50) {
  if (!map) return;
  map.invalidateSize();
  const size = map.getSize();
  if ((size.x > 0 && size.y > 0) || attemptsLeft <= 0) {
    map.fitBounds(bounds, options);
    return;
  }
  setTimeout(() => fitMapBoundsWhenReady(bounds, options, attemptsLeft - 1), 100);
}

async function loadTripById(id) {
  if (!window.firebaseDb) {
    throw new Error('Firebase が初期化されていません。ページを再読み込みしてください。');
  }

  // トリップ読み込み時はサムネイルを非表示にしてパフォーマンス向上
  thumbnailsVisible = false;

  // 前のトリップの写真ポップアップをクリア
  closePhotoPopup();

  // キャッシュから即座に表示
  const cached = myTripsMap.get(id);
  if (cached) {
    try {
      currentTrip = { ...cached, id: cached.id };
      currentPhotoIndex = 0;

      // URLにトリップ名パラメータを追加（IDもコンソールに表示）
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('trip', encodeURIComponent(currentTrip.name));
      window.history.replaceState({}, '', newUrl.toString());

      // トリップID確認用のログ（URLで使用可能）
      console.log(`✓ トリップID: ${id}`);
      console.log(`  → IDで開くURL: ${window.location.origin}${window.location.pathname}?tripId=${id}`);

      // 同期処理を先に実行
      refreshTripSelect();
      renderThumbnails();

      // UIとマップの更新を並列実行（両者は独立）
      await Promise.all([
        updateTripInputs(),
        updateMapMarkers()
      ]);

      await renderTripDetailPane(); // → updateHeaderInfo() + renderTripList() を内包

      // トリップの全ポイントが収まるように地図を調整（マーカー更新後に実行）
      setTimeout(() => {
        const photos = getDisplayPhotos();
        console.log(`🗺️ 地図表示範囲を調整: 写真数=${photos.length}`);
        if (photos.length > 0 && map) {
          const bounds = [];
          photos.forEach(p => {
            if (p.lat != null && p.lng != null) {
              bounds.push([p.lat, p.lng]);
            }
          });
          console.log(`🗺️ 地図に表示する座標数: ${bounds.length}`);
          if (bounds.length > 0) {
            try {
              fitMapBoundsWhenReady(bounds, { padding: [50, 50], maxZoom: 17 });
              console.log(`✅ 地図の表示範囲を調整しました`);
            } catch (err) {
              console.error('❌ fitBoundsエラー:', err);
            }
          } else {
            console.warn('⚠️ GPS座標を持つ写真がありません');
          }
        } else if (photos.length === 0) {
          console.warn('⚠️ 表示する写真がありません');
        } else if (!map) {
          console.error('❌ 地図が初期化されていません');
        }
      }, 300); // マーカーのレンダリングを待つ

      // アニメ画像一覧を表示
      console.log('トリップロード（キャッシュ）:', {
        tripId: id,
        generatedAnimesCount: currentTrip.generatedAnimes?.length || 0,
        travelogueUrl: currentTrip.travelogueUrl || 'なし'
      });
      renderGeneratedAnimesList();
      // updateHeaderInfo は renderTripDetailPane() 内で呼ばれるため除去

      // モバイルタブを地図に戻す
      if (isMobileView()) {
        switchMobileTab('map');
      }

      try { localStorage.setItem(LAST_TRIP_ID_KEY, id); } catch (_) {}
      return; // キャッシュで完了
    } catch (err) {
      console.error('キャッシュからの読み込みエラー:', err);
      throw err;
    }
  }

  // キャッシュになければFirestoreから取得（リトライ付き）
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`トリップ読み込みリトライ中... (${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // 待機時間を増やす
      }

      console.log(`トリップ ${id} を Firestore から取得中...`);
      const doc = await window.firebaseDb.collection('trips').doc(id).get();

      if (!doc.exists) {
        throw new Error('トリップが見つかりません（削除された可能性があります）');
      }

      const data = doc.data();
      console.log('トリップデータ取得成功:', {
        id,
        name: data.name,
        photoCount: data.photos?.length || 0,
        generatedAnimesCount: data.generatedAnimes?.length || 0,
        hasTravelogueUrl: !!data.travelogueUrl,
        hasTravelogueHtml: !!data.travelogueHtml
      });

      const isOwner = window.firebaseAuth?.currentUser && data.userId === window.firebaseAuth.currentUser.uid;
      const isPublic = data.public === true;
      if (!isOwner && !isPublic) {
        throw new Error('このトリップは非公開です');
      }

      const tripData = { ...data, id: doc.id };
      if (tripData.photos?.length) {
        tripData.photos = tripData.photos.map(p => {
          const c = ensureLatLng(p.lat, p.lng);
          if (c) return { ...p, lat: c.lat, lng: c.lng };
          return p;
        });
      }

      currentTrip = tripData;
      currentPhotoIndex = 0;
      await updateTripInputs();
      // renderTripList は renderTripDetailPane() 内で呼ばれるため除去
      refreshTripSelect();
      renderThumbnails();
      await updateMapMarkers();

      if (map) map.invalidateSize();
      await renderTripDetailPane(); // → updateHeaderInfo() + renderTripList() を内包

      // トリップの全ポイントが収まるように地図を調整（マーカー更新後に実行）
      setTimeout(() => {
        const photos = getDisplayPhotos();
        console.log(`🗺️ 地図表示範囲を調整: 写真数=${photos.length}`);
        if (photos.length > 0 && map) {
          const bounds = [];
          photos.forEach(p => {
            if (p.lat != null && p.lng != null) {
              bounds.push([p.lat, p.lng]);
            }
          });
          console.log(`🗺️ 地図に表示する座標数: ${bounds.length}`);
          if (bounds.length > 0) {
            try {
              fitMapBoundsWhenReady(bounds, { padding: [50, 50], maxZoom: 17 });
              console.log(`✅ 地図の表示範囲を調整しました`);
            } catch (err) {
              console.error('❌ fitBoundsエラー:', err);
            }
          } else {
            console.warn('⚠️ GPS座標を持つ写真がありません');
          }
        } else if (photos.length === 0) {
          console.warn('⚠️ 表示する写真がありません');
        } else if (!map) {
          console.error('❌ 地図が初期化されていません');
        }
      }, 300); // マーカーのレンダリングを待つ

      // アニメ画像一覧を表示
      console.log('トリップロード（Firestore）:', {
        tripId: id,
        generatedAnimesCount: currentTrip.generatedAnimes?.length || 0,
        travelogueUrl: currentTrip.travelogueUrl || 'なし'
      });
      renderGeneratedAnimesList();
      // updateHeaderInfo は renderTripDetailPane() 内で呼ばれるため除去

      // モバイルタブを地図に戻す
      if (isMobileView()) {
        switchMobileTab('map');
      }

      setStatus(`${currentTrip.name} を読み込みました`);
      try { localStorage.setItem(LAST_TRIP_ID_KEY, id); } catch (_) {}

      return; // 成功したら終了

    } catch (err) {
      lastError = err;
      console.error(`Firestore読み込みエラー (試行 ${attempt + 1}/${maxRetries + 1}):`, err);

      const isNetworkError = err.message?.includes('Failed to fetch') ||
                            err.message?.includes('NetworkError') ||
                            err.message?.includes('network') ||
                            err.code === 'unavailable';

      // ネットワークエラーでない、または最後の試行の場合はリトライしない
      if (!isNetworkError || attempt === maxRetries) {
        break;
      }
    }
  }

  // すべてのリトライが失敗した場合
  console.error('トリップ読み込み最終エラー:', lastError);
  checkFirebaseStatus(); // 状態をログに出力

  if (lastError.message?.includes('Failed to fetch') || lastError.message?.includes('NetworkError') || lastError.code === 'unavailable') {
    throw new Error('ネットワークエラー: インターネット接続を確認してください\n\nブラウザのコンソール（F12）で詳細を確認できます');
  } else if (lastError.code === 'permission-denied') {
    throw new Error('アクセス権限がありません\n\nログインしているか、またはトリップが公開設定になっているか確認してください');
  } else {
    throw lastError;
  }
}

async function deleteTrip() {
  if (!isEditor() || !window.firebaseDb || !window.firebaseAuth?.currentUser) return;
  if (!currentTrip) { setStatus('削除するトリップが選択されていません'); return; }
  if (currentTrip.userId !== window.firebaseAuth.currentUser.uid) { setStatus('このトリップを削除する権限がありません'); return; }
  if (!confirm(`本当に「${currentTrip.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
  const idToDelete = currentTrip.id;
  const tripToDelete = { ...currentTrip };
  try {
    await deleteAllTripFiles(tripToDelete);
    await window.firebaseDb.collection('trips').doc(idToDelete).delete();
    currentTrip = null;
    currentPhotoIndex = 0;
    thumbnailsVisible = false;
    const newOrder = tripOrder.filter(x => x !== idToDelete);
    await saveTripOrder(newOrder);
    renderThumbnails();
    await updateMapMarkers();
    await updateTripInputs();
    await renderTripDetailPane();
    try {
      await loadMyTrips();
    } catch (err) {
      console.warn('削除後のトリップ一覧再読み込みに失敗（削除自体は成功）:', err);
    }
    renderTripList();
    refreshTripSelect();
    setStatus('削除しました');
  } catch (err) {
    alert('削除に失敗しました: ' + (err.message || err));
  }
}

async function renderTripDetailPane() {
  await updateHeaderInfo();
  renderTripList();
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 指定トリップの動画URLを表示順で取得（トリップ動画→ポイント動画の順） */
/**
 * トリップの代表アニメ画像（表紙）を1枚選ぶ。
 * 詳細4ページ・浮世絵風は表紙として不適切なため除外し、通常の表紙系
 * スタイル（地球の歩き方風・少年ジャンプ風・旅行雑誌風・出来事生成）を優先する。
 * 旅行記ページの表紙選定ロジックと同じ基準。
 */
// マップInk/スタンプInk/御朱印風QRは表紙として使う絵ではなく参照・記念用の図なので、トリップの代表画像には選ばない
const NON_COVER_ANIME_STYLES = new Set(['meisho-ukiyoe', 'map-ink', 'map-bw', 'stamp-ink', 'stamp-goshuin']);

function getAnimeCoverForTrip(trip) {
  const animes = trip?.generatedAnimes || trip?.animes || [];
  if (animes.length === 0) return null;
  const isNotCoverStyle = (style) => {
    const s = String(style || '');
    return s.startsWith('detail') || s.startsWith('infographic') || NON_COVER_ANIME_STYLES.has(s);
  };
  const coverAnimes = animes.filter(a => a.style && !isNotCoverStyle(a.style));
  if (coverAnimes.length > 0) return coverAnimes[0];
  if (!isNotCoverStyle(animes[0].style)) return animes[0];
  return null;
}

function getTripVideoUrlsForTrip(trip) {
  if (!trip) return [];
  const urls = [];
  if (trip.isParent) {
    // 親トリップ: 親のvideoUrl → 子トリップのvideoUrl → 子トリップのポイントvideoUrl の順で連続収集
    if (trip.videoUrl && trip.videoUrl.trim()) urls.push(trip.videoUrl.trim());
    const children = getChildTrips(trip.id);
    for (const c of children) {
      if (c.videoUrl && c.videoUrl.trim()) urls.push(c.videoUrl.trim());
      for (const p of (c.photos || [])) {
        if (p.videoUrl && p.videoUrl.trim()) urls.push(p.videoUrl.trim());
      }
    }
  } else {
    if (trip.videoUrl && trip.videoUrl.trim()) urls.push(trip.videoUrl.trim());
    for (const p of (trip.photos || [])) {
      if (p.videoUrl && p.videoUrl.trim()) urls.push(p.videoUrl.trim());
    }
  }
  return urls;
}

/** 現在のトリップ＋ポイントの動画URLを表示順で取得 */
function getTripVideoUrls() {
  return getTripVideoUrlsForTrip(currentTrip);
}

function getVideoEmbedUrl(url) {
  if (!url) return null;
  const u = url.trim();
  const ytMatch = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;
  const vimeoMatch = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  return null;
}

function getYouTubeVideoId(url) {
  if (!url) return null;
  const u = url.trim();
  const ytMatch = u.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  return ytMatch ? ytMatch[1] : null;
}

function getVimeoVideoId(url) {
  if (!url) return null;
  const u = url.trim();
  const vimeoMatch = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return vimeoMatch ? vimeoMatch[1] : null;
}

// YouTubeサムネイルのアスペクト比から縦横を判定（portrait / landscape）
async function detectVideoOrientation(videoUrl) {
  const youtubeId = getYouTubeVideoId(videoUrl);
  if (youtubeId) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve(img.naturalHeight > img.naturalWidth ? 'portrait' : 'landscape');
      };
      img.onerror = () => resolve('landscape');
      img.src = `https://i.ytimg.com/vi/${youtubeId}/0.jpg`;
    });
  }

  // Vimeoの場合、oEmbed APIでアスペクト比を取得
  const vimeoId = getVimeoVideoId(videoUrl);
  if (vimeoId) {
    try {
      const response = await fetch(`https://vimeo.com/api/oembed.json?url=https://vimeo.com/${vimeoId}`);
      const data = await response.json();
      if (data.width && data.height) {
        return data.height > data.width ? 'portrait' : 'landscape';
      }
    } catch (e) {
      console.warn('Vimeo動画情報の取得に失敗:', e);
    }
  }

  return 'landscape';
}

function getVideoThumbnailUrl(videoUrl) {
  if (!videoUrl) return null;

  // YouTube
  const youtubeId = getYouTubeVideoId(videoUrl);
  if (youtubeId) {
    return `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`;
  }

  // Vimeo
  const vimeoId = getVimeoVideoId(videoUrl);
  if (vimeoId) {
    return `https://vumbnail.com/${vimeoId}.jpg`;
  }

  return null;
}

/** 動画コントロールバーを生成（前の動画、再生/停止、次の動画、終了） */
function createVideoControlsBar(overlay, wrap, { currentUrl, onPrev, onNext, onClose }) {
  let existing = overlay.querySelector('.video-controls-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.className = 'video-controls-bar';

  if (onPrev) {
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'video-ctrl-btn';
    prevBtn.dataset.action = 'prev';
    prevBtn.title = '前の動画';
    prevBtn.textContent = '⏮';
    prevBtn.onclick = onPrev;
    bar.appendChild(prevBtn);
  }

  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.className = 'video-ctrl-btn';
  pauseBtn.dataset.action = 'pause';
  pauseBtn.title = '再生 / 停止';
  pauseBtn.textContent = '⏸';
  bar.appendChild(pauseBtn);

  if (onNext) {
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'video-ctrl-btn';
    nextBtn.dataset.action = 'next';
    nextBtn.title = '次の動画';
    nextBtn.textContent = '⏭';
    nextBtn.onclick = onNext;
    bar.appendChild(nextBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'video-ctrl-btn';
  closeBtn.dataset.action = 'close';
  closeBtn.title = '動画を終了';
  closeBtn.textContent = '✕';
  closeBtn.onclick = onClose;
  bar.appendChild(closeBtn);

  let videoPaused = false;
  pauseBtn.onclick = () => {
    const iframe = wrap.querySelector('iframe');
    const videoEl = wrap.querySelector('video');
    videoPaused = !videoPaused;
    pauseBtn.textContent = videoPaused ? '▶' : '⏸';
    if (iframe && currentUrl) {
      const ytId = getYouTubeVideoId(currentUrl);
      if (ytId) {
        try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: videoPaused ? 'pauseVideo' : 'playVideo' }), '*'); } catch (_) {}
      } else if (currentUrl.includes('vimeo')) {
        try { iframe.contentWindow.postMessage(JSON.stringify({ method: videoPaused ? 'pause' : 'play' }), '*'); } catch (_) {}
      }
    } else if (videoEl) {
      videoPaused ? videoEl.pause() : videoEl.play();
    }
  };

  overlay.appendChild(bar);
  return bar;
}

function collectVideoUrlsFromCurrentPoint() {
  const photos = getDisplayPhotos();
  if (!photos.length) return [];

  const videoUrls = [];
  const pointNames = [];

  // 現在のポイントから順に動画URLを収集
  for (let i = currentPhotoIndex; i < photos.length; i++) {
    const p = photos[i];
    if (p.videoUrl && p.videoUrl.trim()) {
      videoUrls.push(p.videoUrl.trim());
      pointNames.push(p.name || `ポイント ${i + 1}`);
    }
  }

  return { urls: videoUrls, names: pointNames };
}

function showVideoOverlay(url) {
  const overlay = document.getElementById('videoOverlay');
  const wrap = document.getElementById('videoPlayerWrap');
  if (!overlay || !wrap) return;
  const embedUrl = getVideoEmbedUrl(url);
  wrap.innerHTML = '';
  if (embedUrl) {
    const ytId = getYouTubeVideoId(url);
    const src = ytId
      ? `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=0&controls=1&modestbranding=1&rel=0&playsinline=1&enablejsapi=1`
      : embedUrl + '?autoplay=1';
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = '動画';
    iframe.allow = 'autoplay; encrypted-media; accelerometer; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    wrap.appendChild(iframe);
  } else {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.muted = false;
    wrap.appendChild(video);
  }
  overlay.classList.remove('hidden');
  document.querySelector('.map-container')?.classList.add('map-showing-video');
  createVideoControlsBar(overlay, wrap, {
    currentUrl: url,
    onPrev: null,
    onNext: null,
    onClose: () => closeVideoOverlay()
  });
}

/** 動画URLとポイント名の配列を連続再生 */
function playVideoSequenceWithNames(urls, names = []) {
  if (!urls || urls.length === 0) return;
  console.log(`動画連続再生を開始: ${urls.length}本の動画`);
  const overlay = document.getElementById('videoOverlay');
  const wrap = document.getElementById('videoPlayerWrap');
  if (!overlay || !wrap) return;

  let index = 0;

  const playAt = (idx) => {
    if (videoSequenceTimer) {
      clearTimeout(videoSequenceTimer);
      videoSequenceTimer = null;
    }
    if (idx < 0 || idx >= urls.length) return;
    index = idx;
    const url = urls[index];
    const pointName = names[index] || '';
    console.log(`動画再生開始 (${index + 1}/${urls.length}): ${pointName || 'ポイント名なし'}`);
    wrap.innerHTML = '';

    // ポイント名を表示するオーバーレイを追加
    if (pointName) {
      let nameOverlay = overlay.querySelector('.video-overlay-point-name');
      if (!nameOverlay) {
        nameOverlay = document.createElement('div');
        nameOverlay.className = 'video-overlay-point-name';
        overlay.appendChild(nameOverlay);
      }
      nameOverlay.textContent = pointName;
      nameOverlay.style.display = '';
    }

    const embedUrl = getVideoEmbedUrl(url);
    if (embedUrl) {
      const ytId = getYouTubeVideoId(url);
      const isVimeo = embedUrl.includes('vimeo.com');
      const src = ytId
        ? `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=0&controls=1&modestbranding=1&rel=0&playsinline=1&enablejsapi=1`
        : embedUrl + '?autoplay=1' + (isVimeo ? '&api=1' : '');
      const iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.title = '動画';
      iframe.allow = 'autoplay; encrypted-media; accelerometer; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      wrap.appendChild(iframe);

      const advanceToNext = () => {
        console.log(`動画終了: 次の動画に進みます (${index + 1}/${urls.length} → ${index + 2}/${urls.length})`);
        if (videoSequenceTimer) { clearTimeout(videoSequenceTimer); videoSequenceTimer = null; }
        if (index + 1 < urls.length) playAt(index + 1);
      };

      // YouTube: postMessage で動画終了を検知
      if (ytId) {
        const ytHandler = (e) => {
          if (!e.origin.includes('youtube.com')) return;
          try {
            const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (data?.event === 'onStateChange' && data?.info === 0) {
              console.log(`YouTube動画終了イベント受信`);
              window.removeEventListener('message', ytHandler);
              advanceToNext();
            }
          } catch (_) {}
        };
        window.addEventListener('message', ytHandler);
        iframe.onload = () => {
          try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*'); } catch (_) {}
        };
      }

      // Vimeo: postMessage で終了検知
      if (isVimeo) {
        const vimeoHandler = (e) => {
          try {
            const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (data && data.event === 'finish') {
              console.log(`Vimeo動画終了イベント受信`);
              window.removeEventListener('message', vimeoHandler);
              advanceToNext();
            }
          } catch (_) {}
        };
        window.addEventListener('message', vimeoHandler);
        iframe.onload = () => {
          try { iframe.contentWindow.postMessage(JSON.stringify({ method: 'addEventListener', value: 'finish' }), '*'); } catch (_) {}
        };
      }

      // フォールバック: 終了イベントが発火しない場合に備えて60秒後に次へ
      if (index + 1 < urls.length) {
        videoSequenceTimer = setTimeout(() => {
          console.log('動画シーケンスフォールバックタイマー: 次へ進みます');
          advanceToNext();
        }, 60000);
      }
    } else {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      video.muted = false;
      video.addEventListener('ended', () => {
        if (index + 1 < urls.length) playAt(index + 1);
      });
      wrap.appendChild(video);
    }
    overlay.classList.remove('hidden');
    document.querySelector('.map-container')?.classList.add('map-showing-video');

    createVideoControlsBar(overlay, wrap, {
      currentUrl: url,
      onPrev: index > 0 ? () => playAt(index - 1) : null,
      onNext: index + 1 < urls.length ? () => playAt(index + 1) : null,
      onClose: () => closeVideoOverlay()
    });
  };

  playAt(0);
}

/** 動画URLの配列を連続再生。1件の場合は showVideoOverlay、複数なら順番に再生 */
function playVideoSequence(urls) {
  if (!urls || urls.length === 0) return;
  const overlay = document.getElementById('videoOverlay');
  const wrap = document.getElementById('videoPlayerWrap');
  if (!overlay || !wrap) return;

  if (urls.length === 1) {
    showVideoOverlay(urls[0]);
    return;
  }

  let index = 0;
  const VIDEO_DURATION_MS = 30000;

  const playAt = (idx) => {
    if (videoSequenceTimer) {
      clearTimeout(videoSequenceTimer);
      videoSequenceTimer = null;
    }
    if (idx < 0 || idx >= urls.length) return;
    index = idx;
    const url = urls[index];
    wrap.innerHTML = '';
    const embedUrl = getVideoEmbedUrl(url);
    if (embedUrl) {
      const ytId = getYouTubeVideoId(url);
      const isVimeo = embedUrl.includes('vimeo.com');
      const src = ytId
        ? `https://www.youtube.com/embed/${ytId}?autoplay=1&mute=0&controls=1&modestbranding=1&rel=0&playsinline=1&enablejsapi=1`
        : embedUrl + '?autoplay=1' + (isVimeo ? '&api=1' : '');
      const iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.title = '動画';
      iframe.allow = 'autoplay; encrypted-media; accelerometer; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      wrap.appendChild(iframe);

      const advanceToNext = () => {
        console.log(`動画終了: 次の動画に進みます (${index + 1}/${urls.length} → ${index + 2}/${urls.length})`);
        if (videoSequenceTimer) { clearTimeout(videoSequenceTimer); videoSequenceTimer = null; }
        if (index + 1 < urls.length) playAt(index + 1);
      };

      // YouTube: postMessage で動画終了を検知
      if (ytId) {
        const ytHandler = (e) => {
          if (!e.origin.includes('youtube.com')) return;
          try {
            const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (data?.event === 'onStateChange' && data?.info === 0) {
              console.log(`YouTube動画終了イベント受信`);
              window.removeEventListener('message', ytHandler);
              advanceToNext();
            }
          } catch (_) {}
        };
        window.addEventListener('message', ytHandler);
        iframe.onload = () => {
          try { iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening' }), '*'); } catch (_) {}
        };
      }

      // Vimeo: postMessage で終了検知
      if (isVimeo) {
        const vimeoHandler = (e) => {
          try {
            const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
            if (data && data.event === 'finish') {
              console.log(`Vimeo動画終了イベント受信`);
              window.removeEventListener('message', vimeoHandler);
              advanceToNext();
            }
          } catch (_) {}
        };
        window.addEventListener('message', vimeoHandler);
        iframe.onload = () => {
          try { iframe.contentWindow.postMessage(JSON.stringify({ method: 'addEventListener', value: 'finish' }), '*'); } catch (_) {}
        };
      }

      // フォールバック: 終了イベントが発火しない場合に備えて60秒後に次へ
      if (index + 1 < urls.length) {
        videoSequenceTimer = setTimeout(() => {
          console.log('動画シーケンスフォールバックタイマー: 次へ進みます');
          advanceToNext();
        }, 60000);
      }
    } else {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      video.muted = false;
      video.addEventListener('ended', () => {
        if (index + 1 < urls.length) playAt(index + 1);
      });
      wrap.appendChild(video);
    }
    overlay.classList.remove('hidden');
    document.querySelector('.map-container')?.classList.add('map-showing-video');

    createVideoControlsBar(overlay, wrap, {
      currentUrl: url,
      onPrev: index > 0 ? () => playAt(index - 1) : null,
      onNext: index + 1 < urls.length ? () => playAt(index + 1) : null,
      onClose: () => closeVideoOverlay()
    });
  };

  playAt(0);
}

let cachedAiConfig = null;

async function loadUserAiConfig() {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return null;
  try {
    const doc = await window.firebaseDb.collection('users').doc(window.firebaseAuth.currentUser.uid).get();
    const d = doc.exists ? doc.data() : {};
    const provider = d.aiProvider || 'gemini';
    const cfg = {
      provider,
      apiKey: (d.aiApiKey || '').trim() || null,
      model: d.aiModel || AI_MODEL_DEFAULTS[provider] || null
    };
    cachedAiConfig = cfg;
    return cfg;
  } catch (err) {
    console.warn('AI設定読み込みエラー:', err);
    return cachedAiConfig;
  }
}

async function saveUserAiConfig(cfg) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return { ok: false, err: 'ログインが必要です' };
  try {
    await window.firebaseDb.collection('users').doc(window.firebaseAuth.currentUser.uid).set({
      aiProvider: cfg.provider,
      aiApiKey: (cfg.apiKey || '').trim(),
      aiModel: cfg.model || null
    }, { merge: true });
    cachedAiConfig = cfg;
    return { ok: true };
  } catch (err) {
    console.warn('AI設定保存エラー:', err);
    return { ok: false, err: err.message || String(err) };
  }
}

const AI_MODEL_OPTIONS = {
  openai: [
    { value: 'gpt-image-1-mini', label: 'gpt-image-1-mini（リーズナブル）' },
    { value: 'gpt-image-1',      label: 'gpt-image-1（標準）' },
    { value: 'gpt-image-2',      label: 'gpt-image-2（ハイスペック）' }
  ],
  gemini: [
    { value: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image（リーズナブル）' },
    { value: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image（標準）' },
    { value: 'gemini-3-pro-image',     label: 'Gemini 3 Pro Image（ハイスペック）' }
  ]
};

const AI_MODEL_DEFAULTS = {
  openai: 'gpt-image-1-mini',
  gemini: 'gemini-3.1-flash-image'
};

// 画像生成メニューの「ロウ/ミドル/ハイ」選択に対応するインデックス。
// AI_MODEL_OPTIONS[provider]は既にリーズナブル→標準→ハイスペックの順で並んでいるため、
// そのままLOW/MID/HIGHの位置として使う。
const MODEL_LEVEL_INDEX = { low: 0, mid: 1, high: 2 };

/** 選択された品質レベルに対応するモデル名を、設定中のプロバイダーのAI_MODEL_OPTIONSから選ぶ */
function getModelForLevel(provider, level) {
  const options = AI_MODEL_OPTIONS[provider];
  if (!options || options.length === 0) return null;
  const idx = MODEL_LEVEL_INDEX[level] ?? MODEL_LEVEL_INDEX.low;
  return (options[idx] || options[options.length - 1]).value;
}

function updateAiModelFieldVisibility(provider, currentModel) {
  const modelField = document.getElementById('aiModelField');
  const modelSelect = document.getElementById('aiModelSelect');
  if (!modelField || !modelSelect) return;

  const options = AI_MODEL_OPTIONS[provider];
  if (!options) {
    modelField.style.display = 'none';
    return;
  }

  // ドロップダウンを再構築
  modelSelect.innerHTML = options.map(o =>
    `<option value="${o.value}">${o.label}</option>`
  ).join('');

  // 保存済みモデルがこのプロバイダーのオプションに存在すれば復元
  const defaultModel = AI_MODEL_DEFAULTS[provider] || options[0].value;
  const savedValid = currentModel && options.some(o => o.value === currentModel);
  modelSelect.value = savedValid ? currentModel : defaultModel;

  modelField.style.display = '';
}

function showAiSettingsModal() {
  if (!window.firebaseAuth?.currentUser) {
    alert('ログインしてください');
    return;
  }
  loadUserAiConfig().then((cfg) => {
    if (!cfg) cfg = { provider: 'gemini', apiKey: '', model: null };
    const providerSelect = document.getElementById('aiProviderSelect');
    const modelSelect = document.getElementById('aiModelSelect');
    const aiInput = document.getElementById('aiApiKeyInput');
    const provider = cfg.provider || 'gemini';
    if (providerSelect) providerSelect.value = provider;
    if (aiInput) aiInput.value = cfg.apiKey || '';
    updateAiModelFieldVisibility(provider, cfg.model);
  });
  document.getElementById('aiSettingsModal').classList.add('open');
}

function closeAiSettingsModal() {
  document.getElementById('aiSettingsModal').classList.remove('open');
}

/** トリップデータのハッシュを生成（旅行記の差分更新用） */
function generateTripContentHash(trip) {
  try {
    const photos = trip?.photos || [];
    const contentData = {
      description: trip?.description || '',
      url: trip?.url || '',
      photos: photos.map(p => ({
        placeName: p?.placeName || '',
        name: p?.name || '',
        description: p?.description || '',
        landmarkNo: p?.landmarkNo || '',
        isStamp: !!p?.isStamp,
        lat: p?.lat,
        lng: p?.lng,
        videoUrl: p?.videoUrl || ''
      }))
    };

    // シンプルなハッシュ関数（文字列化して簡易ハッシュ）
    const str = JSON.stringify(contentData);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32bit整数に変換
    }
    return hash.toString(36);
  } catch (error) {
    console.error('ハッシュ生成エラー:', error);
    // エラー時はランダムなハッシュを返す（常に再生成させる）
    return Math.random().toString(36).substring(2);
  }
}

/**
 * 過去の旅行記HTMLから写真URLをキーに説明テキストを抽出する。
 * @param {string} html - 旅行記のHTML文字列
 * @returns {Map<string, {name:string, overlay:string, description:string}>}
 */
function extractPhotoDescriptionsFromTravelogue(html) {
  const map = new Map();
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const sections = doc.querySelectorAll('div[style*="margin:1.5rem 0"]');
    sections.forEach(section => {
      const img = section.querySelector('img');
      if (!img) return;
      const photoUrl = img.getAttribute('src') || '';
      if (!photoUrl) return;

      const nameEl = section.querySelector('div[style*="top:12px"]');
      const overlayEl = section.querySelector('div[style*="bottom:0"]');
      const descEl = section.querySelector('div[style*="flex:1"]');

      const name = nameEl ? nameEl.textContent.trim() : '';
      const overlay = overlayEl ? overlayEl.textContent.trim() : '';
      const description = descEl ? descEl.textContent.trim() : '';

      if (overlay || description) {
        map.set(photoUrl, { name, overlay, description });
      }
    });
  } catch (e) {
    console.warn('旅行記HTML解析エラー:', e);
  }
  return map;
}

// ─── 旅行記生成ストリーミングヘルパー ────────────────────────────────────────
/**
 * SSE / ストリーミングで AI からテキストを受け取り、チャンクごとに onChunk(partialText) を呼ぶ。
 * 完成したテキスト全体を返す。
 *
 * @param {'gemini'|'openai'|'anthropic'} provider
 * @param {object} cfg  { apiKey }
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {(partial: string) => void} onChunk  チャンク受信コールバック
 * @returns {Promise<string>}  完成テキスト
 */
async function streamTravelogueFromAI(provider, cfg, systemPrompt, userPrompt, onChunk) {
  /** SSE レスポンスを行単位でパースして各チャンクを処理する共通ユーティリティ */
  async function consumeSSE(res, extractText) {
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `HTTP ${res.status} ${res.statusText}`);
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer  = '';
    let content = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 末尾の不完全行を次ループへ
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json || json === '[DONE]') continue;
        try {
          const chunk = extractText(JSON.parse(json));
          if (chunk) { content += chunk; onChunk(content); }
        } catch { /* 不正 JSON は無視 */ }
      }
    }
    return content;
  }

  if (provider === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
          generationConfig: { temperature: 0.7 }
        })
      }
    );
    return consumeSSE(res, (d) => d.candidates?.[0]?.content?.parts?.[0]?.text || '');
  }

  if (provider === 'openai') {
    const res = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   }
          ],
          temperature: 0.7,
          stream: true
        })
      }
    );
    return consumeSSE(res, (d) => d.choices?.[0]?.delta?.content || '');
  }

  if (provider === 'anthropic') {
    const res = await fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          stream: true
        })
      }
    );
    return consumeSSE(res, (d) => d.delta?.text || d.content_block?.text || '');
  }

  throw new Error('未対応のプロバイダーです: ' + provider);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 旅行記生成のテキストAI呼び出し共通処理（プロバイダー振り分け＋Markdown除去）。
 * generateTravelogueWithAI（通常トリップ）とgenerateParentSummaryTravelogueWithAI
 * （親トリップの要約旅行記）の両方から呼ばれる。
 */
async function callTravelogueTextAI(systemPrompt, userPrompt, cfg, timeoutMs = 180000) {
  const provider = cfg.provider || 'gemini';

  const fetchWithTimeout = async (url, options, timeout = timeoutMs) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      console.log(`🔗 API呼び出し: ${url.split('?')[0]}...`);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      console.log(`✅ API応答ステータス: ${response.status}`);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      console.error('📡 ネットワークエラー:', error.name, error.message);
      if (error.name === 'AbortError') {
        throw new Error(`API呼び出しがタイムアウトしました（${timeout / 1000}秒）。写真が多い場合は数を減らしてみてください。`);
      }
      throw error;
    }
  };

  let content = '';
  if (provider === 'gemini') {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
          generationConfig: { temperature: 0.7 }
        })
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(`Gemini API エラー: ${data.error.message || JSON.stringify(data.error)}`);
    if (!data.candidates || !data.candidates[0]) throw new Error('Gemini APIからの応答が不正です。candidatesが空です。');
    content = data.candidates[0]?.content?.parts?.[0]?.text || '';
  } else if (provider === 'openai') {
    const res = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7
        })
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(`OpenAI API エラー: ${data.error.message || JSON.stringify(data.error)}`);
    if (!data.choices || !data.choices[0]) throw new Error('OpenAI APIからの応答が不正です。choicesが空です。');
    content = data.choices[0]?.message?.content || '';
  } else if (provider === 'anthropic') {
    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(`Anthropic API エラー: ${data.error.message || JSON.stringify(data.error)}`);
    if (!data.content || !data.content[0]) throw new Error('Anthropic APIからの応答が不正です。contentが空です。');
    content = data.content[0]?.text || '';
  } else {
    throw new Error('未対応のプロバイダーです: ' + provider);
  }
  if (!content.trim()) {
    throw new Error('AIからの応答が空です。APIキーが正しいか、プロバイダーの設定を確認してください。');
  }

  let finalHtml = content.trim();
  finalHtml = finalHtml.replace(/```html\s*/gi, '').replace(/```\s*$/g, '');
  const htmlTagMatch = finalHtml.match(/(<h2\s|<div\s)/i);
  if (htmlTagMatch && htmlTagMatch.index > 0) {
    finalHtml = finalHtml.substring(htmlTagMatch.index);
  }
  return finalHtml.trim();
}

async function generateTravelogueWithAI() {
  const startTime = Date.now();
  const trip = currentTrip;

  // トリップの詳細な検証とログ出力
  console.log('🔍 旅行記生成開始 - トリップ情報:', {
    hasTripObject: !!trip,
    tripId: trip?.id,
    tripName: trip?.name,
    photosCount: trip?.photos?.length || 0
  });

  if (!trip) {
    alert('トリップを選択してください');
    return;
  }
  if (!trip.id) {
    alert('トリップIDが不正です。トリップを再度選択してください。');
    console.error('トリップIDが不正:', trip);
    return;
  }

  // 親トリップは全ての子トリップの写真を1枚ずつ解説する旅行記ではなく、
  // アニメ・動画・旅行記リンク・スタンプなどのサマリー情報から総合情報ページを作る
  if (trip.isParent) {
    await generateParentSummaryTravelogueWithAI(trip);
    return;
  }

  // 旅行記の差分更新チェック
  console.log('🔍 旅行記の差分チェック開始...');
  const currentHash = generateTripContentHash(trip);
  const hasExistingTravelogue = !!(trip.travelogueUrl || trip.travelogueHtml || (trip.travelogueHistory?.length > 0));

  if (hasExistingTravelogue && trip.travelogueContentHash === currentHash) {
    console.log('✓ トリップの内容に変更なし - 既存の旅行記を使用');
    setStatus('トリップの内容に変更がないため、既存の旅行記を表示します');
    showTravelogueModal();
    return;
  }

  // 内容に変更がある場合は旅行記を再生成
  if (hasExistingTravelogue) {
    console.log('🔄 内容が変更されたため、旅行記を更新します');
    setStatus('内容が変更されたため、旅行記を更新します...');
  } else {
    console.log('📝 新規旅行記を生成します');
  }

  const cfg = cachedAiConfig ?? (await loadUserAiConfig());
  if (!cfg?.apiKey?.trim()) {
    alert('旅行記生成にはAPIキーが必要です。AI設定でプロバイダーを選択し、APIキーを入力してください。');
    return;
  }

  const btn = document.getElementById('generateTravelogueBtn');
  const originalBtnText = btn?.textContent || '旅行記生成';

  // カスタム指示（強調場所・除外事項など）を取得
  const customInstructions = (document.getElementById('travelogueCustomInstructions')?.value || '').trim();

  // 既存の旅行記がある場合は上書き（削除せずに更新）
  if (trip.travelogueUrl || trip.travelogueHtml) {
    setStatus('旅行記を更新します...');
    console.log('既存の旅行記を更新します');
  }

  const photos = getDisplayPhotos();
  const parts = [];

  // 親トリップの情報を取得
  let parentTripInfo = null;
  if (trip.parentId) {
    const allTrips = getOrderedTrips() || [];
    const parentTrip = allTrips.find(t => t && t.id === trip.parentId);
    if (parentTrip) {
      parentTripInfo = {
        name: parentTrip.name || '（無題）',
        description: parentTrip.description || ''
      };
    }
  }

  // 親トリップの情報がある場合は最初に記載
  if (parentTripInfo) {
    parts.push(`【重要】この旅は「${parentTripInfo.name}」の一部です。`);
    if (parentTripInfo.description) {
      parts.push(`親トリップの説明: ${parentTripInfo.description}`);
    }
    parts.push(`この旅行記は、上記の大きな旅の一環として書いてください。`);
    parts.push('');
  }

  parts.push(`トリップ名: ${trip.name || '（無題）'}`);
  if (trip.description) parts.push(`説明: ${trip.description}`);
  if (trip.url) parts.push(`ブログURL: ${trip.url}`);
  if (trip.videoUrl) parts.push(`動画URL: ${trip.videoUrl}`);
  let gpxSummary = '';
  try {
    const gpxText = await getGpxContent(trip);
    if (gpxText) {
      const stats = getGpxStats(gpxText);
      if (stats) gpxSummary = `ルート: ${stats.moveKm ? stats.moveKm + 'km' : ''}${stats.date ? '、日付: ' + stats.date : ''}`;
      const pts = parseGpxPoints(gpxText);
      if (pts.length > 0) gpxSummary += `、経由点${pts.length}箇所`;
    }
  } catch (_) {}
  if (gpxSummary) parts.push(`GPS情報: ${gpxSummary}`);

  const photoInfos = [];

  if (photos.length > 0) {
    photos.forEach((p, i) => {
      const loc = p.placeName || '';
      const desc = p.description || p.name || '';
      const piVideoUrl = p.videoUrl && p.videoUrl.trim() ? p.videoUrl.trim() : '';
      photoInfos.push({
        index: i + 1,
        url: p.url,
        videoUrl: piVideoUrl,
        videoThumbnailUrl: piVideoUrl ? (getVideoThumbnailUrl(piVideoUrl) || '') : '',
        placeName: loc,
        description: desc,
        landmarkNo: p.landmarkNo || '',
        pointName: p.name || p.description || '',
        isStamp: !!p.isStamp
      });
    });
  }

  // ── ランドマーク写真はWikipediaから概要を取得し、サマリー情報として付加する ──────
  // 全写真ではなくランドマークのみを対象にし、並列取得することで待ち時間を抑える
  // （fetchWikipediaForPlaceは座標/地名ごとにキャッシュされるため、再生成時は再取得しない）
  const landmarkIndexes = photoInfos
    .map((pi, idx) => (pi.landmarkNo && !pi.isStamp ? idx : -1))
    .filter(idx => idx >= 0);
  if (landmarkIndexes.length > 0) {
    setStatus(`ランドマーク情報をWikipediaから取得中...(${landmarkIndexes.length}件)`);
    await Promise.all(landmarkIndexes.map(async (idx) => {
      const pi = photoInfos[idx];
      const p = photos[idx];
      try {
        const wiki = await fetchWikipediaForPlace(p?.lat, p?.lng, pi.placeName || pi.pointName);
        if (wiki?.extract) {
          pi.wikiTitle = wiki.title || '';
          pi.wikiExtract = wiki.extract.slice(0, 600);
        }
      } catch (_) {
        // 取得失敗時はそのランドマークの情報なしで続行（旅行記生成自体は止めない）
      }
    }));
  }

  // ── 過去の旅行記から既存の写真説明を取得して流用 ──────────────────────────
  let prevPhotoDescriptions = new Map();
  const prevTravelogueUrl = trip.travelogueUrl || getLatestTravelogueEntry(trip)?.url || null;

  if (prevTravelogueUrl) {
    try {
      setStatus('過去の旅行記を参照中...');
      const res = await fetch(prevTravelogueUrl);
      if (res.ok) {
        const prevHtml = await res.text();
        prevPhotoDescriptions = extractPhotoDescriptionsFromTravelogue(prevHtml);
      }
    } catch (e) {
      console.warn('過去の旅行記の取得に失敗（スキップ）:', e);
    }
  }

  // 写真を「流用可能（既存）」と「新規」に分類
  let reuseCount = 0;
  photoInfos.forEach(pi => {
    if (prevPhotoDescriptions.has(pi.url)) {
      pi.prevContent = prevPhotoDescriptions.get(pi.url);
      reuseCount++;
    }
  });
  if (reuseCount > 0) {
    console.log(`♻️ 過去の旅行記から ${reuseCount} 件の写真説明を流用予定 (新規: ${photoInfos.length - reuseCount} 件)`);
    setStatus(`過去の旅行記から ${reuseCount} 件を流用、${photoInfos.length - reuseCount} 件を新規生成...`);
  }
  const hasWikiInfo = photoInfos.some(pi => pi.wikiExtract);

  const tripColor = trip.color || '#e1306c';

  // アニメ画像: 表紙(cover)、詳細(detail)、名所浮世絵(ukiyoe)を分離
  const animeImages = trip.generatedAnimes && trip.generatedAnimes.length > 0 ? trip.generatedAnimes : [];
  const coverAnimes = animeImages.filter(a => a.style && !String(a.style).startsWith('detail') && a.style !== 'meisho-ukiyoe');
  const detailAnimes = animeImages.filter(a => a.style && String(a.style).startsWith('detail'));
  const ukiyoeAnimes = animeImages.filter(a => a.style === 'meisho-ukiyoe');

  const animeCoverUrl = coverAnimes.length > 0 ? coverAnimes[0].url : (animeImages.length > 0 && animeImages[0].style !== 'meisho-ukiyoe' ? animeImages[0].url : null);
  let animeCoverHtml = '';
  if (animeCoverUrl) {
    animeCoverHtml = `<img src="${animeCoverUrl}" alt="旅行記の表紙" style="width:100%;max-width:400px;height:auto;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.2);display:block;"/>`;
  }
  let detailAnimeHtml = '';
  if (detailAnimes.length > 0) {
    // 詳細アニメを20%大きく: 33.333% → 40%
    const imgs = detailAnimes.map(a => `<img src="${a.url}" alt="旅行記詳細" style="width:calc(40% - 0.5rem);min-width:150px;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:block;object-fit:cover;"/>`).join('\n');
    detailAnimeHtml = `<div class="travelogue-detail-animes" style="display:flex;flex-wrap:wrap;gap:0.75rem;margin:1rem 0 0 0;justify-content:flex-start;">\n${imgs}\n</div>`;
  }

  // 名所浮世絵を写真情報と関連付け
  const ukiyoeMap = new Map();
  ukiyoeAnimes.forEach(ukiyoe => {
    if (ukiyoe.meishoText) {
      const keywords = ukiyoe.meishoText.split(/[、。・\s]+/).filter(w => w.length >= 2);
      // 各写真と照合して関連度を計算
      photoInfos.forEach((photo, idx) => {
        const photoText = [photo.pointName, photo.placeName, photo.description].filter(Boolean).join(' ');
        const matchCount = keywords.filter(keyword => photoText.includes(keyword)).length;
        if (matchCount > 0) {
          if (!ukiyoeMap.has(idx)) {
            ukiyoeMap.set(idx, []);
          }
          ukiyoeMap.get(idx).push({ ukiyoe, matchCount });
        }
      });
    }
  });

  // 各写真インデックスごとに最もマッチする浮世絵を選択（各浮世絵は全体で1回のみ使用）
  const photoUkiyoeMap = new Map();
  const usedUkiyoeUrls = new Set();
  // 全マッチをフラット化してスコア降順にソートし、貪欲に1対1割り当て
  const allUkiyoeMatches = [];
  ukiyoeMap.forEach((matches, photoIdx) => {
    matches.forEach(({ ukiyoe, matchCount }) => {
      allUkiyoeMatches.push({ photoIdx, ukiyoe, matchCount });
    });
  });
  allUkiyoeMatches.sort((a, b) => b.matchCount - a.matchCount);
  allUkiyoeMatches.forEach(({ photoIdx, ukiyoe }) => {
    if (!photoUkiyoeMap.has(photoIdx) && !usedUkiyoeUrls.has(ukiyoe.url)) {
      photoUkiyoeMap.set(photoIdx, ukiyoe);
      usedUkiyoeUrls.add(ukiyoe.url);
    }
  });

  // photoInfosに浮世絵情報を追加
  photoInfos.forEach((photo, idx) => {
    if (photoUkiyoeMap.has(idx)) {
      photo.ukiyoeImage = photoUkiyoeMap.get(idx);
    }
  });

  // 写真情報をプロンプトに追加（浮世絵情報・既存説明を含む）
  if (photos.length > 0) {
    parts.push('\n写真情報:');
    photoInfos.forEach((pi) => {
      const info = [];
      info.push(`写真${pi.index}: ${pi.url}`);
      if (pi.landmarkNo) info.push(`[ランドマーク${pi.landmarkNo}]`);
      info.push(pi.pointName || pi.placeName || '名称未設定');
      if (pi.description) info.push(`- ${pi.description}`);
      if (pi.ukiyoeImage) {
        info.push(`[浮世絵:${pi.ukiyoeImage.url}]`);
      }
      if (pi.wikiExtract) {
        info.push(`[Wikipedia概要:${pi.wikiExtract}]`);
      }
      // 過去の旅行記に既存の説明がある場合はタグとして渡す
      if (pi.prevContent) {
        if (pi.prevContent.overlay) info.push(`[既存オーバーレイ:${pi.prevContent.overlay}]`);
        if (pi.prevContent.description) info.push(`[既存情景描写:${pi.prevContent.description}]`);
      }
      parts.push(info.join(' '));
    });
  }

  const context = parts.join('\n');

  // プロンプトの長さをログ出力


  const hasAnimeCover = !!animeCoverHtml;
  const hasDetailAnimes = !!detailAnimeHtml;

  // サマリー構造を事前に構築（ネストされたテンプレートリテラルを回避）
  let summaryStructure = '';
  if (hasAnimeCover) {
    const coverDiv = '<div style="flex:0 0 auto;min-width:200px;">' + animeCoverHtml + '</div>';
    const textDiv = '<div style="flex:1;min-width:250px;"><p>220字のサマリー</p>' + (hasDetailAnimes ? detailAnimeHtml : '') + '</div>';
    summaryStructure = '<div class="travelogue-summary" style="display:flex;gap:2rem;align-items:flex-start;flex-wrap:wrap;margin:2rem 0;">' + coverDiv + textDiv + '</div>';
  } else {
    summaryStructure = '<div class="travelogue-summary"><p>220字のサマリー</p>' + (hasDetailAnimes ? detailAnimeHtml : '') + '</div>';
  }

  // 🚀 プロンプト大幅短縮：最速生成のために必要最小限に
  const systemPrompt = `HTMLのみを出力してください。説明文や\`\`\`htmlなどのマークダウンは不要です。

構造:
1. タイトル: <h2 class="travelogue-title">魅力的な表題</h2>
2. サマリー: ${summaryStructure}
<div id="travelogue-map-container" style="min-height:400px;margin:2rem 0;"></div>
3. 各写真セクション（ランドマークは<div class="travelogue-landmark-section"><h3 style="border-left:4px solid ${tripColor};padding-left:12px;color:${tripColor};">📍番号:名前</h3>...）:
<div style="margin:1.5rem 0;"><div style="display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap;"><div style="position:relative;width:500px;max-width:100%;"><img src="URL" loading="lazy" style="width:100%;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:block;"><div style="position:absolute;top:12px;left:12px;background:rgba(0,0,0,0.75);color:#fff;padding:8px 12px;border-radius:6px;font-weight:700;">名前</div><div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(to top,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.6) 60%,transparent 100%);color:#fff;padding:40px 12px 12px 12px;border-radius:0 0 8px 8px;font-size:0.9rem;">写真に記載された説明文をそのまま表示</div></div><div style="flex:1;min-width:250px;"><p>150字の情景描写（ランドマークの場合は歴史的背景・豆知識も自然に含めて厚みを持たせる）</p></div></div></div>

【名所浮世絵の配置】写真情報に[浮世絵:URL]が含まれる場合、その写真セクションの情景描写の後に浮世絵を配置（同じURLの浮世絵は旅行記全体で1回のみ表示すること。キャプション文は付けないこと）:
<div style="margin:1.5rem 0 0 0;text-align:center;"><img src="浮世絵URL" alt="名所浮世絵" loading="lazy" style="width:100%;max-width:600px;height:auto;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.2);display:inline-block;"/></div>

重要: HTMLのみ出力、トリップカラー=${tripColor}、写真500px幅、各写真固有の描写。写真下部オーバーレイには各写真の説明文を必ず含めてください。
注意: スタンプ写真はランドマークセクションとして扱わず、通常の写真として表示してください${customInstructions ? `
【ユーザー指示】以下の指示を必ず守って旅行記を生成してください:
${customInstructions}` : ''}${reuseCount > 0 ? `
【既存説明の流用ルール】写真情報に[既存オーバーレイ:...]と[既存情景描写:...]がある写真は、過去の旅行記で既に説明済みです。これらの写真については、提供された既存テキストをそのまま使用してください（Wikiや場所の説明を再生成しない）。[既存オーバーレイ:...]の内容をオーバーレイに、[既存情景描写:...]の内容を情景描写に使用してください。新規写真（[既存...]タグがない写真）のみ新たな情景描写を生成してください。` : ''}${hasWikiInfo ? `
【Wikipedia概要の扱い】写真情報に[Wikipedia概要:...]がある場合、それはそのランドマークに関するWikipediaからの参考情報です。このテキストをそのままコピーせず、必ず旅行記の文体に合わせて自分の言葉で要約・言い換えたうえで、その写真の情景描写に歴史的背景や豆知識として自然に盛り込んでください。` : ''}`;
  const userPrompt = `以下のトリップ情報をもとに、上記の構造に従って旅行記を生成してください。\n\n${context}`;

  const provider = cfg.provider || 'gemini';
  const TRAVELOGUE_MODELS = {
    gemini: 'gemini-2.5-flash',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-20241022'
  };
  const travelogueModel = TRAVELOGUE_MODELS[provider] || provider;

  try {
    setStatus(`旅行記を生成中... [${travelogueModel}]`);
    if (btn) btn.textContent = '旅行記生成中...';

    // 写真が非常に多い場合のみ警告（閾値を50枚に引き上げ）
    const photoCount = photos.length;
    if (photoCount > 50) {
      const proceed = confirm(
        `写真が${photoCount}枚あります。\n\n` +
        '高速モードでも生成に時間がかかる可能性があります。\n\n' +
        'このまま生成を続けますか？'
      );
      if (!proceed) {
        setStatus('旅行記生成をキャンセルしました');
        return;
      }
    }

    // タイムアウト設定（基本180秒 + 写真20枚ごとに30秒）
    const baseTimeout = 180000;
    const additionalTimeout = Math.floor(photoCount / 20) * 30000;
    const timeout = baseTimeout + additionalTimeout;
    console.log(`タイムアウト設定: ${timeout / 1000}秒 (写真${photoCount}枚)`);

    let finalHtml = await callTravelogueTextAI(systemPrompt, userPrompt, cfg, timeout);

    finalHtml = finalHtml.trim();

    // 全<img>にloading="lazy"を強制する（プロンプトで指示済みだが、AIが従わなかった場合のフォールバック）。
    // 写真が多いトリップでも初期表示時に全画像を一括ダウンロードしないようにする。
    finalHtml = finalHtml.replace(/<img(?![^>]*\bloading=)([^>]*)>/gi, (m, attrs) => `<img${attrs} loading="lazy">`);

    // 動画URLがあるポイントの写真をサムネイルに差し替え（AIが従わなかった場合のフォールバック）
    photos.filter(p => p.url && p.videoUrl && p.videoUrl.trim()).forEach(p => {
      const vUrl = p.videoUrl.trim();
      const thumbUrl = getVideoThumbnailUrl(vUrl);
      if (!thumbUrl || !finalHtml.includes(`src="${p.url}"`)) return;
      const playOverlay = `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;background:rgba(0,0,0,0.72);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.6rem;color:#fff;pointer-events:none;">▶</div>`;
      // <img src="写真URL" ...> を <a href="動画URL"><img src="サムネイルURL" ...></a> + 再生ボタンに差し替え
      finalHtml = finalHtml.replace(
        new RegExp(`<img src="${p.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"([^>]*)>`, 'g'),
        `<a href="${escapeHtml(vUrl)}" target="_blank" rel="noopener" style="display:block;"><img src="${escapeHtml(thumbUrl)}"$1>${playOverlay}</a>`
      );
    });

    // 旅行記の最後にナビゲーターを追加
    if (!trip || !trip.id) {
      throw new Error('ナビゲーター生成時にトリップ情報が不正です');
    }
    const allTrips = getOrderedTrips() || [];
    const currentIndex = allTrips.findIndex(t => t && t.id === trip.id);
    const prevTrip = currentIndex > 0 ? allTrips[currentIndex - 1] : null;
    const nextTrip = currentIndex >= 0 && currentIndex < allTrips.length - 1 ? allTrips[currentIndex + 1] : null;

    let navHtml = '<div style="margin-top:3rem;padding:2rem 0;border-top:2px solid #e0e0e0;display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">';

    if (prevTrip) {
      const prevName = escapeHtml(prevTrip.name || '前のトリップ');
      navHtml += `<div style="flex:1;text-align:left;"><a href="#" class="travelogue-nav-prev" data-trip-id="${prevTrip.id}" style="color:${tripColor};text-decoration:none;font-weight:600;font-size:1rem;">← ${prevName}</a></div>`;
    } else {
      navHtml += '<div style="flex:1;"></div>';
    }

    const currentName = escapeHtml(trip.name || '現在のトリップ');
    navHtml += `<div style="flex:0 0 auto;text-align:center;color:#666;font-weight:700;font-size:1.1rem;">${currentName}</div>`;

    if (nextTrip) {
      const nextName = escapeHtml(nextTrip.name || '次のトリップ');
      navHtml += `<div style="flex:1;text-align:right;"><a href="#" class="travelogue-nav-next" data-trip-id="${nextTrip.id}" style="color:${tripColor};text-decoration:none;font-weight:600;font-size:1rem;">${nextName} →</a></div>`;
    } else {
      navHtml += '<div style="flex:1;"></div>';
    }

    navHtml += '</div>';

    // 旅行記に目次を追加
    // ランドマークセクション（h3タグ）を抽出して目次を生成（スタンプは除外）
    const landmarks = [];
    const landmarkRegex = /<div class="travelogue-landmark-section"[^>]*>\s*<h3[^>]*>([^<]*)<\/h3>/gi;
    let match;
    while ((match = landmarkRegex.exec(finalHtml)) !== null) {
      const landmarkTitle = match[1].replace(/<[^>]+>/g, ''); // HTMLタグを除去
      // スタンプ項目は目次から除外（「スタンプ」「✅」を含むタイトルを除外）
      if (!landmarkTitle.includes('スタンプ') && !landmarkTitle.includes('✅')) {
        const landmarkId = `landmark-${landmarks.length + 1}`;
        landmarks.push({ id: landmarkId, title: landmarkTitle });
      }
    }

    // ランドマークセクションのdivにidを追加
    if (landmarks.length > 0) {
      let landmarkCount = 0;
      finalHtml = finalHtml.replace(/<div class="travelogue-landmark-section"/g, () => {
        const landmark = landmarks[landmarkCount];
        landmarkCount++;
        return `<div class="travelogue-landmark-section" id="${landmark.id}"`;
      });

      // サマリーの直後（地図コンテナの直前）に目次を挿入
      const tocHtml = `
<details class="travelogue-toc-details">
  <summary class="travelogue-toc-summary">📋 目次</summary>
  <nav class="travelogue-toc-nav">
    <ul>
      ${landmarks.map(landmark => `
      <li><a href="#${landmark.id}" style="color:${tripColor};">› ${escapeHtml(landmark.title)}</a></li>
      `).join('')}
    </ul>
  </nav>
</details>`;

      // 地図コンテナの直前に目次を挿入
      const mapIdIdx = finalHtml.indexOf('id="travelogue-map-container"');
      if (mapIdIdx !== -1) {
        const divStart = finalHtml.lastIndexOf('<div', mapIdIdx);
        if (divStart !== -1) {
          finalHtml = finalHtml.slice(0, divStart) + tocHtml + '\n' + finalHtml.slice(divStart);
        }
      }
    }

    finalHtml += navHtml;

    setStatus('旅行記を生成しました');

    // 旅行記をStorageに保存（Firestoreの1MB制限を回避）
    try {
      // tripとcurrentTripの整合性を確認
      if (!trip || !trip.id) {
        throw new Error('トリップ情報が不正です（trip.idがありません）');
      }
      if (!currentTrip || !currentTrip.id) {
        throw new Error('現在のトリップ情報が不正です（currentTrip.idがありません）');
      }
      if (trip.id !== currentTrip.id) {
        throw new Error('トリップIDが一致しません。旅行記生成中に別のトリップが選択された可能性があります。');
      }

      console.log('旅行記をStorageに保存開始...', { tripId: trip.id });
      const travelogueUrl = await uploadTravelogueToStorage(trip.id, finalHtml);
      currentTrip.travelogueUrl = travelogueUrl;
      // HTMLはStorageに保存したのでFirestoreには保存しない（1MB制限回避）
      currentTrip.travelogueHtml = null;
      currentTrip.travelogueGeneratedAt = Date.now();
      // 旅行記の内容ハッシュを保存（差分更新用）
      currentTrip.travelogueContentHash = currentHash;

      // 履歴に追加
      if (!currentTrip.travelogueHistory) {
        currentTrip.travelogueHistory = [];
      }
      currentTrip.travelogueHistory.push({
        url: travelogueUrl,
        timestamp: Date.now()
      });

      console.log('旅行記をStorageに保存しました:', {
        url: travelogueUrl,
        htmlSize: finalHtml.length,
        historyCount: currentTrip.travelogueHistory.length,
        contentHash: currentHash
      });
    } catch (err) {
      console.error('旅行記のStorage保存エラー:', err);
      // Storageに保存できない場合のみHTMLを直接保存
      // ただし小さいHTMLに限定（500KB以下）
      if (finalHtml.length < 500000) {
        currentTrip.travelogueHtml = finalHtml;
        currentTrip.travelogueUrl = null;
        currentTrip.travelogueGeneratedAt = Date.now();
        // 旅行記の内容ハッシュを保存（差分更新用）
        currentTrip.travelogueContentHash = currentHash;

        // 履歴に追加（HTMLの場合はURLとして特殊値を使用）
        if (!currentTrip.travelogueHistory) {
          currentTrip.travelogueHistory = [];
        }
        currentTrip.travelogueHistory.push({
          html: finalHtml,
          timestamp: Date.now()
        });

        console.log('StorageではなくFirestoreに直接保存します（小サイズ）');
      } else {
        throw new Error('旅行記のサイズが大きすぎてStorageにも保存できませんでした: ' + err.message);
      }
    }

    console.log('💾 トリップを保存します...');
    await saveTrip();
    const totalTime = Date.now() - startTime;
    updateCoverPreview();
    updateTravelogueActionButtons();
    updateTravelogueHistoryLinks();
    updateViewerSection();
    showTravelogueModal();
  } catch (err) {
    console.error('旅行記生成エラー:', err);
    console.error('エラースタック:', err.stack);
    console.error('トリップ情報:', { trip, currentTrip });
    console.error('AI設定:', { provider: cfg?.provider, hasApiKey: !!cfg?.apiKey });

    let errorMessage = '旅行記の生成に失敗しました。\n\n';

    if (err.message) {
      errorMessage += `エラー: ${err.message}\n\n`;
    }

    if (!cfg?.apiKey?.trim()) {
      errorMessage = 'APIキーが設定されていません。\n\n';
      errorMessage += 'メニュー → AI設定 で以下を確認してください:\n';
      errorMessage += '1. プロバイダーを選択（Gemini / OpenAI / Anthropic）\n';
      errorMessage += '2. APIキーを入力';
    } else if (err.message && err.message.includes('トリップ')) {
      errorMessage += 'トリップ情報が不正です。\n';
      errorMessage += 'トリップを再度選択してから、もう一度お試しください。';
    } else if (err.message && err.message.includes('API')) {
      errorMessage += 'APIキーが正しいか確認してください。\n';
      errorMessage += 'AI設定でプロバイダーとAPIキーを確認してください。';
    } else if (err.message && err.message.includes('timeout')) {
      errorMessage += 'APIの応答に時間がかかりすぎています。\n';
      errorMessage += '写真の数を減らすか、しばらく待ってから再試行してください。';
    } else if (err.message && err.message.includes('undefined')) {
      errorMessage += 'データが不完全です。\n';
      errorMessage += 'トリップを再度選択してから、もう一度お試しください。';
    } else if (err.message && (err.message.includes('Network') || err.message.includes('fetch'))) {
      errorMessage += 'ネットワーク接続が失敗しました。\n\n';
      errorMessage += '確認事項:\n';
      errorMessage += '1. インターネット接続を確認\n';
      errorMessage += '2. VPN/ファイアウォール設定を確認\n';
      errorMessage += '3. ブラウザのコンソール(F12)でエラー詳細を確認';
    } else {
      errorMessage += 'コンソールログ(F12)を確認してください。';
    }

    alert(errorMessage);
    setStatus('旅行記生成に失敗しました');
  } finally {
    if (btn) btn.textContent = originalBtnText;
  }
}

/** トリップ（親なら全子トリップを集約）の生成済みアニメ画像を全て返す */
function getAllAnimesForTrip(trip) {
  if (!trip) return [];
  if (trip.isParent) {
    return getChildTrips(trip.id).flatMap(c =>
      (c.generatedAnimes || c.animes || []).map(a => ({ ...a, _tripName: c.name, _tripId: c.id }))
    );
  }
  return (trip.generatedAnimes || trip.animes || []).map(a => ({ ...a, _tripName: trip.name, _tripId: trip.id }));
}

/**
 * 親トリップ自身のために生成されたアニメ画像（マップInk・カバー画像等）をグリッド表示するHTMLを組み立てる。
 * 子トリップのアニメではなく、親トリップの generatedAnimes のみを対象にする。
 */
function buildParentAnimeSectionHtml(trip) {
  const animes = (trip.generatedAnimes || trip.animes || []).filter(a => a?.url);
  if (animes.length === 0) return '';
  const imgs = animes.map(a =>
    `<img src="${escapeHtml(a.url)}" alt="生成画像" loading="lazy" style="width:calc(33.333% - 0.7rem);min-width:150px;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:block;object-fit:cover;"/>`
  ).join('\n');
  return `<div class="travelogue-parent-anime-section" style="margin:2rem 0;display:flex;flex-wrap:wrap;gap:1rem;">${imgs}</div>`;
}

/**
 * 親トリップおよび各子トリップに設定されたブログURLを一覧表示するHTMLを組み立てる。
 * URLが1件も設定されていない場合は何も出力しない。
 */
function buildBlogSectionHtml(trip, children) {
  const entries = [];
  if (trip.url) entries.push({ name: trip.name || '（無題）', url: trip.url });
  (children || []).forEach(c => {
    if (c.url) entries.push({ name: c.name || '（無題）', url: c.url });
  });
  if (entries.length === 0) return '';
  const links = entries.map(e =>
    `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener" style="display:block;padding:8px 0;color:#405de6;text-decoration:none;border-bottom:1px solid #eee;">📝 ${escapeHtml(e.name)}</a>`
  ).join('');
  return `<div class="travelogue-blog-section" style="margin:2rem 0;">
    <h3 style="margin-bottom:0.75rem;font-size:1.2rem;">ブログ</h3>
    ${links}
  </div>`;
}

/**
 * 子トリップへのアクセスカード一覧のHTMLを組み立てる。
 * 各カードには写真サムネイル・件数バッジ・旅行記/動画への直接リンクを付け、
 * 総合情報ページから傘下の各トリップの情報にすぐアクセスできるようにする。
 */
function buildChildAccessSectionHtml(children) {
  if (!children || children.length === 0) return '';
  const cards = children.map(c => {
    const thumbUrl = (c.photos || []).find(p => p.url)?.url || getAnimeCoverForTrip(c)?.url || '';
    const hasTravelogue = tripHasTravelogue(c);
    const videoUrls = getTripVideoUrlsForTrip(c);
    const stampCount = (c.photos || []).filter(p => p.isStamp).length;
    const landmarkCount = (c.photos || []).filter(p => p.landmarkNo).length;
    const safeName = escapeHtml(c.name || '無題');

    const badges = [];
    if (landmarkCount > 0) badges.push(`📍${landmarkCount}`);
    if (stampCount > 0) badges.push(`🎫${stampCount}`);

    const links = [];
    if (hasTravelogue) {
      links.push(`<a href="#" class="travelogue-child-link" data-trip-id="${c.id}" style="display:inline-block;padding:4px 10px;background:#f0f0f0;border-radius:14px;font-size:0.8rem;text-decoration:none;color:#333;">📖 旅行記</a>`);
    }
    if (videoUrls.length > 0) {
      links.push(`<a href="${escapeHtml(videoUrls[0])}" target="_blank" rel="noopener" style="display:inline-block;padding:4px 10px;background:#f0f0f0;border-radius:14px;font-size:0.8rem;text-decoration:none;color:#333;">🎬 動画</a>`);
    }

    const thumbClickable = thumbUrl && hasTravelogue;
    return `<div class="travelogue-child-card" style="border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;background:#fff;">
      ${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" loading="lazy" ${thumbClickable ? `class="travelogue-child-thumb-link" data-trip-id="${c.id}" title="${safeName}の旅行記を見る"` : ''} style="width:100%;height:130px;object-fit:cover;display:block;${thumbClickable ? 'cursor:pointer;' : ''}" />` : ''}
      <div style="padding:10px 12px;">
        <div style="font-weight:700;font-size:0.95rem;margin-bottom:4px;">${safeName}</div>
        ${badges.length > 0 ? `<div style="font-size:0.78rem;color:#888;margin-bottom:8px;">${badges.join('　')}</div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;">${links.join('')}</div>
      </div>
    </div>`;
  }).join('');

  return `<div class="travelogue-child-access-section" style="margin:2.5rem 0;">
    <h3 style="margin-bottom:1rem;font-size:1.2rem;">🗂️ 子トリップ一覧（${children.length}件）</h3>
    <div class="travelogue-child-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;">${cards}</div>
  </div>`;
}

/**
 * 親トリップ向けの総合情報ページ（サマリー旅行記）を生成する。
 * 子トリップ全ての写真を1枚ずつ解説するのではなく、既にサマリー表示で使っている
 * アニメ・動画・旅行記リンク・スタンプなどの集約情報からサマリー文を作り、
 * マップは全子トリップのルートを1枚にまとめ、末尾に子トリップへのアクセスカードを添える。
 */
async function generateParentSummaryTravelogueWithAI(trip) {
  const cfg = cachedAiConfig ?? (await loadUserAiConfig());
  if (!cfg?.apiKey?.trim()) {
    alert('旅行記生成にはAPIキーが必要です。AI設定でプロバイダーを選択し、APIキーを入力してください。');
    return;
  }

  const btn = document.getElementById('generateTravelogueBtn');
  const originalBtnText = btn?.textContent || '旅行記生成';
  const customInstructions = (document.getElementById('travelogueCustomInstructions')?.value || '').trim();
  const tripColor = trip.color || TRIP_COLORS[0];

  const children = getChildTrips(trip.id);
  if (children.length === 0) {
    alert('この親トリップには子トリップがありません。子トリップを作成してから旅行記を生成してください。');
    return;
  }

  try {
    setStatus('子トリップの情報を集計中...');
    if (btn) btn.textContent = '旅行記生成中...';

    const stamps = getStampListForTrip(trip);
    const videoUrls = getTripVideoUrlsForTrip(trip);
    const animes = getAllAnimesForTrip(trip);
    const childrenWithTravelogue = children.filter(c => tripHasTravelogue(c));
    const totalPhotos = children.reduce((sum, c) => sum + (c.photos || []).length, 0);
    const totalLandmarks = children.reduce((sum, c) => sum + (c.photos || []).filter(p => p.landmarkNo).length, 0);

    // 全子トリップのGPXから総移動距離を集計（取得できないものはスキップ）
    let totalKm = 0;
    await Promise.all(children.map(async (c) => {
      try {
        const gpxText = await getGpxContent(c);
        if (gpxText) {
          const stats = getGpxStats(gpxText);
          if (stats?.moveKm) totalKm += stats.moveKm;
        }
      } catch (_) {}
    }));

    const childList = children.map(c => {
      const bits = [c.name || '無題'];
      if (c.description) bits.push(c.description);
      return `- ${bits.join('：')}`;
    }).join('\n');

    const systemPrompt = `HTMLのみを出力してください。説明文や\`\`\`htmlなどのマークダウンは不要です。

これは複数の子トリップ（日程・区間）をまとめた「親トリップ」の総合情報ページです。
子トリップの写真を1枚ずつ解説する詳細な旅行記ではなく、旅全体を俯瞰できる分かりやすいサマリーを書いてください。

構造（この順番・タグをそのまま使う）:
1. タイトル: <h2 class="travelogue-title">魅力的な表題</h2>
2. サマリー: <div class="travelogue-summary"><p>300字程度で、旅全体の行程・魅力・見どころを紹介する文章</p></div>
<div id="travelogue-map-container" style="min-height:400px;margin:2rem 0;"></div>

重要:
- HTMLのみ出力。上記の2ブロック以外（個々の写真セクションなど）は書かないでください。
- トリップカラー=${tripColor}
- 与えられた数値（距離・件数など）は書き換えず、正確に反映してください。${customInstructions ? `
【ユーザー指示】以下の指示を必ず守ってください（強調すべき情報として優先的に反映すること）:
${customInstructions}` : ''}`;

    const userPrompt = `以下の情報をもとに、上記の構造に従って親トリップ全体の総合情報ページを生成してください。

トリップ名: ${trip.name || '（無題）'}
${trip.description ? `説明: ${trip.description}` : ''}
子トリップ数: ${children.length}
子トリップ一覧:
${childList}
${totalKm > 0 ? `総移動距離: 約${Math.round(totalKm)}km` : ''}
訪問地点数（写真ベース）: 約${totalPhotos}件
ランドマーク数: ${totalLandmarks}
スタンプ数: ${stamps.length}
旅行記がある子トリップ数: ${childrenWithTravelogue.length}
生成されたアニメ画像数: ${animes.length}
動画数: ${videoUrls.length}`;

    setStatus('旅行記を生成中...');
    let finalHtml = await callTravelogueTextAI(systemPrompt, userPrompt, cfg, 90000);

    // 地図表示の直後、子トリップ一覧の前に、親トリップのアニメ画像とブログリンクを追加
    // （AIの自然文生成では位置・データの正確な反映が不安定なため、コード側で機械的に組み立てる）
    finalHtml += buildParentAnimeSectionHtml(trip);
    finalHtml += buildBlogSectionHtml(trip, children);

    // 子トリップへのアクセスカードを末尾に追加（傘下の各情報へすぐアクセスできるように）
    finalHtml += buildChildAccessSectionHtml(children);

    if (!trip.id || !currentTrip || currentTrip.id !== trip.id) {
      throw new Error('トリップIDが一致しません。旅行記生成中に別のトリップが選択された可能性があります。');
    }

    try {
      const travelogueUrl = await uploadTravelogueToStorage(trip.id, finalHtml);
      currentTrip.travelogueUrl = travelogueUrl;
      currentTrip.travelogueHtml = null;
      currentTrip.travelogueGeneratedAt = Date.now();
      if (!currentTrip.travelogueHistory) currentTrip.travelogueHistory = [];
      currentTrip.travelogueHistory.push({ url: travelogueUrl, timestamp: Date.now() });
    } catch (err) {
      console.error('旅行記のStorage保存エラー:', err);
      if (finalHtml.length < 500000) {
        currentTrip.travelogueHtml = finalHtml;
        currentTrip.travelogueUrl = null;
        currentTrip.travelogueGeneratedAt = Date.now();
        if (!currentTrip.travelogueHistory) currentTrip.travelogueHistory = [];
        currentTrip.travelogueHistory.push({ html: finalHtml, timestamp: Date.now() });
      } else {
        throw new Error('旅行記のサイズが大きすぎてStorageにも保存できませんでした: ' + err.message);
      }
    }

    await saveTrip();
    updateCoverPreview();
    updateTravelogueActionButtons();
    updateTravelogueHistoryLinks();
    updateViewerSection();
    setStatus('総合情報ページを作成しました');
    showTravelogueModal();
  } catch (err) {
    console.error('親トリップ旅行記生成エラー:', err);
    alert('総合情報ページの生成に失敗しました: ' + (err.message || String(err)));
    setStatus('旅行記生成に失敗しました');
  } finally {
    if (btn) btn.textContent = originalBtnText;
  }
}

async function initTravelogueMap(trip) {
  const wrap = document.getElementById('travelogueMap');
  if (!wrap || !window.L) return;
  if (travelogueMap) {
    travelogueMap.remove();
    travelogueMap = null;
  }

  // 親トリップは自身のGPX・写真を持たないため、全子トリップのルート・写真を集約して
  // 1枚の地図に表示する（マップInk/generateEinkMapDataUrlと同じ集約方針）。
  const sourceTrips = trip.isParent ? getChildTrips(trip.id) : [trip];
  if (sourceTrips.length === 0) return;

  const perTripPts = await Promise.all(sourceTrips.map(async (t) => {
    const tPts = [];
    try {
      const gpxText = await getGpxContent(t);
      if (gpxText) tPts.push(...parseGpxPoints(gpxText));
    } catch (_) {}
    if (tPts.length <= 1 && (t.photos || []).length > 0) {
      const photoPts = (t.photos || [])
        .map(p => ensureLatLng(p.lat, p.lng))
        .filter(Boolean)
        .map(c => [c.lat, c.lng]);
      if (photoPts.length > 0) tPts.push(...photoPts);
    }
    return tPts;
  }));

  const firstPoint = perTripPts.flat()[0] || null;
  if (!firstPoint) return;
  wrap.style.display = '';
  travelogueMap = L.map('travelogueMap').setView([firstPoint[0], firstPoint[1]], 10);

  // メインマップと同じレイヤーを使用（高解像度対応）
  if (currentMapLayer === 'satellite') {
    // 衛星画像 + ラベルレイヤー
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
      detectRetina: true,
      className: 'map-tiles-crisp'
    }).addTo(travelogueMap);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap, © CartoDB',
      maxZoom: 19,
      detectRetina: true,
      subdomains: 'abcd',
      pane: 'overlayPane'
    }).addTo(travelogueMap);
  } else if (currentMapLayer === 'terrain') {
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap, © OpenTopoMap',
      maxZoom: 17,
      detectRetina: true,
      className: 'map-tiles-crisp'
    }).addTo(travelogueMap);
  } else {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
      detectRetina: true,
      className: 'map-tiles-crisp'
    }).addTo(travelogueMap);
  }

  // トリップごと（親トリップなら子トリップごと）に、ルート線とマーカーを描画する。
  // 色はメインの地図・マップInkと同じくtrip.color（未設定ならTRIP_COLORSの順送り）を使う。
  const allPoints = [];
  sourceTrips.forEach((t, tripIdx) => {
    const tPts = perTripPts[tripIdx];
    const color = t.color || trip.color || TRIP_COLORS[tripIdx % TRIP_COLORS.length];

    // GPSルートを表示（トリップごとに独立した線として描画し、トリップ間を線でつながない）
    if (tPts.length > 1) {
      L.polyline(tPts, { color, weight: 3, opacity: 0.7 }).addTo(travelogueMap);
    }
    allPoints.push(...tPts);

    // 写真ポイントをマーカーで表示
    const photos = t.photos || [];
    photos.forEach((p, i) => {
      const coord = ensureLatLng(p.lat, p.lng);
      if (coord) {
        allPoints.push([coord.lat, coord.lng]);

        const isLandmark = !!(p.landmarkNo);
        const isStamp = !!(p.isStamp);
        let markerHtml;

        if (isStamp) {
          // スタンプは番号のみの丸（写真を表示しない）
          const no = String(p.landmarkNo || '?').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          markerHtml = `<div style="background:${color};width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:13px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)">${no}</div>`;
        } else if (isLandmark && p.url) {
          // ランドマーク（スタンプでない）は小さい写真で表示
          const no = String(p.landmarkNo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          markerHtml = `
            <div style="position:relative;width:40px;height:40px;">
              <img src="${getPhotoThumbUrl(p)}" decoding="async" style="width:40px;height:40px;border-radius:4px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);object-fit:cover;display:block;" />
              <span style="position:absolute;top:-2px;left:-2px;background:${color};color:#fff;font-weight:bold;font-size:10px;padding:2px 4px;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,0.4);">${no}</span>
            </div>
          `;
        } else if (isLandmark) {
          // ランドマーク（写真なし）
          const no = String(p.landmarkNo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          markerHtml = `<div style="background:${color};width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:13px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)">${no}</div>`;
        } else {
          // 通常のポイント
          markerHtml = `<span style="background:${color};border:2px solid #fff;width:10px;height:10px;border-radius:50%;display:block;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></span>`;
        }

        const showsSmallPhoto = isLandmark && !isStamp && p.url;
        const marker = L.marker([coord.lat, coord.lng], {
          icon: L.divIcon({
            className: 'travelogue-map-marker',
            html: markerHtml,
            iconSize: showsSmallPhoto ? [40, 40] : ((isLandmark || isStamp) ? [28, 28] : [10, 10]),
            iconAnchor: showsSmallPhoto ? [20, 40] : ((isLandmark || isStamp) ? [14, 14] : [5, 5])
          })
        });

        // ツールチップ表示（親トリップ集約時は由来トリップ名も添える）
        const tooltipParts = [];
        if (trip.isParent && t.name) tooltipParts.push(t.name);
        if (p.landmarkNo) tooltipParts.push('📍 ' + p.landmarkNo);
        if (p.name) tooltipParts.push(p.name);
        if (p.description) tooltipParts.push(p.description);
        const tooltipLabel = tooltipParts.length ? tooltipParts.join(' — ') : `#${i + 1}`;
        marker.bindTooltip(tooltipLabel, { direction: 'top', offset: [0, -10] });

        marker.addTo(travelogueMap);
      }
    });
  });

  // 全てのポイント（GPSルート + 写真ポイント、全トリップ分）が収まるように表示
  if (allPoints.length > 0) {
    const bounds = L.latLngBounds(allPoints);
    travelogueMap.fitBounds(bounds, { padding: [40, 40] });
  }
}

async function showTravelogueModal(trip) {
  const modal = document.getElementById('travelogueModal');
  const content = document.getElementById('travelogueContent');
  const mapWrap = document.getElementById('travelogueMap');
  const modalTitle = document.querySelector('#travelogueModal .modal-blog-title');
  if (!modal || !content) return;

  const t = trip || currentTrip;
  if (!t) return;

  // 親トリップの場合、自身の総合情報ページ（旅行記生成済みなら）を表示する。
  // まだ生成していない場合のみ、従来通り子トリップの旅行記ピッカーを表示する。
  if (t.isParent && !tripHasTravelogue(t)) {
    const children = getChildTrips(t.id);
    const childrenWithTravelogue = children.filter(c =>
      tripHasTravelogue(c)
    );

    if (childrenWithTravelogue.length === 0) {
      content.innerHTML = '<p class="travelogue-empty">子トリップに旅行記がありません。</p>';
      if (mapWrap) mapWrap.style.display = 'none';
      if (modalTitle) {
        const tripName = t?.name || '';
        modalTitle.textContent = tripName ? `${tripName} - 旅行記` : '旅行記';
      }
      modal.classList.add('open');
      return;
    }

    // 子トリップの旅行記リストを表示
    if (modalTitle) {
      const tripName = t?.name || '';
      modalTitle.textContent = tripName ? `${tripName} - 旅行記` : '旅行記';
    }
    if (mapWrap) mapWrap.style.display = 'none';

    let listHtml = '<div style="padding:2rem;">';
    listHtml += `<h3 style="margin-bottom:1.5rem;color:${t.color || '#e1306c'};font-size:1.5rem;font-weight:700;">旅行記を選択</h3>`;
    listHtml += '<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(150px, 1fr));gap:1rem;">';

    childrenWithTravelogue.forEach(c => {
      const childName = escapeHtml(c.name || '（無題）');
      const childColor = c.color || t.color || '#e1306c';
      const hasVideo = getTripVideoUrlsForTrip(c).length > 0;
      const coverUrl = (c.photos || []).find(p => p.url)?.url || '';
      listHtml += `<div class="travelogue-tile" style="position:relative;">`;
      listHtml += `<button type="button" class="child-travelogue-btn" data-trip-id="${c.id}" style="
        width:100%;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:flex-end;
        gap:0.4rem;
        aspect-ratio:1/1;
        padding:0.75rem 0.6rem;
        background:${coverUrl ? `#eee url('${escapeHtml(coverUrl)}') center/cover no-repeat` : 'rgba(255,255,255,0.95)'};
        color:${coverUrl ? '#fff' : childColor};
        border:2px solid ${childColor};
        border-radius:12px;
        font-size:0.85rem;
        font-weight:700;
        line-height:1.3;
        cursor:pointer;
        box-shadow:0 2px 8px rgba(0,0,0,0.1);
        transition:transform 0.15s;
        text-align:center;
      ">
        ${coverUrl ? `<span style="position:absolute;inset:0;border-radius:10px;background:linear-gradient(to top,rgba(0,0,0,0.75) 0%,rgba(0,0,0,0.15) 55%,transparent 100%);"></span>` : ''}
        <span style="position:relative;font-size:1.4rem;${coverUrl ? 'filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6));' : ''}">📖</span>
        <span style="position:relative;${coverUrl ? 'text-shadow:0 1px 3px rgba(0,0,0,0.7);' : ''}">${childName}</span>
      </button>`;
      if (hasVideo) {
        listHtml += `<button type="button" class="child-video-btn" data-trip-id="${c.id}" style="
          position:absolute;
          top:6px;
          right:6px;
          width:30px;
          height:30px;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:0;
          background:rgba(255,255,255,0.95);
          color:#405de6;
          border:2px solid #405de6;
          border-radius:50%;
          font-size:0.95rem;
          cursor:pointer;
          box-shadow:0 2px 6px rgba(0,0,0,0.25);
          transition:transform 0.15s;
        " title="動画を再生">🎬</button>`;
      }
      listHtml += '</div>';
    });

    listHtml += '</div></div>';
    content.innerHTML = listHtml;

    // 子トリップボタンにクリックイベントを追加
    content.querySelectorAll('.child-travelogue-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const childId = btn.dataset.tripId;
        const childTrip = children.find(c => c.id === childId);
        if (childTrip) {
          await showTravelogueModal(childTrip);
        }
      });
      btn.addEventListener('mouseenter', (e) => {
        e.target.style.transform = 'translateY(-2px)';
        e.target.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
      });
      btn.addEventListener('mouseleave', (e) => {
        e.target.style.transform = 'translateY(0)';
        e.target.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
      });
    });
    content.querySelectorAll('.child-video-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const childId = btn.dataset.tripId;
        const childTrip = children.find(c => c.id === childId);
        if (childTrip) playVideoSequence(getTripVideoUrlsForTrip(childTrip));
      });
      btn.addEventListener('mouseenter', (e) => {
        e.target.style.transform = 'translateY(-2px)';
        e.target.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
      });
      btn.addEventListener('mouseleave', (e) => {
        e.target.style.transform = 'translateY(0)';
        e.target.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
      });
    });

    modal.classList.add('open');
    return;
  }

  let html = t.travelogueHtml;
  let travelogueUrl = t.travelogueUrl;

  // 履歴があれば直近（最新タイムスタンプ）の旅行記を優先表示（3/21 21:22 のような直近生成を参照）
  if (t.travelogueHistory?.length > 0) {
    const latest = getLatestTravelogueEntry(t);
    if (latest?.url) {
      travelogueUrl = latest.url;
      html = null; // URL から取得するためクリア
    } else if (latest?.html) {
      html = latest.html;
      travelogueUrl = null;
    }
  }

  // travelogueUrlがある場合はStorageから取得
  if (!html && travelogueUrl) {
    try {
      const response = await fetch(travelogueUrl);
      html = await response.text();
    } catch (err) {
      console.error('旅行記の取得エラー:', err);
      content.innerHTML = '<p class="travelogue-empty">旅行記の読み込みに失敗しました。</p>';
      if (mapWrap) mapWrap.style.display = 'none';
      if (modalTitle) {
        const tripName = t?.name || '';
        modalTitle.textContent = tripName ? `${tripName} - 旅行記` : '旅行記';
      }
      modal.classList.add('open');
      return;
    }
  }

  if (html) {
    // モーダルタイトルを旅行記のタイトルに設定
    const titleMatch = html.match(/<h2[^>]*class="travelogue-title"[^>]*>(.*?)<\/h2>/i);
    if (titleMatch && modalTitle) {
      modalTitle.textContent = titleMatch[1].replace(/<[^>]+>/g, ''); // HTMLタグを除去
    } else if (modalTitle) {
      const tripName = t?.name || '';
      modalTitle.textContent = tripName ? `${tripName} - 旅行記` : '旅行記';
    }

    // HTMLを挿入（古い旅行記との互換性のため、古い表記を変換）
    let processedHtml = html.replace(/詳しい情報/g, '知っ得情報');

    // travelogue-map-containerが無い古い旅行記の場合のみ、サマリー後に地図プレースホルダーを挿入
    if (!processedHtml.includes('id="travelogue-map-container"')) {
      const summaryEnd = processedHtml.indexOf('</div>', processedHtml.indexOf('class="travelogue-summary"'));
      if (summaryEnd !== -1) {
        const insertPos = summaryEnd + '</div>'.length;
        const mapPlaceholder = '\n<div id="travelogueMapPlaceholder"></div>\n';
        processedHtml = processedHtml.slice(0, insertPos) + mapPlaceholder + processedHtml.slice(insertPos);
      }
    }

    content.innerHTML = processedHtml;

    // 地図・TOC のレイアウト制御（デスクトップ: 横並び / モバイル: アコーディオン）
    const tocDetails = content.querySelector('.travelogue-toc-details');
    const mapCont = content.querySelector('#travelogue-map-container');

    if (!isMobileView()) {
      // ── デスクトップ: 地図(左) と TOC(右) を横並び ──
      if (mapCont && tocDetails) {
        const row = document.createElement('div');
        row.className = 'travelogue-map-toc-row';

        const mapCol = document.createElement('div');
        mapCol.className = 'travelogue-map-col';

        const tocCol = document.createElement('div');
        tocCol.className = 'travelogue-toc-col';

        // <details> を外して TOC コンテンツだけ tocCol に移す
        const tocTitle = document.createElement('div');
        tocTitle.className = 'travelogue-toc-title';
        tocTitle.textContent = '📋 目次';
        const tocNav = tocDetails.querySelector('.travelogue-toc-nav');
        tocCol.appendChild(tocTitle);
        if (tocNav) tocCol.appendChild(tocNav);
        tocDetails.remove();

        mapCont.parentNode.insertBefore(row, mapCont);
        mapCol.appendChild(mapCont);
        row.appendChild(mapCol);
        row.appendChild(tocCol);
      } else if (tocDetails) {
        // 地図なし: TOC を常時展開
        tocDetails.open = true;
      }
    } else {
      // ── モバイル: 地図を <details> でラップ（デフォルト閉じ） ──
      // TOC は生成時に既に <details> でラップ済み（閉じた状態がデフォルト）
      if (mapCont) {
        const mapDetailsEl = document.createElement('details');
        mapDetailsEl.className = 'travelogue-map-details';
        mapDetailsEl.id = 'travelogue-map-details';
        const mapSummaryEl = document.createElement('summary');
        mapSummaryEl.className = 'travelogue-map-summary';
        mapSummaryEl.textContent = '🗺️ ルート地図';
        mapDetailsEl.appendChild(mapSummaryEl);
        mapCont.parentNode.insertBefore(mapDetailsEl, mapCont);
        mapDetailsEl.appendChild(mapCont);
        // open なし → 閉じた状態
      }
    }

    // サマリー下に非表紙アニメ（detail系）を表示順に小さく並べる
    // AI生成HTML内の既存アニメ行を除去（重複防止）
    content.querySelectorAll('.travelogue-detail-animes').forEach(el => el.remove());
    const allAnimes = t.generatedAnimes || [];
    const detailAnimesToShow = allAnimes.filter(a => String(a.style || '').startsWith('detail'));
    if (detailAnimesToShow.length > 0) {
      const summaryEl = content.querySelector('.travelogue-summary');
      if (summaryEl) {
        const animesRow = document.createElement('div');
        animesRow.className = 'travelogue-detail-animes-strip';
        detailAnimesToShow.forEach(anime => {
          const img = document.createElement('img');
          img.src = anime.url;
          img.alt = '';
          img.loading = 'lazy';
          img.title = 'クリックで全アニメを表示';
          img.dataset.isAnime = 'true';
          img.onclick = () => showAnimeImageViewer(allAnimes, t.name);
          animesRow.appendChild(img);
        });
        summaryEl.insertAdjacentElement('afterend', animesRow);
      }
    }

    // 詳細アニメの後に出来事アニメ（event-story）を「出来事、出会い」セクションとして表示
    content.querySelectorAll('.travelogue-event-stories').forEach(el => el.remove());
    const eventAnimes = allAnimes.filter(a => a.style === 'event-story');
    if (eventAnimes.length > 0) {
      // 詳細アニメの後、または詳細アニメがなければサマリーの後に挿入
      const detailAnimesStrip = content.querySelector('.travelogue-detail-animes-strip');
      const insertAfter = detailAnimesStrip || content.querySelector('.travelogue-summary');
      if (insertAfter) {
        const eventSection = document.createElement('div');
        eventSection.className = 'travelogue-event-stories';
        eventSection.style.cssText = 'margin:2rem 0;padding:1.5rem;background:rgba(255,250,240,0.5);border-radius:12px;border-left:4px solid #ff9a9e;';

        const eventTitle = document.createElement('h3');
        eventTitle.textContent = '✨ 出来事、出会い';
        eventTitle.style.cssText = 'font-size:1.3rem;color:#ff6b81;margin-bottom:1rem;font-weight:600;';
        eventSection.appendChild(eventTitle);

        eventAnimes.forEach(anime => {
          const eventItem = document.createElement('div');
          eventItem.className = 'travelogue-event-item';

          const img = document.createElement('img');
          img.src = anime.url;
          img.alt = '出来事のアニメ';
          img.loading = 'lazy';
          img.title = 'クリックで拡大表示';
          img.dataset.isAnime = 'true';
          img.className = 'travelogue-event-anime';
          img.onclick = () => showAnimeImageViewer(allAnimes, t.name);
          eventItem.appendChild(img);

          if (anime.eventText) {
            const eventText = document.createElement('p');
            eventText.textContent = anime.eventText;
            eventText.className = 'travelogue-event-text';
            eventItem.appendChild(eventText);
          }

          eventSection.appendChild(eventItem);
        });

        insertAfter.insertAdjacentElement('afterend', eventSection);
      }
    }

    // 旅行記内のナビゲーションリンクにイベントを追加
    content.querySelectorAll('.travelogue-nav-prev, .travelogue-nav-next').forEach((link) => {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tripId = link.dataset.tripId;
        if (tripId) {
          await loadTripById(tripId);
          showTravelogueModal(currentTrip);
        }
      });
    });

    // 親トリップの総合情報ページ内、子トリップアクセスカードの「📖 旅行記」リンク
    content.querySelectorAll('.travelogue-child-link').forEach((link) => {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tripId = link.dataset.tripId;
        if (tripId) {
          await loadTripById(tripId);
          showTravelogueModal(currentTrip);
        }
      });
    });

    // 親トリップの総合情報ページ内、子トリップアクセスカードのサムネイル画像（クリックで子トリップの旅行記へ）
    content.querySelectorAll('.travelogue-child-thumb-link').forEach((thumb) => {
      thumb.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tripId = thumb.dataset.tripId;
        if (tripId) {
          await loadTripById(tripId);
          showTravelogueModal(currentTrip);
        }
      });
    });

    // 旅行記内の写真・アニメ画像をクリックで拡大表示
    // （子トリップアクセスカードのサムネイルは上記で個別ハンドラ済みのため除外）
    content.querySelectorAll('img:not(.travelogue-child-thumb-link)').forEach((img) => {
      img.style.cursor = 'pointer';
      if (!img.dataset.isAnime) img.title = 'クリックで拡大表示';
      img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // アニメ画像は onclick で処理済み（全アニメビューアーを開く）
        if (img.dataset.isAnime) return;
        if (img.src) showImagePopup(img.src);
      });
    });

    // 旅行記の最後にスタンプ一覧を追加（スタンプボタンと同様の形式・スタンプチェック付き写真）
    // 既存のスタンプ一覧を削除してから最新のものを追加
    const existingStampSection = content.querySelector('.travelogue-stamp-section');
    if (existingStampSection) {
      existingStampSection.remove();
    }
    const stampPhotos = getStampListForTrip(t);
    if (stampPhotos.length > 0) {
      const stampSection = document.createElement('div');
      stampSection.className = 'travelogue-stamp-section';
      stampSection.innerHTML = `
        <div style="border-top:3px solid #d4c5a9;margin-top:4rem;padding-top:2rem;">
          <h3 style="text-align:center;color:#c1272d;font-size:1.8rem;margin-bottom:0.5rem;font-weight:700;letter-spacing:0.1em;">🎫 スタンプ一覧</h3>
          <p style="text-align:center;color:#8b7355;font-size:0.9rem;margin-bottom:2rem;">訪れたスタンプスポット</p>
          <div class="stamp-rally-grid" style="background:linear-gradient(135deg,#f9f5e8 0%,#f5f0e0 50%,#f0ead8 100%);border-radius:12px;padding:2rem;box-shadow:inset 0 2px 8px rgba(193,39,45,0.08);">${stampPhotos.map((p, i) => {
            const stamped = !!(p.url && p.url.trim());
            const landmarkNo = escapeHtml(p.landmarkNo || '');
            const pointName = escapeHtml(p.name || '');
            const imgHtml = stamped
              ? `<img src="${escapeHtml(getPhotoThumbUrl(p))}" alt="${pointName}" class="stamp-card-img" loading="lazy" decoding="async">`
              : '<div class="stamp-card-empty">?</div>';
            return `<div class="stamp-card ${stamped ? 'stamp-card-stamped' : ''}" data-trip-id="${escapeHtml(p._tripId)}" data-photo-index="${p._photoIndex}">
              <div class="stamp-card-inner">
                ${imgHtml}
                <div class="stamp-card-info-overlay">
                  ${landmarkNo ? `<span class="stamp-card-no">${landmarkNo}</span>` : ''}
                  ${pointName ? `<span class="stamp-card-name">${pointName}</span>` : ''}
                </div>
              </div>
              <span class="stamp-card-badge">${stamped ? `✓${p.description ? ' ' + escapeHtml(p.description) : ''}` : '未スタンプ'}</span>
            </div>`;
          }).join('')}</div>
          <p style="text-align:center;color:#8b7355;font-size:0.85rem;margin-top:1.5rem;font-style:italic;">訪れた全てのスポットを記録しました ✨</p>
        </div>`;
      content.appendChild(stampSection);
      stampSection.querySelectorAll('.stamp-card').forEach((card) => {
        const tripId = card.dataset.tripId;
        const photoIdx = parseInt(card.dataset.photoIndex, 10);
        card.onclick = async () => {
          if (currentTrip?.id !== tripId) await loadTripById(tripId);
          closeTravelogueModal();
          showPhotoAtIndex(photoIdx);
        };
        card.querySelectorAll('img').forEach((img) => {
          img.style.cursor = 'pointer';
          img.title = 'クリックで拡大表示';
          img.addEventListener('click', (e) => {
            e.stopPropagation();
            if (img.src) showImagePopup(img.src);
          });
        });
      });
    }

    // 親トリップは自身のphotos/GPXを持たないため、子トリップにマップ材料があるかで判定する
    const hasMapData = t?.isParent
      ? getChildTrips(t.id).some(c => (c.photos?.length || c.gpxData || c.gpxDataUrl))
      : !!(t?.photos?.length || t?.gpxData || t?.gpxDataUrl);
    if (t && hasMapData) {
      // 新しいtravelogue-map-containerがある場合はそれを使用
      const mapContainer = document.getElementById('travelogue-map-container');
      if (mapContainer) {
        // 新しい形式：mapContainerの中に地図を表示
        if (mapWrap) {
          mapWrap.style.display = 'block';
          mapContainer.appendChild(mapWrap);
        }
        const mapDetailsEl = document.getElementById('travelogue-map-details');
        if (isMobileView() && mapDetailsEl && !mapDetailsEl.open) {
          // モバイル: details が開かれた時に初期化（遅延）
          mapDetailsEl.addEventListener('toggle', function onMapToggle() {
            if (mapDetailsEl.open) {
              mapDetailsEl.removeEventListener('toggle', onMapToggle);
              setTimeout(() => initTravelogueMap(t), 100);
            }
          });
        } else {
          setTimeout(() => initTravelogueMap(t), 100);
        }
      } else {
        // 古い形式：プレースホルダーを使用
        if (mapWrap) {
          mapWrap.style.display = 'block';
          const placeholder = document.getElementById('travelogueMapPlaceholder');
          if (placeholder && placeholder.parentNode) {
            placeholder.parentNode.insertBefore(mapWrap, placeholder);
            placeholder.remove();
          }
        }
        setTimeout(() => initTravelogueMap(t), 100);
      }
    } else if (mapWrap) {
      mapWrap.style.display = 'none';
    }
  } else {
    content.innerHTML = '<p class="travelogue-empty">旅行記がありません。AI旅行記生成で作成してください。</p>';
    if (mapWrap) mapWrap.style.display = 'none';
  }

  // 前後のトリップ旅行記へのナビゲーション
  const tripsWithTravelogue = getOrderedTrips().filter(trip => {
    const hasTravelogue = tripHasTravelogue(trip);
    return hasTravelogue;
  });

  const currentIndex = tripsWithTravelogue.findIndex(trip => trip.id === t.id);
  const prevBtn = document.getElementById('traveloguePrevBtn');
  const nextBtn = document.getElementById('travelogueNextBtn');

  if (prevBtn && nextBtn) {
    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex >= 0 && currentIndex < tripsWithTravelogue.length - 1;

    prevBtn.style.display = hasPrev ? '' : 'none';
    nextBtn.style.display = hasNext ? '' : 'none';

    if (hasPrev) {
      const prevTrip = tripsWithTravelogue[currentIndex - 1];
      prevBtn.onclick = async () => {
        await loadTripById(prevTrip.id);
        showTravelogueModal(prevTrip);
      };
      prevBtn.title = `前のトリップ旅行記: ${prevTrip.name || '（無題）'}`;
    }

    if (hasNext) {
      const nextTrip = tripsWithTravelogue[currentIndex + 1];
      nextBtn.onclick = async () => {
        await loadTripById(nextTrip.id);
        showTravelogueModal(nextTrip);
      };
      nextBtn.title = `次のトリップ旅行記: ${nextTrip.name || '（無題）'}`;
    }
  }

  // 共有ボタンを生成
  renderTravelogueShareButtons(t);

  modal.classList.add('open');
}

/** 旅行記の共有ボタンを生成 */
function renderTravelogueShareButtons(trip) {
  const shareButtonsWrap = document.getElementById('travelogueShareButtons');
  if (!shareButtonsWrap || !trip) return;

  // 親トリップの場合は共有ボタンを非表示
  if (trip.isParent) {
    shareButtonsWrap.style.display = 'none';
    return;
  }

  // 共有用のURL（現在のページURL + トリップ名 + 旅行記フラグ）
  const baseUrl = window.location.origin + window.location.pathname;
  const tripName = trip.name || '';
  const shareUrl = `${baseUrl}?trip=${encodeURIComponent(tripName)}&travelogue=true`;
  const shareText = `${tripName}の旅行記`;

  shareButtonsWrap.innerHTML = '';
  shareButtonsWrap.style.display = 'flex';

  // X (Twitter) ボタン
  const twitterBtn = document.createElement('a');
  twitterBtn.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
  twitterBtn.target = '_blank';
  twitterBtn.rel = 'noopener noreferrer';
  twitterBtn.className = 'travelogue-share-btn twitter';
  twitterBtn.innerHTML = '𝕏';
  twitterBtn.title = 'Xでシェア';
  shareButtonsWrap.appendChild(twitterBtn);

  // Instagram ボタン（Instagramは直接共有URLがないため、モバイル版のみ対応）
  const instagramBtn = document.createElement('button');
  instagramBtn.type = 'button';
  instagramBtn.className = 'travelogue-share-btn instagram';
  instagramBtn.innerHTML = '📷';
  instagramBtn.title = 'Instagram（URLをコピーしてアプリで共有）';
  instagramBtn.onclick = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      alert('URLをコピーしました。Instagramアプリで共有してください。');
    });
  };
  shareButtonsWrap.appendChild(instagramBtn);

  // Facebook ボタン
  const facebookBtn = document.createElement('a');
  facebookBtn.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
  facebookBtn.target = '_blank';
  facebookBtn.rel = 'noopener noreferrer';
  facebookBtn.className = 'travelogue-share-btn facebook';
  facebookBtn.innerHTML = 'f';
  facebookBtn.title = 'Facebookでシェア';
  shareButtonsWrap.appendChild(facebookBtn);

  // URLコピー ボタン
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'travelogue-share-btn copy-url';
  copyBtn.innerHTML = '🔗';
  copyBtn.title = 'URLをコピー';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = '✓';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.innerHTML = '🔗';
      }, 2000);
    } catch (err) {
      console.error('URLコピー失敗:', err);
      alert('URLのコピーに失敗しました');
    }
  };
  shareButtonsWrap.appendChild(copyBtn);
}

/** 画像を大きなポップアップで表示（旅行記内の写真・アニメクリック用） */
function showImagePopup(src) {
  if (!src) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.9);z-index:10001;display:flex;align-items:center;justify-content:center;cursor:pointer;';
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;object-fit:contain;pointer-events:none;';
  overlay.appendChild(img);
  const close = () => {
    document.body.removeChild(overlay);
    overlay.removeEventListener('click', close);
  };
  overlay.addEventListener('click', close);
  document.body.appendChild(overlay);
}

function closeTravelogueModal() {
  if (travelogueMap) {
    travelogueMap.remove();
    travelogueMap = null;
  }
  document.getElementById('travelogueModal')?.classList.remove('open');
}

/** モバイルタブを切り替え（地図⇔旅行記） */
async function switchMobileTab(tab, tripToShow) {
  // 新実装：タブ切り替えは廃止、旅行記はモーダルで表示
  const mobileTravelogueView = document.getElementById('mobileTravelogueView');

  if (tab === 'map') {
    // 地図タブ（モバイル専用ビューを非表示）
    if (mobileTravelogueView) mobileTravelogueView.style.display = 'none';
  } else if (tab === 'travelogue') {
    // 旅行記 → モーダルで表示
    const tripToDisplay = tripToShow || currentTrip;
    if (tripToDisplay) {
      await showTravelogueModal(tripToDisplay);
    }
  }

}

/** スタンプチェックがついた写真一覧を取得（スタンプボタン・旅行記で共通利用） */
function getStampListForTrip(trip) {
  if (!trip) return [];
  let allPhotos = [];
  if (trip.isParent) {
    const childTrips = getChildTrips(trip.id);
    childTrips.forEach(childTrip => {
      const childStamps = (childTrip.photos || []).filter(p => p.isStamp);
      childStamps.forEach(p => {
        allPhotos.push({
          ...p,
          _tripId: childTrip.id,
          _tripName: childTrip.name,
          _photoIndex: (childTrip.photos || []).indexOf(p)
        });
      });
    });
  } else {
    const stamps = (trip?.photos || []).filter(p => p.isStamp);
    stamps.forEach(p => {
      allPhotos.push({
        ...p,
        _tripId: trip.id,
        _tripName: trip.name,
        _photoIndex: (trip.photos || []).indexOf(p)
      });
    });
  }
  allPhotos.sort((a, b) => {
    const na = String(a.landmarkNo || '');
    const nb = String(b.landmarkNo || '');
    return na.localeCompare(nb, undefined, { numeric: true });
  });
  return allPhotos;
}

let stampRallyModalTrip = null; // E-Ink画像生成ボタンが対象にするトリップ（モーダルを開いた時点のもの）

function showStampRallyModal(trip) {
  stampRallyModalTrip = trip || currentTrip || null;
  const modal = document.getElementById('stampRallyModal');
  const titleEl = document.getElementById('stampRallyTitle');
  const countEl = document.getElementById('stampRallyCount');
  const content = document.getElementById('stampRallyContent');
  if (!modal || !content) return;

  const allPhotos = getStampListForTrip(trip);
  const tripName = trip?.name || '';

  renderStampRallyEinkList(allPhotos);

  if (allPhotos.length === 0) {
    if (titleEl) titleEl.textContent = tripName ? `${tripName} - スタンプ一覧` : 'スタンプ一覧';
    if (countEl) countEl.textContent = '';
    content.innerHTML = '<p class="stamp-rally-empty">スタンプがありません。写真のポップアップで「スタンプ」にチェックを入れてください。</p>';
  } else {
    const stampedCount = allPhotos.filter(p => p.url && p.url.trim()).length;
    const totalCount = allPhotos.length;
    if (titleEl) titleEl.textContent = tripName ? `${tripName} - スタンプ一覧` : 'スタンプ一覧';
    if (countEl) countEl.textContent = `スタンプ済み ${stampedCount} / ${totalCount}`;
    content.innerHTML = allPhotos.map((p, i) => {
      const stamped = !!(p.url && p.url.trim());
      const landmarkNo = escapeHtml(p.landmarkNo || '');
      const pointName = escapeHtml(p.name || '');
      const imgHtml = stamped
        ? `<img src="${escapeHtml(getPhotoThumbUrl(p))}" alt="${pointName}" class="stamp-card-img" loading="lazy" decoding="async">`
        : '<div class="stamp-card-empty">?</div>';
      return `<div class="stamp-card ${stamped ? 'stamp-card-stamped' : ''}" data-index="${i}" data-trip-id="${p._tripId}" data-photo-index="${p._photoIndex}">
        <div class="stamp-card-inner">
          ${imgHtml}
          <div class="stamp-card-info-overlay">
            ${landmarkNo ? `<span class="stamp-card-no">${landmarkNo}</span>` : ''}
            ${pointName ? `<span class="stamp-card-name">${pointName}</span>` : ''}
          </div>
        </div>
        <span class="stamp-card-badge">${stamped ? `✓${p.description ? ' ' + escapeHtml(p.description) : ''}` : '未スタンプ'}</span>
      </div>`;
    }).join('');
    content.querySelectorAll('.stamp-card').forEach((card) => {
      const tripId = card.dataset.tripId;
      const photoIdx = parseInt(card.dataset.photoIndex, 10);
      card.onclick = async () => {
        if (currentTrip?.id !== tripId) await loadTripById(tripId);
        showPhotoAtIndex(photoIdx);
        closeStampRallyModal();
      };
    });
  }
  modal.classList.add('open');
}

/** E-Inkボタンの右側に、生成済みの御朱印風画像を小さく一覧表示する。クリックでダウンロード */
function renderStampRallyEinkList(allPhotos) {
  const list = document.getElementById('stampRallyEinkList');
  if (!list) return;
  const generated = allPhotos.filter(p => p.generatedGoshuinUrl);
  if (generated.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = generated.map(p => {
    const pointName = escapeHtml(p.name || '');
    return `<img src="${escapeHtml(p.generatedGoshuinUrl)}" alt="${pointName}" class="stamp-rally-eink-thumb" data-url="${escapeHtml(p.generatedGoshuinUrl)}" data-point-name="${pointName}" title="クリックでダウンロード" loading="lazy" decoding="async">`;
  }).join('');
  list.querySelectorAll('.stamp-rally-eink-thumb').forEach((img) => {
    img.onclick = () => {
      showGoshuinLightbox(img.dataset.url, `${sanitizeFileNamePart(img.dataset.pointName || 'goshuin')}_goshuin.png`);
    };
  });
}

/** 生成済み御朱印画像をオリジナルサイズで表示し、ダウンロードできるライトボックスを開く */
function showGoshuinLightbox(url, filename) {
  if (!url) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.9);z-index:10001;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;cursor:pointer;';
  const img = document.createElement('img');
  img.src = url;
  img.alt = filename || '御朱印画像';
  img.style.cssText = 'max-width:92vw;max-height:78vh;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);cursor:default;';
  img.onclick = (e) => e.stopPropagation();
  const dlLink = document.createElement('a');
  dlLink.href = url;
  dlLink.download = filename || 'goshuin.png';
  dlLink.target = '_blank';
  dlLink.rel = 'noopener';
  dlLink.className = 'btn btn-primary btn-sm';
  dlLink.textContent = '⬇️ ダウンロード';
  dlLink.onclick = (e) => e.stopPropagation();
  overlay.appendChild(img);
  overlay.appendChild(dlLink);
  overlay.onclick = () => document.body.removeChild(overlay);
  document.body.appendChild(overlay);
}

function closeStampRallyModal() {
  document.getElementById('stampRallyModal')?.classList.remove('open');
}

/**
 * スタンプ一覧の全スタンプについて、1枚ずつ御朱印風画像（generateStampGoshuinImage
 * と同じくカラー・写真に忠実・QR＋ポイント名/説明キャプション付き）を生成し、
 * 各投稿の写真（photos[idx].generatedGoshuinUrl）とトリップの生成画像一覧の
 * 両方に保存する。
 * 親トリップの場合はスタンプが複数の子トリップにまたがるため、トリップIDごとに
 * まとめて処理し、currentTripのDOMフォームに依存するsaveTrip()は使わず
 * Firestoreへ直接部分更新する。
 */
async function generateAllStampGoshuinImages(trip, onProgress) {
  const stamps = getStampListForTrip(trip).filter(p => p.url && p.url.trim());
  if (stamps.length === 0) return { count: 0, results: [] };

  const byTripId = new Map();
  for (const p of stamps) {
    const arr = byTripId.get(p._tripId) || [];
    arr.push(p);
    byTripId.set(p._tripId, arr);
  }

  const results = [];
  let done = 0;
  const total = stamps.length;

  for (const [tripId, tripStamps] of byTripId) {
    const targetTrip = myTripsMap.get(tripId);
    if (!targetTrip) continue;
    let changed = false;
    for (const p of tripStamps) {
      const idx = p._photoIndex;
      const photo = targetTrip.photos?.[idx];
      if (!photo || !photo.url) continue;
      done++;
      if (onProgress) onProgress(done, total, photo.name || '');
      try {
        const { dataUrl } = await generateStampGoshuinImage(targetTrip, idx);
        const storageUrl = await uploadAnimeImageToStorage(targetTrip.id, dataUrl, `goshuin_${idx}`);
        photo.generatedGoshuinUrl = storageUrl;
        if (!targetTrip.generatedAnimes) targetTrip.generatedAnimes = [];
        targetTrip.generatedAnimes.push({
          url: storageUrl,
          timestamp: Date.now(),
          style: 'stamp-goshuin',
          name: photo.name || ''
        });
        results.push({ tripId: targetTrip.id, photoIndex: idx, url: storageUrl });
        changed = true;
      } catch (err) {
        console.error(`御朱印画像生成エラー（${photo.name || idx}）:`, err);
        results.push({ tripId: targetTrip.id, photoIndex: idx, error: err.message || String(err) });
      }
    }
    if (changed) {
      await window.firebaseDb.collection('trips').doc(targetTrip.id).set(
        sanitizeForFirestore({ photos: targetTrip.photos, generatedAnimes: targetTrip.generatedAnimes }),
        { merge: true }
      );
      invalidateOrderedTripsCache();
      if (targetTrip.id === currentTrip?.id) {
        renderGeneratedAnimesList();
      }
    }
  }
  return { count: results.filter(r => r.url).length, results };
}

/**
 * スタンプ一覧モーダルの「🖼️ E-Ink画像」ボタン用ハンドラ。
 * 全スタンプ1枚ずつの御朱印風画像をまとめて生成し、完了後に一覧を再描画する。
 */
async function handleStampRallyEinkGeneration() {
  const trip = stampRallyModalTrip || currentTrip;
  if (!trip) {
    alert('トリップを選択してください');
    return;
  }
  const stamps = getStampListForTrip(trip).filter(p => p.url && p.url.trim());
  if (stamps.length === 0) {
    alert('スタンプ（写真編集の「スタンプ」チェック）が設定された写真がありません。');
    return;
  }
  const btn = document.getElementById('stampRallyEinkBtn');
  const originalText = btn?.textContent;
  if (btn) btn.disabled = true;
  try {
    const { count, results } = await generateAllStampGoshuinImages(trip, (done, total, name) => {
      setStatus(`御朱印画像を生成中... (${done}/${total}) ${name}`);
      if (btn) btn.textContent = `生成中 ${done}/${total}`;
    });
    const errorCount = results.filter(r => r.error).length;
    setStatus(errorCount > 0
      ? `御朱印画像を${count}枚生成しました（${errorCount}枚失敗）`
      : `✓ 御朱印画像を${count}枚生成しました`);
    if (errorCount > 0) {
      console.warn('御朱印画像生成に失敗したスタンプ:', results.filter(r => r.error));
    }
    showStampRallyModal(trip); // 生成結果を反映して一覧を再描画
  } catch (err) {
    console.error('御朱印画像生成エラー:', err);
    alert('御朱印画像の生成に失敗しました: ' + (err.message || String(err)));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

const ANIME_COVER_PREFIX = 'Create a cover image that reflects and illustrates the following travelogue content. Use the travelogue as the main reference for the image. ';

const ANIME_STYLES = {
  'chikyu-cover': {
    label: '地球の歩き方表紙風',
    brand: '地球の歩き方',
    prompt: ANIME_COVER_PREFIX + 'Japanese travel guidebook cover style. Professional cover layout with bold trip title typography, scenic travel imagery, warm and inviting colors. IMPORTANT: Include a hand-drawn illustrated mini-map in the cover design showing the travel route with key waypoints marked — styled like a vintage travel guidebook map (soft watercolor or ink sketch style). No specific brand name or logo. Travelogue content: '
  },
  'travel-magazine': {
    label: '旅行雑誌の表紙風',
    brand: '旅行雑誌',
    prompt: ANIME_COVER_PREFIX + 'Professional travel magazine cover style. Elegant travel publication aesthetic, high-end magazine layout, aspirational travel imagery. Travelogue content: '
  },
  'detail4pages': {
    label: '詳細4ページ',
    brand: '地球の歩き方',
    prompt: ''
  },
  'event-story': {
    label: '出来事生成',
    brand: '旅の思い出',
    prompt: ''
  },
  'meisho-ukiyoe': {
    label: '名所浮世絵風',
    brand: '名所絵',
    prompt: ''
  },
  'infographic': {
    label: 'インフォグラフィック',
    brand: '',
    prompt: ''
  }
};

// E-Ink端末（電子ペーパー）向けカバー画像生成のプロンプト前置き。
// 写真的な諧調やグラデーションはE-Inkで潰れるため、白黒中心のシャープな線画を明示的に指示する。
const EINK_COVER_PROMPT = 'Create a sharp, high-contrast cover illustration optimized for E-Ink e-paper displays (like a Kindle or reMarkable). Use a near black-and-white palette (avoid soft gradients and subtle gray tones that disappear on E-Ink). Bold, crisp linework, flat shapes, strong contrast, minimalist composition with few large elements rather than fine detail. Large, bold, clearly legible typography for the title. No photographic realism, no blur, no soft shadows, no fine textures. ';

function openCreateImageModal() {
  document.getElementById('createImageModal')?.classList.add('open');
}

function closeCreateImageModal() {
  document.getElementById('createImageModal')?.classList.remove('open');
}

function showCreateImageResult(statusText, dataUrl, filename) {
  const previewWrap = document.getElementById('createImagePreviewWrap');
  const downloadLink = document.getElementById('createImageDownloadLink');
  const statusEl = document.getElementById('createImageStatus');
  if (statusEl) statusEl.textContent = statusText || '';
  if (previewWrap) {
    previewWrap.innerHTML = '';
    if (dataUrl) {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = filename || '生成画像';
      img.style.cssText = 'max-width:100%;max-height:50vh;border:1px solid var(--border);border-radius:4px;';
      previewWrap.appendChild(img);
    }
  }
  if (downloadLink) {
    if (dataUrl) {
      downloadLink.href = dataUrl;
      downloadLink.download = filename || 'image.png';
      downloadLink.style.display = '';
    } else {
      downloadLink.style.display = 'none';
      downloadLink.removeAttribute('href');
    }
  }
}

function sanitizeFileNamePart(name) {
  return (name || 'trip').replace(/[\\/:*?"<>|]/g, '_').trim() || 'trip';
}

// 陸地ポリゴンデータ（Natural Earth 110m land、パブリックドメイン）。
// 各要素は1つの陸地（島・大陸）を表す輪の配列＝[外輪, 穴1, 穴2, ...]、
// 各輪は[lat, lng]の配列。事前変換してassets/geo/に同梱し、実行時のネットワーク依存や
// タイル画像のCORS問題（canvasが汚染されダウンロードできなくなる）を避ける。
let landPolygonDataPromise = null;
async function loadLandPolygonData() {
  if (!landPolygonDataPromise) {
    landPolygonDataPromise = fetch('assets/geo/land-110m.json')
      .then(res => (res.ok ? res.json() : []))
      .catch(err => {
        console.warn('陸地データの取得に失敗（スキップ）:', err);
        return [];
      });
  }
  return landPolygonDataPromise;
}

/**
 * 単一トリップ分のGPXルート座標とランドマーク写真を取得する。
 * 親トリップのマップ生成では子トリップごとにこれを呼び出して集約する。
 */
async function getTripRouteAndLandmarks(trip) {
  const photos = trip.photos || [];
  const landmarkPhotos = photos
    .map(p => ({ photo: p, coord: ensureLatLng(p.lat, p.lng) }))
    .filter(x => x.coord && x.photo.landmarkNo != null && String(x.photo.landmarkNo).trim() !== '');

  let routeCoords = [];
  try {
    const gpxText = await getGpxContent(trip);
    if (gpxText) routeCoords = parseGpxPoints(gpxText).map(([lat, lng]) => ({ lat, lng }));
  } catch (_) {}
  if (routeCoords.length <= 1) {
    routeCoords = photos.map(p => ensureLatLng(p.lat, p.lng)).filter(Boolean);
  }
  return { routeCoords, landmarkPhotos };
}

/**
 * E-Ink端末向けの、ランドマーク番号を示すシンプルな地図画像をcanvasで直接描画する。
 * AI生成だと番号や位置が不正確になりがちなため、既存のlandmarkNo/GPSデータから
 * 決定論的に（AIを使わず）描画する。
 * 親トリップが選択された場合は、写真・GPSを持たない親トリップ自身の代わりに
 * 全ての子トリップ（getChildTrips）のランドマーク・ルートを集約して描画する。
 */
async function generateEinkMapDataUrl(trip, options = {}) {
  const monochrome = !!options.monochrome;
  const sourceTrips = trip.isParent ? getChildTrips(trip.id) : [trip];
  if (sourceTrips.length === 0) return null;

  const perTripData = await Promise.all(sourceTrips.map(t => getTripRouteAndLandmarks(t)));
  // トリップをまたいで線をつながないよう、ルートはトリップごとに独立したセグメントとして保持する。
  // トリップ名が「Plan」で始まる場合は計画段階の旅として点線で描くため、由来トリップも保持する。
  // 色はメインの地図と同じくtrip.color（未設定ならTRIP_COLORSの順送り）を使う。マップBWでは
  // 色分けせず全て黒にする。
  const tripColorOf = (i) => monochrome ? '#000000' : (sourceTrips[i].color || TRIP_COLORS[i % TRIP_COLORS.length]);
  const routeSegments = perTripData
    .map((d, i) => ({ coords: d.routeCoords, isPlan: isPlanTrip(sourceTrips[i]), color: tripColorOf(i) }))
    .filter(seg => seg.coords.length > 0);
  const landmarkPhotos = perTripData.flatMap((d, i) =>
    d.landmarkPhotos.map(lp => ({ ...lp, color: tripColorOf(i) }))
  );

  if (landmarkPhotos.length === 0 && routeSegments.length === 0) return null;

  // 番号の昇順に並べる（番号は既存のスタンプラリー機能のlandmarkNoをそのまま使う）。
  // 件数はタイトル下のサブタイトルに使うため、描画より前に確定させておく。
  const sortedLandmarks = [...landmarkPhotos].sort((a, b) => {
    const na = parseFloat(a.photo.landmarkNo), nb = parseFloat(b.photo.landmarkNo);
    if (Number.isNaN(na) || Number.isNaN(nb)) return 0;
    return na - nb;
  });

  const allCoords = [...routeSegments.flatMap(seg => seg.coords), ...landmarkPhotos.map(x => x.coord)];
  // GPXトラックは数千点になり得るため、スプレッド演算子でMath.min/maxに渡すと
  // 呼び出しスタック上限を超える（Maximum call stack size exceeded）。reduceで集計する。
  const minMaxOf = (values) => values.reduce(
    (acc, v) => ({ min: Math.min(acc.min, v), max: Math.max(acc.max, v) }),
    { min: Infinity, max: -Infinity }
  );
  const latRange = minMaxOf(allCoords.map(c => c.lat));
  const lngRange = minMaxOf(allCoords.map(c => c.lng));
  // 緯度によって経度1度あたりの距離が変わるため、平均緯度でcos補正して形の歪みを抑える
  const avgLatRad = ((latRange.min + latRange.max) / 2) * Math.PI / 180;
  const cosLat = Math.max(0.15, Math.cos(avgLatRad));
  const project = (lat, lng) => ({ x: lng * cosLat, y: lat });

  const projected = allCoords.map(c => project(c.lat, c.lng));
  const xRange = minMaxOf(projected.map(p => p.x));
  const yRange = minMaxOf(projected.map(p => p.y));
  const minX = xRange.min, maxX = xRange.max;
  const minY = yRange.min, maxY = yRange.max;
  // 単一地点や直線的なルートで幅/高さが0になるのを防ぐ
  const spanX = Math.max(maxX - minX, 0.0005);
  const spanY = Math.max(maxY - minY, 0.0005);

  // フッターの文言は廃止したため、下マージンはボーダーの余白分だけで良い
  const TOP_MARGIN = 130, BOTTOM_MARGIN = 40, SIDE_MARGIN = 70, MAX_SIDE = 1300;
  const aspect = spanX / spanY;
  let drawWidth, drawHeight;
  if (aspect >= 1) {
    drawWidth = MAX_SIDE;
    drawHeight = Math.max(500, Math.round(MAX_SIDE / aspect));
  } else {
    drawHeight = MAX_SIDE;
    drawWidth = Math.max(500, Math.round(MAX_SIDE * aspect));
  }
  const canvasW = drawWidth + SIDE_MARGIN * 2;
  const canvasH = drawHeight + TOP_MARGIN + BOTTOM_MARGIN;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // E-Inkは白地に黒がもっともくっきり表示されるため、白背景+黒線のみで構成する
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvasW - 4, canvasH - 4);

  const toCanvas = (lat, lng) => {
    const p = project(lat, lng);
    const nx = (p.x - minX) / spanX;
    const ny = (p.y - minY) / spanY;
    return {
      x: SIDE_MARGIN + nx * drawWidth,
      y: TOP_MARGIN + (1 - ny) * drawHeight
    };
  };

  // 海・陸地を背景として描画。トリップ範囲より少し広めの範囲を対象にする。
  // マップBW（白黒）: 海・湖を黒で塗りつぶし、陸地を白抜きにする（くっきりした地図らしい見た目に）。
  // マップInk（カラー）: 塗りつぶさず、陸地の輪郭を太めの線で描くだけにとどめる
  //   （ルート・ランドマークの配色を主役にするため）。
  // 110m解像度は都市規模のズームには粗すぎて誤った形になるため、塗りつぶしは
  // トリップの地理的な範囲が一定以上広い場合のみ行う。
  const SEA_FILL_MIN_SPAN_DEG = 1.0;
  const geoSpanDeg = Math.max(latRange.max - latRange.min, lngRange.max - lngRange.min);
  const fillSea = monochrome && geoSpanDeg >= SEA_FILL_MIN_SPAN_DEG;
  try {
    const landPolygons = await loadLandPolygonData();
    if (landPolygons.length > 0) {
      const latPad = Math.max((latRange.max - latRange.min) * 0.3, 0.05);
      const lngPad = Math.max((lngRange.max - lngRange.min) * 0.3, 0.05);
      const boxLatMin = latRange.min - latPad, boxLatMax = latRange.max + latPad;
      const boxLngMin = lngRange.min - lngPad, boxLngMax = lngRange.max + lngPad;

      ctx.save();
      ctx.beginPath();
      ctx.rect(SIDE_MARGIN, TOP_MARGIN, drawWidth, drawHeight);
      ctx.clip();

      if (fillSea) {
        // まず描画エリア全体を「海」として黒で塗ってから、陸地ポリゴンを白で塗り重ねる
        ctx.fillStyle = '#000000';
        ctx.fillRect(SIDE_MARGIN, TOP_MARGIN, drawWidth, drawHeight);
      } else {
        ctx.strokeStyle = monochrome ? '#000000' : '#5b8fb0'; // 海岸線は控えめな青系にし、ルート・ランドマークの色と区別する（マップBWでは黒）
        ctx.lineWidth = 4.5;
      }

      landPolygons.forEach(rings => {
        // トリップ範囲（＋余白）にかすっている陸地だけを描画対象にする（外輪郭で簡易判定）
        const exterior = rings[0] || [];
        const isRelevant = exterior.some(([lat, lng]) =>
          lat >= boxLatMin && lat <= boxLatMax && lng >= boxLngMin && lng <= boxLngMax
        );
        if (!isRelevant) return;
        rings.forEach((ring, idx) => {
          ctx.beginPath();
          ring.forEach(([lat, lng], i) => {
            const pt = toCanvas(lat, lng);
            if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
          });
          ctx.closePath();
          if (fillSea) {
            // 外輪郭は白（陸地）、2つ目以降の輪（湖などの穴）は黒（水域）に塗り戻す
            ctx.fillStyle = idx === 0 ? '#ffffff' : '#000000';
            ctx.fill();
          } else {
            ctx.stroke();
          }
        });
      });
      ctx.restore();
    }
  } catch (err) {
    console.warn('海岸線の描画に失敗（スキップ）:', err);
  }

  // タイトル配置の判定: 下部中央のエリアにルート・ランドマークが何もかかっていなければ、
  // 複数の子トリップを集約した広域マップなどで生まれる空白にタイトルを大きく収めて
  // スペースを有効に使う。何かあれば従来通り上部の固定ヘッダーに表示する。
  const bottomBoxHeight = Math.max(160, Math.round(drawHeight * 0.22));
  const bottomBoxWidth = Math.round(drawWidth * 0.6);
  const bottomBoxY0 = TOP_MARGIN + drawHeight - bottomBoxHeight;
  const bottomBoxY1 = TOP_MARGIN + drawHeight;
  const bottomBoxX0 = SIDE_MARGIN + (drawWidth - bottomBoxWidth) / 2;
  const bottomBoxX1 = bottomBoxX0 + bottomBoxWidth;

  let bottomBoxOccupied = false;
  for (const c of allCoords) {
    const pt = toCanvas(c.lat, c.lng);
    if (pt.x >= bottomBoxX0 - 20 && pt.x <= bottomBoxX1 + 20 && pt.y >= bottomBoxY0 - 20 && pt.y <= bottomBoxY1) {
      bottomBoxOccupied = true;
      break;
    }
  }

  if (!bottomBoxOccupied) {
    // 下部の空白にタイトルを大きく表示。黒塗りの海に重なる場合は白文字、
    // 白地（陸地・背景）に重なる場合は黒文字にして、どちらでも確実に読めるようにする。
    const centerX = (bottomBoxX0 + bottomBoxX1) / 2;
    const centerY = (bottomBoxY0 + bottomBoxY1) / 2;
    const availableWidth = bottomBoxWidth * 0.92;
    const titleText = trip.name || '旅行マップ';
    const titleFont = fitTextFontSize(ctx, titleText, availableWidth, Math.min(84, Math.round(bottomBoxHeight * 0.38)), 22);
    const subtitleSize = Math.max(18, Math.round(titleFont * 0.42));

    // 実際に描画された背景ピクセルの明るさから文字色を決める
    let textColor = '#000000';
    try {
      const px = ctx.getImageData(Math.round(centerX), Math.round(centerY), 1, 1).data;
      const brightness = (px[0] + px[1] + px[2]) / 3;
      textColor = brightness < 128 ? '#ffffff' : '#000000';
    } catch (_) {}

    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${titleFont}px sans-serif`;
    ctx.fillText(titleText, centerX, centerY - subtitleSize * 0.7);
    ctx.font = `${subtitleSize}px sans-serif`;
    ctx.fillText(`全${sortedLandmarks.length}ランドマーク`, centerX, centerY + titleFont * 0.55);
    ctx.textBaseline = 'alphabetic';
  } else {
    // タイトル（上部の固定ヘッダー）
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.font = 'bold 46px sans-serif';
    ctx.fillText(trip.name || '旅行マップ', canvasW / 2, 68);
    ctx.font = '24px sans-serif';
    ctx.fillText(`全${sortedLandmarks.length}ランドマーク`, canvasW / 2, 105);
  }

  // ルート線（トリップごとに独立したセグメントとして描画し、トリップ間を線でつながない）。
  // メインの地図と同じトリップカラーを使い、太く目立たせる。
  // トリップ名が「Plan」で始まる場合は計画段階の旅として点線で描く。
  routeSegments.forEach(seg => {
    if (seg.coords.length <= 1) return;
    ctx.strokeStyle = seg.color;
    ctx.lineWidth = 15;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(seg.isPlan ? [28, 20] : []);
    ctx.beginPath();
    seg.coords.forEach((c, i) => {
      const pt = toCanvas(c.lat, c.lng);
      if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();
  });
  ctx.setLineDash([]); // 以降の描画（ランドマーク円・方位マークなど）に点線が影響しないようリセット

  // ランドマーク番号を描画（並び順・件数は冒頭で確定済みのsortedLandmarksを使う）。
  // 円の縁は由来トリップと同じ色にして、ルート線との対応が分かるようにする。
  sortedLandmarks.forEach(({ photo, coord, color }) => {
    const pt = toCanvas(coord.lat, coord.lng);
    const label = String(photo.landmarkNo);
    const radius = label.length >= 3 ? 40 : label.length === 2 ? 36 : 32;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#000000';
    ctx.font = `bold ${label.length >= 3 ? 26 : 30}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pt.x, pt.y + 1);
  });
  ctx.textBaseline = 'alphabetic';

  // 方位マーク（N）: ヘッダー領域内に置き、地図の描画エリア（ランドマーク）と重ならないようにする
  const compassX = canvasW - SIDE_MARGIN - 10, compassY = 30;
  ctx.beginPath();
  ctx.moveTo(compassX, compassY + 20);
  ctx.lineTo(compassX - 8, compassY + 20);
  ctx.lineTo(compassX, compassY);
  ctx.lineTo(compassX + 8, compassY + 20);
  ctx.closePath();
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', compassX, compassY + 36);

  // 右下にこのトリップを開けるQRコードを表示する
  drawQrCodeCorner(ctx, buildTripShareUrl(trip), canvasW, canvasH);

  return canvas.toDataURL('image/png');
}

/** canvas上のテキストがmaxWidthに収まるよう、必要なら末尾を「…」で省略する */
function truncateTextToWidth(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

/** テキストがmaxWidthに収まる最大のフォントサイズ（maxFontSize以下）を探す。省略はしない */
function fitTextFontSize(ctx, text, maxWidth, maxFontSize, minFontSize = 16, weight = 'bold') {
  let size = maxFontSize;
  while (size > minFontSize) {
    ctx.font = `${weight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

// ============================================================
// トリップ動画書き出し（地図の移動＋写真のスライドショーをmp4/webmで書き出す）
// canvasに毎フレーム手描きし、canvas.captureStream + MediaRecorderでそのまま録画する。
// 実際のマップタイル（Leaflet/Mapbox）はCORSで汚染されるため描画できず、
// E-Ink画像生成と同じ「座標から決定論的に描く簡易マップ」の手法を流用する。
const TRIP_VIDEO_W = 720;
const TRIP_VIDEO_H = 1280; // モバイルの縦長（9:16）
const TRIP_VIDEO_FPS = 30;
const TRIP_VIDEO_BITRATE = 2500000; // 2.5Mbps: 高画質を保ちつつファイルサイズを抑える
// 写真は全画面表示、地図は左上に小さくオーバーラップさせる（従来640x460の約1/3サイズを基準に、さらに縦横1.5倍）
const TRIP_VIDEO_MAP_X = 24, TRIP_VIDEO_MAP_Y = 96, TRIP_VIDEO_MAP_W = 336, TRIP_VIDEO_MAP_H = 240, TRIP_VIDEO_MAP_R = 16;
const TRIP_VIDEO_TITLE_MS = 1400;
const TRIP_VIDEO_TRANSITION_MS = 800;
const TRIP_VIDEO_HOLD_MS = 1700;

/** 動画生成にかかるおおよその秒数を見積もる（実時間で録画するため、写真読み込み時間を除けばほぼこの通りの長さになる） */
function estimateTripVideoSeconds(pointCount) {
  if (pointCount <= 0) return 0;
  const firstMs = 200 + TRIP_VIDEO_HOLD_MS;
  const restMs = (pointCount - 1) * (TRIP_VIDEO_TRANSITION_MS + TRIP_VIDEO_HOLD_MS);
  return Math.ceil((TRIP_VIDEO_TITLE_MS + firstMs + restMs) / 1000);
}

// 地図の背景タイル（衛星写真＝地形が視覚的にわかるスタイル。アプリ本体のデフォルト地図と同じ）。
// server.arcgisonline.com はcanvas読み込みに必要なCORSヘッダーを返すため使用（OSM本家は
// ポリシー上ブロックされる場合があるため避ける）。
const TRIP_VIDEO_TILE_SIZE = 256;
const TRIP_VIDEO_TILE_MAX_ZOOM = 18;
function tripVideoTileUrl(z, x, y) {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

let tripVideoExportState = null; // { cancelled: boolean } / 生成中でなければnull
let tripVideoExportObjectUrl = null;

/**
 * Safari/iOSはMediaRecorderで直接mp4(h264)録画に対応しているためそれを優先し、
 * 非対応環境（Chrome/Firefoxなど）はwebmにフォールバックする。
 * ffmpeg.wasm等での変換は行わない（数十MBの追加ダウンロードが発生し、
 * このアプリの軽量さの方針と合わないため）。
 */
function pickTripVideoMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  return candidates.find(c => MediaRecorder.isTypeSupported(c)) || null;
}

function openTripVideoExportModal() {
  document.getElementById('tripVideoExportModal')?.classList.add('open');
}

function closeTripVideoExportModal() {
  document.getElementById('tripVideoExportModal')?.classList.remove('open');
  if (tripVideoExportState) tripVideoExportState.cancelled = true;
}

function setTripVideoExportStatus(text, progress) {
  const statusEl = document.getElementById('tripVideoExportStatus');
  if (statusEl) statusEl.textContent = text || '';
  if (progress != null) {
    const bar = document.getElementById('tripVideoExportProgressBar');
    if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }
}

function setTripVideoExportCancelLabel(text) {
  const btn = document.getElementById('tripVideoExportCancelBtn');
  if (btn) btn.textContent = text;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** hexカラーを指定%だけ明るく（負値で暗く）した rgb() 文字列を返す */
function shadeHexColor(hex, percent) {
  const h = (hex || '#333333').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(full, 16) || 0x333333;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp((num >> 16) + Math.round(255 * percent / 100));
  const g = clamp(((num >> 8) & 0xff) + Math.round(255 * percent / 100));
  const b = clamp((num & 0xff) + Math.round(255 * percent / 100));
  return `rgb(${r},${g},${b})`;
}

/** GPXは数千点になり得るため、動画の背景線として描く分は間引く */
function decimateCoords(coords, maxPoints) {
  if (coords.length <= maxPoints) return coords;
  const step = Math.ceil(coords.length / maxPoints);
  const out = [];
  for (let i = 0; i < coords.length; i += step) out.push(coords[i]);
  const last = coords[coords.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** 画像URLをcanvas安全なdata URL経由でImageとして読み込む（CORS汚染対策はfetchImageAsResizedDataUrlと同じ） */
async function loadTripVideoImage(url, maxDim) {
  if (!url) return null;
  try {
    const dataUrl = await fetchImageAsResizedDataUrl(url, maxDim);
    if (!dataUrl) return null;
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  } catch (err) {
    console.warn('動画用画像の読み込みに失敗（スキップ）:', url, err);
    return null;
  }
}

/** 各ポイントに座標を割り当てる。GPSが無いポイントは直前の有効な座標を引き継ぐ */
function computeTripVideoPoints(photos) {
  const coords = photos.map(p => ensureLatLng(p.lat, p.lng));
  const fallback = coords.find(c => c) || { lat: 35.6812, lng: 139.7671 };
  let last = fallback;
  return photos.map((p, i) => {
    const c = coords[i] || last;
    last = c;
    return { ...p, _coord: c };
  });
}

/** 背景に薄く表示するGPXルート（E-Ink地図生成と同じくトリップごとに独立したセグメントとして扱う） */
async function buildTripVideoRouteSegments(trip) {
  const sourceTrips = trip.isParent ? getChildTrips(trip.id) : [trip];
  const perTripData = await Promise.all(sourceTrips.map(t => getTripRouteAndLandmarks(t)));
  return perTripData
    .map((d, i) => ({
      coords: decimateCoords(d.routeCoords, 600),
      color: sourceTrips[i].color || TRIP_COLORS[i % TRIP_COLORS.length]
    }))
    .filter(seg => seg.coords.length > 1);
}

// 標準的なslippy-map（Webメルカトル）のタイル座標変換
function lngToTileXFrac(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
function latToTileYFrac(lat, z) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
}

/** ルート全体が地図の枠に収まる最大のズームレベルを探す（Leafletのfit-boundsと同じ考え方） */
function pickTripVideoTileZoom(latRange, lngRange, mapW, mapH) {
  const PAD = 0.82; // 枠の端まで使い切らず少し余白を残す
  let best = 2;
  for (let z = 2; z <= TRIP_VIDEO_TILE_MAX_ZOOM; z++) {
    const spanW = (lngToTileXFrac(lngRange.max, z) - lngToTileXFrac(lngRange.min, z)) * TRIP_VIDEO_TILE_SIZE;
    const spanH = (latToTileYFrac(latRange.min, z) - latToTileYFrac(latRange.max, z)) * TRIP_VIDEO_TILE_SIZE;
    if (spanW <= mapW * PAD && spanH <= mapH * PAD) {
      best = z;
    } else {
      break;
    }
  }
  return best;
}

/**
 * ルート全体を覆う衛星タイル画像を一括で読み込む（地図は左上に固定表示する簡易ミニマップの
 * ため、ポイントごとの再取得はせずここで一度だけ取得する）。一部タイルの取得に失敗しても
 * （CORS非対応・オフライン等）他のタイルとルート線・マーカーの描画は継続する。
 */
async function buildTripVideoTiles(points, routeSegments, mapW, mapH) {
  const allCoords = [...points.map(p => p._coord), ...routeSegments.flatMap(s => s.coords)].filter(Boolean);
  const minMaxOf = (values) => values.reduce(
    (acc, v) => ({ min: Math.min(acc.min, v), max: Math.max(acc.max, v) }),
    { min: Infinity, max: -Infinity }
  );
  const latRange = minMaxOf(allCoords.map(c => c.lat));
  const lngRange = minMaxOf(allCoords.map(c => c.lng));

  const z = pickTripVideoTileZoom(latRange, lngRange, mapW, mapH);
  const centerXFrac = lngToTileXFrac((lngRange.min + lngRange.max) / 2, z);
  const centerYFrac = latToTileYFrac((latRange.min + latRange.max) / 2, z);
  const originXFrac = centerXFrac - (mapW / 2) / TRIP_VIDEO_TILE_SIZE;
  const originYFrac = centerYFrac - (mapH / 2) / TRIP_VIDEO_TILE_SIZE;

  const startTx = Math.floor(originXFrac);
  const startTy = Math.floor(originYFrac);
  const endTx = Math.floor(originXFrac + mapW / TRIP_VIDEO_TILE_SIZE);
  const endTy = Math.floor(originYFrac + mapH / TRIP_VIDEO_TILE_SIZE);
  const worldTiles = Math.pow(2, z);

  const tileDefs = [];
  for (let ty = startTy; ty <= endTy; ty++) {
    if (ty < 0 || ty >= worldTiles) continue;
    for (let tx = startTx; tx <= endTx; tx++) {
      const wrappedX = ((tx % worldTiles) + worldTiles) % worldTiles;
      tileDefs.push({ tx, ty, url: tripVideoTileUrl(z, wrappedX, ty) });
    }
  }

  const loaded = await Promise.all(tileDefs.map(t => loadTripVideoImage(t.url, TRIP_VIDEO_TILE_SIZE)));
  const tileImages = new Map();
  tileDefs.forEach((t, i) => { if (loaded[i]) tileImages.set(`${t.tx},${t.ty}`, loaded[i]); });

  return {
    tileImages,
    originXFrac,
    originYFrac,
    project(lat, lng) {
      return {
        x: (lngToTileXFrac(lng, z) - originXFrac) * TRIP_VIDEO_TILE_SIZE,
        y: (latToTileYFrac(lat, z) - originYFrac) * TRIP_VIDEO_TILE_SIZE
      };
    }
  };
}

/** durationMs間、毎フレームrenderFn(t)を呼び続ける（tは0→1）。canvas.captureStreamがこの描画をそのまま録画する */
/**
 * requestAnimationFrameはタブがバックグラウンド/非表示になると完全に停止する
 * ブラウザが多く、動画書き出し中にアプリを切り替えられると無限に固まってしまう。
 * setTimeoutは非表示時も（多少スロットリングされつつ）動き続けるため、
 * 画面表示を伴わないこのオフスクリーン描画にはこちらを使う。
 */
function runVideoFrames(state, renderFn, durationMs) {
  return new Promise(resolve => {
    const start = performance.now();
    const step = () => {
      if (state.cancelled) { resolve(); return; }
      const t = Math.min(1, (performance.now() - start) / durationMs);
      renderFn(t);
      if (t < 1) setTimeout(step, 1000 / TRIP_VIDEO_FPS); else resolve();
    };
    step();
  });
}

function drawTripVideoBackground(ctx, trip) {
  const color = trip.color || TRIP_COLORS[0];
  const grad = ctx.createLinearGradient(0, 0, 0, TRIP_VIDEO_H);
  grad.addColorStop(0, shadeHexColor(color, -8));
  grad.addColorStop(1, shadeHexColor(color, -55));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TRIP_VIDEO_W, TRIP_VIDEO_H);
}

function drawTripVideoHeader(ctx, trip) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 24px sans-serif';
  ctx.fillText(truncateTextToWidth(ctx, trip.name || '', TRIP_VIDEO_W - 100), TRIP_VIDEO_W / 2, 70);
  ctx.restore();
}

/** Instagramストーリー風の区切りプログレスバー */
function drawTripVideoProgress(ctx, total, currentIdx, segT) {
  const barY = 28, barH = 4, gap = 5;
  const areaX = 40, areaW = TRIP_VIDEO_W - 80;
  const segW = Math.max(2, (areaW - gap * (total - 1)) / total);
  for (let i = 0; i < total; i++) {
    const x = areaX + i * (segW + gap);
    roundRectPath(ctx, x, barY, segW, barH, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();
    let ratio = 0;
    if (i < currentIdx) ratio = 1;
    else if (i === currentIdx) ratio = Math.max(0, Math.min(1, segT));
    if (ratio > 0) {
      roundRectPath(ctx, x, barY, segW * ratio, barH, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  }
}

function drawTripVideoMap(ctx, tileBundle, routeSegments, points, currentIdx, markerCoord) {
  // 写真の上に浮いて見えるよう、外枠にドロップシャドウを落としてから本体を描く
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  roundRectPath(ctx, TRIP_VIDEO_MAP_X, TRIP_VIDEO_MAP_Y, TRIP_VIDEO_MAP_W, TRIP_VIDEO_MAP_H, TRIP_VIDEO_MAP_R);
  ctx.fillStyle = '#cfd6da';
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, TRIP_VIDEO_MAP_X, TRIP_VIDEO_MAP_Y, TRIP_VIDEO_MAP_W, TRIP_VIDEO_MAP_H, TRIP_VIDEO_MAP_R);
  ctx.clip();
  ctx.fillStyle = '#cfd6da';
  ctx.fillRect(TRIP_VIDEO_MAP_X, TRIP_VIDEO_MAP_Y, TRIP_VIDEO_MAP_W, TRIP_VIDEO_MAP_H);

  // 実際の衛星タイル（地形が分かる背景）を敷く。一部取得失敗しても上の背景色がフォールバックになる
  tileBundle.tileImages.forEach((img, key) => {
    const [tx, ty] = key.split(',').map(Number);
    const x = TRIP_VIDEO_MAP_X + (tx - tileBundle.originXFrac) * TRIP_VIDEO_TILE_SIZE;
    const y = TRIP_VIDEO_MAP_Y + (ty - tileBundle.originYFrac) * TRIP_VIDEO_TILE_SIZE;
    ctx.drawImage(img, x, y, TRIP_VIDEO_TILE_SIZE, TRIP_VIDEO_TILE_SIZE);
  });

  const toXY = (lat, lng) => {
    const p = tileBundle.project(lat, lng);
    return { x: TRIP_VIDEO_MAP_X + p.x, y: TRIP_VIDEO_MAP_Y + p.y };
  };

  const strokePath = (coordsToXY, color, width, alpha) => {
    ctx.beginPath();
    coordsToXY.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 衛星写真は背景が賑やかなため、白い縁取り（ハロー）を先に描いてから色線を重ね視認性を確保する
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = width + 2;
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  routeSegments.forEach(seg => {
    if (seg.coords.length <= 1) return;
    strokePath(seg.coords.map(c => toXY(c.lat, c.lng)), seg.color, 3, 0.55);
  });

  const visited = points.slice(0, currentIdx + 1).filter(p => p._coord);
  if (visited.length > 1) {
    strokePath(visited.map(p => toXY(p._coord.lat, p._coord.lng)), '#ff4d5e', 3, 1);
  }

  visited.slice(0, -1).forEach(p => {
    const pt = toXY(p._coord.lat, p._coord.lng);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4d5e';
    ctx.fill();
  });

  if (markerCoord) {
    const mp = toXY(markerCoord.lat, markerCoord.lng);
    const pulse = 1 + 0.2 * Math.sin(performance.now() / 260);
    ctx.beginPath();
    ctx.arc(mp.x, mp.y, 9 * pulse, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,77,94,0.3)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(mp.x, mp.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff4d5e';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mp.x, mp.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4d5e';
    ctx.fill();
  }

  ctx.restore();
  roundRectPath(ctx, TRIP_VIDEO_MAP_X, TRIP_VIDEO_MAP_Y, TRIP_VIDEO_MAP_W, TRIP_VIDEO_MAP_H, TRIP_VIDEO_MAP_R);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.stroke();
}

/** 写真を全画面表示（クロスフェード＋ケンバーンズのゆっくり拡大） */
function drawTripVideoPhoto(ctx, state) {
  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, TRIP_VIDEO_W, TRIP_VIDEO_H);

  const drawCover = (img, alpha, zoom) => {
    if (!img || alpha <= 0) return;
    ctx.globalAlpha = alpha;
    const scale = Math.max(TRIP_VIDEO_W / img.width, TRIP_VIDEO_H / img.height) * (1 + 0.06 * zoom);
    const dw = img.width * scale, dh = img.height * scale;
    const dx = (TRIP_VIDEO_W - dw) / 2;
    const dy = (TRIP_VIDEO_H - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.globalAlpha = 1;
  };

  if (state.fromImg !== state.toImg) {
    drawCover(state.fromImg, 1 - state.crossT, 0);
    drawCover(state.toImg, state.crossT, state.zoomT);
  } else {
    drawCover(state.toImg, 1, state.zoomT);
  }

  if (state.isVideoPoint) {
    // 地図（左上）と重ならないよう右上に動画ポイントの再生アイコンを表示
    const cx = TRIP_VIDEO_W - 44, cy = TRIP_VIDEO_MAP_Y + TRIP_VIDEO_MAP_H / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy - 11);
    ctx.lineTo(cx - 7, cy + 11);
    ctx.lineTo(cx + 11, cy);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

/** 上部（プログレスバー・トリップ名）の視認性を確保するための暗いグラデーション */
function drawTripVideoTopGradient(ctx) {
  const h = 160;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TRIP_VIDEO_W, h);
}

/** 下部（ポイント名ラベル）の視認性を確保するための暗いグラデーション */
function drawTripVideoBottomGradient(ctx) {
  const h = 260;
  const grad = ctx.createLinearGradient(0, TRIP_VIDEO_H - h, 0, TRIP_VIDEO_H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, TRIP_VIDEO_H - h, TRIP_VIDEO_W, h);
}

function drawTripVideoLabel(ctx, point) {
  const label = point?.name || '';
  if (!label) return;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const baseY = TRIP_VIDEO_H - 48;
  let x = 28;
  let maxW = TRIP_VIDEO_W - 56;
  if (point.landmarkNo) {
    const bx = x + 18, by = baseY - 10;
    ctx.beginPath();
    ctx.arc(bx, by, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(point.landmarkNo), bx, by + 6);
    x += 48;
    maxW -= 48;
  }
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(truncateTextToWidth(ctx, label, maxW), x, baseY);
  ctx.restore();
}

function composeTripVideoTitleFrame(ctx, trip, t) {
  drawTripVideoBackground(ctx, trip);
  const et = easeInOutCubic(Math.min(1, t / 0.6));
  ctx.save();
  ctx.globalAlpha = et;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const title = trip.name || '旅の記録';
  const titleSize = fitTextFontSize(ctx, title, TRIP_VIDEO_W - 120, 56, 28);
  ctx.font = `bold ${titleSize}px sans-serif`;
  ctx.fillText(truncateTextToWidth(ctx, title, TRIP_VIDEO_W - 120), TRIP_VIDEO_W / 2, TRIP_VIDEO_H / 2 - 20);
  ctx.font = '22px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText('Air', TRIP_VIDEO_W / 2, TRIP_VIDEO_H / 2 + 30);
  ctx.restore();
}

function composeTripVideoFrame(ctx, trip, points, routeSegments, tileBundle, currentIdx, markerCoord, imgState, segT) {
  drawTripVideoPhoto(ctx, imgState);
  drawTripVideoTopGradient(ctx);
  drawTripVideoProgress(ctx, points.length, currentIdx, segT);
  drawTripVideoHeader(ctx, trip);
  drawTripVideoMap(ctx, tileBundle, routeSegments, points, currentIdx, markerCoord);
  drawTripVideoBottomGradient(ctx);
  drawTripVideoLabel(ctx, points[currentIdx]);
}

/** 生成した動画をStorageにアップロードし、ダウンロードURLを返す */
async function uploadTripVideoToStorage(tripId, blob, ext) {
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');
  const path = `trips/${tripId}/videos/trip_video_${Date.now()}.${ext}`;
  const ref = window.firebaseStorage.ref(path);
  await ref.put(blob, { contentType: blob.type || (ext === 'mp4' ? 'video/mp4' : 'video/webm') });
  return await ref.getDownloadURL();
}

/**
 * 生成した動画を、トリップの最後のポイントのvideoUrlとして保存する（画面から再生できるように）。
 * 動画URLは既存の再生機構（showVideoOverlay等）がYouTube/Vimeo以外は<video>タグで
 * そのまま再生するフォールバックを持つため、追加対応なしで再生可能。
 * 親トリップ集約時は実際に写真を持つ子トリップのドキュメントを直接更新する
 * （saveTrip()はフォーム入力・currentTrip前提のため、子トリップの写真は更新できない）。
 */
async function attachGeneratedVideoToLastPoint(trip, points, videoUrl) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return false;
  const lastPoint = points[points.length - 1];
  if (!lastPoint) return false;
  const targetTripId = lastPoint._tripId || trip.id;
  const targetTrip = myTripsMap.get(targetTripId);
  const photoIdx = lastPoint._photoIndexInTrip;
  if (!targetTrip || photoIdx == null || !targetTrip.photos?.[photoIdx]) return false;

  const uid = window.firebaseAuth.currentUser.uid;
  if (targetTrip.userId && targetTrip.userId !== uid) return false;

  targetTrip.photos = targetTrip.photos.map((p, i) => i === photoIdx ? { ...p, videoUrl } : p);
  await window.firebaseDb.collection('trips').doc(targetTripId).set(
    { photos: targetTrip.photos, updatedAt: Date.now() },
    { merge: true }
  );
  if (currentTrip?.id === targetTripId) currentTrip.photos = targetTrip.photos;
  renderThumbnails();
  await updateMapMarkers();
  return true;
}

/**
 * トリップの地図移動＋写真スライドショーを1本のmp4（非対応ブラウザではwebm）動画として書き出す。
 * 実際のライブマップ（Leaflet/Mapbox）は使わず、オフスクリーンcanvasに独自描画したものを
 * canvas.captureStream + MediaRecorderでそのまま録画するため、画面上の再生表示には影響しない。
 * 完成した動画はダウンロードできるほか、ログイン中であればStorageに保存し、
 * トリップの最後のポイントにvideoUrlとして紐付けて画面から再生できるようにする。
 */
async function exportTripVideo(trip) {
  if (!trip) { showToast(MSG_NO_PHOTOS); return; }
  if (tripVideoExportState) { showToast('🎬 動画を生成中です'); return; }

  const mimeType = pickTripVideoMimeType();
  if (!mimeType || !document.createElement('canvas').captureStream) {
    showToast('🎬 お使いのブラウザは動画の書き出しに対応していません');
    return;
  }

  const allPhotos = getDisplayPhotos();
  const photos = allPhotos.filter(p => (p.url && p.url.trim()) || (p.videoUrl && p.videoUrl.trim()));
  if (!photos.length) {
    showToast('📷 書き出せる写真・動画がありません');
    return;
  }

  const points = computeTripVideoPoints(photos);

  const estimatedSeconds = estimateTripVideoSeconds(points.length);
  const confirmed = confirm(
    `${points.length}枚の画像から動画を生成するので、${estimatedSeconds}秒ほどかかります。\nその間は画面を閉じないでください。実行しますか？`
  );
  if (!confirmed) return;

  tripVideoExportState = { cancelled: false };
  if (tripVideoExportObjectUrl) {
    URL.revokeObjectURL(tripVideoExportObjectUrl);
    tripVideoExportObjectUrl = null;
  }
  openTripVideoExportModal();
  setTripVideoExportCancelLabel('キャンセル');
  setTripVideoExportStatus('写真を読み込み中…', 0);
  const downloadLinkEl = document.getElementById('tripVideoExportDownloadLink');
  if (downloadLinkEl) downloadLinkEl.style.display = 'none';
  const previewEl = document.getElementById('tripVideoExportPreview');
  if (previewEl) { previewEl.style.display = 'none'; previewEl.removeAttribute('src'); }

  try {
    const routeSegments = await buildTripVideoRouteSegments(trip);

    setTripVideoExportStatus('地図タイルを読み込み中…', 0.02);
    const tileBundle = await buildTripVideoTiles(points, routeSegments, TRIP_VIDEO_MAP_W, TRIP_VIDEO_MAP_H);
    if (tripVideoExportState.cancelled) throw new Error('cancelled');

    // 写真を先読み（動画ポイントはサムネイルで代用）
    const images = [];
    for (let i = 0; i < points.length; i++) {
      if (tripVideoExportState.cancelled) break;
      const p = points[i];
      const isVideo = p.videoUrl && p.videoUrl.trim();
      const url = isVideo ? getVideoThumbnailUrl(p.videoUrl) : p.url;
      images.push(await loadTripVideoImage(url, 960));
      setTripVideoExportStatus(`写真を読み込み中…（${i + 1}/${points.length}）`, 0.05 + (i + 1) / points.length * 0.30);
    }
    if (tripVideoExportState.cancelled) throw new Error('cancelled');

    const canvas = document.createElement('canvas');
    canvas.width = TRIP_VIDEO_W;
    canvas.height = TRIP_VIDEO_H;
    const ctx = canvas.getContext('2d');

    const stream = canvas.captureStream(TRIP_VIDEO_FPS);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: TRIP_VIDEO_BITRATE });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();

    setTripVideoExportStatus('動画を生成中…', 0.35);

    await runVideoFrames(tripVideoExportState, (t) => {
      composeTripVideoTitleFrame(ctx, trip, t);
    }, TRIP_VIDEO_TITLE_MS);

    for (let i = 0; i < points.length && !tripVideoExportState.cancelled; i++) {
      const prev = points[Math.max(0, i - 1)];
      const curr = points[i];
      const prevImg = images[Math.max(0, i - 1)];
      const currImg = images[i];
      const isVideoPoint = !!(curr.videoUrl && curr.videoUrl.trim());

      // 遷移: 前のポイント→現在のポイントへ地図を移動しながら写真をクロスフェード
      await runVideoFrames(tripVideoExportState, (t) => {
        const et = easeInOutCubic(t);
        const markerCoord = i === 0 ? curr._coord : {
          lat: lerp(prev._coord.lat, curr._coord.lat, et),
          lng: lerp(prev._coord.lng, curr._coord.lng, et)
        };
        composeTripVideoFrame(ctx, trip, points, routeSegments, tileBundle, i, markerCoord, {
          fromImg: i === 0 ? currImg : prevImg,
          toImg: currImg,
          crossT: i === 0 ? 1 : et,
          zoomT: 0,
          isVideoPoint
        }, t);
      }, i === 0 ? 200 : TRIP_VIDEO_TRANSITION_MS);

      if (tripVideoExportState.cancelled) break;

      // 保持: 写真をしっかり見せる（ゆっくりケンバーンズ拡大）
      await runVideoFrames(tripVideoExportState, (t) => {
        composeTripVideoFrame(ctx, trip, points, routeSegments, tileBundle, i, curr._coord, {
          fromImg: currImg,
          toImg: currImg,
          crossT: 1,
          zoomT: t,
          isVideoPoint
        }, 1);
      }, TRIP_VIDEO_HOLD_MS);

      setTripVideoExportStatus(`動画を生成中…（${i + 1}/${points.length}）`, 0.35 + (i + 1) / points.length * 0.6);
    }

    recorder.stop();
    await stopped;

    if (tripVideoExportState.cancelled) {
      setTripVideoExportStatus('キャンセルしました');
      closeTripVideoExportModal();
      return;
    }

    const blobType = mimeType.split(';')[0];
    const blob = new Blob(chunks, { type: blobType });
    const ext = blobType === 'video/mp4' ? 'mp4' : 'webm';
    const objectUrl = URL.createObjectURL(blob);
    tripVideoExportObjectUrl = objectUrl;
    const sizeMb = (blob.size / (1024 * 1024)).toFixed(1);

    if (previewEl) { previewEl.src = objectUrl; previewEl.style.display = ''; }
    if (downloadLinkEl) {
      downloadLinkEl.href = objectUrl;
      downloadLinkEl.download = `${sanitizeFileNamePart(trip.name)}.${ext}`;
      downloadLinkEl.style.display = '';
    }
    setTripVideoExportCancelLabel('閉じる');
    const baseMsg = ext === 'mp4'
      ? `完成しました（${sizeMb}MB）`
      : `完成しました（${sizeMb}MB・このブラウザはmp4録画非対応のためwebm形式です）`;

    const lastPoint = points[points.length - 1];
    const targetTripId = lastPoint?._tripId || trip.id;
    if (window.firebaseAuth?.currentUser) {
      setTripVideoExportStatus(`${baseMsg}\n最後のポイントに保存中…`, 1);
      try {
        const storageUrl = await uploadTripVideoToStorage(targetTripId, blob, ext);
        const saved = await attachGeneratedVideoToLastPoint(trip, points, storageUrl);
        setTripVideoExportStatus(
          saved
            ? `${baseMsg}\n最後のポイント「${lastPoint.name || ''}」に保存しました。画面から再生できます`
            : `${baseMsg}\n最後のポイントへの保存はスキップされました（権限がありません）`,
          1
        );
      } catch (saveErr) {
        console.error('動画のトリップへの保存エラー:', saveErr);
        setTripVideoExportStatus(`${baseMsg}\n※トリップへの保存に失敗しました（ダウンロードは可能です）`, 1);
      }
    } else {
      setTripVideoExportStatus(baseMsg, 1);
    }
  } catch (err) {
    if (err?.message !== 'cancelled') {
      console.error('動画書き出しエラー:', err);
      setTripVideoExportStatus('動画の生成に失敗しました');
      setTripVideoExportCancelLabel('閉じる');
      showToast('🎬 動画の生成に失敗しました');
    }
  } finally {
    tripVideoExportState = null;
  }
}

/**
 * 写真URLを、E-Ink向けに白黒（グレースケール＋コントラスト強調）化した
 * <img>要素として読み込む。Storageへの直接描画はCORSでcanvasが汚染される
 * 可能性があるため、fetchImageAsResizedDataUrlで一度data URL化してから読み込む
 * （AI参照画像で使っているのと同じ安全策）。
 */
async function loadStampPhotoImage(url) {
  if (!url) return null;
  try {
    const dataUrl = await fetchImageAsResizedDataUrl(url, 400);
    if (!dataUrl) return null;
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  } catch (err) {
    console.warn('スタンプ写真の読み込みに失敗（スキップ）:', url, err);
    return null;
  }
}

/**
 * E-Ink端末向けの、スタンプ（isStamp写真）投稿の実際の写真を白黒化して
 * 判子風の丸型に収めたシート画像をcanvasで直接描画する。親トリップの場合は
 * getStampListForTripが全子トリップのスタンプを番号順に集約して返すため、
 * 既存のスタンプラリー機能と同じ集約結果をそのまま使う。
 */
async function generateEinkStampSheetDataUrl(trip) {
  const stamps = getStampListForTrip(trip);
  if (stamps.length === 0) return null;

  // 各スタンプの写真を先に読み込んでおく（写真がない/失敗したものはnull）
  const stampPhotoImages = await Promise.all(stamps.map(s => loadStampPhotoImage(s.url)));

  // 1行2列の固定グリッド。スタンプをなるべく大きく表示するため正方形セルを大きめに取る。
  const COLS = 2;
  const rows = Math.ceil(stamps.length / COLS);
  const SQUARE = 480; // 各スタンプの一辺
  const GAP = 24; // セル同士の間隔
  const PAD = 40; // 外周の余白
  const TOP_MARGIN = 90; // タイトル分のみ（サブタイトルは廃止）
  const BOTTOM_MARGIN = 40;
  // 親トリップ集約時のみ、各スタンプの下に由来トリップ名を表示するための帯を確保する
  const LABEL_H = trip.isParent ? 30 : 0;
  const ROW_PITCH = SQUARE + LABEL_H + GAP;

  const canvasW = PAD * 2 + SQUARE * COLS + GAP * (COLS - 1);
  const canvasH = TOP_MARGIN + rows * (SQUARE + LABEL_H) + GAP * (rows - 1) + BOTTOM_MARGIN;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // E-Inkは白地に黒がもっともくっきり表示されるため、白背景+黒線のみで構成する
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvasW - 4, canvasH - 4);

  // タイトル（トリップ名のみ。「スタンプ一覧」のサブタイトルは表示しない）
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.font = 'bold 46px sans-serif';
  ctx.fillText(trip.name || '旅行', canvasW / 2, 62);

  // 親トリップ集約時は番号が子トリップ間で重複し得るため、由来トリップ名を添えて区別する
  const showSourceTripName = !!trip.isParent;
  const inset = 14; // 外枠と内側（写真）の間隔

  stamps.forEach((stamp, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const x0 = PAD + col * (SQUARE + GAP);
    const y0 = TOP_MARGIN + row * ROW_PITCH;
    const cx = x0 + SQUARE / 2;
    const innerX = x0 + inset, innerY = y0 + inset, innerSize = SQUARE - inset * 2;
    const photoImg = stampPhotoImages[i];

    if (photoImg) {
      // 実際にアップロードされた写真を四角に切り抜き、白黒（グレースケール＋コントラスト強調）で描画する
      ctx.save();
      ctx.beginPath();
      ctx.rect(innerX, innerY, innerSize, innerSize);
      ctx.clip();
      ctx.filter = 'grayscale(100%) contrast(1.25)';
      const scale = Math.max(innerSize / photoImg.width, innerSize / photoImg.height);
      const dw = photoImg.width * scale, dh = photoImg.height * scale;
      ctx.drawImage(photoImg, innerX + innerSize / 2 - dw / 2, innerY + innerSize / 2 - dh / 2, dw, dh);
      ctx.filter = 'none';
      ctx.restore();

      // 写真の下側に名前キャプションを敷く（半透明の黒帯＋白文字で、写真の濃淡によらず読めるようにする）
      if (stamp.name) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(innerX, innerY, innerSize, innerSize);
        ctx.clip();
        const capH = innerSize * 0.16;
        const grad = ctx.createLinearGradient(0, innerY + innerSize - capH, 0, innerY + innerSize);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.72)');
        ctx.fillStyle = grad;
        ctx.fillRect(innerX, innerY + innerSize - capH, innerSize, capH);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '22px sans-serif';
        ctx.fillText(truncateTextToWidth(ctx, stamp.name, innerSize * 0.9), cx, innerY + innerSize - 16);
        ctx.restore();
      }
    }

    const label = String(stamp.landmarkNo || (i + 1));
    if (photoImg) {
      // 写真がある場合は左上に白丸バッジで番号を表示（写真の濃淡によらず読めるように）
      const badgeR = label.length >= 3 ? 28 : 24;
      const badgeX = innerX + badgeR + 6, badgeY = innerY + badgeR + 6;
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${label.length >= 3 ? 22 : 28}px sans-serif`;
      ctx.fillText(label, badgeX, badgeY + 1);
    } else {
      // 写真がない場合は従来通り中央に大きく番号・名前を表示
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${label.length >= 3 ? 90 : 120}px sans-serif`;
      ctx.fillText(label, cx, y0 + SQUARE / 2 - (stamp.name ? 24 : 0));

      if (stamp.name) {
        ctx.font = '28px sans-serif';
        ctx.fillText(truncateTextToWidth(ctx, stamp.name, SQUARE * 0.8), cx, y0 + SQUARE / 2 + SQUARE * 0.22);
      }
    }

    if (showSourceTripName && stamp._tripName) {
      // 枠の下に確保したLABEL_H分の帯に由来トリップ名を表示する
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '15px sans-serif';
      ctx.fillStyle = '#000000';
      ctx.fillText(truncateTextToWidth(ctx, stamp._tripName, SQUARE - 20), cx, y0 + SQUARE + LABEL_H / 2);
    }
  });
  ctx.textBaseline = 'alphabetic';

  // 右下にこのトリップを開けるQRコードを表示する（枠線は表示せず、白地とQR本体のみ）
  drawQrCodeCorner(ctx, buildTripShareUrl(trip), canvasW, canvasH, { border: false });

  return canvas.toDataURL('image/png');
}

/**
 * E-Ink端末向けの、白黒中心でシャープな線画スタイルのカバー画像をAIで生成する。
 * 既存の「アニメ生成」表紙系スタイルと同じ組み立て（情景ブリーフ＋参照写真）を使うが、
 * プロンプトはE-Ink向けの高コントラスト・線画指定に差し替える。
 */
async function generateEinkCoverImage(trip, preValidatedCfg = null) {
  let animeCfg = preValidatedCfg;
  if (!animeCfg) {
    const cfg = cachedAiConfig ?? (await loadUserAiConfig());
    const provider = cfg?.provider || 'gemini';
    const apiKey = cfg?.apiKey?.trim();
    if (!apiKey) throw new Error('AI画像生成にはAPIキーが必要です。AI設定でAPIキーを入力してください。');
    if (provider === 'anthropic') throw new Error('Anthropicは画像生成に対応していません。AI設定でGeminiまたはOpenAIを選択してください。');
    animeCfg = { provider, apiKey, model: cfg?.model || null };
  }
  const tripName = trip.name || '旅行';
  const photos = trip.photos || [];
  const places = [...new Set(photos.filter(p => p.placeName).map(p => p.placeName))];
  const landmarks = photos.filter(p => p.landmarkNo);

  const promptParts = [
    EINK_COVER_PROMPT,
    `画像内に「${tripName}」というタイトルを大きく太字で、はっきり読みやすく配置してください。`,
    '',
    `【表紙タイトル】${tripName}`
  ];
  if (places.length > 0) promptParts.push(`【訪問地】${places.slice(0, 8).join('、')}`);
  if (landmarks.length > 0) {
    const landmarkNames = landmarks.map(p => `${p.landmarkNo}: ${p.name || '名所'}`).slice(0, 5).join('、');
    promptParts.push(`【主な立ち寄り先】${landmarkNames}`);
  }

  setStatus('カバー画像の雰囲気を要約中...');
  const highlightDescriptions = [...new Set(photos.filter(p => p.description).map(p => p.description))].slice(0, 5);
  const travelogueRaw = await getTravelogueTextForTrip(trip, 1000);
  const briefSource = [trip.description, highlightDescriptions.join('。'), travelogueRaw].filter(Boolean).join('\n');
  const sceneBrief = briefSource ? await buildSceneBrief(briefSource, animeCfg) : null;
  if (sceneBrief) {
    promptParts.push(`【旅の雰囲気】${sceneBrief}`);
  } else if (trip.description) {
    promptParts.push(`【旅行の説明】${trip.description}`);
  }

  promptParts.push('');
  promptParts.push('【最重要】E-Ink端末での表示を前提に、白黒（またはごく少ないグレー階調）のみのシャープでくっきりした線画・フラットイラストにしてください。写真的なリアリズム、繊細なグラデーション、ぼかし、細かすぎるテクスチャは避けてください。');

  setStatus('参照写真を準備中...');
  const refImages = await buildAnimeReferenceImages(null, photos, 2);
  const refPhotos = refImages.filter(r => r.kind === 'photo');
  if (refPhotos.length > 0) {
    promptParts.push('');
    promptParts.push('【添付の参照写真】実際にこの旅で撮影した風景です。建物・自然の特徴だけを参考にし、シャープな線画イラストとして描き起こしてください。');
  }

  setStatus('E-ink向けカバー画像を生成中...');
  const prompt = promptParts.join('\n');
  return await generateImageWithAI(prompt, refImages.map(r => r.dataUrl), animeCfg);
}

/**
 * スタンプ投稿（御朱印）用の画像を生成する。
 * 登録された写真をカラー対応E-Ink端末向けのシンプルでアーティスティックな
 * イラストに描き起こし、左下に控えめな御朱印風QRコード（登録されたURL、なければ
 * そのポイントへのディープリンクURL）を合成した1枚の画像を返す。
 */
async function generateStampGoshuinImage(trip, idx) {
  const p = trip?.photos?.[idx];
  if (!p) throw new Error('写真が見つかりません');
  if (!p.url) throw new Error('先に写真を登録してください');

  const cfg = cachedAiConfig ?? (await loadUserAiConfig());
  const provider = cfg?.provider || 'gemini';
  const apiKey = cfg?.apiKey?.trim();
  if (!apiKey) throw new Error('AI画像生成にはAPIキーが必要です。AI設定でAPIキーを入力してください。');
  if (provider === 'anthropic') throw new Error('Anthropicは画像生成に対応していません。AI設定でGeminiまたはOpenAIを選択してください。');
  const animeCfg = { provider, apiKey, model: cfg?.model || null };

  const spotName = p.name || p.placeName || trip.name || 'スポット';
  const promptParts = [
    'この写真をもとに、カラー対応E-Ink端末（Kaleido/Spectra等の電子ペーパー）での表示に適した、クリアでシャープな1枚のイラストに描き起こしてください。',
    '写真に写っている被写体・構図・色合いに忠実に描いてください。実際に写っているもの以外の要素（文字、キャプション、印章、スタンプ、判子、装飾、追加の背景など）は一切加えず、見やすくクリアな1枚に仕上げてください。',
    '色数を絞ったフラットな配色、くっきりした輪郭線、大きくまとまった形で構成し、細かすぎるテクスチャや繊細なグラデーション・ぼかしは避けてください（E-Inkは色再現・階調表現が苦手なため）。',
    `【スポット名（参考情報。画像内に文字として描かないこと）】${spotName}`,
    p.description ? `【説明（参考情報。画像内に文字として描かないこと）】${p.description}` : '',
    '例外として、画像の左下の一角だけは、後から別に作成した小さな四角い画像を重ねて配置するため、その部分に格子状・マス目状の模様や、人物の顔など隠れてほしくない重要な被写体を置かないでください。'
  ].filter(Boolean);
  const prompt = promptParts.join('\n');

  setStatus('参照写真を準備中...');
  const refDataUrl = await fetchImageAsResizedDataUrl(p.url);

  setStatus('御朱印風QR画像を生成中...');
  const rawDataUrl = await generateImageWithAI(prompt, refDataUrl, animeCfg);
  if (!rawDataUrl) throw new Error('画像の生成に失敗しました。APIキーと入力内容を確認してください。');

  const targetUrl = (p.videoUrl && p.videoUrl.trim()) || buildPhotoShareUrl(trip, idx);
  const composedDataUrl = await overlayGoshuinQrSeal(rawDataUrl, targetUrl, p.name, p.description);
  return { dataUrl: composedDataUrl, targetUrl };
}

/**
 * トリップの旅行記本文を取得する。
 * travelogueHtml はFirestore保存時に削除されるため通常は空で、
 * 実体はStorage上の travelogueUrl にある。両方を見て本文を返す。
 */
/**
 * 旅行記の生HTMLを取得する。
 * travelogueHtmlはFirestore保存時に削除されるため通常は空で、
 * 実体はStorage上のtravelogueUrl（または履歴の最新エントリ）にある。
 * showTravelogueModalと同じ優先順位: 履歴があれば直近（最新タイムスタンプ）の
 * エントリを優先し、無ければトリップ本体のtravelogueHtml/travelogueUrlを使う。
 */
async function fetchTravelogueHtmlForTrip(trip) {
  if (!trip) return '';
  let html = trip.travelogueHtml && trip.travelogueHtml.trim() ? trip.travelogueHtml : null;
  let url = trip.travelogueUrl || null;

  const latest = getLatestTravelogueEntry(trip);
  if (latest?.url) {
    url = latest.url;
    html = null;
  } else if (latest?.html && latest.html.trim()) {
    html = latest.html;
    url = null;
  }

  if (html) return html;
  if (!url) return '';
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    return await res.text();
  } catch (err) {
    console.warn('旅行記HTMLの取得に失敗（スキップ）:', err);
    return '';
  }
}

async function getTravelogueTextForTrip(trip, maxLen = 400) {
  if (!trip) return '';
  try {
    const html = await fetchTravelogueHtmlForTrip(trip);
    if (!html) return '';
    const sections = parseTravelogueSections(html);
    return sections.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  } catch (err) {
    console.warn('旅行記テキストの取得に失敗（スキップ）:', err);
    return '';
  }
}

function parseTravelogueSections(html) {
  if (!html || !html.trim()) return [];
  const div = document.createElement('div');
  div.innerHTML = html;
  const sections = [];
  let currentTitle = '';
  let currentText = [];
  const flush = () => {
    const text = currentText.join(' ').replace(/\s+/g, ' ').trim();
    if (text || currentTitle) {
      sections.push({ title: currentTitle, text });
    }
    currentTitle = '';
    currentText = [];
  };
  for (const node of div.childNodes) {
    if (node.nodeType !== 1) continue;
    const tag = (node.tagName || '').toLowerCase();
    const text = (node.textContent || '').trim();
    if (tag === 'h3') {
      flush();
      currentTitle = text;
    } else if (tag === 'p' && text) {
      currentText.push(text);
    }
  }
  flush();
  if (sections.length === 0 && html.trim()) {
    sections.push({ title: '', text: div.textContent.replace(/\s+/g, ' ').trim().slice(0, 500) });
  }
  return sections;
}

function getSelectedAnimeStyle() {
  const select = document.getElementById('animeStyleSelect');
  return (select && select.value) || 'chikyu-cover';
}

/**
 * 旅行記を4分割し、指定ページ(1-4)の1/4分の全文を返す。
 * travelogueHtmlが無い（Storage保存済みの）トリップでも取得できるよう
 * fetchTravelogueHtmlForTripを使う。写真情報へのフォールバック時は
 * 同一テキストの重複を除去する。
 */
async function getTravelogueQuarterContent(trip, pageIndex) {
  const pageIndex0 = Math.max(0, Math.min(pageIndex - 1, 3));
  let fullText = '';
  const html = await fetchTravelogueHtmlForTrip(trip);
  if (html) {
    const sections = parseTravelogueSections(html);
    fullText = sections.map(s => (s.title ? `【${s.title}】` : '') + s.text).join('\n\n');
  }
  if (!fullText.trim()) {
    const parts = [];
    if (trip.description) parts.push(trip.description);
    const seen = new Set();
    (trip.photos || []).forEach(p => {
      [p.placeName, p.name, p.description].filter(Boolean).forEach(text => {
        if (!seen.has(text)) {
          seen.add(text);
          parts.push(text);
        }
      });
    });
    fullText = parts.join('。').replace(/\s+/g, ' ') || trip.name || '旅行の思い出';
  }
  fullText = fullText.replace(/\s+/g, ' ').trim();
  if (!fullText) return '';

  const len = fullText.length;
  const quarterLen = Math.ceil(len / 4);
  const start = pageIndex0 * quarterLen;
  const end = Math.min(start + quarterLen, len);
  return fullText.slice(start, end).trim();
}

/**
 * 詳細4ページ用: 旅行記1/4 + 対応する写真・説明をまとめて返す（そのトリップをトータルにカバー）。
 * 同じ内容の写真情報が連続する場合は重複行を除いて詰め込みすぎを防ぐ。
 */
async function getDetail4PagesQuarterContent(trip, pageIndex) {
  const pageIndex0 = Math.max(0, Math.min(pageIndex - 1, 3));
  const parts = [];

  // 旅行記の1/4
  const quarterText = await getTravelogueQuarterContent(trip, pageIndex);
  if (quarterText) {
    parts.push('【旅行記の内容】');
    parts.push(quarterText);
  }

  // 写真を4区間に分割し、このページに対応する写真の情報を追加
  const photos = trip.photos || [];
  if (photos.length > 0) {
    const qSize = Math.ceil(photos.length / 4);
    const startIdx = pageIndex0 * qSize;
    const endIdx = Math.min(startIdx + qSize, photos.length);
    const quarterPhotos = photos.slice(startIdx, endIdx);
    if (quarterPhotos.length > 0) {
      parts.push('');
      parts.push('【この区間の写真と説明】');
      const seenLines = new Set();
      let itemNo = 0;
      quarterPhotos.forEach((p) => {
        const items = [];
        if (p.placeName) items.push(`場所: ${p.placeName}`);
        if (p.name) items.push(`ポイント: ${p.name}`);
        if (p.description) items.push(`説明: ${p.description}`);
        if (p.landmarkNo) items.push(`ランドマーク: 📍${p.landmarkNo}`);
        if (items.length === 0) return;
        const line = items.join(' / ');
        if (seenLines.has(line)) return; // 重複する写真情報は除外
        seenLines.add(line);
        itemNo++;
        parts.push(`  ${itemNo}. ${line}`);
      });
    }
  }

  const result = parts.join('\n').trim();
  return result || (trip.name || '旅行の思い出');
}

async function generateImageWithNanoBananaPro2(prompt, cfg, characterImage = null) {
  const apiKey = cfg?.apiKey?.trim();
  if (!apiKey) {
    console.error('gemini-3.1-flash-image-preview: APIキーが設定されていません');
    return null;
  }
  try {
    console.log('gemini-3.1-flash-image-preview: 画像生成リクエスト送信中...');
    console.log('プロンプト長:', prompt.length, '文字');
    console.log('キャラクター画像:', characterImage ? 'あり' : 'なし');

    // リクエストのparts配列を構築
    const parts = [];

    // キャラクター画像がある場合は最初に追加
    if (characterImage) {
      // Data URLからBase64データとMIMEタイプを抽出
      const matches = characterImage.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const base64Data = matches[2];
        parts.push({
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        });
      }
    }

    // テキストプロンプトを追加
    parts.push({
      text: prompt
    });

    // Gemini image モデルを使用して画像を生成
    const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: parts
        }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE']
        }
      })
    });

    const data = await res.json();
    console.log('gemini-3.1-flash-image-preview: レスポンス受信:', data);

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    // Geminiのレスポンスから画像データを取得
    const responseParts = data.candidates?.[0]?.content?.parts;
    if (!responseParts) {
      throw new Error('レスポンスにpartsが見つかりませんでした');
    }

    // inlineDataを含むpartを探す
    const imagePart = responseParts.find(part => part.inlineData);
    if (imagePart && imagePart.inlineData?.data) {
      const imageData = imagePart.inlineData.data;
      const mimeType = imagePart.inlineData.mimeType || 'image/jpeg';
      const imageUrl = `data:${mimeType};base64,${imageData}`;
      console.log('gemini-3.1-flash-image-preview: 画像生成成功');
      return imageUrl;
    } else {
      console.error('レスポンス内容:', JSON.stringify(data, null, 2));
      throw new Error('画像データが見つかりませんでした。レスポンスを確認してください。');
    }
  } catch (e) {
    console.error('gemini-3.1-flash-image-preview image generation error:', e);
    return null;
  }
}

/** dataURL を File に変換する（画像APIのmultipart送信用） */
function dataUrlToFile(dataUrl, filename) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename, { type: m[1] });
}

/**
 * 画像を生成する。
 * @param {string} prompt
 * @param {string|string[]|null} imageUrl 参照画像（dataURL）。配列で複数指定可。
 *   1枚目をキャラクター、2枚目以降を旅行写真として渡す想定。
 * @param {object} cfg
 */
async function generateImageWithAI(prompt, imageUrl, cfg) {
  if (!cfg?.apiKey?.trim()) return null;
  const provider = cfg.provider || 'gemini';
  // 単一指定・複数指定のどちらも受け付ける
  const refImages = (Array.isArray(imageUrl) ? imageUrl : [imageUrl])
    .filter(u => typeof u === 'string' && u.startsWith('data:'));
  try {
    if (provider === 'openai') {
      const model = cfg.model || 'gpt-image-1-mini';
      const isGptImage = model.startsWith('gpt-image-');

      // gpt-image-1系は参照画像を渡せる（images/edits）。
      // generations は画像を受け付けないため、参照画像がある場合は edits を使う。
      if (isGptImage && refImages.length > 0) {
        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('n', '1');
        form.append('size', '1024x1536');
        form.append('quality', 'medium');
        refImages.forEach((d, i) => {
          const file = dataUrlToFile(d, `ref_${i}.png`);
          if (file) form.append('image[]', file);
        });
        const editRes = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
          body: form
        });
        const editData = await editRes.json();
        if (editData.error) throw new Error(editData.error.message || JSON.stringify(editData.error));
        const editItem = editData.data?.[0];
        if (editItem?.b64_json) return `data:image/png;base64,${editItem.b64_json}`;
        if (editItem?.url) return editItem.url;
        return null;
      }

      const body = isGptImage
        ? {
            model,
            prompt,
            n: 1,
            size: '1024x1536',   // 縦長（gpt-image-1系）
            quality: 'medium',
            output_format: 'png'
          }
        : {
            model,               // dall-e-3
            prompt,
            n: 1,
            size: '1024x1792',
            quality: 'hd'
          };

      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      // gpt-image-1系はb64_jsonで返る
      const item = data.data?.[0];
      if (!item) return null;
      if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
      return item.url || null;
    }
    if (provider === 'anthropic') {
      const apiKey = cfg.apiKey;
      if (!apiKey?.trim()) return null;
      const baseUrl = 'https://api.defapi.org';
      const res = await fetch(`${baseUrl}/api/image/gen`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'google/gempix2',
          prompt,
          images: refImages.length > 0 ? refImages : undefined
        })
      });
      const data = await res.json();
      if (data.code !== 0 || !data.data?.task_id) throw new Error(data.message || 'API error');
      const taskId = data.data.task_id;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const qRes = await fetch(`${baseUrl}/api/task/query?task_id=${encodeURIComponent(taskId)}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const qData = await qRes.json();
        if (qData.status === 'success' && qData.result?.[0]?.image) return qData.result[0].image;
        if (qData.status === 'failed') throw new Error(qData.status_reason?.message || 'Failed');
      }
      throw new Error('Timeout');
    }
    if (provider === 'gemini') {
      const geminiModel = cfg.model || 'gemini-3.1-flash-image';
      const parts = [];
      // 参照画像を全て添付する（1枚目=キャラ、2枚目以降=旅行写真）
      refImages.forEach((d) => {
        const matches = d.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          parts.push({ inlineData: { mimeType: matches[1], data: matches[2] } });
        }
      });
      parts.push({ text: prompt });

      const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
          }
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (imagePart?.inlineData?.data) {
        const mimeType = imagePart.inlineData.mimeType || 'image/jpeg';
        return `data:${mimeType};base64,${imagePart.inlineData.data}`;
      }
      // レスポンスに画像が含まれない場合はデバッグ情報をログ出力
      console.warn('Gemini画像生成: 画像データなし', JSON.stringify(data).slice(0, 500));
      return null;
    }
    return null;
  } catch (e) {
    console.error('Image generation error:', e);
    throw e;
  }
}

/**
 * Ink系（カバーInk/マップInk/スタンプInk）の生成結果をStorageに保存し、
 * 既存の生成アニメ一覧（generatedAnimes/renderGeneratedAnimesList）に追加する。
 * 一覧に表示されれば、生成アニメと同じ並び替え（← →）・削除（✕）がそのまま使える。
 * ダウンロード用モーダルには引き続き元のdataUrlを使う（Storage URLは別オリジンのため
 * <a download>で確実にダウンロードできるとは限らない）。
 */
async function persistInkImageToGallery(trip, dataUrl, style, filePrefix) {
  const storageUrl = await uploadAnimeImageToStorage(trip.id, dataUrl, filePrefix);
  if (!trip.generatedAnimes) trip.generatedAnimes = [];
  trip.generatedAnimes.push({ url: storageUrl, timestamp: Date.now(), style });
  await saveTrip({ silent: true });
  renderGeneratedAnimesList();
}

/**
 * 「マップInk」選択時は、他のスタイルで使うモデル品質(L/M/H)の代わりに
 * カラー/白黒(C/B)を選ぶ切替として同じセレクトを流用する。
 * マップInkはAIを使わない決定論的なcanvas生成のため、品質レベルという
 * 概念自体が存在せず、その代わりに色の出力形式を選べるようにしている。
 */
function updateModelLevelSelectForStyle(styleId) {
  const sel = document.getElementById('modelLevelSelect');
  if (!sel) return;
  if (styleId === 'map-ink') {
    if (sel.dataset.mode !== 'color') {
      sel.innerHTML = '<option value="color" selected>C</option><option value="bw">B</option>';
      sel.title = 'C: カラーでマップを生成 / B: 白黒でマップを生成';
      sel.dataset.mode = 'color';
    }
  } else if (sel.dataset.mode === 'color') {
    sel.innerHTML = '<option value="low" selected>L</option><option value="mid">M</option><option value="high">H</option>';
    sel.title = '画像生成に使うモデルの品質レベル';
    delete sel.dataset.mode;
  }
}

async function showAnimeModal() {
  const trip = currentTrip;
  if (!trip) {
    alert('トリップを選択してください');
    return;
  }

  const styleId = getSelectedAnimeStyle();
  const btn = document.getElementById('generateAnimeBtnViewer');
  const originalBtnText = btn?.textContent || '画像生成';

  // マップInk: AIを使わずcanvasで決定論的に生成するため、APIキー不要でここで完結させる
  // カラー/白黒はモデル品質(L/M/H)の代わりに流用しているC/Bセレクトで選ぶ
  if (styleId === 'map-ink') {
    const isMonochrome = document.getElementById('modelLevelSelect')?.value === 'bw';
    const galleryStyle = isMonochrome ? 'map-bw' : 'map-ink';
    const filePrefix = isMonochrome ? 'mapbw' : 'mapink';
    const fileSuffix = isMonochrome ? '_map_bw.png' : '_map.png';
    try {
      if (btn) btn.textContent = 'マップ生成中...';
      setStatus('マップ画像を生成中...');
      if (trip.isParent && getChildTrips(trip.id).length === 0) {
        showCreateImageResult('この親トリップには子トリップがありません。子トリップを作成し、写真やGPXを追加してください。', null, null);
        openCreateImageModal();
        return;
      }
      const dataUrl = await generateEinkMapDataUrl(trip, { monochrome: isMonochrome });
      if (!dataUrl) {
        const msg = trip.isParent
          ? 'この親トリップの子トリップに、ランドマーク番号を設定した写真、またはGPS付きの写真がありません。各子トリップの写真編集でランドマーク番号やGPS位置を設定してください。'
          : 'ランドマーク番号を設定した写真、またはGPS付きの写真がありません。写真編集でランドマーク番号やGPS位置を設定してください。';
        showCreateImageResult(msg, null, null);
      } else {
        showCreateImageResult('マップ画像を作成しました。', dataUrl, `${sanitizeFileNamePart(trip.name)}${fileSuffix}`);
        setStatus('マップ画像を作成しました');
        try {
          await persistInkImageToGallery(trip, dataUrl, galleryStyle, filePrefix);
        } catch (saveErr) {
          console.error('マップ画像の保存エラー:', saveErr);
        }
      }
      openCreateImageModal();
    } catch (err) {
      console.error('マップ画像生成エラー:', err);
      showCreateImageResult('マップ画像の生成に失敗しました: ' + (err.message || String(err)), null, null);
      openCreateImageModal();
    } finally {
      if (btn) btn.textContent = originalBtnText;
    }
    return;
  }

  // スタンプInk: AIを使わずcanvasで決定論的に生成するため、APIキー不要でここで完結させる
  if (styleId === 'stamp-ink') {
    try {
      if (btn) btn.textContent = 'スタンプ生成中...';
      setStatus('スタンプ画像を生成中...');
      if (trip.isParent && getChildTrips(trip.id).length === 0) {
        showCreateImageResult('この親トリップには子トリップがありません。子トリップを作成し、スタンプを追加してください。', null, null);
        openCreateImageModal();
        return;
      }
      const dataUrl = await generateEinkStampSheetDataUrl(trip);
      if (!dataUrl) {
        const msg = trip.isParent
          ? 'この親トリップの子トリップに、スタンプ（写真編集の「スタンプ」チェック）が設定された写真がありません。'
          : 'スタンプ（写真編集の「スタンプ」チェック）が設定された写真がありません。';
        showCreateImageResult(msg, null, null);
      } else {
        showCreateImageResult('スタンプ画像を作成しました。', dataUrl, `${sanitizeFileNamePart(trip.name)}_stamps.png`);
        setStatus('スタンプ画像を作成しました');
        try {
          await persistInkImageToGallery(trip, dataUrl, 'stamp-ink', 'stampink');
        } catch (saveErr) {
          console.error('スタンプ画像の保存エラー:', saveErr);
        }
      }
      openCreateImageModal();
    } catch (err) {
      console.error('スタンプ画像生成エラー:', err);
      showCreateImageResult('スタンプ画像の生成に失敗しました: ' + (err.message || String(err)), null, null);
      openCreateImageModal();
    } finally {
      if (btn) btn.textContent = originalBtnText;
    }
    return;
  }

  const cfg = cachedAiConfig ?? (await loadUserAiConfig());
  const provider = cfg?.provider || 'gemini';
  const apiKey = cfg?.apiKey?.trim();

  if (!apiKey) {
    alert('AI画像生成にはAPIキーが必要です。AI設定でAPIキーを入力してください。');
    return;
  }

  if (provider === 'anthropic') {
    alert('Anthropicは画像生成に対応していません。AI設定でGeminiまたはOpenAIを選択してください。');
    return;
  }

  // アニメ生成用cfg（プロバイダーはユーザー設定を使用し、モデルは「ロウ/ミドル/ハイ」選択に応じて選ぶ）
  const modelLevel = document.getElementById('modelLevelSelect')?.value || 'low';
  const animeCfg = {
    provider,
    apiKey,
    model: getModelForLevel(provider, modelLevel) || cfg?.model || null
  };

  const style = ANIME_STYLES[styleId] || ANIME_STYLES['chikyu-cover'];
  const isDetail4Pages = styleId === 'detail4pages';
  const isInfographic = styleId === 'infographic';
  const isEventStory = styleId === 'event-story';
  const isMeishoUkiyoe = styleId === 'meisho-ukiyoe';
  const isCoverInk = styleId === 'cover-ink';

  try {
    if (btn) btn.textContent = '画像生成中...';
    setStatus('アニメ画像を生成中...');

    // カバーInk: 既存のアニメ表紙生成と同じ組み立てだが、E-Ink向けの白黒線画プロンプトを使う
    if (isCoverInk) {
      setStatus('E-ink向けカバー画像を生成中...');
      if (btn) btn.textContent = 'カバー生成中...';
      try {
        const rawDataUrl = await generateEinkCoverImage(trip, animeCfg);
        // AI生成画像にはQRコードが含まれないため、右下に合成する
        const dataUrl = rawDataUrl ? await overlayQrCodeOnDataUrl(rawDataUrl, buildTripShareUrl(trip)) : null;
        if (dataUrl) {
          showCreateImageResult('カバー画像を作成しました。', dataUrl, `${sanitizeFileNamePart(trip.name)}_cover.png`);
          openCreateImageModal();
          setStatus('カバー画像を作成しました');
          try {
            await persistInkImageToGallery(trip, dataUrl, 'cover-ink', 'coverink');
          } catch (saveErr) {
            console.error('カバー画像の保存エラー:', saveErr);
          }
        } else {
          showCreateImageResult('カバー画像の生成に失敗しました。APIキーと入力内容を確認してください。', null, null);
          openCreateImageModal();
        }
      } catch (err) {
        console.error('カバー画像生成エラー:', err);
        showCreateImageResult('カバー画像の生成に失敗しました: ' + (err.message || String(err)), null, null);
        openCreateImageModal();
      }
      return;
    }

    const charImg = await getCharacterImageForGeneration();

    // 出来事生成: ユーザーが入力した出来事を元に5コマアニメを生成（キャラ画像必須）
    if (isEventStory) {
      if (!charImg) {
        alert('出来事生成ではキャラ画像が必須です。キャラ画像をアップロードしてください。');
        return;
      }
      const eventStoryInput = document.getElementById('eventStoryInput');
      const eventText = eventStoryInput?.value?.trim();
      if (!eventText) {
        alert('出来事の説明を入力してください。\n例：山道で老夫婦が運転する車に遭遇して、それに乗せてもらい難を逃れた');
        return;
      }

      setStatus('出来事から5コマアニメを生成中...');
      if (btn) btn.textContent = '出来事アニメ生成中...';

      const tripName = trip.name || '旅行';
      const eventPromptParts = [
        `旅行「${tripName}」での以下の出来事を、5コマのマンガ形式で優しいタッチのアニメとして表現してください。`,
        '',
        '【重要】画像内のすべての言葉・説明・吹き出しのセリフ・ラベル・タイトルは必ず日本語のみで記述してください。英語は一切使用しないでください。',
        '',
        '【スタイル】優しく温かみのあるタッチ。柔らかい色調、アニメ調。ソフトで親しみやすいイラスト。',
        '',
        '【必須】',
        '- 1枚の画像内に5コマを縦に並べた旅行記ページのレイアウト。',
        '- アップロードされたキャラクターを主人公として、全5コマに登場させる。',
        '- 各コマでキャラクターが吹き出しで出来事を説明・表現する。吹き出しの言葉は全て日本語。',
        '- 出来事の流れを5コマで順に展開して表現する。',
        '- 実写感は残さず、優しいアニメ調で統一。',
        '',
        '【出来事の内容 - 5コマで展開して表現】',
        eventText,
        '',
        '【画質】輪郭がはっきりした高精細で綺麗な仕上がりに。ぼやけた描写は避け、細部まで丁寧に描いてください。'
      ];

      // 旅の風景が背景として伝わるよう、実際の写真も参照画像に加える
      const eventRefs = await buildAnimeReferenceImages(charImg, trip.photos || [], 3);
      const eventRefPhotos = eventRefs.filter(r => r.kind === 'photo');
      if (eventRefPhotos.length > 0) {
        eventPromptParts.push('');
        eventPromptParts.push(`【添付の参照写真（${eventRefPhotos.length}枚）】2枚目以降はこの旅で実際に撮影した写真です。背景の風景づくりの参考にして、実在の場所の雰囲気が伝わるように描いてください。`);
      }

      const generatedDataUrl = await generateImageWithAI(eventPromptParts.join('\n'), eventRefs.map(r => r.dataUrl), animeCfg);
      if (generatedDataUrl) {
        await finalizeGeneratedAnime(currentTrip, generatedDataUrl, {
          style: 'event-story',
          eventText: eventText
        }, 'event');
        setStatus('出来事の5コマアニメを生成しました');
        // 入力欄をクリア
        if (eventStoryInput) eventStoryInput.value = '';
      } else {
        alert('出来事アニメの生成に失敗しました。APIキーと入力内容を確認してください。');
      }
      return;
    }

    // 名所浮世絵風: 名所情報をWikipediaや旅行記から収集し、浮世絵風の絵画を生成
    if (isMeishoUkiyoe) {
      const meishoInput = document.getElementById('meishoUkiyoeInput');
      const meishoText = meishoInput?.value?.trim();
      if (!meishoText) {
        alert('名所の説明を入力してください。\n例：お遍路第六番札所安楽寺の巡礼記');
        return;
      }

      const ukiyoeStyleSelect = document.getElementById('meishoUkiyoeStyleSelect');
      const ukiyoeStyle = ukiyoeStyleSelect?.value || 'hiroshige';
      const ukiyoeArtistName = ukiyoeStyle === 'hiroshige' ? '歌川広重' : '葛飾北斎';

      setStatus('名所情報を収集中...');
      if (btn) btn.textContent = '名所情報収集中...';

      // トリップの旅行記と写真から名所関連情報を収集
      const tripName = trip.name || '旅行';
      const photos = trip.photos || [];

      // 名所に関連する写真を広く収集（キーワードマッチング）
      const meishoKeywords = meishoText.split(/[、。・\s]+/).filter(w => w.length >= 2);
      const relatedPhotos = photos.filter(p => {
        const photoText = [p.name, p.placeName, p.description].filter(Boolean).join(' ');
        return meishoKeywords.some(keyword => photoText.includes(keyword));
      });

      // 写真からの詳細情報を収集
      const photoInfo = {
        places: [],
        landmarks: [],
        descriptions: [],
        stampRally: []
      };

      relatedPhotos.forEach(p => {
        if (p.placeName && !photoInfo.places.includes(p.placeName)) {
          photoInfo.places.push(p.placeName);
        }
        if (p.name) {
          photoInfo.landmarks.push(p.name);
        }
        if (p.description) {
          photoInfo.descriptions.push(p.description);
        }
        if (p.landmarkNo) {
          photoInfo.stampRally.push(`第${p.landmarkNo}番: ${p.name || '名所'}`);
        }
      });

      // 旅行記から該当箇所を詳細に抽出
      // （Firestoreには本文が残らないため、Storage上の旅行記も取得対象にする）
      let travelogueContext = '';
      let travelogueDetails = [];
      let travelogueHtmlForUkiyoe = trip.travelogueHtml && trip.travelogueHtml.trim() ? trip.travelogueHtml : '';
      if (!travelogueHtmlForUkiyoe) {
        const tUrl = trip.travelogueUrl || getLatestTravelogueEntry(trip)?.url || null;
        if (tUrl) {
          try {
            const tRes = await fetch(tUrl);
            if (tRes.ok) travelogueHtmlForUkiyoe = await tRes.text();
          } catch (err) {
            console.warn('旅行記の取得に失敗（スキップ）:', err);
          }
        }
      }
      if (travelogueHtmlForUkiyoe) {
        const sections = parseTravelogueSections(travelogueHtmlForUkiyoe);
        // 名所に関連するセクションを抽出
        const relatedSections = sections.filter(s => {
          const sectionText = s.title + s.text;
          return meishoKeywords.some(keyword => sectionText.includes(keyword));
        });

        if (relatedSections.length > 0) {
          travelogueContext = relatedSections.map(s =>
            (s.title ? `【${s.title}】` : '') + s.text
          ).join('\n\n');
          travelogueDetails = relatedSections.map(s => s.text);
        } else {
          // 関連セクションがなければ全体のサマリーを使用
          travelogueContext = sections.map(s => s.text).join(' ').slice(0, 800);
        }
      }

      // トリップの説明・背景情報
      const tripBackground = trip.description || '';

      // 一連の作品名を抽出（例: お遍路八十八ケ所巡り）
      const seriesMatch = meishoText.match(/(お遍路.*?巡り|四国.*?巡礼|.*?街道|.*?参り|.*?巡り|.*?八十八.*)/);
      const seriesName = seriesMatch ? seriesMatch[1] : '';

      setStatus('浮世絵風の絵画を生成中...');
      if (btn) btn.textContent = '浮世絵生成中...';

      // キャラクター画像と、実物の北斎・広重作品（スタイル参照）を取得。
      // 文章だけで「北斎風」と指示するより、実物を見せた方が画風の再現度が上がる。
      const charImg = await getCharacterImageForGeneration();
      const styleRefDataUrl = await getUkiyoeStyleReferenceImage(ukiyoeStyle);

      // 情景ブリーフ: 生の情報を全てプロンプトに詰め込む代わりに、
      // 何を描くべきかをテキストモデルで一度短く要約させ、それを核にする。
      // 長い箇条書きの羅列より、要点を絞った短い指示の方が画像生成モデルの追従性が高い。
      setStatus('情景を要約中...');
      const briefSource = [
        tripBackground,
        photoInfo.places.length > 0 ? `訪問場所: ${photoInfo.places.join('、')}` : '',
        photoInfo.landmarks.length > 0 ? `名所: ${photoInfo.landmarks.join('、')}` : '',
        photoInfo.descriptions.join('。'),
        travelogueContext
      ].filter(Boolean).join('\n');
      const sceneBrief = (await buildSceneBrief(briefSource, animeCfg)) || meishoText;

      // 参照写真: 名所に関連する写真を優先し、見つからなければ旅全体から補う
      setStatus('参照画像を準備中...');
      const photosForRef = relatedPhotos.length > 0 ? relatedPhotos : photos;
      const contentRefs = await buildAnimeReferenceImages(charImg, photosForRef, 3);
      const ukiyoeRefs = styleRefDataUrl
        ? [{ dataUrl: styleRefDataUrl, kind: 'style' }, ...contentRefs]
        : contentRefs;

      // 添付した参照画像を番号付きで説明する（画像の意味をモデルに正しく伝えるため）
      let refIdx = 0;
      const refExplain = [];
      if (styleRefDataUrl) {
        refIdx++;
        refExplain.push(`- 参照画像${refIdx}: ${ukiyoeArtistName}の実際の代表作です。人物や構図をそのまま描き写すのではなく、筆致・色彩・空気感などの画風の手本として使ってください。`);
      }
      if (charImg) {
        refIdx++;
        refExplain.push(`- 参照画像${refIdx}: 旅の主人公です。浮世絵の中の小さな旅人として描いてください（画面の10-15%程度）。`);
      }
      const photoRefCount = ukiyoeRefs.filter(r => r.kind === 'photo').length;
      if (photoRefCount > 0) {
        const startIdx = refIdx + 1;
        refIdx += photoRefCount;
        refExplain.push(`- 参照画像${startIdx}${photoRefCount > 1 ? `〜${refIdx}` : ''}: この名所で実際に撮影した写真です。建物の形・屋根・門・自然の様子など写真から読み取れる特徴を正確に反映してください。`);
      }

      const ukiyoePrompt = [
        `${ukiyoeArtistName}風の浮世絵を1枚生成してください。`,
        '',
        '【絶対条件（最優先で守る）】',
        '1. 添付の参照画像の画風・筆致・色彩を忠実に再現する（下記の参照画像の説明を参照）。',
        '2. 名所の建物・風景を画面の主役として大きく描く（画面の80-85%）。人物は10-15%程度に小さく、写実的にはせずソフトなタッチで。',
        '3. 画像内の文字は全て日本語のみ。英語は一切使用しない。',
        '',
        '【この絵で描く情景】',
        sceneBrief,
        '',
        seriesName ? `【シリーズ名】画像内に「${seriesName}」という作品シリーズ名を配置` : '',
        photoInfo.stampRally.length > 0 ? `【札所】${photoInfo.stampRally.slice(0, 5).join('、')}（御朱印や札所の雰囲気を反映）` : '',
        '',
        '【参照画像について】',
        ...refExplain,
        '',
        '輪郭がはっきりした高精細で綺麗な仕上がりにし、ぼやけた描写は避けてください。'
      ].filter(line => line !== '');

      const promptText = ukiyoePrompt.join('\n');
      setStatus('浮世絵を生成中...');
      const generatedDataUrl = await generateImageWithAI(promptText, ukiyoeRefs.map(r => r.dataUrl), animeCfg);

      if (generatedDataUrl) {
        await finalizeGeneratedAnime(currentTrip, generatedDataUrl, {
          style: 'meisho-ukiyoe',
          meishoText: meishoText,
          ukiyoeStyle: ukiyoeStyle,
          ukiyoeArtist: ukiyoeArtistName
        }, 'ukiyoe');
        setStatus(`${ukiyoeArtistName}風の浮世絵を生成しました`);
        // 入力欄をクリア
        if (meishoInput) meishoInput.value = '';
      } else {
        alert('浮世絵の生成に失敗しました。APIキーと入力内容を確認してください。');
      }
      return;
    }

    // 詳細4ページ: キャラ主人公で4枚の5コマアニメ画像を生成（キャラ画像必須）
    if (isDetail4Pages) {
      if (!charImg) {
        alert('詳細4ページではキャラ画像が必須です。キャラ画像をアップロードしてください。');
        return;
      }
      // 4ページ分の内容を先にまとめて取得（Storage上の旅行記も参照。重複取得を避けるため1回だけ計算）
      const quarterContents = await Promise.all([1, 2, 3, 4].map(p => getDetail4PagesQuarterContent(trip, p)));
      const hasContent = quarterContents.some(Boolean);
      if (!hasContent) {
        alert('旅行記または写真・説明がありません。まず旅行記を生成するか、写真に説明を追加してください。');
        return;
      }
      const generatedAnimesToAdd = [];
      const tripName = trip.name || '旅行';
      const pageArcLabels = ['旅の始まり', '前半の展開', '後半の展開', '旅の締めくくり'];
      for (let page = 1; page <= 4; page++) {
        setStatus(`詳細4ページ生成中 ${page}/4...`);
        if (btn) btn.textContent = `詳細4ページ生成中 (${page}/4)...`;

        const quarterContent = quarterContents[page - 1];

        // 情景ブリーフ: 1/4に機械的に切られた旅行記の断片をそのまま渡すより、
        // このページで描くべき内容を先に短く要約させた方が5コマの構成が明確になる
        setStatus(`ページ${page}/4の情景を要約中...`);
        const pageBrief = quarterContent ? await buildSceneBrief(quarterContent, animeCfg, 150) : null;

        const pagePromptParts = [
          `この旅行「${tripName}」を4ページのマンガで表現します。今回は${page}/4ページ目（${pageArcLabels[page - 1]}）です。`,
          '4枚の画像で旅行全体をカバーするよう、各ページは旅の1/4の内容を担当し、4ページ通して読むと旅の流れが繋がるようにします。',
          '',
          '以下の内容を1枚の画像内に5コマのマンガ形式で表現してください。',
          '',
          '【重要】画像内のすべての言葉・説明・吹き出しのセリフ・ラベル・タイトルは必ず日本語のみで記述してください。英語は一切使用しないでください。',
          '',
          '【スタイル】日本の旅行ガイドブック風のイラスト。ソフトで温かみのあるタッチ、柔らかい色調、アニメ調。特定のブランド名は使用しない。',
          '',
          '【必須】',
          '- 1枚の画像内に5コマを縦に並べた旅行記ページのレイアウト。',
          '- アップロードされたキャラクターを主人公として、全5コマに登場させる。',
          '- 各コマでキャラクターが吹き出しで旅のスポット・名所・情景を説明する。吹き出しの言葉は全て日本語。',
          '- 5コマはそれぞれ異なる場所・出来事・瞬間を描くこと。似た構図やセリフの繰り返しは避ける。',
          '- 実写感は残さずアニメ調で統一。',
          '',
          `【ページ${page}/4で描く内容】`,
          pageBrief || quarterContent.slice(0, 1100),
          '',
          '【画質】輪郭がはっきりした高精細で綺麗な仕上がりに。ぼやけた描写は避け、細部まで丁寧に描いてください。'
        ];

        // このページが担当する区間の写真を参照画像として添付する
        const allPhotos = trip.photos || [];
        const qSize = Math.ceil(allPhotos.length / 4);
        const quarterPhotos = allPhotos.slice((page - 1) * qSize, (page - 1) * qSize + qSize);
        const pageRefs = await buildAnimeReferenceImages(charImg, quarterPhotos, 3);
        const pageRefPhotos = pageRefs.filter(r => r.kind === 'photo');
        if (pageRefPhotos.length > 0) {
          pagePromptParts.push('');
          pagePromptParts.push(`【添付の参照写真（${pageRefPhotos.length}枚）】${charImg ? '2枚目以降' : '添付'}はこの区間で実際に撮影した写真です。写っている風景・建物の特徴を各コマの背景に反映し、実在の場所が伝わるように明瞭に描いてください。`);
          pageRefPhotos.forEach((r, i) => {
            const label = [r.label, r.description].filter(Boolean).join(' - ');
            if (label) pagePromptParts.push(`- 参照写真${i + 1}: ${label}`);
          });
        }

        const generatedDataUrl = await generateImageWithAI(pagePromptParts.join('\n'), pageRefs.map(r => r.dataUrl), animeCfg);
        if (generatedDataUrl) {
          const storageUrl = await uploadAnimeImageToStorage(trip.id, generatedDataUrl, 'detail');
          generatedAnimesToAdd.push({
            url: storageUrl,
            timestamp: Date.now(),
            style: `detail4pages-page${page}`
          });
        }
      }

      if (generatedAnimesToAdd.length > 0) {
        if (!currentTrip.generatedAnimes) currentTrip.generatedAnimes = [];
        currentTrip.generatedAnimes.push(...generatedAnimesToAdd);
        await saveTrip({ silent: true });
        renderGeneratedAnimesList();
        showAnimeImageViewer(generatedAnimesToAdd, currentTrip.name || '');
        setStatus(`${generatedAnimesToAdd.length}ページのアニメを生成しました`);
      } else {
        alert('詳細4ページの生成に失敗しました。APIキーと旅行記の内容を確認してください。');
      }
      return;
    }

    // インフォグラフィック: 旅行記＋追加情報（統計データなど）から、データ・グラフ・イラストを
    // 交えたカラフルなインフォグラフィックを4枚生成する（キャラ画像は不要）
    if (isInfographic) {
      const infographicInput = document.getElementById('infographicInput');
      const extraInfo = infographicInput?.value?.trim() || '';

      setStatus('旅行記の内容を取得中...');
      const travelogueRaw = await getTravelogueTextForTrip(trip, 3000);
      const combinedSource = [
        trip.description,
        travelogueRaw,
        extraInfo ? `【追加情報】${extraInfo}` : ''
      ].filter(Boolean).join('\n\n');

      if (!combinedSource.trim()) {
        alert('旅行記・説明・追加情報のいずれかが必要です。まず旅行記を生成するか、追加情報欄にデータを入力してください。');
        return;
      }

      const tripName = trip.name || '旅行';
      const photos = trip.photos || [];
      const refImages = await buildAnimeReferenceImages(null, photos, 3);
      const refPhotoUrls = refImages.map(r => r.dataUrl);

      // 4枚それぞれの切り口。「データで見る旅」は追加情報があればそれを優先的にグラフ化する。
      const infographicPages = [
        { title: '旅の概要・ハイライト', instruction: '旅の全体像（訪問地・日数・移動ルート）と主なハイライトを、簡単な地図イラストやピクトグラムを交えて紹介する。' },
        {
          title: 'データで見る旅',
          instruction: extraInfo
            ? '【追加情報】に書かれている統計データを主役にし、棒グラフ・円グラフ・折れ線グラフなど具体的なグラフで数字の変化や割合を視覚化する。'
            : '旅行記から読み取れる訪問回数・時間帯・移動手段などの傾向を、グラフやピクトグラムで視覚化する。'
        },
        { title: '訪問スポット・体験', instruction: '実際に訪れた場所や体験を、アイコンやイラストマップで楽しく紹介する。' },
        { title: '旅の思い出・エピソード', instruction: '旅行記に書かれた印象的な出来事やエピソードを、イラストと短いキャプションで振り返る。' }
      ];

      const generatedAnimesToAdd = [];
      for (let page = 1; page <= 4; page++) {
        const pageTheme = infographicPages[page - 1];
        const isDataPage = page === 2;
        setStatus(`インフォグラフィック生成中 ${page}/4...`);
        if (btn) btn.textContent = `インフォグラフィック生成中 (${page}/4)...`;

        // 「データで見る旅」ページは、要約によって数値が変質・欠落しないよう、
        // 追加情報欄の文章をそのまま使う（要約しない）。他のページは情景ブリーフで要約する。
        let pageContent;
        if (isDataPage && extraInfo) {
          pageContent = extraInfo;
        } else {
          setStatus(`ページ${page}/4の情景を要約中...`);
          pageContent = (await buildSceneBrief(combinedSource, animeCfg, 220)) || combinedSource.slice(0, 1200);
        }

        const promptParts = [
          `旅行「${tripName}」のインフォグラフィックを4枚シリーズで作成します。今回は${page}/4枚目「${pageTheme.title}」です。`,
          '',
          '【重要】画像内のすべての文字・数字・ラベル・見出しは必ず日本語のみで記述してください。英語は一切使用しないでください。',
          '',
          '【スタイル】カラフルで親しみやすいインフォグラフィックデザイン。データ・グラフ・イラストを組み合わせ、雑誌や旅行ガイドのように整ったレイアウトにする。単色べたぬりや白黒ではなく、鮮やかで多彩な配色を使うこと。',
          '',
          `【このページの内容】${pageTheme.title}：${pageTheme.instruction}`,
          '',
          isDataPage && extraInfo
            ? '【入力された統計データ・数値情報（最優先で正確に反映すること。数値・割合・年代などを書き換えたり、記載のない数値を創作したりしないでください）】'
            : '【元データ】',
          pageContent,
          '',
          '【忠実性について】上記のデータ・地名・固有名詞・数値は入力情報に忠実に描いてください。特に数値やグラフの比率は入力内容と矛盾しないようにしてください。',
          '',
          '【画質】輪郭がはっきりした高精細で綺麗な仕上がりに。文字・数字は読みやすく大きめに配置してください。'
        ];

        if (refPhotoUrls.length > 0) {
          promptParts.push('');
          promptParts.push('【添付の参照写真】この旅で実際に撮影した写真です。イラストの雰囲気・実在の風景の参考にしてください。');
        }

        const generatedDataUrl = await generateImageWithAI(promptParts.join('\n'), refPhotoUrls, animeCfg);
        if (generatedDataUrl) {
          const storageUrl = await uploadAnimeImageToStorage(trip.id, generatedDataUrl, 'infographic');
          generatedAnimesToAdd.push({
            url: storageUrl,
            timestamp: Date.now(),
            style: `infographic-page${page}`
          });
        }
      }

      if (generatedAnimesToAdd.length > 0) {
        if (!currentTrip.generatedAnimes) currentTrip.generatedAnimes = [];
        currentTrip.generatedAnimes.push(...generatedAnimesToAdd);
        await saveTrip({ silent: true });
        renderGeneratedAnimesList();
        showAnimeImageViewer(generatedAnimesToAdd, currentTrip.name || '');
        setStatus(`${generatedAnimesToAdd.length}枚のインフォグラフィックを生成しました`);
      } else {
        alert('インフォグラフィックの生成に失敗しました。APIキーと入力内容を確認してください。');
      }
      return;
    }

    // 表紙系スタイル: 単一画像を生成
    const tripName = trip.name || '旅行';

    // トリップ名から表紙タイトルを生成
    const photos = trip.photos || [];
    const places = [...new Set(photos.filter(p => p.placeName).map(p => p.placeName))];

    function buildCoverTitle(name) {
      // Step1: Day7・第7日・7日目 などの日付プレフィックスを除去
      let s = name.replace(/^(Day\s*\d+|第?\d+日目?)[:\s　]+/i, '').trim();

      // Step2: 活動系サフィックスを除去して地名だけ残す
      s = s.replace(/[のの]?(走り方|歩き方|旅行記?|観光|めぐり|巡り|サイクリング|ツーリング|ハイキング|トレッキング|探訪|散策|見学|紀行|一周|縦断|横断|制覇|の旅|ライド|ウォーク|ドライブ).*$/, '').trim();

      // Step3: 漢字・ひらがな・カタカナ・長音符・中点で構成される地名部分を抽出
      const locMatch = s.match(/[一-龥ぁ-んァ-ンー々・〜]{2,}/);
      if (locMatch) return `${locMatch[0]}の歩き方`;

      // Step4: 元の cleaned 文字列が使えるならそのまま使う
      if (s.length >= 2) return `${s}の歩き方`;

      // Step5: 写真の地名から補完
      if (places.length > 0) {
        const mainPlace = places[0].replace(/(市|町|村|区|県|府|道).*/u, '');
        if (mainPlace.length >= 2) return `${mainPlace}の歩き方`;
      }

      return `${name}の歩き方`;
    }

    let coverTitle = buildCoverTitle(tripName);

    const promptParts = [
      style.prompt,
      `画像内に「${coverTitle}」というタイトルを大きく、読みやすく配置してください。`,
      '',
      `【表紙タイトル】${coverTitle}`,
      `【旅行名】${tripName}`,
    ];

    if (charImg) {
      promptParts.push('【メインキャラクター】アップロードされた人物の特徴（顔立ち、髪型、表情など）を保ちながら、優しく親しみやすいタッチのアニメキャラクターに変換してください。柔らかな線、温かみのある色彩、穏やかな表情で描いてください。このキャラクターを旅の主人公として、選択されたテーマスタイルに完全に合わせ、背景や他の要素と統一された画風で描いてください。写真のような実写感は残さず、全体が一つのアニメ作品として調和するように仕上げてください。');
    }

    if (trip.url) {
      promptParts.push('【ブログ】旅の詳細記録あり');
    }

    if (photos.length > 0) {
      if (places.length > 0) {
        promptParts.push(`【訪問地】${places.slice(0, 8).join('、')}`);
      }

      const landmarks = photos.filter(p => p.landmarkNo);
      if (landmarks.length > 0) {
        const landmarkNames = landmarks.map(p => `${p.landmarkNo}: ${p.name || '名所'}`).slice(0, 5).join('、');
        promptParts.push(`【スタンプラリー】${landmarkNames}`);
      }

      // 地球の歩き方表紙風: マップ情報を追加
      if (styleId === 'chikyu-cover') {
        // ルート順の地名リスト（重複除去）。10件を超える場合は先頭に偏らないよう
        // 全区間から均等な間隔で抜き出し、旅の後半が欠落しないようにする。
        const uniqueRouteNames = photos
          .filter(p => p.name || p.placeName)
          .map(p => p.name || p.placeName)
          .filter((v, i, arr) => arr.indexOf(v) === i);
        const routeNames = uniqueRouteNames.length <= 10
          ? uniqueRouteNames
          : Array.from({ length: 10 }, (_, i) =>
              uniqueRouteNames[Math.round(i * (uniqueRouteNames.length - 1) / 9)]
            ).filter((v, i, arr) => arr.indexOf(v) === i);
        if (routeNames.length > 0) {
          promptParts.push(`【ルート順のスポット（ミニマップに使用）】${routeNames.join(' → ')}`);
        }
        const hasGps = photos.some(p => p.lat != null && p.lng != null);
        if (hasGps) {
          const startPhoto = photos.find(p => p.lat != null);
          const endPhoto = [...photos].reverse().find(p => p.lat != null);
          if (startPhoto && endPhoto) {
            const startName = startPhoto.name || startPhoto.placeName || 'スタート';
            const endName = endPhoto.name || endPhoto.placeName || 'ゴール';
            promptParts.push(`【スタート〜ゴール】${startName} → ${endName}`);
          }
        }
        promptParts.push('【ミニマップの指示】表紙の一角（右下や左下など）に手描き風の小さなルートマップを配置してください。訪問スポットをドット（●）でマークし、矢印の線でつないだシンプルな地図スタイル。旅行ガイドブックらしい味のある手書きイラスト調で。');
      }
    }

    // 情景ブリーフ: 説明・写真のハイライト・旅行記本文を一度短く要約し、雰囲気の核にする。
    // 生の長文をそのまま箇条書きで並べるより、要点を絞った方が指示追従性が高い。
    setStatus('情景を要約中...');
    // 同じ説明文が繰り返し登録されている写真があっても、要約の元データが偏らないよう重複を除去
    const highlightDescriptions = [...new Set(photos.filter(p => p.description).map(p => p.description))].slice(0, 5);
    const travelogueRaw = await getTravelogueTextForTrip(trip, 1200);
    const briefSource = [trip.description, highlightDescriptions.join('。'), travelogueRaw].filter(Boolean).join('\n');
    const sceneBrief = briefSource ? await buildSceneBrief(briefSource, animeCfg) : null;
    if (sceneBrief) {
      promptParts.push(`【旅の雰囲気】${sceneBrief}`);
    } else if (trip.description) {
      promptParts.push(`【旅行の説明】${trip.description}`);
    }

    // 実際の旅行写真を参照画像として添付し、実在の風景・建物に基づいて描かせる
    setStatus('参照写真を準備中...');
    const refImages = await buildAnimeReferenceImages(charImg, photos);
    const refPhotos = refImages.filter(r => r.kind === 'photo');
    if (refPhotos.length > 0) {
      promptParts.push('');
      promptParts.push(`【添付の参照写真（${refPhotos.length}枚）】${charImg ? '2枚目以降' : '添付'}はこの旅で実際に撮影した風景写真です。写真に写っている建物・自然・風景の特徴を読み取り、それらを画風に合わせて描き起こしてください。実在の場所が伝わる、具体的で明瞭な描写にしてください。`);
      refPhotos.forEach((r, i) => {
        const label = [r.label, r.description].filter(Boolean).join(' - ');
        if (label) promptParts.push(`- 参照写真${i + 1}: ${label}`);
      });
    }

    promptParts.push('');
    promptParts.push(`この旅行の魅力が一目で伝わる、「${coverTitle}」というタイトルの魅力的な表紙画像を作成してください。`);
    promptParts.push('【画質】輪郭がはっきりした高精細で綺麗な仕上がりにしてください。ぼやけた描写や不明瞭な要素は避け、細部まで丁寧に描いてください。');
    if (charImg) {
      promptParts.push('人物は完全にアニメキャラクターとして描き直し、表紙全体が統一されたアニメ作品の一部として自然に調和するように仕上げてください。実写的な要素は一切残さないでください。');
    }

    const prompt = promptParts.join('\n');
    setStatus('アニメ画像を生成中...');
    const generatedDataUrl = await generateImageWithAI(prompt, refImages.map(r => r.dataUrl), animeCfg);

    if (generatedDataUrl) {
      try {
        setStatus('画像をStorageに保存中...');
        await finalizeGeneratedAnime(currentTrip, generatedDataUrl, { style: styleId }, 'cover');
        setStatus('アニメ画像を生成しました');
      } catch (err) {
        console.error('アニメ画像の保存エラー:', err);
        alert('画像は生成されましたが、保存に失敗しました: ' + (err.message || String(err)));
      }
    } else {
      const errorMsg = '画像生成に失敗しました（画像データが返されませんでした）。\n\nAI設定でAPIキーが正しく設定されているか確認してください。';
      alert(errorMsg);
      setStatus('画像生成に失敗しました');
    }
  } catch (err) {
    console.error('アニメ生成エラー:', err);
    const errorMsg = '画像生成に失敗しました: ' + (err.message || String(err));
    alert(errorMsg);
  } finally {
    if (btn) btn.textContent = originalBtnText;
  }
}

function renderGeneratedAnimesList() {
  const container = document.getElementById('generatedAnimesList');
  if (!container) {
    console.warn('generatedAnimesListコンテナが見つかりません');
    return;
  }

  container.innerHTML = '';

  if (!currentTrip || !currentTrip.generatedAnimes || currentTrip.generatedAnimes.length === 0) {
    return;
  }

  const total = currentTrip.generatedAnimes.length;

  currentTrip.generatedAnimes.forEach((anime, index) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;display:inline-flex;flex-direction:column;align-items:center;gap:2px;';

    // サムネイル画像
    const img = document.createElement('img');
    img.src = anime.url;
    img.loading = 'lazy';
    img.alt = `${currentTrip.name}のアニメ画像`;
    img.style.cssText = 'height:90px;width:auto;border-radius:4px;box-shadow:0 2px 4px rgba(0,0,0,0.2);cursor:pointer;display:block;';
    img.title = 'クリックで拡大表示';
    img.onclick = () => {
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.9);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:pointer;';
      const fullImg = document.createElement('img');
      fullImg.src = anime.url;
      fullImg.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;';
      modal.appendChild(fullImg);
      modal.onclick = () => document.body.removeChild(modal);
      document.body.appendChild(modal);
    };
    wrapper.appendChild(img);

    // 削除ボタン（画像右上に絶対配置）
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.title = '画像を削除';
    deleteBtn.style.cssText = 'position:absolute;top:2px;right:2px;background:#dc3545;color:white;border:none;border-radius:50%;width:18px;height:18px;font-size:12px;line-height:1;cursor:pointer;padding:0;z-index:1;';
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('この画像を削除しますか？')) return;
      try {
        await deleteAnimeImageFromStorage(anime.url);
        currentTrip.generatedAnimes.splice(index, 1);
        await saveTrip({ silent: true });
        renderGeneratedAnimesList();
        setStatus('画像を削除しました');
      } catch (err) {
        console.error('画像削除エラー:', err);
        alert('画像の削除に失敗しました: ' + (err.message || String(err)));
      }
    };
    wrapper.appendChild(deleteBtn);

    // 並び替えボタン（画像の下に横並び）
    const orderRow = document.createElement('div');
    orderRow.style.cssText = 'display:flex;gap:2px;';

    const moveBtn = (label, delta, title) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.style.cssText = 'background:#555;color:#fff;border:none;border-radius:3px;width:22px;height:18px;font-size:11px;cursor:pointer;padding:0;line-height:1;';
      btn.disabled = delta < 0 ? index === 0 : index === total - 1;
      if (btn.disabled) btn.style.opacity = '0.3';
      btn.onclick = async (e) => {
        e.stopPropagation();
        const arr = currentTrip.generatedAnimes;
        const target = index + delta;
        [arr[index], arr[target]] = [arr[target], arr[index]];
        await saveTrip({ silent: true });
        renderGeneratedAnimesList();
      };
      return btn;
    };

    orderRow.appendChild(moveBtn('←', -1, '左へ移動'));
    orderRow.appendChild(moveBtn('→', 1, '右へ移動'));
    wrapper.appendChild(orderRow);

    container.appendChild(wrapper);
  });
}


let animeImageViewerList = [];
let animeImageViewerIndex = 0;

function showAnimeImageViewer(animeList, tripName = '') {
  if (!animeList || animeList.length === 0) return;
  animeImageViewerList = animeList;
  const modal = document.getElementById('animeImageViewerModal');
  const bodyEl = document.querySelector('#animeImageViewerModal .anime-viewer-body');
  const counterEl = document.getElementById('animeImageViewerCounter');
  const titleEl = document.getElementById('animeImageViewerTitle');
  const prevBtn = document.getElementById('animeImageViewerPrev');
  const nextBtn = document.getElementById('animeImageViewerNext');
  if (!modal || !bodyEl) return;

  if (titleEl) titleEl.textContent = tripName ? `${tripName} - アニメ` : 'アニメ';

  // カウンター表示
  if (counterEl) {
    counterEl.textContent = `全 ${animeList.length} 枚`;
    counterEl.style.display = '';
  }

  // 前後ボタンを非表示（スクロール表示のため不要）
  if (prevBtn) prevBtn.style.display = 'none';
  if (nextBtn) nextBtn.style.display = 'none';

  // すべてのアニメ画像を縦にスクロール表示
  bodyEl.innerHTML = animeList.map((anime, index) => {
    const styleLabel = anime.style ? ` (${escapeHtml(anime.style)})` : '';
    return `<img src="${escapeHtml(anime.url)}" alt="アニメ画像 ${index + 1}${styleLabel}" class="anime-viewer-display-img" loading="lazy">`;
  }).join('');

  modal.classList.add('open');
}

function closeAnimeImageViewer() {
  document.getElementById('animeImageViewerModal')?.classList.remove('open');
}

function animeImageViewerPrev() {
  if (animeImageViewerList.length <= 1) return;
  animeImageViewerIndex = (animeImageViewerIndex - 1 + animeImageViewerList.length) % animeImageViewerList.length;
  const imgEl = document.getElementById('animeImageViewerImage');
  const counterEl = document.getElementById('animeImageViewerCounter');
  if (imgEl) imgEl.src = animeImageViewerList[animeImageViewerIndex].url;
  if (counterEl) counterEl.textContent = `${animeImageViewerIndex + 1} / ${animeImageViewerList.length}`;
}

function animeImageViewerNext() {
  if (animeImageViewerList.length <= 1) return;
  animeImageViewerIndex = (animeImageViewerIndex + 1) % animeImageViewerList.length;
  const imgEl = document.getElementById('animeImageViewerImage');
  const counterEl = document.getElementById('animeImageViewerCounter');
  if (imgEl) imgEl.src = animeImageViewerList[animeImageViewerIndex].url;
  if (counterEl) counterEl.textContent = `${animeImageViewerIndex + 1} / ${animeImageViewerList.length}`;
}

function closeVideoOverlay() {
  if (videoSequenceTimer) {
    clearTimeout(videoSequenceTimer);
    videoSequenceTimer = null;
  }
  const overlay = document.getElementById('videoOverlay');
  const wrap = document.getElementById('videoPlayerWrap');
  if (overlay) {
    overlay.classList.add('hidden');
    // ポイント名のオーバーレイを削除
    const nameOverlay = overlay.querySelector('.video-overlay-point-name');
    if (nameOverlay) nameOverlay.remove();
  }
  document.querySelector('.map-container')?.classList.remove('map-showing-video');
  if (wrap) {
    wrap.innerHTML = '';
  }
}

function setStatus(msg, isError = false) {
  console.log(msg);
}

function showMarkerSaveBar(pending) {
  pendingMarkerDrag = pending;
  const bar = document.getElementById('mapMarkerSaveBar');
  const label = document.getElementById('mapMarkerSaveLabel');
  if (!bar) return;
  const name = pending.tripRef?.photos?.[pending.photoIdx]?.name;
  if (label) label.textContent = name ? `📍 「${name}」の位置を移動中` : '📍 GPS位置を移動中';
  bar.style.display = '';
}

function hideMarkerSaveBar() {
  pendingMarkerDrag = null;
  const bar = document.getElementById('mapMarkerSaveBar');
  if (bar) bar.style.display = 'none';
  const saveBtn = document.getElementById('mapMarkerSaveBtn');
  const cancelBtn = document.getElementById('mapMarkerCancelBtn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
  if (cancelBtn) cancelBtn.disabled = false;
}

async function getGpsInfo() {
  let gpxStats = null;
  const gpxText = await getGpxContent(currentTrip);
  if (gpxText) {
    gpxStats = getGpxStats(gpxText);
  } else if (currentTrip?.isParent) {
    const children = getChildTrips(currentTrip.id);
    let totalMove = 0;
    let totalTimeH = 0;
    let firstDate = '';
    for (const c of children) {
      const cGpx = await getGpxContent(c);
      if (cGpx) {
        const s = getGpxStats(cGpx);
        if (s) {
          totalMove += s.moveKm;
          if (s.date) firstDate = firstDate || s.date;
          const hours = s.moveKm > 0 && s.velocityKmh > 0 ? s.moveKm / s.velocityKmh : 0;
          totalTimeH += hours;
        }
      }
    }
    if (totalMove > 0) {
      const vel = totalTimeH > 0 ? totalMove / totalTimeH : 0;
      gpxStats = { date: firstDate, moveKm: totalMove, velocityKmh: vel };
    }
  }
  if (gpxStats) {
    const move = gpxStats.moveKm >= 1 ? gpxStats.moveKm.toFixed(1) : gpxStats.moveKm.toFixed(2);
    const vel = gpxStats.velocityKmh >= 1 ? gpxStats.velocityKmh.toFixed(1) : gpxStats.velocityKmh.toFixed(2);
    const inner = [gpxStats.date, `${move}km`, `${vel}km/h`].filter(Boolean).join(' ');
    return inner ? `[${inner}]` : '';
  }
  return '';
}

async function goToDefaultView() {
  currentTrip = null;
  currentPhotoIndex = 0;
  thumbnailsVisible = false;
  stopPlay();
  await updateMapMarkers();
  await updateHeaderInfo();
  renderThumbnails();
  await renderTripDetailPane();
  if (isMobileView() && document.getElementById('tripPanel')?.classList.contains('open')) {
    document.getElementById('tripPanel').classList.remove('open');
    document.getElementById('tripSheetOverlay')?.classList.remove('open');
  }
}

/** ヘッダー要素の参照キャッシュ（毎回querySelector/getElementByIdを回避） */
let _headerDomCache = null;
function getHeaderDom() {
  if (!_headerDomCache) {
    _headerDomCache = {
      line1: document.getElementById('headerLine1'),
      line2: document.getElementById('headerLine2'),
      headerInfo: document.querySelector('.header-info'),
      videoBtn: document.getElementById('headerVideoBtn'),
      headerLogo: document.getElementById('headerLogo'),
      headerMobileTripName: document.getElementById('headerMobileTripName'),
      animeBtn: document.getElementById('headerAnimeBtn'),
      stampBtn: document.getElementById('headerStampBtn'),
      mobileVideoBtn: document.getElementById('mobileVideoBtn'),
      mobileAnimeBtn: document.getElementById('mobileAnimeBtn'),
      mobileStampBtn: document.getElementById('mobileStampBtn'),
      headerControls: document.getElementById('headerControls'),
      headerMobileContent: document.getElementById('headerMobileContent'),
      headerMobileControls: document.getElementById('headerMobileControls'),
    };
  }
  return _headerDomCache;
}

async function updateHeaderInfo() {
  const { line1, line2, headerInfo, videoBtn, headerLogo, headerMobileTripName,
    animeBtn, stampBtn, mobileVideoBtn, mobileAnimeBtn, mobileStampBtn,
    headerControls, headerMobileContent, headerMobileControls } = getHeaderDom();
  if (!line1 || !line2) return;
  if (!currentTrip) {
    line1.textContent = 'トリップを選択';
    line2.textContent = '';
    if (headerInfo) {
      headerInfo.classList.remove('header-info-mobile');
      headerInfo.style.display = ''; // 表示
    }

    // すべてのボタンを非表示
    if (videoBtn) videoBtn.style.display = 'none';
    if (animeBtn) animeBtn.style.display = 'none';
    if (stampBtn) stampBtn.style.display = 'none';
    if (headerMobileTripName) headerMobileTripName.style.display = 'none';
    if (mobileVideoBtn) mobileVideoBtn.style.display = 'none';
    if (mobileAnimeBtn) mobileAnimeBtn.style.display = 'none';
    if (mobileStampBtn) mobileStampBtn.style.display = 'none';

    // ヘッダーコントロールの表示制御
    if (isMobileView()) {
      if (headerControls) headerControls.style.display = 'none';
      if (headerMobileContent) headerMobileContent.style.display = 'none';
      if (headerMobileControls) headerMobileControls.style.display = 'none';
    } else {
      if (headerControls) headerControls.style.display = 'flex';
      if (headerMobileContent) headerMobileContent.style.display = 'none';
      if (headerMobileControls) headerMobileControls.style.display = 'none';
    }

    // トリップが選択されていない時は、ウェブでもモバイルでもロゴを表示
    if (headerLogo) headerLogo.classList.remove('hidden');
    return;
  }

  // トリップが選択されている時のロゴ表示制御
  let hasTravelogue = tripHasTravelogue(currentTrip);

  // 親トリップ用の子トリップリストを 1 回だけ取得（以下で複数回利用）
  const _childTrips = currentTrip.isParent
    ? getChildTrips(currentTrip.id)
    : [];

  // 親トリップの場合は、子トリップに旅行記があるかどうかで判定
  if (currentTrip.isParent) {
    hasTravelogue = _childTrips.some(c =>
      tripHasTravelogue(c)
    );
  }
  // ロゴは常に表示（ウェブ・モバイル共通）
  if (headerLogo) {
    headerLogo.classList.remove('hidden');
  }
  let animes = [];
  if (currentTrip.isParent) {
    // 親トリップの場合、全ての子トリップのアニメとスタンプを集める
    _childTrips.forEach(child => {
      const childAnimes = child.generatedAnimes || child.animes || [];
      animes = animes.concat(childAnimes);
    });
  } else {
    animes = currentTrip.generatedAnimes || currentTrip.animes || [];
  }
  let hasStamps = false;
  if (currentTrip.isParent) {
    hasStamps = _childTrips.some(child => (child.photos || []).some(p => p.isStamp));
  } else {
    hasStamps = (currentTrip.photos || []).some(p => p.isStamp);
  }

  // デスクトップボタンの表示制御
  const hasVideo = getTripVideoUrls().length > 0;
  if (videoBtn) videoBtn.style.display = hasVideo ? '' : 'none';
  if (animeBtn) animeBtn.style.display = animes.length > 0 ? '' : 'none';
  if (stampBtn) stampBtn.style.display = hasStamps ? '' : 'none';

  // モバイルボタンの表示制御
  if (mobileVideoBtn) mobileVideoBtn.style.display = hasVideo ? '' : 'none';
  if (mobileAnimeBtn) mobileAnimeBtn.style.display = animes.length > 0 ? '' : 'none';
  if (mobileStampBtn) mobileStampBtn.style.display = hasStamps ? '' : 'none';

  const name = currentTrip.name || '（無題）';
  const url = currentTrip.url;

  // デスクトップ用のトリップ名HTML（クリックで地図表示に遷移）
  let nameHtml;
  if (url) {
    // ブログURLがある場合は、トリップ名はクリック可能（地図遷移）、URLアイコンを追加
    nameHtml = `<a href="#" class="header-trip-link header-trip-map-link">${escapeHtml(name)}</a> <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="header-blog-icon" title="ブログを開く">🔗</a>`;
  } else {
    // クリックで地図表示に遷移
    nameHtml = `<a href="#" class="header-trip-link header-trip-map-link">${escapeHtml(name)}</a>`;
  }

  // ヘッダーコントロールの表示切り替え（キャッシュ済み参照を使用）

  if (isMobileView()) {
    // モバイル表示
    if (headerControls) headerControls.style.display = 'none';
    if (headerMobileContent) {
      headerMobileContent.style.display = 'flex';
    }
    if (headerMobileControls) headerMobileControls.style.display = 'flex';

    // headerInfoは非表示（モバイルトリップ名を使用）
    if (headerInfo) headerInfo.style.display = 'none';

    // モバイルトリップ名の表示
    if (headerMobileTripName) {
      const tripName = currentTrip.name || '（無題）';
      headerMobileTripName.textContent = tripName;

      // トリップカラーを適用
      const tripColor = currentTrip.color || '#e1306c';
      headerMobileTripName.style.color = tripColor;
      headerMobileTripName.style.display = 'block';

      // クリックイベント：旅行記を開く
      headerMobileTripName.style.cursor = 'pointer';
      headerMobileTripName.onclick = (e) => {
        e.stopPropagation();
        showTravelogueModal();
      };
    }
  } else {
    // デスクトップ表示
    if (headerControls) headerControls.style.display = 'flex';
    if (headerMobileContent) headerMobileContent.style.display = 'none';
    if (headerMobileControls) headerMobileControls.style.display = 'none';
    if (headerInfo) {
      headerInfo.classList.remove('header-info-mobile');
      headerInfo.style.display = ''; // 表示
    }
    const gpxInfo = await getGpsInfo();
    const photos = currentTrip.isParent ? [] : (currentTrip.photos || []);
    let line1Html = nameHtml;
    if (photos.length > 0) {
      line1Html += ` <span class="header-photo-count-toggle">（${photos.length}枚）</span>`;
    }
    if (gpxInfo) {
      line1Html += ' <span class="header-gpx">' + escapeHtml(gpxInfo) + '</span>';
    }
    line1.innerHTML = line1Html;

    let line2Html = '';
    if (currentTrip.description) {
      // 旅行記がある場合は説明の後ろに小さい旅行記ボタンを追加
      if (hasTravelogue) {
        line2Html += escapeHtml(currentTrip.description);
        line2Html += ' <button type="button" class="header-travelogue-btn">📝 旅行記</button>';
      } else if (currentTrip.url) {
        // ブログURLがある場合は(ブログ)を付けて説明全体をリンクに
        line2Html += `<a href="${escapeHtml(currentTrip.url)}" target="_blank" rel="noopener" class="header-trip-link">${escapeHtml(currentTrip.description)}（ブログ）</a>`;
      } else {
        line2Html += escapeHtml(currentTrip.description);
      }
    }
    line2.innerHTML = line2Html;

    // 旅行記ボタンにクリックイベントを追加
    const travelogueBtn = line2.querySelector('.header-travelogue-btn');
    if (travelogueBtn) {
      travelogueBtn.addEventListener('click', (e) => {
        e.preventDefault();
        showTravelogueModal();
      });
    }

    // デスクトップのトリップ名リンクにクリックイベントを追加（旅行記を開く）
    const tripMapLink = line1.querySelector('.header-trip-map-link');
    if (tripMapLink) {
      tripMapLink.addEventListener('click', (e) => {
        e.preventDefault();
        showTravelogueModal();
      });
    }

    // ヘッダーの写真枚数にクリックイベントを追加
    const headerPhotoCount = line1.querySelector('.header-photo-count-toggle');
    if (headerPhotoCount) {
      headerPhotoCount.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleThumbnails(); };
    }
  }

  // モバイル用トリップシートトリガーのラベルを更新
  updateTripSheetTriggerLabel();

  // 表紙プレビューを更新
  updateCoverPreview();

  // 旅行記アクションボタンを更新
  updateTravelogueActionButtons();

  // 旅行記履歴リンクを更新
  updateTravelogueHistoryLinks();
}

function updateTripSheetTriggerLabel() {
  const tripSheetTriggerLabelName = document.querySelector('.trip-sheet-trigger-label-name');
  const prevBtn = document.getElementById('tripNavPrev');
  const nextBtn = document.getElementById('tripNavNext');
  const travelogueBtn = document.getElementById('tripSheetTravelogueBtn');
  if (!tripSheetTriggerLabelName) return;

  if (currentTrip && currentTrip.name) {
    tripSheetTriggerLabelName.textContent = currentTrip.name;
    // トリップカラーを適用
    if (currentTrip.color) {
      tripSheetTriggerLabelName.style.color = currentTrip.color;
      tripSheetTriggerLabelName.style.fontWeight = '600';
    }

    // 前後のボタンの有効/無効を設定（getOrderedTrips はメモ化済みなので再取得は低コスト）
    const trips = getOrderedTrips();
    const currentIndex = trips.findIndex(t => t.id === currentTrip.id);
    if (prevBtn) {
      prevBtn.disabled = currentIndex <= 0;
    }
    if (nextBtn) {
      nextBtn.disabled = currentIndex < 0 || currentIndex >= trips.length - 1;
    }
    if (travelogueBtn) {
      travelogueBtn.style.display = tripHasTravelogue(currentTrip) ? '' : 'none';
      travelogueBtn.title = currentTrip.isParent ? 'トリップまとめ' : '旅行記';
    }
  } else {
    tripSheetTriggerLabelName.textContent = 'トリップ一覧';
    tripSheetTriggerLabelName.style.color = '';
    tripSheetTriggerLabelName.style.fontWeight = '';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    if (travelogueBtn) travelogueBtn.style.display = 'none';
  }

  // 地図上のトリップ名オーバーレイも更新
  updateMapTripNameOverlay();
}

function updateMapTripNameOverlay() {
  const overlay = document.getElementById('mapTripNameOverlay');
  const playStopBtnMobile = document.getElementById('playStopBtnMobile');
  const mapPlayBtn = document.getElementById('mapPlayBtn');
  if (!overlay) return;

  if (currentTrip && currentTrip.name) {
    const tripColor = currentTrip.color || '#e1306c';
    const hasTravelogue = tripHasTravelogue(currentTrip);
    // getOrderedTrips() はメモ化済みのため再取得は O(1) に近い
    const childTripsForOverlay = currentTrip.isParent
      ? getChildTrips(currentTrip.id)
      : [];
    const hasStamps = currentTrip.isParent
      ? childTripsForOverlay.some(child => (child.photos || []).some(p => p.isStamp))
      : (currentTrip.photos || []).some(p => p.isStamp);

    // トリップ名に旅行記ラベルを追加
    const tripNameDisplay = hasTravelogue
      ? `${escapeHtml(currentTrip.name)} <span class="map-trip-travelogue-label">旅行記</span>`
      : escapeHtml(currentTrip.name);

    if (isMobileView()) {
      // モバイル：トリップ名のみ表示（ボタンなし）
      overlay.innerHTML = `
        <div class="map-trip-name-card" style="--trip-color: ${tripColor}" id="mapTripNameCard">
          <div class="map-trip-name-text" id="mapTripNameText">${tripNameDisplay}</div>
        </div>
      `;
    } else {
      // デスクトップ：従来通り
      overlay.innerHTML = `
        <div class="map-trip-name-card" style="--trip-color: ${tripColor}" id="mapTripNameCard">
          <div class="map-trip-name-text">${tripNameDisplay}</div>
        </div>
      `;
    }
    overlay.classList.add('visible');

    // 再生ボタンにもトリップカラーを適用
    if (playStopBtnMobile) {
      playStopBtnMobile.style.setProperty('--trip-color', tripColor);
    }
    if (mapPlayBtn) {
      mapPlayBtn.style.setProperty('--trip-color', tripColor);
    }

    // クリックイベントを追加
    if (isMobileView()) {
      // モバイル：トリップ名をクリックで旅行記を開く
      const tripNameText = document.getElementById('mapTripNameText');
      if (tripNameText) {
        tripNameText.style.cursor = 'pointer';
        tripNameText.title = '旅行記を表示';
        tripNameText.onclick = (e) => {
          e.stopPropagation();
          showTravelogueModal();
        };
      }
    } else {
      // デスクトップ：従来の動作
      const card = document.getElementById('mapTripNameCard');
      if (card) {
        card.style.cursor = 'pointer';
        card.title = hasTravelogue ? '旅行記を表示' : '地図を全体表示';
        card.onclick = () => {
          if (hasTravelogue) {
            showTravelogueModal();
            return;
          }
          // 旅行記が無い場合は従来の動作：全てのスポットが収まるように地図を表示
          const photos = getDisplayPhotos();
          if (photos.length > 0 && map) {
            const bounds = [];
            photos.forEach(p => {
              if (p.lat != null && p.lng != null) {
                bounds.push([p.lat, p.lng]);
              }
            });
            if (bounds.length > 0) {
              map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
            }
          }

          // サムネイルを表示
          if (!thumbnailsVisible) {
            thumbnailsVisible = true;
            renderThumbnails();
          }
        };
      }
    }
  } else {
    overlay.classList.remove('visible');
    overlay.innerHTML = '';
    // トリップがない場合はデフォルトカラー
    if (playBtn) {
      playBtn.style.setProperty('--trip-color', '#e1306c');
    }
  }
}

function updateCoverPreview() {
  const previewContainer = document.getElementById('generatedImagesPreview');
  if (!previewContainer) return;

  // 既存のプレビューをクリア
  previewContainer.innerHTML = '';

  if (!currentTrip || !currentTrip.travelogueHtml) {
    return;
  }

  // 旅行記HTMLから表紙画像URLを抽出
  const html = currentTrip.travelogueHtml;
  const imgMatch = html.match(/<img src="([^"]+)" alt="旅行記の表紙"/);

  if (imgMatch && imgMatch[1]) {
    const coverImg = document.createElement('img');
    coverImg.src = imgMatch[1];
    coverImg.alt = '生成された表紙';
    coverImg.style.cssText = 'height:60px;width:auto;border-radius:4px;box-shadow:0 2px 4px rgba(0,0,0,0.2);cursor:pointer;';
    coverImg.title = 'クリックで旅行記を表示';
    coverImg.onclick = () => showTravelogueModal();
    previewContainer.appendChild(coverImg);
  }
}

function updateTravelogueActionButtons() {
  // 日時表示と削除ボタンは不要になったため、この関数は何もしない
  const container = document.getElementById('travelogueActionButtons');
  if (container) {
    container.innerHTML = '';
  }
}

function updateTravelogueHistoryLinks() {
  const container = document.getElementById('travelogueHistoryLinks');
  if (!container) return;

  container.innerHTML = '';

  if (!currentTrip || !currentTrip.travelogueHistory || currentTrip.travelogueHistory.length === 0) {
    return;
  }

  // 履歴を新しい順に並べる（最新が最初）
  const history = [...currentTrip.travelogueHistory].reverse();

  history.forEach((entry, index) => {
    const actualIndex = history.length - 1 - index; // 元のインデックス
    const date = new Date(entry.timestamp);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:stretch;border-radius:4px;overflow:hidden;border:1px solid #d0d0d0;';

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'btn btn-secondary btn-xs';
    link.style.borderRadius = '0';
    link.style.border = 'none';
    link.textContent = `📝 ${dateStr}`;
    link.title = `旅行記履歴 ${actualIndex + 1} を表示`;
    link.onclick = () => showTravelogueFromHistory(entry);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.style.cssText = 'border:none;border-left:1px solid #d0d0d0;background:#fff;color:#c0392b;padding:0 6px;cursor:pointer;font-size:0.8rem;line-height:1;';
    deleteBtn.title = 'この旅行記履歴を削除';
    deleteBtn.textContent = '✕';
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`${dateStr} の旅行記履歴を削除しますか？`)) return;
      currentTrip.travelogueHistory.splice(actualIndex, 1);
      await saveTrip({ silent: true });
      updateTravelogueHistoryLinks();
    };

    wrap.appendChild(link);
    wrap.appendChild(deleteBtn);
    container.appendChild(wrap);
  });
}

async function showTravelogueFromHistory(entry) {
  try {
    let html = '';
    if (entry.url) {
      // StorageからHTMLを取得
      const response = await fetch(entry.url);
      html = await response.text();
    } else if (entry.html) {
      // Firestoreに保存されたHTML
      html = entry.html;
    }

    if (html) {
      // 一時的にcurrentTripのtravelogueHtml/Urlを上書きして表示
      const originalHtml = currentTrip.travelogueHtml;
      const originalUrl = currentTrip.travelogueUrl;

      currentTrip.travelogueHtml = html;
      currentTrip.travelogueUrl = entry.url || null;

      showTravelogueModal();

      // 元に戻す
      currentTrip.travelogueHtml = originalHtml;
      currentTrip.travelogueUrl = originalUrl;
    }
  } catch (err) {
    console.error('履歴の旅行記表示エラー:', err);
    alert('旅行記の読み込みに失敗しました: ' + (err.message || String(err)));
  }
}

function initEventListeners() {
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      updateHeaderInfo();
    }, 150);
  });
  document.addEventListener('dragend', () => {
    document.querySelectorAll('.trip-item-drag-over').forEach(el => el.classList.remove('trip-item-drag-over'));
  });
  document.getElementById('authBtn').onclick = () => {
    if (window.firebaseAuth?.currentUser) signOut();
    else signInWithGoogle();
  };

  const headerLogo = document.getElementById('headerLogo');
  if (headerLogo) {
    headerLogo.onclick = goToDefaultView;
    headerLogo.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToDefaultView(); } };
  }

  // モバイルでリダイレクトログインの結果を処理
  handleRedirectResult();

  window.firebaseAuth?.onAuthStateChanged(async (user) => {
    if (user) {
      console.log('認証状態変化: ログイン中', {
        email: user.email,
        uid: user.uid,
        displayName: user.displayName
      });
    } else {
      console.log('認証状態変化: ログアウト状態');
      cachedAiConfig = null;
    }
    // ユーザーが実際に変わった場合のみ onSnapshot リスナーをリセット（loadMyTrips が再設定する）。
    // 無条件にリセットすると、初回ロード時に init() 側の loadMyTrips() が張ったリスナーを
    // 同一ユーザーでの初回 onAuthStateChanged 発火が横から解除してしまい、
    // 誰にも resolve されない Promise が残ってホームURLの初期トリップ選択が止まっていた。
    const newUserId = user?.uid || 'public';
    const userChanged = tripsCache.userId != null && tripsCache.userId !== newUserId;
    if (userChanged && _tripsUnsubscribe) {
      _tripsUnsubscribe();
      _tripsUnsubscribe = null;
      tripsCache.data = null;
      tripsCache.userId = null;
    }
    updateEditorUI();
    // Firestore読み込みを並列化（パフォーマンス最適化）
    await Promise.all([loadMyTrips(), loadTripOrder()]);
    renderTripList();
    refreshTripSelect();

    // URLパラメータで指定されたトリップを読み込む（初回発火時のみ。以降の再発火で
    // ユーザーが操作後のトリップを上書きしないようにする）
    if (!_urlTripLoadHandled) {
      _urlTripLoadHandled = true;
      let tripToLoad = null;

      if (window.appUrlTripId) {
        // ID ベースの検索
        tripToLoad = myTrips.find(t => t.id === window.appUrlTripId);
        if (tripToLoad) {
          console.log('✅ ID で トリップを見つけました:', tripToLoad.name);
        } else {
          console.warn('❌ ID でトリップが見つかりません:', window.appUrlTripId);
          console.log('利用可能なトリップID:', myTrips.map(t => ({ id: t.id, name: t.name })));
        }
      } else if (window.appUrlTripName) {
        // 名前ベースの検索（複数の戦略を試す）
        const searchName = window.appUrlTripName.toLowerCase().trim();

        // 1. 完全一致（大文字小文字を区別しない）
        tripToLoad = myTrips.find(t => (t.name || '').toLowerCase().trim() === searchName);
        if (tripToLoad) {
          console.log('✅ 完全一致でトリップを見つけました:', tripToLoad.name);
        }

        // 2. 完全一致失敗時は部分一致
        if (!tripToLoad) {
          tripToLoad = myTrips.find(t => (t.name || '').toLowerCase().includes(searchName));
          if (tripToLoad) {
            console.log('✅ 部分一致でトリップを見つけました:', tripToLoad.name);
          }
        }

        // 3. 名前に検索語が含まれている（逆向き）
        if (!tripToLoad) {
          tripToLoad = myTrips.find(t => searchName.includes((t.name || '').toLowerCase().trim()));
          if (tripToLoad) {
            console.log('✅ 逆向き一致でトリップを見つけました:', tripToLoad.name);
          }
        }

        if (!tripToLoad) {
          console.warn('❌ トリップが見つかりません:', window.appUrlTripName);
          console.log('利用可能なトリップ:', myTrips.slice(0, 10).map(t => ({ id: t.id, name: t.name, isParent: t.isParent })));
        }
      }

      if (tripToLoad) {
        console.log('🚀 URLパラメータで指定されたトリップを読み込みます:', tripToLoad.name);
        await loadTripById(tripToLoad.id);
        // トリップ名をフィルタに設定（子トリップの場合は親を見つける）
        const prevFilterName = tripFilterParentName;
        if (tripToLoad.isParent) {
          tripFilterParentName = tripToLoad.name;
        } else if (tripToLoad.parentId) {
          const parent = myTrips.find(t => t.id === tripToLoad.parentId);
          if (parent) {
            tripFilterParentName = parent.name;
          }
        }
        // フィルタが変わった場合、既に描画済みの一覧を絞り込み後の内容で描き直す
        if (tripFilterParentName !== prevFilterName) {
          renderTripList();
          refreshTripSelect();
        }
      }
    }

    await updateMapMarkers();
    await updateHeaderInfo();
  });

  const menuPanel = document.getElementById('menuPanel');
  const menuOverlay = document.getElementById('menuOverlay');
  document.getElementById('hamburgerBtn').onclick = () => {
    menuPanel?.classList.add('open');
    menuOverlay?.classList.add('open');
  };
  menuOverlay?.addEventListener('click', closeMenu);
  document.getElementById('menuClose').onclick = closeMenu;

  const tripListTitle = document.getElementById('tripListTitle');
  if (tripListTitle) {
    tripListTitle.onclick = () => goToDefaultView();
    tripListTitle.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToDefaultView(); } };
  }

  const tripRegionSelect = document.getElementById('tripRegionSelect');
  if (tripRegionSelect) {
    tripRegionSelect.value = tripRegionFilter;
    tripRegionSelect.onchange = async () => {
      tripRegionFilter = tripRegionSelect.value;
      try {
        const url = new URL(window.location.href);
        if (tripRegionFilter === 'all') {
          url.searchParams.delete('region');
        } else {
          url.searchParams.set('region', tripRegionFilter);
        }
        window.history.replaceState({}, '', url.toString());
      } catch (_) {}
      renderTripList();
      refreshTripSelect();
      const displayIds = new Set(getTripsForDisplay().map(x => x.trip.id));
      if (currentTrip && !displayIds.has(currentTrip.id)) {
        const first = getTripsForDisplay()[0]?.trip;
        if (first) await loadTripById(first.id);
        else await updateHeaderInfo();
      } else {
        updateHeaderInfo();
      }
    };
  }
  const tripSheetTrigger = document.getElementById('tripSheetTrigger');
  const tripSheetOverlay = document.getElementById('tripSheetOverlay');
  const tripPanel = document.getElementById('tripPanel');
  if (tripSheetTrigger && tripPanel) {
    tripSheetTrigger.onclick = () => {
      // トリップ一覧を開閉（トグル）
      const isOpen = tripPanel.classList.contains('open');
      if (isOpen) {
        tripPanel.classList.remove('open');
        if (tripSheetOverlay) tripSheetOverlay.classList.remove('open');
      } else {
        tripPanel.classList.add('open');
        if (tripSheetOverlay) tripSheetOverlay.classList.add('open');
      }
    };
  }

  // 前のトリップボタン（フィルタ適用後の表示順でナビゲート）
  const tripNavPrev = document.getElementById('tripNavPrev');
  if (tripNavPrev) {
    tripNavPrev.onclick = async (e) => {
      e.stopPropagation();
      if (!currentTrip) return;
      const displayTrips = getTripsForDisplay().map(x => x.trip);
      const currentIndex = displayTrips.findIndex(t => t.id === currentTrip.id);
      if (currentIndex > 0) {
        await loadTripById(displayTrips[currentIndex - 1].id);
      }
    };
  }

  // 次のトリップボタン（フィルタ適用後の表示順でナビゲート）
  const tripNavNext = document.getElementById('tripNavNext');
  if (tripNavNext) {
    tripNavNext.onclick = async (e) => {
      e.stopPropagation();
      if (!currentTrip) return;
      const displayTrips = getTripsForDisplay().map(x => x.trip);
      const currentIndex = displayTrips.findIndex(t => t.id === currentTrip.id);
      if (currentIndex >= 0 && currentIndex < displayTrips.length - 1) {
        await loadTripById(displayTrips[currentIndex + 1].id);
      }
    };
  }
  if (tripSheetOverlay && tripPanel) {
    tripSheetOverlay.onclick = () => {
      tripPanel.classList.remove('open');
      tripSheetOverlay.classList.remove('open');
    };
  }

  // 旅選択バーの旅行記アイコン
  const tripSheetTravelogueBtn = document.getElementById('tripSheetTravelogueBtn');
  if (tripSheetTravelogueBtn) {
    tripSheetTravelogueBtn.onclick = (e) => {
      e.stopPropagation();
      if (currentTrip) showTravelogueModal(currentTrip);
    };
  }

  document.getElementById('saveTripBtn').onclick = saveTrip;

  // マーカードラッグ後の保存バー
  const mapMarkerSaveBtn = document.getElementById('mapMarkerSaveBtn');
  const mapMarkerCancelBtn = document.getElementById('mapMarkerCancelBtn');
  if (mapMarkerSaveBtn) {
    mapMarkerSaveBtn.onclick = async () => {
      if (!pendingMarkerDrag) return;
      mapMarkerSaveBtn.disabled = true;
      mapMarkerSaveBtn.textContent = '保存中...';
      if (mapMarkerCancelBtn) mapMarkerCancelBtn.disabled = true;
      const { tripRef, photoIdx } = pendingMarkerDrag;
      try {
        if (tripRef.photos?.[photoIdx]) {
          const lat = tripRef.photos[photoIdx].lat;
          const lng = tripRef.photos[photoIdx].lng;
          tripRef.photos[photoIdx].placeName = await reverseGeocode(lat, lng);
        }
        await saveTrip({ silent: true });
        await updateMapMarkers();
        setStatus('✓ GPS位置を保存しました');
        hideMarkerSaveBar();
      } catch (err) {
        console.error('GPS位置の保存に失敗:', err);
        alert('保存に失敗しました: ' + (err.message || err));
        mapMarkerSaveBtn.disabled = false;
        mapMarkerSaveBtn.textContent = '保存';
        if (mapMarkerCancelBtn) mapMarkerCancelBtn.disabled = false;
      }
    };
  }
  if (mapMarkerCancelBtn) {
    mapMarkerCancelBtn.onclick = () => {
      if (!pendingMarkerDrag) return;
      const { tripRef, photoIdx, originalLat, originalLng, originalPlaceName } = pendingMarkerDrag;
      if (tripRef.photos?.[photoIdx]) {
        tripRef.photos[photoIdx].lat = originalLat;
        tripRef.photos[photoIdx].lng = originalLng;
        tripRef.photos[photoIdx].placeName = originalPlaceName;
      }
      hideMarkerSaveBar();
      scheduleMapMarkersUpdate();
      setStatus('位置の変更を元に戻しました');
    };
  }

  document.getElementById('newTripBtn').onclick = async () => {
    if (!isEditor()) return;

    // 前のトリップの写真ポップアップをクリア
    closePhotoPopup();

    currentTrip = createNewTrip();
    document.getElementById('tripParentInput').checked = false;
    document.getElementById('tripParentSelect').value = '';
    document.getElementById('tripParentSelectWrap').style.display = '';
    document.getElementById('tripParentChildrenWrap').style.display = 'none';
    await updateTripInputs();
    renderThumbnails();
    await updateMapMarkers();
    await renderTripDetailPane();
  };
  const menuVideoExportBtn = document.getElementById('menuVideoExportBtn');
  if (menuVideoExportBtn) {
    menuVideoExportBtn.onclick = () => {
      closeMenu();
      exportTripVideo(currentTrip);
    };
  }
  document.getElementById('tripParentInput').onchange = () => {
    const isParent = document.getElementById('tripParentInput').checked;
    document.getElementById('tripParentSelectWrap').style.display = isParent ? 'none' : '';
    document.getElementById('tripParentChildrenWrap').style.display = isParent && isEditor() ? '' : 'none';
    if (isParent) document.getElementById('tripParentSelect').value = '';
    if (isParent && currentTrip?.id) renderParentTripChildren(currentTrip.id);
  };
  document.getElementById('tripColorInput').oninput = () => renderColorSwatches();
  const tripSelect = document.getElementById('tripSelect');
  tripSelect.onchange = () => {
    const id = tripSelect.value;
    if (id) loadTripById(id);
  };
  document.getElementById('loadTripBtn').onclick = () => {
    const id = tripSelect.value;
    if (id) loadTripById(id);
  };
  document.getElementById('deleteTripBtn').onclick = deleteTrip;

  const tripOrderResetBtn = document.getElementById('tripOrderResetBtn');
  if (tripOrderResetBtn) {
    tripOrderResetBtn.onclick = async () => {
      if (!isEditor()) return;
      const res = await saveTripOrder([]);
      if (res.ok) {
        const uid = window.firebaseAuth?.currentUser?.uid;
        if (uid && window.firebaseDb) {
          const mine = myTrips.filter(t => t.userId === uid);
          for (const t of mine) {
            try {
              await window.firebaseDb.collection('trips').doc(t.id).update({ order: firebase.firestore.FieldValue.delete() });
            } catch (_) {}
          }
        }
        await loadMyTrips();
        renderTripList();
        setStatus('並び順をリセットしました');
      } else {
        setStatus(res.err || 'リセットに失敗しました');
      }
    };
  }

  const uploadZone = document.getElementById('uploadZone');
  const photoInput = document.getElementById('photoInput');
  uploadZone.onclick = () => photoInput.click();
  uploadZone.ondragover = (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); };
  uploadZone.ondragleave = () => uploadZone.classList.remove('drag-over');
  uploadZone.ondrop = (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  };
  photoInput.onchange = async (e) => {
    const files = e.target.files;
    if (files?.length) await handleFiles(files);
    e.target.value = '';
  };

  const gpxZone = document.getElementById('gpxZone');
  const gpxInput = document.getElementById('gpxInput');
  gpxZone.onclick = () => gpxInput.click();
  gpxInput.onchange = async (e) => {
    if (!isEditor()) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    currentTrip = currentTrip || createNewTrip();
    try {
      currentTrip.gpxDataUrl = await uploadGpxToStorage(currentTrip.id, text);
      currentTrip.gpxFileName = file.name;
      currentTrip.gpxData = null;
      uploadOk = true;
      try {
        await persistGpxToTrip(currentTrip.id, currentTrip.gpxDataUrl, currentTrip.gpxFileName);
        await loadMyTrips();
        const saved = myTripsMap.get(currentTrip.id);
        if (saved) currentTrip = { ...saved, id: saved.id };
        renderTripList();
        renderThumbnails();
        setStatus('GPX をアップロード・保存しました');
      } catch (persistErr) {
        console.error('GPX Firestore保存エラー:', persistErr);
        setStatus('GPX をアップロードしました（保存は「保存」ボタンで）');
      }
    } catch (err) {
      console.error('GPXアップロードエラー:', err);
      currentTrip.gpxData = text;
      currentTrip.gpxFileName = file.name;
      currentTrip.gpxDataUrl = null;
      setStatus('GPX を読み込みました（Storage未使用）');
    }
    await updateMapMarkers();
    await updateHeaderInfo();
    await updateTripInputs();
    e.target.value = '';
  };

  document.getElementById('playBtn').onclick = startPlay;
  const playStopBtnMobile = document.getElementById('playStopBtnMobile');
  if (playStopBtnMobile) {
    playStopBtnMobile.onclick = () => {
      if (playTimer) {
        // 自動再生停止時は完全停止して地図をリロード
        stopPlay();
        if (currentTrip) {
          loadTripById(currentTrip.id);
        }
      } else {
        startPlay();
      }
    };
  }
  document.getElementById('photoPrevBtn').onclick = prevPhoto;
  document.getElementById('photoNextBtn').onclick = nextPhoto;

  // 地図上の前後ボタン（モバイル用）
  const mapPhotoPrevBtnMobile = document.getElementById('mapPhotoPrevBtnMobile');
  if (mapPhotoPrevBtnMobile) mapPhotoPrevBtnMobile.onclick = prevPhoto;
  const mapPhotoNextBtnMobile = document.getElementById('mapPhotoNextBtnMobile');
  if (mapPhotoNextBtnMobile) mapPhotoNextBtnMobile.onclick = nextPhoto;

  // 地図下部のナビゲーションボタン（デスクトップ用）
  const mapPlayBtn = document.getElementById('mapPlayBtn');
  if (mapPlayBtn) {
    mapPlayBtn.onclick = () => {
      if (playTimer) {
        // 自動再生停止時は完全停止して地図をリロード
        stopPlay();
        if (currentTrip) {
          loadTripById(currentTrip.id);
        }
      } else {
        startPlay();
      }
    };
  }
  const mapPhotoPrevBtn = document.getElementById('mapPhotoPrevBtn');
  if (mapPhotoPrevBtn) mapPhotoPrevBtn.onclick = prevPhoto;
  const mapPhotoNextBtn = document.getElementById('mapPhotoNextBtn');
  if (mapPhotoNextBtn) mapPhotoNextBtn.onclick = nextPhoto;
  const headerVideoBtn = document.getElementById('headerVideoBtn');
  if (headerVideoBtn) headerVideoBtn.onclick = () => {
    if (playTimer) stopPlay();
    const urls = getTripVideoUrls();
    if (urls.length > 0) playVideoSequence(urls);
  };
  const headerAnimeBtn = document.getElementById('headerAnimeBtn');
  if (headerAnimeBtn) headerAnimeBtn.onclick = () => {
    if (currentTrip) {
      let animes = [];
      if (currentTrip.isParent) {
        // 親トリップの場合、全ての子トリップのアニメを取得
        const childTrips = getChildTrips(currentTrip.id);
        childTrips.forEach(child => {
          const childAnimes = child.generatedAnimes || child.animes || [];
          animes = animes.concat(childAnimes);
        });
      } else {
        animes = currentTrip.generatedAnimes || currentTrip.animes || [];
      }
      if (animes.length > 0) {
        showAnimeImageViewer(animes, currentTrip.name);
      }
    }
  };
  const headerStampBtn = document.getElementById('headerStampBtn');
  if (headerStampBtn) headerStampBtn.onclick = () => {
    if (playTimer) stopPlay();
    if (currentTrip) showStampRallyModal(currentTrip);
  };


  // モバイル用のコントロールボタン
  const mobilePhotoPrevBtn = document.getElementById('mobilePhotoPrevBtn');
  if (mobilePhotoPrevBtn) mobilePhotoPrevBtn.onclick = prevPhoto;
  const mobilePhotoNextBtn = document.getElementById('mobilePhotoNextBtn');
  if (mobilePhotoNextBtn) mobilePhotoNextBtn.onclick = nextPhoto;
  const mobilePlayBtn = document.getElementById('mobilePlayBtn');
  if (mobilePlayBtn) {
    mobilePlayBtn.onclick = () => {
      if (playTimer) {
        // 自動再生停止時は完全停止して地図をリロード
        stopPlay();
        if (currentTrip) {
          loadTripById(currentTrip.id);
        }
        mobilePlayBtn.textContent = '▶';
      } else {
        startPlay();
        mobilePlayBtn.textContent = '■';
      }
    };
  }
  // モバイル用のボタン
  const mobileVideoBtn = document.getElementById('mobileVideoBtn');
  if (mobileVideoBtn) mobileVideoBtn.onclick = () => {
    const urls = getTripVideoUrls();
    if (urls.length > 0) playVideoSequence(urls);
  };
  const mobileAnimeBtn = document.getElementById('mobileAnimeBtn');
  if (mobileAnimeBtn) mobileAnimeBtn.onclick = () => {
    if (currentTrip) {
      let animes = [];
      if (currentTrip.isParent) {
        // 親トリップの場合、全ての子トリップのアニメを取得
        const childTrips = getChildTrips(currentTrip.id);
        childTrips.forEach(child => {
          const childAnimes = child.generatedAnimes || child.animes || [];
          animes = animes.concat(childAnimes);
        });
      } else {
        animes = currentTrip.generatedAnimes || currentTrip.animes || [];
      }
      if (animes.length > 0) {
        showAnimeImageViewer(animes, currentTrip.name);
      }
    }
  };
  const mobileStampBtn = document.getElementById('mobileStampBtn');
  if (mobileStampBtn) mobileStampBtn.onclick = () => {
    if (playTimer) stopPlay();
    if (currentTrip) showStampRallyModal(currentTrip);
  };

  // 閲覧者用のボタン
  const viewerTravelogueBtn = document.getElementById('viewerTravelogueBtn');
  if (viewerTravelogueBtn) viewerTravelogueBtn.onclick = () => {
    showTravelogueModal();
    closeMenu();
  };
  const viewerVideoBtn = document.getElementById('viewerVideoBtn');
  if (viewerVideoBtn) viewerVideoBtn.onclick = () => {
    const urls = getTripVideoUrls();
    if (urls.length > 0) playVideoSequence(urls);
    closeMenu();
  };
  const viewerStampBtn = document.getElementById('viewerStampBtn');
  if (viewerStampBtn) viewerStampBtn.onclick = () => {
    if (currentTrip) showStampRallyModal(currentTrip);
    closeMenu();
  };

  const generateTravelogueBtn = document.getElementById('generateTravelogueBtn');
  if (generateTravelogueBtn) generateTravelogueBtn.onclick = () => generateTravelogueWithAI();


  document.getElementById('helpModalClose').onclick = () => document.getElementById('helpModal').classList.remove('open');

  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) helpBtn.onclick = () => document.getElementById('helpModal').classList.add('open');

  const generateAnimeBtn = document.getElementById('generateAnimeBtnViewer');
  if (generateAnimeBtn) generateAnimeBtn.onclick = () => showAnimeModal();

  // アニメスタイル選択時に出来事入力欄・名所浮世絵入力欄・インフォグラフィック入力欄の表示を切り替え
  const animeStyleSelect = document.getElementById('animeStyleSelect');
  const eventStoryInputWrap = document.getElementById('eventStoryInputWrap');
  const meishoUkiyoeInputWrap = document.getElementById('meishoUkiyoeInputWrap');
  const infographicInputWrap = document.getElementById('infographicInputWrap');
  if (animeStyleSelect && eventStoryInputWrap && meishoUkiyoeInputWrap && infographicInputWrap) {
    animeStyleSelect.onchange = () => {
      const value = animeStyleSelect.value;
      eventStoryInputWrap.style.display = value === 'event-story' ? '' : 'none';
      meishoUkiyoeInputWrap.style.display = value === 'meisho-ukiyoe' ? '' : 'none';
      infographicInputWrap.style.display = value === 'infographic' ? '' : 'none';
      updateModelLevelSelectForStyle(value);
    };
    updateModelLevelSelectForStyle(animeStyleSelect.value);
  }

  const animeImageViewerModal = document.getElementById('animeImageViewerModal');
  const animeImageViewerClose = document.getElementById('animeImageViewerClose');
  const animeViewerPrevBtn = document.getElementById('animeImageViewerPrev');
  const animeViewerNextBtn = document.getElementById('animeImageViewerNext');
  if (animeImageViewerClose) animeImageViewerClose.onclick = closeAnimeImageViewer;
  if (animeViewerPrevBtn) animeViewerPrevBtn.onclick = animeImageViewerPrev;
  if (animeViewerNextBtn) animeViewerNextBtn.onclick = animeImageViewerNext;
  if (animeImageViewerModal) animeImageViewerModal.onclick = (e) => { if (e.target === animeImageViewerModal) closeAnimeImageViewer(); };

  // キャラクター画像アップロード
  const uploadCharacterBtn = document.getElementById('uploadCharacterBtn');
  const characterImageInput = document.getElementById('characterImageInput');
  const characterPreview = document.getElementById('characterPreview');
  const characterPreviewImg = document.getElementById('characterPreviewImg');
  const removeCharacterBtn = document.getElementById('removeCharacterBtn');

  if (uploadCharacterBtn && characterImageInput) {
    uploadCharacterBtn.onclick = () => characterImageInput.click();
    characterImageInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!currentTrip || currentTrip.isParent) {
        alert('子トリップを選択してからキャラクターをアップロードしてください');
        return;
      }

      try {
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => resolve(event.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        setStatus('キャラクター画像を保存中...');
        const url = await uploadCharacterImageToStorage(currentTrip.id, base64Data);
        currentTrip.characterImageUrl = url;
        characterImageData = base64Data;

        if (characterPreviewImg && characterPreview) {
          characterPreviewImg.src = base64Data;
          characterPreview.style.display = 'flex';
        }
        await saveCharacterToTrip(currentTrip.id, url);
        setStatus('キャラクター画像をこのトリップに保存しました');
      } catch (err) {
        console.error('キャラクター画像アップロードエラー:', err);
        const msg = err?.message || String(err);
        if (msg.includes('Photos or GPX required')) {
          alert('トリップに写真またはGPXを追加してからキャラクターをアップロードしてください。');
        } else if (msg.includes('Storage not ready')) {
          alert('ストレージの準備ができていません。ログインしているか確認してください。');
        } else {
          alert('キャラクター画像のアップロードに失敗しました: ' + msg);
        }
      }
      characterImageInput.value = '';
    };
  }

  if (removeCharacterBtn && characterPreview) {
    removeCharacterBtn.onclick = async () => {
      if (!currentTrip || currentTrip.isParent) return;
      const tripId = currentTrip.id;
      currentTrip.characterImageUrl = null;
      characterImageData = null;
      characterPreview.style.display = 'none';
      if (characterImageInput) characterImageInput.value = '';
      try {
        await saveCharacterToTrip(tripId, null);
        setStatus('キャラクター画像を削除しました');
      } catch (err) {
        console.error('キャラ削除エラー:', err);
        alert('削除の保存に失敗しました: ' + (err?.message || err));
      }
    };
  }

  const aiSettingsBtn = document.getElementById('aiSettingsBtn');
  const aiSettingsModal = document.getElementById('aiSettingsModal');
  const aiSettingsModalClose = document.getElementById('aiSettingsModalClose');
  const aiSettingsSaveBtn = document.getElementById('aiSettingsSaveBtn');
  if (aiSettingsBtn) aiSettingsBtn.onclick = () => showAiSettingsModal();
  if (aiSettingsModalClose) aiSettingsModalClose.onclick = () => closeAiSettingsModal();
  if (aiSettingsSaveBtn) aiSettingsSaveBtn.onclick = async () => {
    const providerSelect = document.getElementById('aiProviderSelect');
    const modelSelect = document.getElementById('aiModelSelect');
    const aiInput = document.getElementById('aiApiKeyInput');
    const provider = providerSelect?.value || 'gemini';
    const model = AI_MODEL_OPTIONS[provider] ? (modelSelect?.value || AI_MODEL_DEFAULTS[provider] || null) : null;
    const apiKey = aiInput?.value || '';
    try {
      await saveUserAiConfig({ provider, apiKey, model });
      closeAiSettingsModal();
      setStatus('AI設定を保存しました');
    } catch (err) {
      alert(err?.message || '保存に失敗しました');
    }
  };
  const aiProviderSelect = document.getElementById('aiProviderSelect');
  if (aiProviderSelect) {
    aiProviderSelect.onchange = () => updateAiModelFieldVisibility(aiProviderSelect.value, null);
  }
  if (aiSettingsModal) aiSettingsModal.onclick = (e) => { if (e.target === aiSettingsModal) closeAiSettingsModal(); };

  const createImageModal = document.getElementById('createImageModal');
  const createImageModalClose = document.getElementById('createImageModalClose');
  const createImageBackBtn = document.getElementById('createImageBackBtn');
  if (createImageModalClose) createImageModalClose.onclick = () => closeCreateImageModal();
  if (createImageBackBtn) createImageBackBtn.onclick = () => closeCreateImageModal();
  if (createImageModal) createImageModal.onclick = (e) => { if (e.target === createImageModal) closeCreateImageModal(); };

  const tripVideoExportModal = document.getElementById('tripVideoExportModal');
  const tripVideoExportModalClose = document.getElementById('tripVideoExportModalClose');
  const tripVideoExportCancelBtn = document.getElementById('tripVideoExportCancelBtn');
  if (tripVideoExportModalClose) tripVideoExportModalClose.onclick = () => closeTripVideoExportModal();
  if (tripVideoExportCancelBtn) tripVideoExportCancelBtn.onclick = () => closeTripVideoExportModal();
  if (tripVideoExportModal) tripVideoExportModal.onclick = (e) => { if (e.target === tripVideoExportModal) closeTripVideoExportModal(); };

  const travelogueModal = document.getElementById('travelogueModal');
  const travelogueModalClose = document.getElementById('travelogueModalClose');
  if (travelogueModalClose) travelogueModalClose.onclick = () => closeTravelogueModal();
  if (travelogueModal) travelogueModal.onclick = (e) => { if (e.target === travelogueModal) closeTravelogueModal(); };
  const stampRallyModal = document.getElementById('stampRallyModal');
  const stampRallyModalClose = document.getElementById('stampRallyModalClose');
  const stampRallyEinkBtn = document.getElementById('stampRallyEinkBtn');
  if (stampRallyModalClose) stampRallyModalClose.onclick = () => closeStampRallyModal();
  if (stampRallyEinkBtn) stampRallyEinkBtn.onclick = () => handleStampRallyEinkGeneration();
  if (stampRallyModal) stampRallyModal.onclick = (e) => { if (e.target === stampRallyModal) closeStampRallyModal(); };

  // GPSポイント追加ボタン
  const addGpsPointBtn = document.getElementById('addGpsPointBtn');
  if (addGpsPointBtn) {
    addGpsPointBtn.onclick = () => toggleAddGpsPointMode();
  }

  // 地図クリックイベント（GPSポイント追加用）
  if (map) {
    map.on('click', (e) => {
      if (addingGpsPointMode && isEditor()) {
        addGpsPointAtLocation(e.latlng.lat, e.latlng.lng);
      }
    });
  }
}

function init() {
  purgeExpiredGpxIDB(); // 期限切れGPXキャッシュをバックグラウンドで削除
  initRegionFilterFromUrl();
  applyAppTitle();
  initMap();
  initMapSearch();
  initEventListeners();
  updateEditorUI();
  updateHeaderInfo();

  // モバイル用トリップシートトリガーの初期化
  const tripSheetTriggerLabelName = document.querySelector('.trip-sheet-trigger-label-name');
  if (tripSheetTriggerLabelName) {
    tripSheetTriggerLabelName.textContent = 'トリップ一覧';
  }

  const loadTripsAndRender = async () => {
    try {
      // Firestore読み込みを並列化（パフォーマンス最適化）
      await Promise.all([loadMyTrips(), loadTripOrder()]);
      renderTripList();
      refreshTripSelect();
      refreshTripParentSelectOptions();

      // URLパラメータからトリップ名またはIDを取得
      const urlParams = new URLSearchParams(window.location.search);
      const tripParam = urlParams.get('t') || urlParams.get('id'); // 短縮形: ?t= または ?id=
      const tripIdParam = urlParams.get('tripId'); // 旧形式: ?tripId=
      const tripNameParam = urlParams.get('trip'); // 名前指定: ?trip=
      const tripOrderParam = urlParams.get('n'); // 順序指定: ?n=1
      const openTravelogue = urlParams.get('travelogue') === 'true';
      const photoIndexParam = urlParams.get('p'); // ポイント指定: ?p=3（御朱印QR等のディープリンク用）
      const isHomeUrl = !tripParam && !tripIdParam && !tripNameParam && !tripOrderParam;

      console.log('🔍 URLパラメータ解析:', {
        url: window.location.href,
        search: window.location.search,
        tripParam,
        tripIdParam,
        tripNameParam,
        tripOrderParam,
        isHomeUrl
      });

      let tripToLoad = null;

      // 優先順位: t/id > tripId > n > trip
      if (tripParam) {
        // ?t= または ?id= (短縮形でトリップIDを指定)
        console.log(`🆔 URLパラメータ: t/id=${tripParam}`);
        console.log(`🆔 検索対象トリップ数: ${myTrips.length}件`);
        const foundTrip = myTrips.find(t => t.id === tripParam);
        if (foundTrip) {
          console.log(`✅ トリップを発見 (短縮ID指定): ${foundTrip.name} (ID: ${foundTrip.id}, 親: ${foundTrip.isParent ? 'はい' : 'いいえ'})`);
          tripToLoad = foundTrip.id;

          // 親トリップの場合、確実に親トリップビューで表示
          if (foundTrip.isParent) {
            console.log(`📁 親トリップをデフォルト表示: ${foundTrip.name}`);
          }
        } else {
          console.error(`❌ トリップID "${tripParam}" が見つかりませんでした`);
          console.log(`📋 登録されているトリップID (${myTrips.length}件):`, myTrips.map(t => `${t.name}: ${t.id}`));
        }
      } else if (tripIdParam) {
        // ?tripId= (旧形式でトリップIDを指定)
        console.log(`🆔 URLパラメータ: tripId=${tripIdParam}`);
        console.log(`🆔 検索対象トリップ数: ${myTrips.length}件`);
        const foundTrip = myTrips.find(t => t.id === tripIdParam);
        if (foundTrip) {
          console.log(`✅ トリップを発見 (ID指定): ${foundTrip.name} (ID: ${foundTrip.id}, 親: ${foundTrip.isParent ? 'はい' : 'いいえ'})`);
          tripToLoad = foundTrip.id;

          // 親トリップの場合、確実に親トリップビューで表示
          if (foundTrip.isParent) {
            console.log(`📁 親トリップをデフォルト表示: ${foundTrip.name}`);
          }
        } else {
          console.error(`❌ トリップID "${tripIdParam}" が見つかりませんでした`);
          console.log(`📋 登録されているトリップID (${myTrips.length}件):`, myTrips.map(t => `${t.name}: ${t.id}`));
        }
      } else if (tripOrderParam) {
        // ?n=1 (順序番号でトリップを指定)
        const order = parseInt(tripOrderParam, 10);
        const orderedTrips = getOrderedTrips();
        console.log(`🔢 URLパラメータ: n=${order} (登録トリップ数: ${orderedTrips.length})`);
        if (order > 0 && order <= orderedTrips.length) {
          const foundTrip = orderedTrips[order - 1];
          console.log(`✅ トリップを発見 (順序指定): ${foundTrip.name} (ID: ${foundTrip.id}, 親: ${foundTrip.isParent ? 'はい' : 'いいえ'})`);
          tripToLoad = foundTrip.id;

          // 親トリップの場合、確実に親トリップビューで表示
          if (foundTrip.isParent) {
            console.log(`📁 親トリップをデフォルト表示: ${foundTrip.name}`);
          }
        } else {
          console.error(`❌ 順序番号 ${order} が範囲外です (1-${orderedTrips.length})`);
        }
      } else if (tripNameParam) {
        // URLパラメータでトリップ名が指定されている場合、そのトリップを検索
        console.log(`🔍 URLパラメータ: trip=${tripNameParam}`);
        let decodedTripName = decodeURIComponent(tripNameParam);
        console.log(`🔍 1回デコード後: "${decodedTripName}"`);

        // 二重エンコードチェック: %が含まれている場合はもう一度デコード
        if (decodedTripName.includes('%')) {
          try {
            const doubleDecoded = decodeURIComponent(decodedTripName);
            console.log(`🔍 二重エンコードを検出: "${decodedTripName}" → "${doubleDecoded}"`);
            decodedTripName = doubleDecoded;
          } catch (e) {
            console.warn('⚠️ デコードエラー:', e);
          }
        }

        console.log(`🔍 最終的なトリップ名: "${decodedTripName}"`);
        const foundTrip = myTrips.find(t => t.name === decodedTripName);
        if (foundTrip) {
          console.log(`✅ トリップを発見: ${decodedTripName} (ID: ${foundTrip.id}, 親: ${foundTrip.isParent ? 'はい' : 'いいえ'})`);
          tripToLoad = foundTrip.id;

          // 親トリップの場合、確実に親トリップビューで表示
          if (foundTrip.isParent) {
            console.log(`📁 親トリップをデフォルト表示: ${foundTrip.name}`);
          }
        } else {
          console.error(`❌ トリップ名 "${decodedTripName}" が見つかりませんでした`);
          console.log(`📋 登録されているトリップ名 (${myTrips.length}件):`, myTrips.map(t => t.name));
        }
      }

      // ホームURL（?trip= なし）の場合は前回のトリップまたはデフォルトを自動選択
      if (!tripToLoad && isHomeUrl) {
        const host = window.location.hostname || '';
        const orderedTrips = getOrderedTrips();

        if (/^ohenro\.ktrips\.net$|^henro\.ktrips\.net$|^air\.ktrips\.net$|^airj\.ktrips\.net$|^air\.jp\.ktrips\.net$|^airg\.ktrips\.net$|^air\.gl\.ktrips\.net$/.test(host)) {
          // 再訪問：前回開いたトリップを表示
          const lastTripId = (() => { try { return localStorage.getItem(LAST_TRIP_ID_KEY); } catch (_) { return null; } })();
          if (lastTripId) {
            const lastTrip = myTripsMap.get(lastTripId);
            if (lastTrip) {
              console.log(`[${host}] 再訪問 - 前回のトリップを表示: ${lastTrip.name}`);
              tripToLoad = lastTripId;
            }
          }

          // 初回アクセス：「しまなみ・淡路と四国遍路」の親トリップを一覧表示状態でデフォルト表示（改名に強いようIDで検索）
          if (!tripToLoad) {
            const defaultParentTrip = myTrips.find(t => t.id === OHENRO_DEFAULT_TRIP_ID && t.isParent);
            if (defaultParentTrip) {
              console.log(`[${host}] 初回アクセス - デフォルト親トリップを表示: ${defaultParentTrip.name}`);
              tripToLoad = defaultParentTrip.id;
              // ohenro/henroドメインでは、このトリップとその子だけに一覧を絞り込む
              if (/^ohenro\.ktrips\.net$|^henro\.ktrips\.net$/.test(host)) {
                tripFilterParentName = defaultParentTrip.name;
              }
            } else {
              const defaultTrip = myTrips.find(t => t.name === 'D1 しまなみ街道');
              if (defaultTrip) {
                console.log(`[${host}] 初回アクセス - デフォルトトリップを表示: ${defaultTrip.name}`);
                tripToLoad = defaultTrip.id;
              } else if (orderedTrips.length > 0) {
                // フォールバック：リスト先頭のトリップ
                console.log(`[${host}] フォールバック - 先頭トリップを表示: ${orderedTrips[0].name}`);
                tripToLoad = orderedTrips[0].id;
              } else {
                console.warn(`[${host}] トリップが見つかりませんでした`);
              }
            }
          }
        }
      }

      // 対象ドメイン以外で未解決の場合は、前回のトリップを開く
      if (!tripToLoad) {
        const lastTripId = (() => { try { return localStorage.getItem(LAST_TRIP_ID_KEY); } catch (_) { return null; } })();
        if (lastTripId) {
          tripToLoad = lastTripId;
        }
      }

      if (tripToLoad) {
        try {
          console.log(`📂 読み込み前のcurrentTrip:`, currentTrip?.id || 'null');
          await loadTripById(tripToLoad);
          // tripFilterParentNameがこの時点で確定するため、既に描画済みの一覧を絞り込み後の内容で描き直す
          if (tripFilterParentName) {
            renderTripList();
            refreshTripSelect();
          }
          console.log(`✅ トリップ読み込み完了:`, {
            id: currentTrip?.id,
            name: currentTrip?.name,
            isParent: currentTrip?.isParent,
            photosCount: getDisplayPhotos().length,
            childrenCount: currentTrip?.isParent ? getChildTrips(currentTrip.id).length : 0
          });

          // 旅行記パラメータがある場合、旅行記モーダルを開く
          if (openTravelogue && currentTrip) {
            setTimeout(() => {
              showTravelogueModal(currentTrip);
            }, 500); // トリップの読み込みが完全に完了するまで少し待つ
          }

          // ポイント指定パラメータ（御朱印QR等のディープリンク）がある場合、そのポイントへ直接ジャンプ
          if (photoIndexParam !== null && currentTrip) {
            const photoIdx = parseInt(photoIndexParam, 10);
            if (!isNaN(photoIdx)) {
              setTimeout(() => {
                showPhotoAtIndex(photoIdx, true);
              }, 500); // トリップの読み込みが完全に完了するまで少し待つ
            }
          }
        } catch (err) {
          console.error('❌ トリップ読み込みエラー:', err);
          // トリップ読み込みに失敗した場合は、デフォルトビューを表示
          await updateHeaderInfo();
          await updateMapMarkers();
        }
      } else {
        console.log('ℹ️ 読み込むトリップが指定されていません。デフォルト表示を使用します。');
        await updateHeaderInfo();
        await updateMapMarkers();
      }
    } catch (err) {
      console.error('初期化エラー:', err);

      // Firebase が初期化されていない場合のみアラート表示
      if (!window.firebaseDb) {
        alert('Firebase が初期化されていません。\n\n・firebase-config.js の設定を確認してください\n・ローカルサーバーで起動していることを確認してください');
      } else if (err.code === 'permission-denied') {
        alert('アクセス権限がありません。\n\n・Firestore のセキュリティルールを確認してください\n・ログインが必要な場合は、ログインしてください');
      } else {
        // CORS エラーやネットワークエラーの場合はコンソールに警告のみ
        console.warn('トリップの読み込みに一部失敗しました。一部の機能が制限される可能性があります。');
        console.warn('詳細はコンソールのエラーログを確認してください。');
      }
    }
  };
  if (window.firebaseDb) {
    loadTripsAndRender();
  } else {
    window.addEventListener('firebase-ready', loadTripsAndRender);
  }

  // モバイルでのヘッダー自動非表示
  initMobileHeaderAutoHide();
}

let mobileHeaderInteractionState = {
  hasInteracted: false,
  isHeaderShowing: false
};

function hideMobileHeader() {
  if (!isMobileView()) return;
  const header = document.getElementById('appHeader');
  if (!header) return;

  if (mobileHeaderInteractionState.hasInteracted && isMobileView()) {
    header.classList.add('header-auto-hidden');
    document.body.classList.add('header-hidden');
    mobileHeaderInteractionState.isHeaderShowing = false;
  }
}

function showMobileHeader() {
  if (!isMobileView()) return;
  const header = document.getElementById('appHeader');
  if (!header) return;

  header.classList.remove('header-auto-hidden');
  document.body.classList.remove('header-hidden');
  mobileHeaderInteractionState.isHeaderShowing = true;
}

function markMobileHeaderInteracted() {
  if (!isMobileView()) return;

  if (!mobileHeaderInteractionState.hasInteracted) {
    mobileHeaderInteractionState.hasInteracted = true;
    setTimeout(hideMobileHeader, 300);
  } else if (mobileHeaderInteractionState.isHeaderShowing) {
    // プルダウンで表示した後、次の操作で隠す
    setTimeout(hideMobileHeader, 300);
  }
}

function initMobileHeaderAutoHide() {
  if (!isMobileView()) return;

  const header = document.getElementById('appHeader');
  if (!header) return;

  // 地図の操作
  if (map) {
    map.on('click', markMobileHeaderInteracted);
    // 地図を移動させた時もヘッダーを隠す
    map.on('movestart', () => {
      if (isMobileView() && mobileHeaderInteractionState.hasInteracted) {
        markMobileHeaderInteracted();
      }
    });
  }

  // 写真切り替えボタン
  const photoNextBtn = document.getElementById('photoNextBtn');
  const photoPrevBtn = document.getElementById('photoPrevBtn');
  const mobilePhotoNextBtn = document.getElementById('mobilePhotoNextBtn');
  const mobilePhotoPrevBtn = document.getElementById('mobilePhotoPrevBtn');
  if (photoNextBtn) photoNextBtn.addEventListener('click', markMobileHeaderInteracted);
  if (photoPrevBtn) photoPrevBtn.addEventListener('click', markMobileHeaderInteracted);
  if (mobilePhotoNextBtn) mobilePhotoNextBtn.addEventListener('click', markMobileHeaderInteracted);
  if (mobilePhotoPrevBtn) mobilePhotoPrevBtn.addEventListener('click', markMobileHeaderInteracted);

  // 再生ボタン
  const playBtn = document.getElementById('playBtn');
  const mobilePlayBtn = document.getElementById('mobilePlayBtn');
  if (playBtn) playBtn.addEventListener('click', markMobileHeaderInteracted);
  if (mobilePlayBtn) mobilePlayBtn.addEventListener('click', markMobileHeaderInteracted);

  // ヘッダー内のボタンをクリックした時の処理
  header.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) {
      // ボタンをクリックしてもヘッダーは表示状態を維持
      if (header.classList.contains('header-auto-hidden')) {
        showMobileHeader();
      }
    }
  });

  // プルダウンバーのタップでヘッダーを表示
  const pulldownBar = document.getElementById('mobileHeaderPulldownBar');
  if (pulldownBar) {
    pulldownBar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMobileHeader();
    });

    // プルダウンバーでのスワイプ検出
    let touchStartY = 0;
    let touchCurrentY = 0;
    let isPulling = false;

    pulldownBar.addEventListener('touchstart', (e) => {
      if (!isMobileView() || !mobileHeaderInteractionState.hasInteracted) return;
      touchStartY = e.touches[0].clientY;
      isPulling = true;
    }, { passive: true });

    pulldownBar.addEventListener('touchmove', (e) => {
      if (!isPulling) return;
      touchCurrentY = e.touches[0].clientY;
      const deltaY = touchCurrentY - touchStartY;

      // プル中の視覚フィードバック
      if (deltaY > 10) {
        document.body.classList.add('header-pulling');
      }

      // 下方向に30px以上スワイプしたらヘッダーを表示
      if (deltaY > 30) {
        showMobileHeader();
        isPulling = false;
        document.body.classList.remove('header-pulling');
      }
    }, { passive: true });

    pulldownBar.addEventListener('touchend', () => {
      isPulling = false;
      document.body.classList.remove('header-pulling');
    }, { passive: true });
  }

  // マップコンテナでの上部スワイプ検出
  const mapContainer = document.querySelector('.map-container');
  if (mapContainer) {
    let touchStartY = 0;
    let touchCurrentY = 0;
    let isPulling = false;

    mapContainer.addEventListener('touchstart', (e) => {
      if (!isMobileView() || !mobileHeaderInteractionState.hasInteracted) return;
      touchStartY = e.touches[0].clientY;
      // 画面上部50pxからのスワイプで反応
      if (touchStartY < 50) {
        isPulling = true;
      }
    }, { passive: true });

    mapContainer.addEventListener('touchmove', (e) => {
      if (!isPulling) return;
      touchCurrentY = e.touches[0].clientY;
      const deltaY = touchCurrentY - touchStartY;

      // プル中の視覚フィードバック
      if (deltaY > 10) {
        document.body.classList.add('header-pulling');
      }

      // 下方向に30px以上スワイプしたらヘッダーを表示
      if (deltaY > 30) {
        showMobileHeader();
        isPulling = false;
        document.body.classList.remove('header-pulling');
      }
    }, { passive: true });

    mapContainer.addEventListener('touchend', () => {
      isPulling = false;
      document.body.classList.remove('header-pulling');
    }, { passive: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
