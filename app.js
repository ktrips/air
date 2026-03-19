/* Air — 地図と写真でエア旅行（Firebase + Firestore） */

// 12色: ピンク〜濃い紫のレインボー順（地図マーカー・ルート線の色分け用）
const TRIP_COLORS = ['#e1306c', '#fd1d1d', '#f56040', '#ffdc80', '#fcaf45', '#f77737', '#c13584', '#833ab4', '#5851db', '#405de6', '#4facfe', '#00f2fe'];

let map = null;
let travelogueMap = null;
let currentTrip = null;
let currentPhotoIndex = 0;
let markers = [];
let gpxLayers = [];
let playTimer = null;
let playIntervalMs = 3000;
let playbackPhotos = []; // 再生中の写真配列
let map3d = null;
let photoPopup = null;
let myTrips = [];
let tripOrder = [];
let draggedTripId = null;
let thumbnailsVisible = false;
let mapLayers = {};
let currentMapLayer = 'satellite'; // デフォルトを衛星写真に設定
const gpxCache = {};
const LAST_TRIP_ID_KEY = 'air-last-trip-id';
let corsWarningShown = false;
let characterImageData = null; // キャラクター画像（Base64形式）
let addingGpsPointMode = false; // GPSポイント追加モード

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
  console.warn('GPX ファイルや画像の読み込みに失敗しています。');
  console.warn('以下のコマンドを実行して CORS 設定を適用してください：');
  console.warn('');
  console.warn('  gsutil cors set cors.json gs://airgo-trip.firebasestorage.app');
  console.warn('');
  console.warn('詳しい手順は CORS_SETUP.md を参照してください。');
  console.warn('='.repeat(60));

  // ユーザーにも通知（1回のみ）
  if (isEditor()) {
    setTimeout(() => {
      if (confirm('Firebase Storage の CORS 設定が必要です。\n\nGPX ファイルの読み込みに失敗しています。\n設定手順を確認しますか？')) {
        alert('ターミナルで以下を実行してください：\n\ngsutil cors set cors.json gs://airgo-trip.firebasestorage.app\n\n詳しくは CORS_SETUP.md を参照してください。');
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

  // 各種マップレイヤーの定義
  mapLayers = {
    terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap, © OpenTopoMap',
      maxZoom: 17
    }),
    standard: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri, Maxar, Earthstar Geographics',
      maxZoom: 18
    })
  };

  // デフォルトレイヤー（地形）を追加
  mapLayers[currentMapLayer].addTo(map);

  // レイヤー切り替えコントロールを追加
  addLayerControl();
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

function initMap3d() {
  return new Promise((resolve) => {
    if (map3d) {
      resolve();
      return;
    }
    if (!window.maplibregl) {
      console.warn('MapLibre GL未読み込み');
      resolve();
      return;
    }
    const el = document.getElementById('map3d');
    if (!el) {
      resolve();
      return;
    }
    const center = map.getCenter();
    map3d = new maplibregl.Map({
      container: 'map3d',
      zoom: 17,
      center: [center.lng, center.lat],
      pitch: 78,
      bearing: 0,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            attribution: '© Esri, Maxar, Earthstar Geographics',
            maxzoom: 19
          },
          terrainSource: {
            type: 'raster-dem',
            url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
            tileSize: 256
          },
          hillshadeSource: {
            type: 'raster-dem',
            url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
            tileSize: 256
          }
        },
        layers: [
          {
            id: 'satellite',
            type: 'raster',
            source: 'satellite',
            paint: {
              'raster-saturation': 0.05,
              'raster-contrast': 0.2,
              'raster-brightness-min': 0.15,
              'raster-brightness-max': 1.0,
              'raster-fade-duration': 300
            }
          },
          {
            id: 'hills',
            type: 'hillshade',
            source: 'hillshadeSource',
            layout: { visibility: 'visible' },
            paint: {
              'hillshade-shadow-color': '#1A1A1A',
              'hillshade-accent-color': '#F5F5F5',
              'hillshade-exaggeration': 0.4,
              'hillshade-illumination-direction': 315,
              'hillshade-illumination-anchor': 'viewport'
            }
          }
        ],
        terrain: { source: 'terrainSource', exaggeration: 2.0 },
        sky: {
          'sky-color': '#7AB8E0',
          'horizon-color': '#D8E8F4',
          'fog-color': '#E8F0F8',
          'fog-ground-blend': 0.4
        }
      },
      maxZoom: 19,
      maxPitch: 85
    });
    map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map3d.on('load', () => {
      // 地形の立体感を強調
      if (map3d.getTerrain()) {
        map3d.setTerrain({ source: 'terrainSource', exaggeration: 2.0 });
      }
      // 霧効果で遠景に深みを追加（航空写真用）
      map3d.setFog({
        range: [0.8, 12],
        color: '#D8E4F0',
        'horizon-blend': 0.15,
        'high-color': '#A8C8E8',
        'space-color': '#7AB8E0',
        'star-intensity': 0.15
      });
      map3d.resize();
      resolve();
    });
  });
}

async function add3dMapRouteAndMarkers() {
  if (!map3d || !currentTrip) return;

  // 既存のレイヤーとソースをクリア
  if (map3d.getLayer('route')) map3d.removeLayer('route');
  if (map3d.getSource('route')) map3d.removeSource('route');
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

    map3d.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      paint: {
        'line-color': color,
        'line-width': 5,
        'line-opacity': 0.8
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
        isLandmark: !!(p.landmarkNo || p.landmarkName)
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

    map3d.addLayer({
      id: 'points',
      type: 'circle',
      source: 'points',
      paint: {
        'circle-radius': 6,
        'circle-color': color,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 0.9
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

function flyMap3dTo(lat, lng, zoom, durationMs) {
  return new Promise((resolve) => {
    if (map3d && playTimer) {
      // 現在のbearingを取得して少し回転させる
      const currentBearing = map3d.getBearing();
      const newBearing = currentBearing + (Math.random() * 20 - 10);

      // moveend イベントでアニメーション完了を検知
      const onMoveEnd = () => {
        map3d.off('moveend', onMoveEnd);
        resolve();
      };
      map3d.once('moveend', onMoveEnd);

      map3d.flyTo({
        center: [lng, lat],
        zoom: zoom ?? 17,
        pitch: 78,
        bearing: newBearing,
        duration: (durationMs || 2700) / 1000,
        essential: true,
        curve: 1.4,
        speed: 0.7,
        easing: (t) => t * (2 - t)
      });
    } else {
      resolve();
    }
  });
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
        const { lat, lon } = data[0];
        map.setView([parseFloat(lat), parseFloat(lon)], 14);
      }
    } catch (err) {
      console.warn('検索エラー:', err);
    }
  });
}

const MAX_PHOTO_DIM = 1024;
const PHOTO_JPEG_QUALITY = 0.78;

function compressImageToBlob(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > MAX_PHOTO_DIM || h > MAX_PHOTO_DIM) {
        if (w > h) {
          h = Math.round(h * MAX_PHOTO_DIM / w);
          w = MAX_PHOTO_DIM;
        } else {
          w = Math.round(w * MAX_PHOTO_DIM / h);
          h = MAX_PHOTO_DIM;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob || new Blob()), 'image/jpeg', PHOTO_JPEG_QUALITY);
    };
    img.onerror = () => resolve(new Blob());
    img.src = dataUrl;
  });
}

async function uploadPhotoToStorage(tripId, photoIndex, blob) {
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');
  const path = `trips/${tripId}/photos/${photoIndex}_${Date.now()}.jpg`;
  const ref = window.firebaseStorage.ref(path);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ref.put(blob, { contentType: 'image/jpeg' });
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
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');
  const path = `trips/${tripId}/travelogue/content.html`;
  const ref = window.firebaseStorage.ref(path);
  const blob = new Blob([htmlContent], { type: 'text/html; charset=utf-8' });
  await ref.put(blob, { contentType: 'text/html; charset=utf-8' });
  const url = await ref.getDownloadURL();
  return url;
}

async function uploadAnimeImageToStorage(tripId, imageDataUrl) {
  if (!window.firebaseStorage || !window.firebaseAuth?.currentUser) throw new Error('Storage not ready');

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

  // ユニークなファイル名を生成
  const timestamp = Date.now();
  const extension = mimeType.split('/')[1] || 'jpg';
  const path = `trips/${tripId}/animes/anime_${timestamp}.${extension}`;
  const ref = window.firebaseStorage.ref(path);

  await ref.put(blob, { contentType: mimeType });
  const url = await ref.getDownloadURL();
  return url;
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
  if (gpxCache[url]) return gpxCache[url];
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`GPX 取得失敗: ${url} (ステータス: ${res.status})`);
      throw new Error(`GPX fetch failed: ${res.status}`);
    }
    const text = await res.text();
    gpxCache[url] = text;
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
  return {
    blob,
    mime: 'image/jpeg',
    lat,
    lng,
    name: file.name,
    placeName: '',
    description: '',
    landmarkNo: '',
    landmarkName: '',
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
      const extUrl = `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&exchars=400&format=json&origin=*&titles=${encodeURIComponent(title)}`;
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
        const photo = {
          url,
          mime: photoData.mime,
          lat,
          lng,
          name: photoData.name,
          placeName,
          description: photoData.description,
          landmarkNo: photoData.landmarkNo,
          landmarkName: photoData.landmarkName,
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

async function updateTripInputs() {
  await updateHeaderInfo();
  const gpxZone = document.getElementById('gpxZone');
  const gpxLabel = gpxZone?.querySelector('span:last-of-type');
  if (!currentTrip) {
    if (gpxLabel) gpxLabel.textContent = 'GPXファイル';
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
  updateViewerSection();
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
      const parentTrip = allTrips.find(t => t.id === currentTrip.parentId);
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
      const childTrips = getOrderedTrips().filter(t => t.parentId === currentTrip.id);
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
  if (nameEl) nameEl.textContent = currentTrip.name || '（無題）';

  // トリップ説明（ブログURLがある場合はリンク化）
  if (descEl && descWrap) {
    const desc = currentTrip.description || '';
    if (desc) {
      if (currentTrip.url) {
        // ブログURLがある場合はリンクを追加
        descEl.innerHTML = `${escapeHtml(desc)}<br><a href="${escapeHtml(currentTrip.url)}" target="_blank" rel="noopener" class="viewer-trip-link">📝 ブログを見る</a>`;
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

  // 旅行記ボタン
  if (travelogueBtn) {
    const hasTravelogue = currentTrip.travelogueHtml || currentTrip.travelogueUrl;
    travelogueBtn.style.display = hasTravelogue ? '' : 'none';
  }

  // 動画ボタン
  if (videoBtn) {
    videoBtn.style.display = currentTrip.videoUrl ? '' : 'none';
  }

  // スタンプボタン
  if (stampBtn) {
    const hasLandmarks = (currentTrip.photos || []).some(p => p.landmarkNo);
    stampBtn.style.display = hasLandmarks ? '' : 'none';
  }

  // アニメ画像
  if (animeWrap && animesList) {
    const animes = currentTrip.animes || [];
    if (animes.length > 0) {
      animesList.innerHTML = '';
      animes.forEach((anime, idx) => {
        const img = document.createElement('img');
        img.src = anime.url;
        img.style.width = '100px';
        img.style.height = '100px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.style.border = '2px solid var(--border)';
        img.title = anime.style || 'アニメ画像';
        img.onclick = () => {
          const modal = document.getElementById('animeModal');
          const modalImg = document.getElementById('animeModalImage');
          if (modal && modalImg) {
            modalImg.src = anime.url;
            modal.classList.add('open');
          }
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
    const children = getOrderedTrips().filter(t => t.parentId === currentTrip.id);
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
  updateMapMarkers();
  setStatus('表示順を変更しました。保存してください');
}

function deleteThumbnail(index) {
  if (!currentTrip?.photos?.length || currentTrip.isParent) return;
  if (!confirm('この写真を削除しますか？')) return;
  currentTrip.photos.splice(index, 1);
  currentPhotoIndex = Math.min(index, Math.max(0, currentTrip.photos.length - 1));
  renderThumbnails();
  updateMapMarkers();
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
        // 写真がある場合
        const img = document.createElement('img');
        img.src = p.url;
        img.alt = p.name;
        img.onclick = () => showPhotoAtIndex(i);
        item.appendChild(img);
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
  const displayItems = getTripsForDisplay();
  const result = [];
  for (const { trip } of displayItems) {
    if (trip.isParent) {
      const children = getOrderedTrips().filter(t => t.parentId === trip.id);
      result.push(...children);
    } else {
      result.push(trip);
    }
  }
  return result.filter(t => t.gpxData || t.gpxDataUrl || ((t.photos || []).some(p => p.lat != null && p.lng != null)));
}

async function updateMapMarkers() {
  if (!map) {
    console.warn('地図が初期化されていません');
    return;
  }

  // 写真ポップアップをクリア
  if (photoPopup) {
    try {
      map.removeLayer(photoPopup);
    } catch (e) {
      console.warn('写真ポップアップ削除エラー:', e);
    }
    photoPopup = null;
  }

  try {
    markers.forEach(m => map.removeLayer(m));
  } catch (e) {
    console.warn('マーカー削除エラー:', e);
  }
  markers = [];

  try {
    gpxLayers.forEach(l => map.removeLayer(l));
  } catch (e) {
    console.warn('GPXレイヤー削除エラー:', e);
  }
  gpxLayers = [];

  const tripsToShow = [];
  if (currentTrip?.isParent) {
    tripsToShow.push(...getOrderedTrips().filter(t => t.parentId === currentTrip.id));
  } else if (currentTrip) {
    tripsToShow.push(currentTrip);
  } else {
    tripsToShow.push(...getTripsWithGpsForOverview());
  }

  if (tripsToShow.length === 0) return;

  const allLatLngs = []; // 地図の表示範囲決定用（写真マーカーのみ）
  let globalIdx = 0;
  for (let tripIdx = 0; tripIdx < tripsToShow.length; tripIdx++) {
    const trip = tripsToShow[tripIdx];
    const color = trip.color || TRIP_COLORS[tripIdx % TRIP_COLORS.length];
    let pts = [];
    const gpxText = await getGpxContent(trip).catch(err => {
      console.warn('GPX取得失敗:', trip.name || trip.id, err);
      return null;
    });
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
      const layer = L.polyline(pts, { color, weight: 4, opacity: 0.8, smoothFactor: 1.5 }).addTo(map);
      gpxLayers.push(layer);
      // allLatLngsには追加しない（写真マーカーのみで範囲を決定）
    }

    // 親トリップ表示時は子トリップの写真マーカーを表示しない
    const shouldShowPhotoMarkers = !(currentTrip?.isParent && trip.parentId === currentTrip.id);

    if (shouldShowPhotoMarkers) {
      (trip.photos || []).forEach((p, i) => {
        const coord = ensureLatLng(p.lat, p.lng);
        if (coord) {
          const { lat: plat, lng: plng } = coord;
        const isLandmark = !!(p.landmarkNo);

        // ランドマークは小さい写真、その他は小さい丸
        let photoIconHtml, iconSize, iconAnchor;
        if (isLandmark && p.url) {
          const no = String(p.landmarkNo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          photoIconHtml = `
            <div style="position:relative;width:50px;height:50px;">
              <img src="${p.url}" style="width:50px;height:50px;border-radius:6px;border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.5);object-fit:cover;display:block;" />
              <span style="position:absolute;top:0;left:0;background:${color};color:#fff;font-weight:bold;font-size:11px;padding:2px 5px;border-radius:3px 0 4px 0;box-shadow:0 2px 4px rgba(0,0,0,0.4);">${no}</span>
            </div>
          `;
          iconSize = [50, 50];
          iconAnchor = [25, 50];
        } else if (isLandmark) {
          // 写真がない場合は番号付きの丸
          const no = String(p.landmarkNo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          photoIconHtml = `<div style="background:${color};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:16px;border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.5)">${no}</div>`;
          iconSize = [34, 34];
          iconAnchor = [17, 17];
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
        // マーカーをツールチップのみで表示（クリック時のポップアップなし）
        const tooltipParts = [];
        if (p.landmarkNo) tooltipParts.push('📍 ' + p.landmarkNo);
        if (p.name) tooltipParts.push(p.name);
        if (p.description) tooltipParts.push(p.description);
        const tooltipLabel = tooltipParts.length ? tooltipParts.join(' — ') : `#${i + 1}`;
        m.addTo(map).bindTooltip(tooltipLabel, { direction: 'top', offset: [0, -10] });
        const tripRef = trip;
        const photoIdx = i;
        const idx = globalIdx++;
        // エディターモードの時だけクリック可能（編集用）
        if (isEditor()) {
          m.on('click', async () => {
            if (!currentTrip) {
              await loadTripById(tripRef.id);
              currentPhotoIndex = photoIdx;
            } else {
              currentPhotoIndex = idx;
            }
            showPhotoAtIndex(currentPhotoIndex);
          });
        }
        if (isEditor() && m.dragging) {
          m.on('dragend', async () => {
            const pos = m.getLatLng();
            if (tripRef.photos?.[photoIdx]) {
              tripRef.photos[photoIdx].lat = parseFloat(pos.lat.toFixed(6));
              tripRef.photos[photoIdx].lng = parseFloat(pos.lng.toFixed(6));
              tripRef.photos[photoIdx].placeName = await reverseGeocode(pos.lat, pos.lng);
              setStatus('位置を更新しました。保存してください');
              updateHeaderInfo();
            }
          });
        }
        markers.push(m);
        allLatLngs.push([plat, plng]);
      }
    });
    }
  }
  if (allLatLngs.length > 0) {
    if (allLatLngs.length === 1) {
      map.setView(allLatLngs[0], 15);
    } else {
      // 全てのポイントが見えるように余裕を持って表示
      map.fitBounds(allLatLngs, { padding: [60, 60] });
    }
  }
}

function parseGpxPoints(xmlStr) {
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

  return pts;
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

  // 自動再生中は専用オーバーレイに表示
  if (playTimer) {
    showPlaybackPhotoOverlay(p);
    return;
  }

  // 写真を表示する際にサムネイルも表示
  if (!thumbnailsVisible) {
    thumbnailsVisible = true;
    renderThumbnails();
  }

  if (photoPopup) {
    map.removeLayer(photoPopup);
    photoPopup = null;
  }
  if (isEditor() && !viewOnly) {
    showPhotoPopupEditMode(lat, lng);
  } else {
    showPhotoViewMode(p, lat, lng);
  }
}

let lastPlaybackPhotoUrl = null;

function showPlaybackPhotoOverlay(p) {
  const overlay = document.getElementById('playbackPhotoOverlay');
  const card = document.getElementById('playbackPhotoCard');
  if (!overlay || !card) return;

  // 同じ写真なら更新しない（パフォーマンス最適化）
  if (lastPlaybackPhotoUrl === p.url) {
    overlay.classList.remove('hidden');
    return;
  }
  lastPlaybackPhotoUrl = p.url;

  // 写真コンテナ
  let photoWrap = card.querySelector('.playback-photo-wrap');
  if (!photoWrap) {
    photoWrap = document.createElement('div');
    photoWrap.className = 'playback-photo-wrap';
    card.appendChild(photoWrap);
  }

  // 写真
  let img = photoWrap.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.loading = 'eager';
    img.decoding = 'async';
    photoWrap.appendChild(img);
  }
  // 画像URLが変わる場合のみ更新
  const newSrc = p.url || '';
  if (img.src !== newSrc) {
    img.src = newSrc;
  }
  img.alt = p.name || '';

  // 写真上部のオーバーレイ（ランドマーク番号・ポイント名）
  let topOverlay = photoWrap.querySelector('.playback-photo-overlay-top');
  if (!topOverlay) {
    topOverlay = document.createElement('div');
    topOverlay.className = 'playback-photo-overlay-top';
    photoWrap.appendChild(topOverlay);
  }
  let overlayHTML = '';
  if (p.landmarkNo) {
    overlayHTML += `<span class="playback-photo-landmark">${escapeHtml(String(p.landmarkNo))}</span>`;
  }
  // ポイント名を表示
  const pointName = p.name || '';
  if (pointName) {
    const tripColor = currentTrip && currentTrip.color ? currentTrip.color : '';
    const colorStyle = tripColor ? ` style="color:${tripColor}"` : '';
    overlayHTML += `<span class="playback-photo-name"${colorStyle}>${escapeHtml(pointName)}</span>`;
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
    overlay.classList.add('hidden');
  }
}

function showPhotoViewMode(p, lat, lng) {
  const div = document.createElement('div');
  div.className = 'photo-popup photo-popup-view';
  const photoWrap = document.createElement('div');
  photoWrap.className = 'photo-popup-photo-wrap';
  const img = document.createElement('img');
  img.src = p.url || '';
  img.alt = p.name || '';
  img.title = 'クリックでオリジナルを表示';
  img.loading = 'eager';
  img.decoding = 'async';
  img.onclick = () => { if (p.url) window.open(p.url, '_blank', 'noopener'); };
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
  if (isEditor()) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'photo-popup-edit photo-popup-edit-inline';
    editBtn.title = '編集';
    editBtn.innerHTML = '✏️';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      if (photoPopup) {
        map.removeLayer(photoPopup);
        photoPopup = null;
      }
      showPhotoPopupEditMode(lat, lng);
    };
    div.appendChild(editBtn);
  }
  photoPopup = L.popup({ maxWidth: 840, className: 'photo-popup-container' })
    .setLatLng([lat, lng])
    .setContent(div)
    .openOn(map);
}

function showPhotoPopupEditMode(lat, lng) {
  if (!currentTrip || currentTrip.isParent) return;
  const photos = currentTrip.photos || [];
  const idx = Math.min(currentPhotoIndex, photos.length - 1);
  const p = photos[idx] || {};
  if (photoPopup) {
    map.removeLayer(photoPopup);
    photoPopup = null;
  }
  const div = document.createElement('div');
  div.className = 'photo-popup photo-popup-edit-mode';
  const photoWrap = document.createElement('div');
  photoWrap.className = 'photo-popup-photo-wrap';
  const img = document.createElement('img');
  img.src = p.url || '';
  img.alt = p.name || '';
  img.title = 'クリックでオリジナルを表示';
  if (p.url) img.onclick = () => window.open(p.url, '_blank', 'noopener');
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
  landmarkCheck.checked = !!(p.landmarkNo || p.landmarkName);
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
  landmarkNoInput.placeholder = '例: 1, 2-A';
  landmarkNoInput.value = p.landmarkNo || '';
  landmarkNoWrap.appendChild(landmarkNoInput);
  landmarkRow.appendChild(landmarkNoWrap);

  form.appendChild(landmarkRow);

  const nameWrap = document.createElement('div');
  nameWrap.className = 'photo-popup-field';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'ポイント名';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'photo-popup-input';
  nameInput.placeholder = '地名・スポット名';
  nameInput.value = p.name || '';
  nameWrap.appendChild(nameLabel);
  nameWrap.appendChild(nameInput);
  form.appendChild(nameWrap);

  const descWrap = document.createElement('div');
  descWrap.className = 'photo-popup-field';
  const descLabel = document.createElement('label');
  descLabel.textContent = 'ポイント説明';
  const descInput = document.createElement('textarea');
  descInput.className = 'photo-popup-input photo-popup-textarea';
  descInput.placeholder = '説明（任意）';
  descInput.rows = 2;
  descInput.value = p.description || '';
  descWrap.appendChild(descLabel);
  descWrap.appendChild(descInput);
  form.appendChild(descWrap);

  const saveDeleteRow = document.createElement('div');
  saveDeleteRow.className = 'photo-popup-save-delete-row';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = '保存';
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
    if (!landmarkCheck.checked) landmarkNoInput.value = '';
  };
  landmarkNoWrap.style.display = landmarkCheck.checked ? 'flex' : 'none';

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
      const coord = ensureLatLng(photoData.lat, photoData.lng);
      let photoLat = coord ? coord.lat : (lat || photos[idx].lat);
      let photoLng = coord ? coord.lng : (lng || photos[idx].lng);
      let placeName = photoData.placeName || '';
      if (coord) {
        placeName = await reverseGeocode(photoLat, photoLng);
      }

      // Storageにアップロード
      const url = await uploadPhotoToStorage(currentTrip.id, idx, photoData.blob);

      // 写真データを更新
      photos[idx].url = url;
      photos[idx].mime = photoData.mime;
      photos[idx].lat = photoLat;
      photos[idx].lng = photoLng;
      photos[idx].placeName = placeName || photos[idx].placeName;
      photos[idx].name = photos[idx].name || photoData.name;

      // UI更新
      img.src = url;
      await updateTripInputs();

      // 保存
      try {
        await saveTrip({ silent: true });
        renderThumbnails();
        updateMapMarkers();
        setStatus('写真を追加しました');
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
      photos[idx].landmarkName = photos[idx].landmarkNo || '';
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
        updateMapMarkers();
        if (closeAfter && photoPopup) {
          map.removeLayer(photoPopup);
          photoPopup = null;
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

    // 写真URLのみ削除、ポイント情報は保持
    if (photos[idx]) {
      photos[idx].url = '';
      photos[idx].mime = '';
      // name, description, lat, lng, landmarkNo などは保持
    }

    if (photoPopup) {
      map.removeLayer(photoPopup);
      photoPopup = null;
    }

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
      updateMapMarkers();
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

    photos.splice(idx, 1);
    if (photoPopup) {
      map.removeLayer(photoPopup);
      photoPopup = null;
    }
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
      updateMapMarkers();
      if (photos.length > 0) {
        showPhotoAtIndex(currentPhotoIndex, true);
      } else {
        renderTripDetailPane();
        updateHeaderInfo();
      }
      setStatus('✓ ポイントを削除しました');
    }
  };

  photoPopup = L.popup({ maxWidth: 840, className: 'photo-popup-container photo-popup-edit-container', closeButton: false })
    .setLatLng([lat, lng])
    .setContent(div)
    .openOn(map);
}

// GPSポイント追加モードの切り替え
function toggleAddGpsPointMode() {
  addingGpsPointMode = !addingGpsPointMode;
  const btn = document.getElementById('addGpsPointBtn');
  if (btn) {
    btn.classList.toggle('active', addingGpsPointMode);
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
  if (photoPopup) {
    map.removeLayer(photoPopup);
    photoPopup = null;
  }
}

function stopPlay() {
  if (playTimer) {
    clearTimeout(playTimer);
    clearInterval(playTimer); // 念のため両方
    playTimer = null;
  }
  playbackPhotos = []; // 再生用配列をクリア
  const playBtn = document.getElementById('playBtn');
  if (playBtn) playBtn.textContent = '▶ 再生';
  document.querySelector('.map-container')?.classList.remove('map-playback-cinematic');
  document.body.classList.remove('app-playing');
  hidePlaybackPhotoOverlay();
  hidePlayOverlay();
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

function animateCameraAlongRoute(routePts, durationMs) {
  return new Promise((resolve) => {
    if (!routePts || routePts.length < 2 || durationMs <= 0) {
      resolve();
      return;
    }
    const start = performance.now();
    const n = routePts.length - 1;
    let lastFrameTime = start;
    const frameInterval = 1000 / 30; // 30fps（パフォーマンス最適化）

    const tick = (now) => {
      if (!playTimer) {
        resolve();
        return;
      }

      // フレームレート制限でパフォーマンス向上
      if (now - lastFrameTime < frameInterval) {
        requestAnimationFrame(tick);
        return;
      }
      lastFrameTime = now;

      const elapsed = now - start;
      if (elapsed >= durationMs) {
        const [lat, lng] = routePts[routePts.length - 1];
        setMap3dView(lat, lng, 17);
        resolve(); // アニメーション完了
        return;
      }
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 1.2);
      const pos = eased * n;
      const idx = Math.min(Math.floor(pos), n - 1);
      const t = pos - idx;
      const [lat1, lng1] = routePts[idx];
      const [lat2, lng2] = routePts[idx + 1];
      const lat = lat1 + t * (lat2 - lat1);
      const lng = lng1 + t * (lng2 - lng1);
      // 自動再生中は3D地図のみ更新（パフォーマンス向上）
      setMap3dView(lat, lng, 17);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function startPlay() {
  if (playTimer) {
    stopPlay();
    return;
  }

  const allPhotos = getDisplayPhotos();
  // 写真があるポイントのみを再生対象にする
  playbackPhotos = allPhotos.filter(p => p.url && p.url.trim());
  if (!playbackPhotos.length) {
    alert('再生できる写真がありません。写真を追加してください。');
    return;
  }

  // 処理中であることを示すため、先に playTimer をセット（二重実行防止）
  const startingPlay = true; // 開始中フラグ

  try {
    // 必ず1枚目の写真から再生開始
    currentPhotoIndex = 0;

    // 前回の再生状態をリセット
    lastPlaybackPhotoUrl = null;

    const intervalSec = 3;
    playIntervalMs = intervalSec * 1000;
    const playBtn = document.getElementById('playBtn');
    if (playBtn) playBtn.textContent = '■ 停止';
    document.querySelector('.map-container')?.classList.add('map-playback-cinematic');
    document.body.classList.add('app-playing');

    // 自動再生時はサムネイルを非表示
    thumbnailsVisible = false;
    renderThumbnails();

    // 3D地図の初期化完了を待つ
    await initMap3d();

    // 3D地図にルートとマーカーを表示
    await add3dMapRouteAndMarkers();

    const p0 = playbackPhotos[0];
    if (p0?.lat != null && p0?.lng != null) {
      map.setView([p0.lat, p0.lng], 17);
      setMap3dView(p0.lat, p0.lng, 17);
    }

    const tick = async () => {
      if (!playTimer || currentPhotoIndex >= playbackPhotos.length - 1) {
        stopPlay();
        return;
      }

      currentPhotoIndex++;
      const nextP = playbackPhotos[currentPhotoIndex];

      // 次の写真を表示
      showPlaybackPhotoOverlay(nextP);

      // カメラアニメーションを実行して完了を待つ
      if (nextP?.lat != null && nextP?.lng != null) {
        // 3D地図を移動
        await flyMap3dTo(nextP.lat, nextP.lng, 17, 1500);
      }

      // カメラアニメーション完了後、写真を表示する時間を設定
      const displayDuration = 2500; // 写真表示時間
      playTimer = setTimeout(tick, displayDuration);
    };

    // playTimerを設定して自動再生モードに（ダミー値で先に設定）
    playTimer = true;

    // 1枚目の写真を表示
    showPlaybackPhotoOverlay(p0);

    // 初期化完了後、最初の写真の表示時間後に次へ
    playTimer = setTimeout(tick, 2500);
  } catch (err) {
    console.error('自動再生の開始エラー:', err);
    stopPlay(); // エラー発生時は停止
    alert('自動再生の開始に失敗しました。ページを再読み込みしてください。');
  }
}

function prevPhoto() {
  const photos = getDisplayPhotos();
  if (!photos.length) return;
  currentPhotoIndex = (currentPhotoIndex - 1 + photos.length) % photos.length;
  if (!thumbnailsVisible) {
    thumbnailsVisible = true;
    renderThumbnails();
  }
  showPhotoAtIndex(currentPhotoIndex);
}

function nextPhoto() {
  const photos = getDisplayPhotos();
  if (!photos.length) return;
  currentPhotoIndex = (currentPhotoIndex + 1) % photos.length;
  if (!thumbnailsVisible) {
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
  if (!isParent && !parentId && (!currentTrip?.photos?.length) && !currentTrip?.gpxData && !currentTrip?.gpxDataUrl) {
    if (!silent) alert('写真またはGPXを追加するか、「親トリップ」にチェックを入れてください');
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
      generatedAnimes: currentTrip.generatedAnimes || []
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
      generatedAnimes: currentTrip.generatedAnimes || []
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
    setStatus('保存しました');
    closeMenu();
    await loadMyTrips();
    const saved = myTrips.find(t => t.id === currentTrip.id);
    if (saved) currentTrip = { ...saved, id: saved.id };
    renderThumbnails();
    await updateMapMarkers();
    renderTripDetailPane();
    await updateHeaderInfo();
    renderTripList();
    refreshTripSelect();
    refreshTripParentSelectOptions();
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

async function loadMyTrips() {
  if (!window.firebaseDb) {
    console.warn('Firebase DB が初期化されていません');
    myTrips = [];
    return;
  }

  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`トリップ一覧読み込みリトライ中... (${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }

      if (window.firebaseAuth?.currentUser) {
        console.log('自分のトリップ一覧を取得中...');
        const snapshot = await window.firebaseDb.collection('trips')
          .where('userId', '==', window.firebaseAuth.currentUser.uid)
          .get();
        myTrips = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
        console.log(`✓ ${myTrips.length} 件のトリップを読み込みました（自分のトリップ）`);
      } else {
        console.log('公開トリップ一覧を取得中...');
        const snapshot = await window.firebaseDb.collection('trips')
          .where('public', '==', true)
          .get();
        myTrips = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
        console.log(`✓ ${myTrips.length} 件の公開トリップを読み込みました`);
      }

      return; // 成功したら終了

    } catch (err) {
      lastError = err;
      console.error(`トリップ一覧読み込みエラー (試行 ${attempt + 1}/${maxRetries + 1}):`, err);

      const isNetworkError = err.message?.includes('Failed to fetch') ||
                            err.message?.includes('NetworkError') ||
                            err.message?.includes('network') ||
                            err.code === 'unavailable';

      if (!isNetworkError || attempt === maxRetries) {
        break;
      }
    }
  }

  // すべてのリトライが失敗した場合
  console.error('トリップ一覧読み込み最終エラー:', lastError);
  myTrips = [];

  if (lastError.message?.includes('Failed to fetch') || lastError.message?.includes('NetworkError') || lastError.code === 'unavailable') {
    console.error('→ ネットワークエラー: インターネット接続を確認してください');
  } else if (lastError.code === 'permission-denied') {
    console.error('→ アクセス権限エラー: Firestore のセキュリティルールを確認してください');
  }

  throw lastError; // エラーを再スローして呼び出し元で処理
}

async function loadTripOrder() {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) {
    tripOrder = [];
    return;
  }
  try {
    const doc = await window.firebaseDb.collection('users').doc(window.firebaseAuth.currentUser.uid).get();
    tripOrder = (doc.exists && doc.data()?.tripOrder) ? [...doc.data().tripOrder] : [];
  } catch (err) {
    console.warn('トリップ順序読み込みエラー:', err);
    tripOrder = [];
  }
}

async function saveTripOrder(ids) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return { ok: false, err: 'ログインが必要です' };
  try {
    await window.firebaseDb.collection('users').doc(window.firebaseAuth.currentUser.uid).set(
      { tripOrder: ids },
      { merge: true }
    );
    tripOrder = [...ids];
    for (let i = 0; i < ids.length; i++) {
      try {
        await window.firebaseDb.collection('trips').doc(ids[i]).set({ order: i }, { merge: true });
      } catch (e) {
        console.warn('トリップ order 更新エラー:', ids[i], e);
      }
    }
    return { ok: true };
  } catch (err) {
    console.warn('トリップ順序保存エラー:', err);
    return { ok: false, err: err.message || String(err) };
  }
}

function getOrderedTrips() {
  const byId = new Map(myTrips.map(t => [t.id, t]));
  if (tripOrder.length > 0) {
    const ordered = [];
    for (const id of tripOrder) {
      if (byId.has(id)) {
        ordered.push(byId.get(id));
        byId.delete(id);
      }
    }
    const rest = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return [...ordered, ...rest];
  }
  const list = [...byId.values()];
  return list.sort((a, b) => {
    const uidA = a.userId || '';
    const uidB = b.userId || '';
    if (uidA !== uidB) return uidA.localeCompare(uidB);
    const oa = a.order ?? Infinity;
    const ob = b.order ?? Infinity;
    if (oa !== ob) return oa - ob;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

/** 表示用: 親→子の順、子はインデント対象 */
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
  const result = [];
  roots.forEach(r => {
    result.push({ trip: r, isChild: false });
    (childrenByParent.get(r.id) || []).sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0)).forEach(c => {
      result.push({ trip: c, isChild: true });
    });
  });
  return result;
}

function renderTripList() {
  const list = document.getElementById('tripList');
  if (!list) return;
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
      row.addEventListener('dragstart', (e) => {
        draggedTripId = t.id;
        e.dataTransfer.setData('text/plain', t.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-trip-id', t.id);
        row.classList.add('trip-item-dragging');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('trip-item-dragging');
        draggedTripId = null;
      });
      row.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('trip-item-drag-over');
      });
      row.addEventListener('dragleave', (e) => {
        const rt = e.relatedTarget;
        if (!rt || !row.contains(rt)) row.classList.remove('trip-item-drag-over');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('trip-item-drag-over');
        const id = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('application/x-trip-id') || draggedTripId;
        if (id && id !== t.id) handleTripDrop(id, t.id);
      });
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
    if (isEditor()) {
      const dragHandle = document.createElement('span');
      dragHandle.className = 'trip-item-drag-handle';
      dragHandle.title = 'ドラッグで順番変更・親にドロップで子に';
      dragHandle.textContent = '⋮⋮';
      dragHandle.draggable = false;
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
    if (isSelected && !t.isParent && !isMobileView()) {
      const detail = document.createElement('div');
      detail.className = 'trip-detail-inline';
      if (t.color) detail.style.setProperty('--trip-selected-color', t.color);
      const photos = t.isParent ? [] : (t.photos || []);
      const children = t.isParent ? getOrderedTrips().filter(x => x.parentId === t.id) : [];
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
      const hasLandmarks = (t.photos || []).some(p => p.landmarkNo);
      // ブログボタンは表示しない（説明にリンクをつけるため）
      if (t.videoUrl || (t.travelogueHtml && t.travelogueHtml.trim()) || hasLandmarks) {
        html += '<div class="trip-detail-btns">';
        if (t.videoUrl) html += `<button type="button" class="btn btn-primary btn-xs trip-detail-btn trip-detail-video-btn">動画</button>`;
        if (t.travelogueHtml && t.travelogueHtml.trim()) html += `<button type="button" class="btn btn-secondary btn-xs trip-detail-btn trip-detail-travelogue-btn">旅行記</button>`;
        if (hasLandmarks) html += `<button type="button" class="btn btn-stamp btn-xs trip-detail-btn trip-detail-stamp-rally-btn">スタンプ</button>`;
        html += '</div>';
      }
      if (t.isParent && children.length > 0) {
        html += `<p class="trip-detail-meta">子トリップ ${children.length} 件</p>`;
      }
      if (children.length > 0) {
        html += '<p class="trip-detail-children"><strong>子トリップ:</strong> ';
        html += children.map(c => escapeHtml(c.name || c.id)).join('、');
        html += '</p>';
      }
      detail.innerHTML = html;
      list.appendChild(detail);
      detail.querySelectorAll('.trip-detail-video-btn').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); showVideoOverlay(t.videoUrl); };
      });
      detail.querySelectorAll('.trip-detail-travelogue-btn').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); showTravelogueModal(); };
      });
      detail.querySelectorAll('.trip-detail-stamp-rally-btn').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); showStampRallyModal(t); };
      });
      detail.querySelectorAll('.trip-photo-count-toggle').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); toggleThumbnails(); };
      });
    }
  });

  // モバイル用トリップシートトリガーのラベルを更新
  updateTripSheetTriggerLabel();
}

async function handleTripDrop(draggedId, targetId) {
  if (!isEditor()) return;
  const dragged = myTrips.find(t => t.id === draggedId);
  const target = myTrips.find(t => t.id === targetId);
  if (!dragged || !target) return;
  if (target.isParent) {
    await setTripParent(draggedId, targetId);
  } else {
    await reorderTripByDrop(draggedId, targetId);
  }
}

async function setTripParent(childId, parentId) {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return;
  const child = myTrips.find(t => t.id === childId);
  if (!child || child.userId !== window.firebaseAuth.currentUser.uid) return;
  const parent = myTrips.find(t => t.id === parentId);
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
  const t = myTrips.find(x => x.id === id);
  if (!t || !window.firebaseDb || !window.firebaseAuth?.currentUser || t.userId !== window.firebaseAuth.currentUser.uid) return;
  if (!confirm(`本当に「${t.name || id}」を削除しますか？\nこの操作は取り消せません。`)) return;
  try {
    await window.firebaseDb.collection('trips').doc(id).delete();
    const newOrder = tripOrder.filter(x => x !== id);
    await saveTripOrder(newOrder);
    if (currentTrip?.id === id) {
      currentTrip = null;
      currentPhotoIndex = 0;
      thumbnailsVisible = false;
      renderThumbnails();
      updateMapMarkers();
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
  const children = getOrderedTrips().filter(t => t.parentId === parentId).sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));
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
}

async function addChildTripUnder(parentId) {
  if (!isEditor()) return;
  const parent = myTrips.find(t => t.id === parentId);
  currentTrip = createNewTrip(parentId);
  currentTrip.color = parent?.color || TRIP_COLORS[0];
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

async function loadTripById(id) {
  if (!window.firebaseDb) {
    throw new Error('Firebase が初期化されていません。ページを再読み込みしてください。');
  }

  // トリップ読み込み時はサムネイルを非表示にしてパフォーマンス向上
  thumbnailsVisible = false;

  // 前のトリップの写真ポップアップをクリア
  if (photoPopup && map) {
    map.removeLayer(photoPopup);
    photoPopup = null;
  }

  // キャッシュから即座に表示
  const cached = myTrips.find(t => t.id === id);
  if (cached) {
    try {
      currentTrip = { ...cached, id: cached.id };
      currentPhotoIndex = 0;
      await updateTripInputs();
      renderTripList();
      refreshTripSelect();
      renderThumbnails();
      await updateMapMarkers();
      await renderTripDetailPane();

      // トリップの全ポイントが収まるように地図を調整
      const photos = getDisplayPhotos();
      if (photos.length > 0 && map) {
        const bounds = [];
        photos.forEach(p => {
          if (p.lat != null && p.lng != null) {
            bounds.push([p.lat, p.lng]);
          }
        });
        if (bounds.length > 0) {
          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
        }
      }

      // トリップ選択時は写真ポップアップを表示しない（地図のマーカーのみ）

      // アニメ画像一覧を表示
      console.log('トリップロード（キャッシュ）:', {
        tripId: id,
        generatedAnimesCount: currentTrip.generatedAnimes?.length || 0,
        travelogueUrl: currentTrip.travelogueUrl || 'なし'
      });
      renderGeneratedAnimesList();

      // ヘッダー情報を更新（トリップ名など）
      await updateHeaderInfo();

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
      renderTripList();
      refreshTripSelect();
      renderThumbnails();
      await updateMapMarkers();
      if (map) map.invalidateSize();
      await renderTripDetailPane();

      // トリップの全ポイントが収まるように地図を調整
      const photos = getDisplayPhotos();
      if (photos.length > 0 && map) {
        const bounds = [];
        photos.forEach(p => {
          if (p.lat != null && p.lng != null) {
            bounds.push([p.lat, p.lng]);
          }
        });
        if (bounds.length > 0) {
          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
        }
      }

      // トリップ選択時は写真ポップアップを表示しない（地図のマーカーのみ）

      // アニメ画像一覧を表示
      console.log('トリップロード（Firestore）:', {
        tripId: id,
        generatedAnimesCount: currentTrip.generatedAnimes?.length || 0,
        travelogueUrl: currentTrip.travelogueUrl || 'なし'
      });
      renderGeneratedAnimesList();

      // ヘッダー情報を更新（トリップ名など）
      await updateHeaderInfo();

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
  if (!isEditor() || !currentTrip || !window.firebaseDb || !window.firebaseAuth?.currentUser) return;
  if (currentTrip.userId !== window.firebaseAuth.currentUser.uid) return;
  if (!confirm(`本当に「${currentTrip.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
  const idToDelete = currentTrip.id;
  try {
    await window.firebaseDb.collection('trips').doc(idToDelete).delete();
    currentTrip = null;
    currentPhotoIndex = 0;
    thumbnailsVisible = false;
    renderThumbnails();
    await updateMapMarkers();
    await updateTripInputs();
    await renderTripDetailPane();
    await loadMyTrips();
    const newOrder = tripOrder.filter(x => x !== idToDelete);
    await saveTripOrder(newOrder);
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
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function getVideoEmbedUrl(url) {
  if (!url) return null;
  const u = url.trim();
  const ytMatch = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;
  const vimeoMatch = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  return null;
}

function showVideoOverlay(url) {
  const overlay = document.getElementById('videoOverlay');
  const wrap = document.getElementById('videoPlayerWrap');
  if (!overlay || !wrap) return;
  const embedUrl = getVideoEmbedUrl(url);
  wrap.innerHTML = '';
  if (embedUrl) {
    const iframe = document.createElement('iframe');
    iframe.src = embedUrl;
    iframe.title = '動画';
    wrap.appendChild(iframe);
  } else {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    wrap.appendChild(video);
  }
  overlay.classList.remove('hidden');
  document.querySelector('.map-container')?.classList.add('map-showing-video');
}

let animePlayTimer = null;
let animeFrameIndex = 0;
let animeFrames = [];
let animeStyleConfig = null;
let cachedAiConfig = null;

async function loadUserAiConfig() {
  if (!window.firebaseDb || !window.firebaseAuth?.currentUser) return null;
  try {
    const doc = await window.firebaseDb.collection('users').doc(window.firebaseAuth.currentUser.uid).get();
    const d = doc.exists ? doc.data() : {};
    const cfg = {
      provider: d.aiProvider || 'gemini',
      apiKey: (d.aiApiKey || '').trim() || null
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
      aiApiKey: (cfg.apiKey || '').trim()
    }, { merge: true });
    cachedAiConfig = cfg;
    return { ok: true };
  } catch (err) {
    console.warn('AI設定保存エラー:', err);
    return { ok: false, err: err.message || String(err) };
  }
}

function showAiSettingsModal() {
  if (!window.firebaseAuth?.currentUser) {
    alert('ログインしてください');
    return;
  }
  loadUserAiConfig().then((cfg) => {
    if (!cfg) cfg = { provider: 'gemini', apiKey: '' };
    const providerSelect = document.getElementById('aiProviderSelect');
    const aiInput = document.getElementById('aiApiKeyInput');
    if (providerSelect) providerSelect.value = cfg.provider || 'gemini';
    if (aiInput) aiInput.value = cfg.apiKey || '';
  });
  document.getElementById('aiSettingsModal').classList.add('open');
}

function closeAiSettingsModal() {
  document.getElementById('aiSettingsModal').classList.remove('open');
}

async function generateTravelogueWithAI() {
  const trip = currentTrip;
  if (!trip) {
    alert('トリップを選択してください');
    return;
  }
  const cfg = cachedAiConfig ?? (await loadUserAiConfig());
  if (!cfg?.apiKey?.trim()) {
    alert('旅行記生成にはAPIキーが必要です。AI設定でプロバイダーを選択し、APIキーを入力してください。');
    return;
  }

  // 既存の旅行記がある場合は削除
  if (trip.travelogueUrl || trip.travelogueHtml) {
    try {
      // StorageのURLがある場合は削除
      if (trip.travelogueUrl) {
        try {
          const ref = window.firebaseStorage?.refFromURL(trip.travelogueUrl);
          if (ref) await ref.delete();
          console.log('既存の旅行記をStorageから削除しました');
        } catch (err) {
          console.warn('既存旅行記Storage削除エラー（無視）:', err);
        }
      }
      // データをクリア
      trip.travelogueHtml = '';
      trip.travelogueUrl = null;
      trip.travelogueGeneratedAt = null;
      console.log('既存の旅行記データをクリアしました');
    } catch (err) {
      console.error('既存旅行記削除エラー:', err);
    }
  }

  const btn = document.getElementById('generateTravelogueBtn');
  const originalBtnText = btn?.textContent || '旅行記生成';

  // 表紙生成チェックボックスの状態を確認
  const generateCover = document.getElementById('generateCoverImageCheckbox')?.checked || false;

  const photos = getDisplayPhotos();
  const parts = [];
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
  const usedWikiExtracts = new Set(); // 既に使用したWikipedia情報を記録

  if (photos.length > 0) {
    setStatus('Wikipediaから情報を取得中...');
    if (btn) btn.textContent = 'Wikipedia取得中...';
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const loc = p.placeName || (p.lat != null && p.lng != null ? `緯度${p.lat.toFixed(4)} 経度${p.lng.toFixed(4)}` : '');
      const desc = p.description || p.name || '';
      let wikiData = null;
      try {
        const result = await fetchWikipediaForPlace(p.lat, p.lng, p.placeName || loc);
        // 重複チェック：同じextractが既に使用されている場合はnullにする
        if (result && result.extract) {
          if (!usedWikiExtracts.has(result.extract)) {
            wikiData = result;
            usedWikiExtracts.add(result.extract);
          }
        }
        if (i < photos.length - 1) await new Promise(r => setTimeout(r, 300));
      } catch (_) {}
      photoInfos.push({
        index: i + 1,
        url: p.url,
        placeName: loc,
        description: desc,
        landmarkNo: p.landmarkNo || '',
        pointName: p.name || p.description || '',
        wikiData // { title, extract } または null
      });
    }
    const landmarkPhotos = photoInfos.filter(pi => pi.landmarkNo);
    if (landmarkPhotos.length > 0) {
      parts.push('スタンプラリー（ランドマークポイント、順番）:');
      landmarkPhotos.forEach((pi) => {
        parts.push(`  📍 ${pi.landmarkNo}${pi.pointName ? ': ' + pi.pointName : ''}（写真${pi.index}）`);
      });
      parts.push('');
      parts.push('⚠️ これらのランドマークスポットを、旅行記の最後に御朱印帳風の一覧として必ず表示してください。');
      parts.push('');
    }
    parts.push('写真情報（順番に、各写真ごとに左右レイアウトで旅行記を生成してください）:');
    photoInfos.forEach((pi) => {
      parts.push(`\n  【写真${pi.index}】`);
      parts.push(`  写真URL: ${pi.url}`);
      parts.push(`  ポイント名: ${pi.pointName || pi.placeName || '名称未設定'}`);
      parts.push(`  ポイント説明: ${pi.description || '説明なし'}`);
      parts.push(`  場所: ${pi.placeName || '（不明）'}`);
      if (pi.landmarkNo) parts.push(`  ランドマーク: 📍 ${pi.landmarkNo}`);
      if (pi.wikiData && pi.wikiData.extract) {
        parts.push(`  Wikipedia情報（${pi.wikiData.title}について）: ${pi.wikiData.extract}`);
      }
      parts.push(`  → この写真について旅行記を書いてください（その場所の様子、体験、感想など）`);
    });
  }
  const context = parts.join('\n');
  const tripColor = trip.color || '#e1306c';

  // アニメ表紙画像があれば取得
  const coverImage = trip.animes && trip.animes.length > 0 ? trip.animes[0].url : null;
  const coverImageHtml = coverImage ? `<div style="text-align:center;margin:2rem 0;"><img src="${coverImage}" alt="旅行記の表紙" style="max-width:100%;height:auto;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.2);"/></div>` : '';

  const systemPrompt = `あなたは「地球の歩き方」のライターです。与えられた情報をもとに、構造化された日本語の旅行記を書いてください。

出力形式（HTML）:

1. 最初に旅の表題を魅力的に表記:
<h2 class="travelogue-title">トリップ名とトリップ説明を元に、旅の魅力を表す表題を生成（例：「瀬戸内の風を感じる しまなみ海道サイクリング紀行」「古都を巡る 京都・奈良の寺社仏閣めぐり」など）</h2>

${coverImage ? `2. 次にAI生成の表紙画像を表示:\n${coverImageHtml}\n\n3` : '2'}. 次にサマリーを250字程度で記述:
<div class="travelogue-summary">
  <p>旅行のサマリー250字程度（地球の歩き方風の文章で、この旅の見どころ、特徴、魅力を具体的に）</p>
</div>

${coverImage ? '4' : '3'}. ランドマーク毎にセクション分けして記述:

<div class="travelogue-landmark-section">
  <h3 style="border-left:4px solid ${tripColor};padding-left:12px;color:${tripColor};">📍 ランドマーク番号: ポイント名</h3>

  そのランドマークに関連する写真を表示:
  <div style="margin:1.5rem 0;">
    <div style="display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap;">
      <div style="position:relative;width:500px;max-width:100%;">
        <img src="写真URL" alt="ポイント名" style="width:100%;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:block;">
        <div style="position:absolute;top:12px;left:12px;background:rgba(0,0,0,0.75);color:#fff;padding:8px 12px;border-radius:6px;font-weight:700;font-size:1rem;box-shadow:0 2px 6px rgba(0,0,0,0.4);">ポイント名</div>
        <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(to top,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.6) 60%,transparent 100%);color:#fff;padding:40px 12px 12px 12px;border-radius:0 0 8px 8px;font-size:0.9rem;line-height:1.4;">[ポイント説明をここに記載]</div>
      </div>
      <div style="flex:1;min-width:250px;">
        <p>100字程度の旅の情景（その場所での体験、見た景色、感じた雰囲気などを具体的に描写してください）</p>
      </div>
    </div>
  </div>

  追加の写真がある場合も同様に配置

  Wikipedia情報がある場合（ランドマークの最後に1回だけ）:
  <p style="background:#f8f9fa;padding:1rem;border-radius:6px;border-left:3px solid ${tripColor};margin:1.5rem 0;">
    <strong>📚 （Wikipediaのtitleフィールドの値）について：</strong>Wikipedia情報の内容
  </p>
  ※「（Wikipediaのtitleフィールドの値）について」の部分には、実際に取得したWikipedia記事のタイトルを使用してください（例：「観音寺について」「しまなみ海道について」など）
</div>

${coverImage ? '5' : '4'}. ランドマークでない写真も同様に表示（h3なし、セクション分けなし）

${coverImage ? '6' : '5'}. ランドマークがある場合、必ず最後に御朱印帳風のスタンプ一覧を表示してください:

<div style="border-top:3px solid #d4c5a9;margin-top:4rem;padding-top:2rem;">
  <h3 style="text-align:center;color:#c1272d;font-size:1.8rem;margin-bottom:0.5rem;font-weight:700;letter-spacing:0.1em;">🎫 御朱印帳</h3>
  <p style="text-align:center;color:#8b7355;font-size:0.9rem;margin-bottom:2rem;">訪れたスタンプスポット</p>

  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1.5rem;padding:2.5rem;background:linear-gradient(135deg,#f9f5e8 0%,#f5f0e0 50%,#f0ead8 100%);border-radius:12px;box-shadow:inset 0 2px 8px rgba(193,39,45,0.08);">
    <!-- ランドマーク写真があるポイントごとに以下のカードを生成 -->
    <div style="background:#fffef8;border:3px double #c1272d;border-radius:10px;padding:1.2rem;text-align:center;box-shadow:0 6px 12px rgba(193,39,45,0.18),inset 0 1px 0 rgba(255,255,255,0.5);position:relative;">
      <div style="position:absolute;top:-10px;right:-10px;width:32px;height:32px;background:#c1272d;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.2rem;box-shadow:0 2px 6px rgba(193,39,45,0.3);">✓</div>
      <div style="font-size:2rem;font-weight:700;color:#c1272d;margin-bottom:0.6rem;text-shadow:1px 1px 2px rgba(193,39,45,0.2);">📍 ランドマーク番号</div>
      <div style="font-size:0.95rem;font-weight:600;color:#2d1810;line-height:1.3;min-height:2.6em;display:flex;align-items:center;justify-content:center;">ポイント名</div>
      <div style="margin-top:0.8rem;padding:0.4rem 0.6rem;background:#c1272d;color:#fff;font-size:0.75rem;font-weight:700;border-radius:6px;box-shadow:0 2px 4px rgba(193,39,45,0.3);letter-spacing:0.05em;">スタンプ済み</div>
    </div>
  </div>

  <p style="text-align:center;color:#8b7355;font-size:0.85rem;margin-top:1.5rem;font-style:italic;">訪れた全てのスポットを記録しました ✨</p>
</div>

重要: ランドマーク番号（📍1、📍2など）が設定されている写真が1つでもある場合は、必ずこの御朱印帳セクションを旅行記の最後に含めてください。各ランドマークごとに上記のカードスタイルで表示してください。

重要事項:
- トリップカラーは${tripColor}です
- ランドマーク見出しにトリップカラーを使用してください
- 旅の表題はトリップ名とトリップ説明を元に魅力的な表題を生成してください
- サマリーは250字程度で、旅の見どころ、特徴、魅力を具体的に
- 写真は500px幅で表示してください
- 写真の左上にポイント名をオーバーレイで配置
- 写真の下部に[ポイント説明]をオーバーレイで配置（ブラケット付きで表示）
- 写真の右側には100字程度の旅の情景を記述（その場所での体験、見た景色、感じた雰囲気など）
- 写真毎のセクション分けは不要です（ランドマーク毎のみ）
- Wikipedia情報は同じ内容を重複して書かないでください（ランドマークごとに1回のみ）
- Wikipedia情報のタイトルは、実際に参照した地域名や観光名所の名前を使用してください（例：「観音寺について」「しまなみ海道について」など）
- Wikipedia情報は、その場所の歴史、特徴、見どころなど、旅行者に役立つ情報を含めてください
- GPSルート地図は自動表示されるのでHTMLに含めない
- ⚠️重要：ランドマーク写真が1つでもある場合は、必ず旅行記の最後に御朱印帳セクションを含めてください。御朱印帳は和の趣を感じる特別なセクションです。`;
  const userPrompt = `以下のトリップ情報をもとに、上記の構造に従って旅行記を生成してください。\n\n${context}`;
  try {
    setStatus('旅行記を生成中...');
    if (btn) btn.textContent = '旅行記生成中...';
    let content = '';
    const provider = cfg.provider || 'gemini';
    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
          generationConfig: { temperature: 0.7 }
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      content = data.choices?.[0]?.message?.content || '';
    } else if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      content = data.content?.[0]?.text || '';
    } else {
      throw new Error('未対応のプロバイダーです');
    }
    if (!content.trim()) throw new Error('応答が空です');

    let finalHtml = content.trim();

    // 表紙生成が有効な場合、Nano Banana Pro2で表紙画像を生成
    if (generateCover) {
      setStatus('表紙画像を生成中...');
      if (btn) btn.textContent = '表紙生成中...';
      try {
        // 訪問地から代表的な地域名を抽出してタイトルを生成
        const uniquePlaces = [...new Set(photos.filter(p => p.placeName).map(p => p.placeName))];
        let coverTitle = trip.name || '旅行';

        // トリップ名から地域を抽出（例：「しまなみ海道サイクリング」→「しまなみ」）
        // 地名、観光地などのキーワードを優先的に抽出
        const regionPatterns = [
          /([ぁ-ん一-龥]{2,})(海道|街道|地方|エリア|地区)/,
          /([ぁ-ん一-龥]{2,})(旅行|観光|めぐり|巡り)/,
          /^([ぁ-ん一-龥]{2,})/
        ];

        for (const pattern of regionPatterns) {
          const match = (trip.name || '').match(pattern);
          if (match) {
            coverTitle = `${match[1]}の歩き方`;
            break;
          }
        }

        // パターンにマッチしない場合は最初の訪問地を使用
        if (coverTitle === (trip.name || '旅行') && uniquePlaces.length > 0) {
          // 市町村名や観光地名を抽出（「〇〇市」「〇〇町」などを除去）
          const mainPlace = uniquePlaces[0].replace(/(市|町|村|区|県|府|道).*/, '');
          coverTitle = `${mainPlace}の歩き方`;
        }

        // 表紙用のプロンプトを作成（トリップの全情報を含める）
        const coverPromptParts = [
          '地球の歩き方の表紙風のアニメスタイルで、旅行の表紙画像を生成してください。',
          '鮮やかな色彩、冒険心をくすぐるレイアウト、魅力的な背景で表現してください。',
          `画像内に「${coverTitle}」というタイトルを大きく、読みやすく配置してください。`,
          '',
          `【表紙タイトル】${coverTitle}`,
          `【旅行名】${trip.name || '旅行'}`,
        ];

        // キャラクター画像がある場合はプロンプトに追加
        if (characterImageData) {
          coverPromptParts.push('【メインキャラクター】アップロードされた人物の特徴（顔立ち、髪型、表情など）を保ちながら、優しく親しみやすいタッチのアニメキャラクターに変換してください。柔らかな線、温かみのある色彩、穏やかな表情で描いてください。このキャラクターを旅の主人公として、地球の歩き方の表紙風アニメスタイルに完全に合わせ、背景や他の要素と統一された画風で描いてください。写真のような実写感は残さず、全体が一つのアニメ作品として調和するように仕上げてください。');
        }

        // トリップ説明
        if (trip.description) {
          coverPromptParts.push(`【旅行の説明】${trip.description}`);
        }

        // GPS情報
        if (gpxSummary) {
          coverPromptParts.push(`【GPS情報】${gpxSummary}`);
        }

        // ブログURL情報
        if (trip.url) {
          coverPromptParts.push('【ブログ】旅の詳細記録あり');
        }

        // 訪問した場所（重複なし、最大8箇所）
        if (uniquePlaces.length > 0) {
          const placesList = uniquePlaces.slice(0, 8).join('、');
          coverPromptParts.push(`【訪問地】${placesList}`);
        }

        // ランドマーク情報
        const landmarks = photoInfos.filter(pi => pi.landmarkNo);
        if (landmarks.length > 0) {
          const landmarkNames = landmarks.map(pi => `${pi.landmarkNo}: ${pi.pointName || '名所'}`).slice(0, 5).join('、');
          coverPromptParts.push(`【スタンプラリー】${landmarkNames}`);
        }

        // 写真の説明から重要なキーワードを抽出（最大3つ）
        const descriptions = photoInfos
          .filter(pi => pi.description && pi.description.length > 5)
          .map(pi => pi.description)
          .slice(0, 3);
        if (descriptions.length > 0) {
          coverPromptParts.push(`【旅のハイライト】${descriptions.join('、')}`);
        }

        // Wikipedia情報から旅の特徴を抽出（最大2つ）
        const wikiExtracts = photoInfos
          .filter(pi => pi.wikiData && pi.wikiData.extract && pi.wikiData.extract.length > 10)
          .map(pi => pi.wikiData.extract.slice(0, 100))
          .slice(0, 2);
        if (wikiExtracts.length > 0) {
          coverPromptParts.push(`【特色】${wikiExtracts.join('。')}`);
        }

        coverPromptParts.push('');
        coverPromptParts.push(`この旅行の魅力が一目で伝わる、「${coverTitle}」というタイトルの地球の歩き方スタイルの素敵な表紙を作成してください。`);
        if (characterImageData) {
          coverPromptParts.push('人物は完全にアニメキャラクターとして描き直し、表紙全体が統一された地球の歩き方風アニメ作品の一部として自然に調和するように仕上げてください。実写的な要素は一切残さないでください。');
        }

        const coverPrompt = coverPromptParts.join('\n');
        const coverImageUrl = await generateImageWithNanoBananaPro2(coverPrompt, cfg, characterImageData);

        if (coverImageUrl) {
          // サマリー部分を抽出
          const summaryMatch = finalHtml.match(/<div class="travelogue-summary">([\s\S]*?)<\/div>/);
          let summaryHtml = '';
          let restHtml = finalHtml;

          if (summaryMatch) {
            summaryHtml = summaryMatch[1];
            restHtml = finalHtml.replace(summaryMatch[0], '');
          }

          // 表紙画像とサマリーを横並びに配置
          const coverSectionHtml = `
<div style="display:flex;gap:2rem;margin-bottom:2rem;align-items:flex-start;flex-wrap:wrap;">
  <div style="flex:0 0 auto;max-width:400px;">
    <img src="${coverImageUrl}" alt="旅行記の表紙" style="width:100%;height:auto;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.2);">
  </div>
  <div style="flex:1;min-width:300px;">
    <h3 style="margin-top:0;color:#c75b12;font-size:1.3rem;">📖 旅のあらすじ</h3>
    ${summaryHtml || '<p>この旅行の素晴らしい思い出をご覧ください。</p>'}
  </div>
</div>

<div id="travelogue-map-container" style="margin:2rem 0;"></div>
`;
          finalHtml = coverSectionHtml + restHtml;

          setStatus('旅行記と表紙を生成しました');
        } else {
          setStatus('表紙生成に失敗しましたが、旅行記は生成しました');
        }
      } catch (err) {
        console.error('表紙生成エラー:', err);
        setStatus('表紙生成に失敗しましたが、旅行記は生成しました');
      }
    } else {
      setStatus('旅行記を生成しました');
    }

    // 旅行記をStorageに保存（Firestoreの1MB制限を回避）
    try {
      console.log('旅行記をStorageに保存開始...');
      const travelogueUrl = await uploadTravelogueToStorage(trip.id, finalHtml);
      currentTrip.travelogueUrl = travelogueUrl;
      // HTMLはStorageに保存したのでFirestoreには保存しない（1MB制限回避）
      currentTrip.travelogueHtml = null;
      currentTrip.travelogueGeneratedAt = Date.now();
      console.log('旅行記をStorageに保存しました:', {
        url: travelogueUrl,
        htmlSize: finalHtml.length
      });
    } catch (err) {
      console.error('旅行記のStorage保存エラー:', err);
      // Storageに保存できない場合のみHTMLを直接保存
      // ただし小さいHTMLに限定（500KB以下）
      if (finalHtml.length < 500000) {
        currentTrip.travelogueHtml = finalHtml;
        currentTrip.travelogueUrl = null;
        currentTrip.travelogueGeneratedAt = Date.now();
        console.log('StorageではなくFirestoreに直接保存します（小サイズ）');
      } else {
        throw new Error('旅行記のサイズが大きすぎてStorageにも保存できませんでした: ' + err.message);
      }
    }

    console.log('トリップを保存します...');
    await saveTrip();
    console.log('トリップ保存完了');
    updateCoverPreview();
    updateTravelogueActionButtons();
    showTravelogueModal();
  } catch (err) {
    console.error('旅行記生成エラー:', err);
    alert('旅行記の生成に失敗しました: ' + (err.message || String(err)));
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
  const pts = [];
  try {
    const gpxText = await getGpxContent(trip);
    if (gpxText) pts.push(...parseGpxPoints(gpxText));
  } catch (_) {}
  if (pts.length <= 1 && (trip.photos || []).length > 0) {
    const photoPts = (trip.photos || [])
      .map(p => ensureLatLng(p.lat, p.lng))
      .filter(Boolean)
      .map(c => [c.lat, c.lng]);
    if (photoPts.length > 0) pts.push(...photoPts);
  }
  if (pts.length === 0) return;
  wrap.style.display = '';
  travelogueMap = L.map('travelogueMap').setView([pts[0][0], pts[0][1]], 10);

  // メインマップと同じレイヤーを使用
  if (currentMapLayer === 'satellite') {
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '© Esri, Maxar, Earthstar Geographics',
      maxZoom: 18
    }).addTo(travelogueMap);
  } else if (currentMapLayer === 'terrain') {
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap, © OpenTopoMap',
      maxZoom: 17
    }).addTo(travelogueMap);
  } else {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }).addTo(travelogueMap);
  }

  const color = trip.color || TRIP_COLORS[0];

  // GPSルートを表示
  if (pts.length > 1) {
    L.polyline(pts, { color, weight: 3, opacity: 0.7 }).addTo(travelogueMap);
  }

  // 写真ポイントをマーカーで表示
  const photos = trip.photos || [];
  const photoPoints = [];
  photos.forEach((p, i) => {
    const coord = ensureLatLng(p.lat, p.lng);
    if (coord) {
      photoPoints.push([coord.lat, coord.lng]);

      const isLandmark = !!(p.landmarkNo);
      let markerHtml;

      if (isLandmark && p.url) {
        // ランドマークは小さい写真で表示
        const no = String(p.landmarkNo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        markerHtml = `
          <div style="position:relative;width:40px;height:40px;">
            <img src="${p.url}" style="width:40px;height:40px;border-radius:4px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);object-fit:cover;display:block;" />
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

      const marker = L.marker([coord.lat, coord.lng], {
        icon: L.divIcon({
          className: 'travelogue-map-marker',
          html: markerHtml,
          iconSize: isLandmark && p.url ? [40, 40] : (isLandmark ? [28, 28] : [10, 10]),
          iconAnchor: isLandmark && p.url ? [20, 40] : (isLandmark ? [14, 14] : [5, 5])
        })
      });

      // ツールチップ表示
      const tooltipParts = [];
      if (p.landmarkNo) tooltipParts.push('📍 ' + p.landmarkNo);
      if (p.name) tooltipParts.push(p.name);
      if (p.description) tooltipParts.push(p.description);
      const tooltipLabel = tooltipParts.length ? tooltipParts.join(' — ') : `#${i + 1}`;
      marker.bindTooltip(tooltipLabel, { direction: 'top', offset: [0, -10] });

      marker.addTo(travelogueMap);
    }
  });

  // 全てのポイント（GPSルート + 写真ポイント）が収まるように表示
  const allPoints = [...pts, ...photoPoints];
  if (allPoints.length > 0) {
    const bounds = L.latLngBounds(allPoints);
    travelogueMap.fitBounds(bounds, { padding: [40, 40] });
  }
}

async function showTravelogueModal() {
  const modal = document.getElementById('travelogueModal');
  const content = document.getElementById('travelogueContent');
  const mapWrap = document.getElementById('travelogueMap');
  const modalTitle = document.querySelector('#travelogueModal .modal-blog-title');
  if (!modal || !content) return;

  let html = currentTrip?.travelogueHtml;

  // travelogueUrlがある場合はStorageから取得
  if (!html && currentTrip?.travelogueUrl) {
    try {
      const response = await fetch(currentTrip.travelogueUrl);
      html = await response.text();
    } catch (err) {
      console.error('旅行記の取得エラー:', err);
      content.innerHTML = '<p class="travelogue-empty">旅行記の読み込みに失敗しました。</p>';
      if (mapWrap) mapWrap.style.display = 'none';
      if (modalTitle) modalTitle.textContent = '旅行記';
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
      modalTitle.textContent = currentTrip?.name || '旅行記';
    }

    // HTMLを挿入し、地図プレースホルダーを追加
    // 古い旅行記との互換性のため、古い表記を変換
    let processedHtml = html.replace(/詳しい情報/g, '知っ得情報');

    // サマリーセクションの後に地図プレースホルダーを挿入
    const summaryEnd = processedHtml.indexOf('</div>', processedHtml.indexOf('class="travelogue-summary"'));
    if (summaryEnd !== -1) {
      const insertPos = summaryEnd + '</div>'.length;
      const mapPlaceholder = '\n<div id="travelogueMapPlaceholder"></div>\n';
      processedHtml = processedHtml.slice(0, insertPos) + mapPlaceholder + processedHtml.slice(insertPos);
    }

    content.innerHTML = processedHtml;

    if (currentTrip && (currentTrip.photos?.length || currentTrip.gpxData || currentTrip.gpxDataUrl)) {
      // 新しいtravelogue-map-containerがある場合はそれを使用
      const mapContainer = document.getElementById('travelogue-map-container');
      if (mapContainer) {
        // 新しい形式：mapContainerの中に地図を表示
        if (mapWrap) {
          mapWrap.style.display = 'block';
          mapContainer.appendChild(mapWrap);
        }
        setTimeout(() => initTravelogueMap(currentTrip), 100);
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
        setTimeout(() => initTravelogueMap(currentTrip), 100);
      }
    } else if (mapWrap) {
      mapWrap.style.display = 'none';
    }
  } else {
    content.innerHTML = '<p class="travelogue-empty">旅行記がありません。AI旅行記生成で作成してください。</p>';
    if (mapWrap) mapWrap.style.display = 'none';
  }
  modal.classList.add('open');
}

function closeTravelogueModal() {
  if (travelogueMap) {
    travelogueMap.remove();
    travelogueMap = null;
  }
  document.getElementById('travelogueModal')?.classList.remove('open');
}

function showStampRallyModal(trip) {
  const modal = document.getElementById('stampRallyModal');
  const content = document.getElementById('stampRallyContent');
  if (!modal || !content) return;
  const photos = (trip?.photos || []).filter(p => p.landmarkNo);
  photos.sort((a, b) => {
    const na = String(a.landmarkNo || '');
    const nb = String(b.landmarkNo || '');
    return na.localeCompare(nb, undefined, { numeric: true });
  });
  if (photos.length === 0) {
    content.innerHTML = '<p class="stamp-rally-empty">ランドマークがありません。写真のポップアップで「ランドマーク」にチェックし、番号を入力してください。</p>';
  } else {
    content.innerHTML = photos.map((p, i) => {
      const stamped = !!(p.url && p.url.trim());
      const no = escapeHtml(p.landmarkNo || '');
      const pointName = escapeHtml(p.name || p.description || '');
      const imgHtml = stamped
        ? `<img src="${escapeHtml(p.url)}" alt="${no}" class="stamp-card-img" loading="lazy">`
        : '<div class="stamp-card-empty">?</div>';
      const infoText = pointName ? `<span class="stamp-card-no">${no}</span> <span class="stamp-card-name">${pointName}</span>` : `<span class="stamp-card-no">${no}</span>`;
      return `<div class="stamp-card ${stamped ? 'stamp-card-stamped' : ''}" data-index="${i}" data-photo-index="${(trip.photos || []).indexOf(p)}">
        <div class="stamp-card-inner">
          ${imgHtml}
          <div class="stamp-card-info-overlay">${infoText}</div>
        </div>
        <span class="stamp-card-badge">${stamped ? '✓ スタンプ済み' : '未スタンプ'}</span>
      </div>`;
    }).join('');
    content.querySelectorAll('.stamp-card').forEach((card) => {
      const photoIdx = parseInt(card.dataset.photoIndex, 10);
      card.onclick = async () => {
        if (currentTrip?.id !== trip?.id) await loadTripById(trip.id);
        showPhotoAtIndex(photoIdx);
        closeStampRallyModal();
      };
    });
  }
  modal.classList.add('open');
}

function closeStampRallyModal() {
  document.getElementById('stampRallyModal')?.classList.remove('open');
}

const ANIME_COVER_PREFIX = 'Create a cover image that reflects and illustrates the following travelogue content. Use the travelogue as the main reference for the image. ';

const ANIME_STYLES = {
  'chikyu-cover': {
    label: '地球の歩き方表紙風',
    brand: '地球の歩き方',
    prompt: ANIME_COVER_PREFIX + 'Chikyu no Arukikata (Earth\'s Walk) travel guide book cover style. Red and white design, Japanese travel publication aesthetic, professional cover layout with bold typography. Travelogue content: ',
    brandClass: 'anime-brand-chikyu'
  },
  'chikyu-spot': {
    label: '地球の歩き方おすすめスポット風',
    brand: '地球の歩き方 おすすめスポット',
    prompt: ANIME_COVER_PREFIX + 'Chikyu no Arukikata recommended spots style. Travel guide recommended destination aesthetic, inviting and informative layout. Travelogue content: ',
    brandClass: 'anime-brand-chikyu'
  },
  'jump': {
    label: '少年ジャンプの表紙風',
    brand: '週刊少年ジャンプ',
    prompt: ANIME_COVER_PREFIX + 'Weekly Shonen Jump manga magazine cover style. Bold Japanese manga magazine aesthetic, dynamic composition, vibrant colors, manga-style impact. Travelogue content: ',
    brandClass: 'anime-brand-jump'
  },
  'travel-magazine': {
    label: '旅行雑誌の表紙風',
    brand: '旅行雑誌',
    prompt: ANIME_COVER_PREFIX + 'Professional travel magazine cover style. Elegant travel publication aesthetic, high-end magazine layout, aspirational travel imagery. Travelogue content: ',
    brandClass: 'anime-brand-magazine'
  },
  'page1': {
    label: '個別ページ1/4',
    brand: '',
    prompt: ANIME_COVER_PREFIX + 'Travel guide book inner page style, layout 1 of 4. Clean editorial design, informative and readable layout. Travelogue content: ',
    brandClass: 'anime-brand-magazine'
  },
  'page2': {
    label: '個別ページ2/4',
    brand: '',
    prompt: ANIME_COVER_PREFIX + 'Travel guide book inner page style, layout 2 of 4. Clean editorial design, informative and readable layout. Travelogue content: ',
    brandClass: 'anime-brand-magazine'
  },
  'page3': {
    label: '個別ページ3/4',
    brand: '',
    prompt: ANIME_COVER_PREFIX + 'Travel guide book inner page style, layout 3 of 4. Clean editorial design, informative and readable layout. Travelogue content: ',
    brandClass: 'anime-brand-magazine'
  },
  'page4': {
    label: '個別ページ4/4',
    brand: '',
    prompt: ANIME_COVER_PREFIX + 'Travel guide book inner page style, layout 4 of 4. Clean editorial design, informative and readable layout. Travelogue content: ',
    brandClass: 'anime-brand-magazine'
  }
};

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

function showAnimeLoading(visible, text = '生成中...') {
  const el = document.getElementById('animeLoading');
  const textEl = document.getElementById('animeLoadingText');
  if (el) el.classList.toggle('visible', visible);
  if (textEl) textEl.textContent = text;
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

    // Gemini image-preview モデルを使用して画像を生成
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: parts
        }],
        generationConfig: {
          temperature: 1.0,
          topK: 40,
          topP: 0.95
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

async function generateImageWithAI(prompt, imageUrl, cfg) {
  if (!cfg?.apiKey?.trim()) return null;
  const provider = cfg.provider || 'gemini';
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024',
          quality: 'hd'
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.data?.[0]?.url || null;
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
          images: imageUrl ? [imageUrl] : undefined
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
      const parts = [{ text: prompt }];
      if (imageUrl) {
        try {
          const imgRes = await fetch(imageUrl);
          const blob = await imgRes.blob();
          const base64 = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(',')[1]);
            r.onerror = reject;
            r.readAsDataURL(blob);
          });
          parts.unshift({
            inline_data: { mime_type: blob.type || 'image/jpeg', data: base64 }
          });
        } catch (_) {}
      }
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            responseMimeType: 'image/png'
          }
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (part?.inlineData?.data) {
        return 'data:' + (part.inlineData.mimeType || 'image/png') + ';base64,' + part.inlineData.data;
      }
      return null;
    }
    return null;
  } catch (e) {
    console.error('Image generation:', e);
    return null;
  }
}

async function showAnimeModal() {
  const trip = currentTrip;
  if (!trip) {
    alert('トリップを選択してください');
    return;
  }

  const cfg = cachedAiConfig ?? (await loadUserAiConfig());
  const apiKey = cfg?.apiKey?.trim();
  if (!apiKey) {
    alert('AIアニメ生成にはNano Banana Pro2のAPIキーが必要です。AI設定でAPIキーを入力してください。');
    return;
  }

  const btn = document.getElementById('generateAnimeBtnViewer');
  const originalBtnText = btn?.textContent || 'アニメ生成';

  const styleId = getSelectedAnimeStyle();
  const style = ANIME_STYLES[styleId] || ANIME_STYLES['chikyu-cover'];

  try {
    if (btn) btn.textContent = '画像生成中...';
    setStatus('アニメ画像を生成中...');

    // トリップ名から代表的な地域名を抽出してタイトルを生成
    const tripName = trip.name || '旅行';
    let coverTitle = tripName;

    // トリップ名から地域を抽出（例：「しまなみ海道サイクリング」→「しまなみ」）
    const regionPatterns = [
      /([ぁ-ん一-龥]{2,})(海道|街道|地方|エリア|地区)/,
      /([ぁ-ん一-龥]{2,})(旅行|観光|めぐり|巡り)/,
      /^([ぁ-ん一-龥]{2,})/
    ];

    for (const pattern of regionPatterns) {
      const match = tripName.match(pattern);
      if (match) {
        coverTitle = `${match[1]}の歩き方`;
        break;
      }
    }

    // パターンにマッチしない場合は最初の訪問地を使用
    const photos = trip.photos || [];
    const places = [...new Set(photos.filter(p => p.placeName).map(p => p.placeName))];
    if (coverTitle === tripName && places.length > 0) {
      // 市町村名や観光地名を抽出（「〇〇市」「〇〇町」などを除去）
      const mainPlace = places[0].replace(/(市|町|村|区|県|府|道).*/, '');
      coverTitle = `${mainPlace}の歩き方`;
    }

    // トリップの全情報を収集
    const promptParts = [
      style.prompt,
      `画像内に「${coverTitle}」というタイトルを大きく、読みやすく配置してください。`,
      '',
      `【表紙タイトル】${coverTitle}`,
      `【旅行名】${tripName}`,
    ];

    // キャラクター画像がある場合はプロンプトに追加
    if (characterImageData) {
      promptParts.push('【メインキャラクター】アップロードされた人物の特徴（顔立ち、髪型、表情など）を保ちながら、優しく親しみやすいタッチのアニメキャラクターに変換してください。柔らかな線、温かみのある色彩、穏やかな表情で描いてください。このキャラクターを旅の主人公として、選択されたテーマスタイルに完全に合わせ、背景や他の要素と統一された画風で描いてください。写真のような実写感は残さず、全体が一つのアニメ作品として調和するように仕上げてください。');
    }

    if (trip.description) {
      promptParts.push(`【旅行の説明】${trip.description}`);
    }

    if (trip.url) {
      promptParts.push('【ブログ】旅の詳細記録あり');
    }

    // 写真情報を収集
    if (photos.length > 0) {
      if (places.length > 0) {
        promptParts.push(`【訪問地】${places.slice(0, 8).join('、')}`);
      }

      const landmarks = photos.filter(p => p.landmarkNo);
      if (landmarks.length > 0) {
        const landmarkNames = landmarks.map(p => `${p.landmarkNo}: ${p.name || '名所'}`).slice(0, 5).join('、');
        promptParts.push(`【スタンプラリー】${landmarkNames}`);
      }

      const descriptions = photos.filter(p => p.description).map(p => p.description).slice(0, 3);
      if (descriptions.length > 0) {
        promptParts.push(`【ハイライト】${descriptions.join('、')}`);
      }
    }

    // 旅行記がある場合はサマリーを追加
    if (trip.travelogueHtml && trip.travelogueHtml.trim()) {
      const sections = parseTravelogueSections(trip.travelogueHtml);
      const summary = sections.map(s => s.text).join(' ').slice(0, 300);
      if (summary) {
        promptParts.push(`【旅行記サマリー】${summary}`);
      }
    }

    promptParts.push('');
    promptParts.push(`この旅行の魅力が一目で伝わる、「${coverTitle}」というタイトルの魅力的な表紙画像を作成してください。`);
    if (characterImageData) {
      promptParts.push('人物は完全にアニメキャラクターとして描き直し、表紙全体が統一されたアニメ作品の一部として自然に調和するように仕上げてください。実写的な要素は一切残さないでください。');
    }

    const prompt = promptParts.join('\n');
    const generatedDataUrl = await generateImageWithNanoBananaPro2(prompt, cfg, characterImageData);

    if (generatedDataUrl) {
      try {
        // 画像をStorageにアップロード
        setStatus('画像をStorageに保存中...');
        const storageUrl = await uploadAnimeImageToStorage(trip.id, generatedDataUrl);

        // トリップデータに追加
        if (!currentTrip.generatedAnimes) {
          currentTrip.generatedAnimes = [];
        }
        currentTrip.generatedAnimes.push({
          url: storageUrl,
          timestamp: Date.now(),
          style: styleId
        });

        console.log('アニメ画像を追加:', {
          url: storageUrl,
          count: currentTrip.generatedAnimes.length
        });

        // トリップを保存
        await saveTrip({ silent: true });
        console.log('トリップ保存完了。generatedAnimesの数:', currentTrip.generatedAnimes.length);

        // UIに追加
        renderGeneratedAnimesList();
        setStatus('アニメ画像を生成しました');
      } catch (err) {
        console.error('アニメ画像の保存エラー:', err);
        alert('画像は生成されましたが、保存に失敗しました: ' + (err.message || String(err)));
      }
    } else {
      const errorMsg = '画像生成に失敗しました。以下を確認してください：\n\n' +
                      '1. AI設定で「画像生成用（Nano Banana Pro2）」のAPIキーが正しく設定されているか\n' +
                      '2. APIキーに十分なクレジットがあるか\n' +
                      '3. ブラウザのコンソール（F12）でエラー詳細を確認してください';
      alert(errorMsg);
      setStatus('画像生成に失敗しました');
    }
  } catch (err) {
    console.error('アニメ生成エラー:', err);
    const errorMsg = '画像生成に失敗しました: ' + (err.message || String(err)) + '\n\n' +
                    'ブラウザのコンソール（F12）で詳細なエラーログを確認してください。';
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

  // コンテナをクリア
  container.innerHTML = '';

  if (!currentTrip || !currentTrip.generatedAnimes || currentTrip.generatedAnimes.length === 0) {
    console.log('表示するアニメ画像がありません');
    return;
  }

  console.log(`${currentTrip.generatedAnimes.length}個のアニメ画像を表示します`);

  // 各画像を表示
  currentTrip.generatedAnimes.forEach((anime, index) => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;display:inline-block;';

    const img = document.createElement('img');
    img.src = anime.url;
    img.alt = `${currentTrip.name}のアニメ画像`;
    img.style.cssText = 'height:100px;width:auto;border-radius:4px;box-shadow:0 2px 4px rgba(0,0,0,0.2);cursor:pointer;';
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

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.title = '画像を削除';
    deleteBtn.style.cssText = 'position:absolute;top:2px;right:2px;background:#dc3545;color:white;border:none;border-radius:50%;width:20px;height:20px;font-size:14px;line-height:1;cursor:pointer;padding:0;';
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('この画像を削除しますか？')) return;

      try {
        // Storageから削除
        await deleteAnimeImageFromStorage(anime.url);

        // トリップデータから削除
        currentTrip.generatedAnimes.splice(index, 1);

        // トリップを保存
        await saveTrip({ silent: true });

        // UIを更新
        renderGeneratedAnimesList();
        setStatus('画像を削除しました');
      } catch (err) {
        console.error('画像削除エラー:', err);
        alert('画像の削除に失敗しました: ' + (err.message || String(err)));
      }
    };
    wrapper.appendChild(deleteBtn);

    container.appendChild(wrapper);
  });
}

function renderAnimeFrame() {
  const frame = animeFrames[animeFrameIndex];
  if (!frame) return;
  const photoEl = document.getElementById('animeCoverPhoto');
  const titleEl = document.getElementById('animeCoverTitle');
  const subtitleEl = document.getElementById('animeCoverSubtitle');
  const metaEl = document.getElementById('animeCoverMeta');
  const brandEl = document.getElementById('animeCoverBrand');
  if (photoEl) {
    photoEl.style.opacity = '0';
    photoEl.style.backgroundImage = frame.url ? `url(${frame.url})` : 'none';
    photoEl.classList.toggle('anime-cover-failed', !frame.url);
    photoEl.title = frame.url ? '' : '画像生成に失敗しました';
    requestAnimationFrame(() => { photoEl.style.opacity = '1'; });
  }
  if (titleEl) titleEl.textContent = frame.title;
  if (subtitleEl) subtitleEl.textContent = frame.subtitle;
  if (metaEl) metaEl.textContent = frame.meta;
  if (brandEl) {
    const brand = frame.brand || animeStyleConfig?.brand || '';
    brandEl.textContent = brand || '地球の歩き方';
    brandEl.style.display = brand ? '' : 'none';
    brandEl.className = 'anime-cover-brand ' + (frame.brandClass || 'anime-brand-chikyu');
  }
}

function advanceAnimeFrame() {
  if (animeFrames.length === 0) return;
  animeFrameIndex = (animeFrameIndex + 1) % animeFrames.length;
  renderAnimeFrame();
}

function toggleAnimePlay() {
  const btn = document.getElementById('animePlayBtn');
  if (animePlayTimer) {
    clearInterval(animePlayTimer);
    animePlayTimer = null;
    if (btn) btn.textContent = '再生';
  } else {
    animePlayTimer = setInterval(advanceAnimeFrame, 4000);
    if (btn) btn.textContent = '停止';
  }
}

function closeAnimeModal() {
  if (animePlayTimer) {
    clearInterval(animePlayTimer);
    animePlayTimer = null;
  }
  document.getElementById('animeModal').classList.remove('open');
  const btn = document.getElementById('animePlayBtn');
  if (btn) btn.textContent = '再生';
}

function closeVideoOverlay() {
  const overlay = document.getElementById('videoOverlay');
  const wrap = document.getElementById('videoPlayerWrap');
  if (overlay) overlay.classList.add('hidden');
  document.querySelector('.map-container')?.classList.remove('map-showing-video');
  if (wrap) {
    wrap.innerHTML = '';
  }
}

function showBlogPopup(tripName, url) {
  const modal = document.getElementById('blogModal');
  const titleEl = document.getElementById('blogModalTitle');
  const iframe = document.getElementById('blogModalIframe');
  const externalLink = document.getElementById('blogModalExternal');
  if (!modal || !titleEl || !iframe || !externalLink) return;
  titleEl.textContent = tripName || 'ブログ';
  iframe.src = url;
  externalLink.href = url;
  modal.classList.add('open');
}

function closeBlogPopup() {
  const modal = document.getElementById('blogModal');
  const iframe = document.getElementById('blogModalIframe');
  if (modal) modal.classList.remove('open');
  if (iframe) iframe.src = 'about:blank';
}

function setStatus(msg, isError = false) {
  console.log(msg);
}

async function getGpsInfo() {
  let gpxStats = null;
  const gpxText = await getGpxContent(currentTrip);
  if (gpxText) {
    gpxStats = getGpxStats(gpxText);
  } else if (currentTrip?.isParent) {
    const children = getOrderedTrips().filter(t => t.parentId === currentTrip.id);
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

async function updateHeaderInfo() {
  const line1 = document.getElementById('headerLine1');
  const line2 = document.getElementById('headerLine2');
  const headerInfo = document.querySelector('.header-info');
  const videoBtn = document.getElementById('headerVideoBtn');
  if (!line1 || !line2) return;
  if (!currentTrip) {
    line1.textContent = 'トリップを選択';
    line2.textContent = '';
    if (headerInfo) headerInfo.classList.remove('header-info-mobile');
    if (videoBtn) videoBtn.style.display = 'none';
    const stampBtn = document.getElementById('headerStampBtn');
    if (stampBtn) stampBtn.style.display = 'none';
    return;
  }
  if (videoBtn) {
    if (currentTrip.videoUrl) {
      videoBtn.style.display = '';
    } else {
      videoBtn.style.display = 'none';
    }
  }
  const stampBtn = document.getElementById('headerStampBtn');
  if (stampBtn) {
    // ランドマーク（スタンプ）がある場合に表示
    const hasLandmarks = (currentTrip.photos || []).some(p => p.landmarkNo);
    if (hasLandmarks) {
      stampBtn.style.display = '';
    } else {
      stampBtn.style.display = 'none';
    }
  }
  const name = currentTrip.name || '（無題）';
  const url = currentTrip.url;
  const nameHtml = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="header-trip-link">${escapeHtml(name)}</a>`
    : escapeHtml(name);
  if (isMobileView()) {
    const short = Array.from(name).slice(0, 4).join('');
    const hasTravelogue = currentTrip.travelogueHtml || currentTrip.travelogueUrl;

    if (hasTravelogue) {
      // 旅行記がある場合は旅行記へのリンク
      line1.innerHTML = `<a href="#" class="header-trip-link header-travelogue-link-mobile">${escapeHtml(short)}</a>`;
    } else if (url) {
      // 旅行記がなくブログURLがある場合はブログへのリンク
      line1.innerHTML = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="header-trip-link">${escapeHtml(short)}</a>`;
    } else {
      // リンクなし
      line1.innerHTML = escapeHtml(short);
    }

    line2.textContent = '';
    if (headerInfo) headerInfo.classList.add('header-info-mobile');

    // 旅行記リンクにクリックイベントを追加
    const travelogueLinkMobile = line1.querySelector('.header-travelogue-link-mobile');
    if (travelogueLinkMobile) {
      travelogueLinkMobile.addEventListener('click', (e) => {
        e.preventDefault();
        showTravelogueModal();
      });
    }
  } else {
    if (headerInfo) headerInfo.classList.remove('header-info-mobile');
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
      const hasTravelogue = currentTrip.travelogueHtml || currentTrip.travelogueUrl;
      if (hasTravelogue) {
        line2Html += escapeHtml(currentTrip.description);
        line2Html += ' <button type="button" class="header-travelogue-btn">📝 旅行記</button>';
      } else if (currentTrip.url) {
        line2Html += `<a href="${escapeHtml(currentTrip.url)}" target="_blank" rel="noopener" class="header-trip-link">${escapeHtml(currentTrip.description)}</a>`;
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
}

function updateTripSheetTriggerLabel() {
  const tripSheetTriggerLabel = document.querySelector('.trip-sheet-trigger-label');
  const prevBtn = document.getElementById('tripNavPrev');
  const nextBtn = document.getElementById('tripNavNext');
  if (!tripSheetTriggerLabel) return;

  if (currentTrip && currentTrip.name) {
    tripSheetTriggerLabel.textContent = currentTrip.name;
    // トリップカラーを適用
    if (currentTrip.color) {
      tripSheetTriggerLabel.style.color = currentTrip.color;
      tripSheetTriggerLabel.style.fontWeight = '600';
    }

    // 前後のボタンの有効/無効を設定
    const trips = getOrderedTrips();
    const currentIndex = trips.findIndex(t => t.id === currentTrip.id);
    if (prevBtn) {
      prevBtn.disabled = currentIndex <= 0;
    }
    if (nextBtn) {
      nextBtn.disabled = currentIndex < 0 || currentIndex >= trips.length - 1;
    }
  } else {
    tripSheetTriggerLabel.textContent = 'トリップ一覧';
    tripSheetTriggerLabel.style.color = '';
    tripSheetTriggerLabel.style.fontWeight = '';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
  }

  // 地図上のトリップ名オーバーレイも更新
  updateMapTripNameOverlay();
}

function updateMapTripNameOverlay() {
  const overlay = document.getElementById('mapTripNameOverlay');
  const playBtn = document.getElementById('playStopBtnMobile');
  if (!overlay) return;

  if (currentTrip && currentTrip.name) {
    const tripColor = currentTrip.color || '#e1306c';
    overlay.innerHTML = `
      <div class="map-trip-name-card" style="--trip-color: ${tripColor}" id="mapTripNameCard">
        <div class="map-trip-name-text">${escapeHtml(currentTrip.name)}</div>
      </div>
    `;
    overlay.classList.add('visible');

    // 再生ボタンにもトリップカラーを適用
    if (playBtn) {
      playBtn.style.setProperty('--trip-color', tripColor);
    }

    // クリックイベントを追加
    const card = document.getElementById('mapTripNameCard');
    if (card) {
      card.onclick = () => {
        // 全てのスポットが収まるように地図を表示
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
  const container = document.getElementById('travelogueActionButtons');
  if (!container) return;

  // ボタンをクリア
  container.innerHTML = '';

  // 旅行記HTMLまたはURLがあるかチェック
  if (!currentTrip || (!currentTrip.travelogueHtml?.trim() && !currentTrip.travelogueUrl)) {
    return;
  }

  // 旅行記生成日時を取得（updatedAtを使用）
  const timestamp = currentTrip.travelogueGeneratedAt || currentTrip.updatedAt || Date.now();
  const date = new Date(timestamp);
  const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  // 旅行記表示ボタン
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn btn-secondary btn-xs';
  viewBtn.textContent = `旅行記 (${dateStr})`;
  viewBtn.title = '旅行記を表示';
  viewBtn.onclick = () => showTravelogueModal();
  container.appendChild(viewBtn);

  // 削除ボタン
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-xs';
  deleteBtn.textContent = '×';
  deleteBtn.title = '旅行記を削除';
  deleteBtn.style.cssText = 'background:#dc3545;color:white;padding:0.2rem 0.5rem;min-width:auto;';
  deleteBtn.onclick = async () => {
    if (!confirm('この旅行記を削除してもよろしいですか？')) return;
    try {
      // StorageのURLがある場合は削除（エラーは無視）
      if (currentTrip.travelogueUrl) {
        try {
          const ref = window.firebaseStorage?.refFromURL(currentTrip.travelogueUrl);
          if (ref) await ref.delete();
        } catch (err) {
          console.warn('旅行記Storage削除エラー（無視）:', err);
        }
      }

      currentTrip.travelogueHtml = '';
      currentTrip.travelogueUrl = null;
      currentTrip.travelogueGeneratedAt = null;
      await saveTrip();
      updateTravelogueActionButtons();
      updateCoverPreview();
      updateHeaderInfo();
      setStatus('旅行記を削除しました');
    } catch (err) {
      console.error('旅行記削除エラー:', err);
      alert('旅行記の削除に失敗しました: ' + (err.message || String(err)));
    }
  };
  container.appendChild(deleteBtn);
}

function updateAnimePreview() {
  const previewContainer = document.getElementById('generatedImagesPreview');
  if (!previewContainer || !animeFrames || animeFrames.length === 0) return;

  // 既に表紙プレビューがあるかチェック
  const existingImages = previewContainer.querySelectorAll('img');

  // 生成されたアニメ画像（最初のフレーム）を追加
  if (animeFrames[0] && animeFrames[0].url) {
    const animeImg = document.createElement('img');
    animeImg.src = animeFrames[0].url;
    animeImg.alt = '生成されたアニメ';
    animeImg.style.cssText = 'height:60px;width:auto;border-radius:4px;box-shadow:0 2px 4px rgba(0,0,0,0.2);cursor:pointer;';
    animeImg.title = 'クリックでアニメを表示';
    animeImg.onclick = () => showAnimeModal();
    previewContainer.appendChild(animeImg);
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
    updateEditorUI();
    await loadMyTrips();
    await loadTripOrder();
    renderTripList();
    refreshTripSelect();
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

  // 前のトリップボタン
  const tripNavPrev = document.getElementById('tripNavPrev');
  if (tripNavPrev) {
    tripNavPrev.onclick = async (e) => {
      e.stopPropagation();
      if (!currentTrip) return;
      const trips = getOrderedTrips();
      const currentIndex = trips.findIndex(t => t.id === currentTrip.id);
      if (currentIndex > 0) {
        await loadTripById(trips[currentIndex - 1].id);
      }
    };
  }

  // 次のトリップボタン
  const tripNavNext = document.getElementById('tripNavNext');
  if (tripNavNext) {
    tripNavNext.onclick = async (e) => {
      e.stopPropagation();
      if (!currentTrip) return;
      const trips = getOrderedTrips();
      const currentIndex = trips.findIndex(t => t.id === currentTrip.id);
      if (currentIndex >= 0 && currentIndex < trips.length - 1) {
        await loadTripById(trips[currentIndex + 1].id);
      }
    };
  }
  if (tripSheetOverlay && tripPanel) {
    tripSheetOverlay.onclick = () => {
      tripPanel.classList.remove('open');
      tripSheetOverlay.classList.remove('open');
    };
  }

  document.getElementById('saveTripBtn').onclick = saveTrip;
  document.getElementById('newTripBtn').onclick = async () => {
    if (!isEditor()) return;

    // 前のトリップの写真ポップアップをクリア
    if (photoPopup && map) {
      map.removeLayer(photoPopup);
      photoPopup = null;
    }

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
        const saved = myTrips.find(t => t.id === currentTrip.id);
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
        stopPlay();
      } else {
        startPlay();
      }
    };
  }
  document.getElementById('photoPrevBtn').onclick = prevPhoto;
  document.getElementById('photoNextBtn').onclick = nextPhoto;
  const headerVideoBtn = document.getElementById('headerVideoBtn');
  if (headerVideoBtn) headerVideoBtn.onclick = () => {
    if (playTimer) stopPlay();
    if (currentTrip?.videoUrl) showVideoOverlay(currentTrip.videoUrl);
  };
  const headerStampBtn = document.getElementById('headerStampBtn');
  if (headerStampBtn) headerStampBtn.onclick = () => {
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
    if (currentTrip?.videoUrl) showVideoOverlay(currentTrip.videoUrl);
    closeMenu();
  };
  const viewerStampBtn = document.getElementById('viewerStampBtn');
  if (viewerStampBtn) viewerStampBtn.onclick = () => {
    if (currentTrip) showStampRallyModal(currentTrip);
    closeMenu();
  };

  const generateTravelogueBtn = document.getElementById('generateTravelogueBtn');
  if (generateTravelogueBtn) generateTravelogueBtn.onclick = () => generateTravelogueWithAI();
  const videoBackBtn = document.getElementById('videoBackBtn');
  if (videoBackBtn) videoBackBtn.onclick = closeVideoOverlay;


  document.getElementById('helpModalClose').onclick = () => document.getElementById('helpModal').classList.remove('open');

  const blogModal = document.getElementById('blogModal');
  const blogModalClose = document.getElementById('blogModalClose');
  if (blogModalClose) blogModalClose.onclick = closeBlogPopup;
  if (blogModal) blogModal.onclick = (e) => { if (e.target === blogModal) closeBlogPopup(); };
  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) helpBtn.onclick = () => document.getElementById('helpModal').classList.add('open');

  const generateAnimeBtn = document.getElementById('generateAnimeBtnViewer');
  const animeModal = document.getElementById('animeModal');
  const animeModalClose = document.getElementById('animeModalClose');
  const animePlayBtn = document.getElementById('animePlayBtn');
  if (generateAnimeBtn) generateAnimeBtn.onclick = () => showAnimeModal();
  if (animeModalClose) animeModalClose.onclick = () => closeAnimeModal();
  if (animePlayBtn) animePlayBtn.onclick = () => toggleAnimePlay();
  if (animeModal) animeModal.onclick = (e) => { if (e.target === animeModal) closeAnimeModal(); };

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

      try {
        // 画像をBase64に変換
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64Data = event.target.result;
          characterImageData = base64Data;

          // プレビュー表示
          if (characterPreviewImg && characterPreview) {
            characterPreviewImg.src = base64Data;
            characterPreview.style.display = 'flex';
          }

          setStatus('キャラクター画像を設定しました');
        };
        reader.readAsDataURL(file);
      } catch (err) {
        console.error('キャラクター画像読み込みエラー:', err);
        alert('画像の読み込みに失敗しました');
      }
    };
  }

  if (removeCharacterBtn && characterPreview) {
    removeCharacterBtn.onclick = () => {
      characterImageData = null;
      characterPreview.style.display = 'none';
      if (characterImageInput) characterImageInput.value = '';
      setStatus('キャラクター画像を削除しました');
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
    const aiInput = document.getElementById('aiApiKeyInput');
    const provider = providerSelect?.value || 'gemini';
    const apiKey = aiInput?.value || '';
    try {
      await saveUserAiConfig({ provider, apiKey });
      closeAiSettingsModal();
      setStatus('AI設定を保存しました');
    } catch (err) {
      alert(err?.message || '保存に失敗しました');
    }
  };
  const aiProviderSelect = document.getElementById('aiProviderSelect');
  if (aiSettingsModal) aiSettingsModal.onclick = (e) => { if (e.target === aiSettingsModal) closeAiSettingsModal(); };

  const travelogueModal = document.getElementById('travelogueModal');
  const travelogueModalClose = document.getElementById('travelogueModalClose');
  if (travelogueModalClose) travelogueModalClose.onclick = () => closeTravelogueModal();
  if (travelogueModal) travelogueModal.onclick = (e) => { if (e.target === travelogueModal) closeTravelogueModal(); };
  const stampRallyModal = document.getElementById('stampRallyModal');
  const stampRallyModalClose = document.getElementById('stampRallyModalClose');
  if (stampRallyModalClose) stampRallyModalClose.onclick = () => closeStampRallyModal();
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
  initMap();
  initMapSearch();
  initEventListeners();
  updateEditorUI();
  updateHeaderInfo();

  // モバイル用トリップシートトリガーの初期化
  const tripSheetTriggerLabel = document.querySelector('.trip-sheet-trigger-label');
  if (tripSheetTriggerLabel) {
    tripSheetTriggerLabel.textContent = 'トリップ一覧';
  }

  const loadTripsAndRender = async () => {
    try {
      await loadMyTrips();
      await loadTripOrder();
      renderTripList();
      refreshTripSelect();
      refreshTripParentSelectOptions();
      const lastTripId = (() => { try { return localStorage.getItem(LAST_TRIP_ID_KEY); } catch (_) { return null; } })();
      if (lastTripId) {
        try {
          await loadTripById(lastTripId);
        } catch (err) {
          console.error('前回のトリップ読み込みエラー:', err);
          // 前回のトリップ読み込みに失敗した場合は、デフォルトビューを表示
          await updateHeaderInfo();
          await updateMapMarkers();
        }
      } else {
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
