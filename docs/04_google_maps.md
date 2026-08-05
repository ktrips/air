# 第4章: Google Mapsの実装

## 4.1 実践的な地図の実装

### 4.1.1 プロジェクト構造

まず、プロジェクトの基本的なファイル構造を整えます：

```
air-app/
├── index.html
├── js/
│   ├── map.js          # 地図管理
│   ├── marker.js       # マーカー管理
│   └── app.js          # メインアプリケーション
├── css/
│   └── style.css
├── .env
├── package.json
└── README.md
```

### 4.1.2 HTML構造

`index.html`を作成します：

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AIR - Trip Management App</title>
    <link rel="stylesheet" href="css/style.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>AIR - Trip Management</h1>
            <button id="loginBtn" class="btn-primary">ログイン</button>
            <button id="logoutBtn" class="btn-primary" style="display:none;">ログアウト</button>
            <span id="userEmail" class="user-email"></span>
        </header>

        <main>
            <div class="controls">
                <button id="addTripBtn" class="btn-primary">新規トリップ作成</button>
                <input type="text" id="searchInput" placeholder="トリップを検索...">
            </div>

            <div class="content">
                <div id="map" class="map"></div>
                <div id="tripList" class="trip-list">
                    <h2>トリップ一覧</h2>
                    <ul id="trips"></ul>
                </div>
            </div>
        </main>
    </div>

    <!-- Firebase SDK -->
    <script src="https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.0.0/firebase-auth.js"></script>

    <!-- Google Maps API -->
    <script src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&libraries=places,geometry"></script>

    <!-- アプリケーションスクリプト -->
    <script type="module" src="js/app.js"></script>
</body>
</html>
```

## 4.2 地図管理クラスの実装

`js/map.js`を作成します：

```javascript
/**
 * Google Mapsを管理するクラス
 */
export class MapManager {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.map = null;
    this.markers = new Map();
    this.infowindows = new Map();

    const defaultOptions = {
      zoom: 12,
      center: { lat: 35.6762, lng: 139.7674 }, // 東京駅
      mapTypeId: 'roadmap'
    };

    const finalOptions = { ...defaultOptions, ...options };
    this.initializeMap(finalOptions);
  }

  /**
   * 地図を初期化
   */
  initializeMap(options) {
    this.map = new google.maps.Map(this.container, options);

    // ユーザーの現在位置を取得（オプション）
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition((position) => {
        const userLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        this.map.setCenter(userLocation);
      });
    }
  }

  /**
   * マーカーを追加
   */
  addMarker(id, lat, lng, title, options = {}) {
    // 既存のマーカーがあれば削除
    this.removeMarker(id);

    const markerOptions = {
      position: { lat, lng },
      map: this.map,
      title: title,
      draggable: options.draggable || false,
      ...options
    };

    const marker = new google.maps.Marker(markerOptions);

    // マーカーをMapに保存
    this.markers.set(id, marker);

    // クリックイベント
    marker.addListener('click', () => {
      this.showInfoWindow(id, title, options.description);
    });

    // ドラッグ終了イベント
    if (options.onDragEnd) {
      marker.addListener('dragend', (event) => {
        options.onDragEnd({
          lat: event.latLng.lat(),
          lng: event.latLng.lng()
        });
      });
    }

    return marker;
  }

  /**
   * マーカーを削除
   */
  removeMarker(id) {
    const marker = this.markers.get(id);
    if (marker) {
      marker.setMap(null);
      this.markers.delete(id);
    }

    const infowindow = this.infowindows.get(id);
    if (infowindow) {
      infowindow.close();
      this.infowindows.delete(id);
    }
  }

  /**
   * すべてのマーカーを削除
   */
  clearMarkers() {
    this.markers.forEach(marker => marker.setMap(null));
    this.markers.clear();

    this.infowindows.forEach(infowindow => infowindow.close());
    this.infowindows.clear();
  }

  /**
   * 情報ウィンドウを表示
   */
  showInfoWindow(id, title, description = '') {
    const marker = this.markers.get(id);
    if (!marker) return;

    const content = `
      <div class="infowindow">
        <h3>${title}</h3>
        ${description ? `<p>${description}</p>` : ''}
      </div>
    `;

    let infowindow = this.infowindows.get(id);
    if (infowindow) {
      infowindow.close();
    }

    infowindow = new google.maps.InfoWindow({ content });
    infowindow.open(this.map, marker);
    this.infowindows.set(id, infowindow);
  }

  /**
   * マーカーを更新
   */
  updateMarker(id, lat, lng) {
    const marker = this.markers.get(id);
    if (marker) {
      marker.setPosition({ lat, lng });
    }
  }

  /**
   * マーカーをハイライト
   */
  highlightMarker(id) {
    this.markers.forEach((marker, markerId) => {
      if (markerId === id) {
        marker.setAnimation(google.maps.Animation.BOUNCE);
      } else {
        marker.setAnimation(null);
      }
    });
  }

  /**
   * 複数のマーカーに基づいて地図をズーム
   */
  fitMarkers(markerIds = null) {
    const bounds = new google.maps.LatLngBounds();

    const markersToFit = markerIds
      ? markerIds.map(id => this.markers.get(id)).filter(m => m)
      : Array.from(this.markers.values());

    if (markersToFit.length === 0) return;

    markersToFit.forEach(marker => {
      bounds.extend(marker.getPosition());
    });

    this.map.fitBounds(bounds);
  }

  /**
   * ポリラインを描画（複数マーカーを結ぶ）
   */
  drawPolyline(pointIds, options = {}) {
    const points = pointIds
      .map(id => {
        const marker = this.markers.get(id);
        return marker ? marker.getPosition() : null;
      })
      .filter(p => p);

    if (points.length < 2) return null;

    const defaultOptions = {
      path: points,
      geodesic: true,
      strokeColor: '#FF0000',
      strokeOpacity: 0.7,
      strokeWeight: 2,
      map: this.map
    };

    return new google.maps.Polyline({ ...defaultOptions, ...options });
  }

  /**
   * 地図の中心を変更
   */
  setCenter(lat, lng) {
    this.map.setCenter({ lat, lng });
  }

  /**
   * ズームレベルを変更
   */
  setZoom(level) {
    this.map.setZoom(level);
  }

  /**
   * 現在のズームレベルを取得
   */
  getZoom() {
    return this.map.getZoom();
  }

  /**
   * マーカーの位置情報を取得
   */
  getMarkerPosition(id) {
    const marker = this.markers.get(id);
    if (!marker) return null;

    const pos = marker.getPosition();
    return {
      lat: pos.lat(),
      lng: pos.lng()
    };
  }
}
```

## 4.3 マーカー管理クラスの実装

`js/marker.js`を作成します：

```javascript
/**
 * マーカーに関連する業務ロジックを管理
 */
export class MarkerDataManager {
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.markerData = new Map(); // マーカーのメタデータを保存
  }

  /**
   * トリップからマーカーを作成
   */
  createMarkerFromTrip(trip) {
    const markerId = trip.id;
    const { title, description, location, color = '#FF0000' } = trip;

    // マーカーのメタデータを保存
    this.markerData.set(markerId, {
      tripId: trip.id,
      title,
      description,
      location
    });

    // マップにマーカーを追加
    const marker = this.mapManager.addMarker(
      markerId,
      location.lat,
      location.lng,
      title,
      {
        description,
        icon: this.getMarkerIcon(color)
      }
    );

    return marker;
  }

  /**
   * マーカーアイコンを取得（色別）
   */
  getMarkerIcon(color) {
    const colorMap = {
      '#FF0000': 'http://maps.google.com/mapfiles/ms/icons/red-dot.png',
      '#00FF00': 'http://maps.google.com/mapfiles/ms/icons/green-dot.png',
      '#0000FF': 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png',
      '#FFFF00': 'http://maps.google.com/mapfiles/ms/icons/yellow-dot.png'
    };
    return colorMap[color] || colorMap['#FF0000'];
  }

  /**
   * 複数のトリップからマーカーを一括作成
   */
  createMarkersFromTrips(trips) {
    trips.forEach(trip => this.createMarkerFromTrip(trip));
  }

  /**
   * 2点間の距離を計算
   */
  calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // 地球の半径（km）
    const rad1 = (lat1 * Math.PI) / 180;
    const rad2 = (lat2 * Math.PI) / 180;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad1) * Math.cos(rad2) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * マーカーのメタデータを取得
   */
  getMarkerData(id) {
    return this.markerData.get(id);
  }

  /**
   * すべてのマーカーデータをクリア
   */
  clearAll() {
    this.mapManager.clearMarkers();
    this.markerData.clear();
  }
}
```

## 4.4 CSS スタイル

`css/style.css`を作成します：

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background-color: #f5f5f5;
}

.container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

header {
  background-color: #2c3e50;
  color: white;
  padding: 1rem 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

header h1 {
  font-size: 1.5rem;
}

.user-email {
  margin-right: 1rem;
  font-size: 0.9rem;
}

.btn-primary {
  background-color: #3498db;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background-color 0.3s;
}

.btn-primary:hover {
  background-color: #2980b9;
}

main {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 2rem;
}

.controls {
  display: flex;
  gap: 1rem;
  margin-bottom: 2rem;
}

.controls input {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.content {
  display: flex;
  gap: 2rem;
  flex: 1;
}

.map {
  flex: 1;
  min-height: 500px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.trip-list {
  width: 300px;
  background-color: white;
  border-radius: 8px;
  padding: 1rem;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  overflow-y: auto;
  max-height: 600px;
}

.trip-list h2 {
  font-size: 1.1rem;
  margin-bottom: 1rem;
  border-bottom: 2px solid #3498db;
  padding-bottom: 0.5rem;
}

.trip-list ul {
  list-style: none;
}

.trip-item {
  padding: 0.75rem;
  margin-bottom: 0.5rem;
  background-color: #f9f9f9;
  border-left: 3px solid #3498db;
  cursor: pointer;
  transition: background-color 0.3s;
}

.trip-item:hover {
  background-color: #e8f4f8;
}

.trip-item.active {
  background-color: #d4e8f7;
  border-left-color: #2980b9;
}

.infowindow {
  padding: 0.5rem;
  font-size: 0.9rem;
}

.infowindow h3 {
  margin-bottom: 0.5rem;
  color: #2c3e50;
}

.infowindow p {
  color: #666;
}

/* レスポンシブ対応 */
@media (max-width: 768px) {
  .content {
    flex-direction: column;
  }

  .trip-list {
    width: 100%;
    max-height: 300px;
  }

  header {
    flex-direction: column;
    gap: 1rem;
    text-align: center;
  }
}
```

## 4.5 基本的なアプリケーション実装

`js/app.js`を作成します：

```javascript
import { MapManager } from './map.js';
import { MarkerDataManager } from './marker.js';

// グローバル変数
let mapManager;
let markerManager;
const trips = [];

/**
 * アプリケーションを初期化
 */
async function initializeApp() {
  // 地図を初期化
  mapManager = new MapManager('map', {
    zoom: 13,
    center: { lat: 35.6762, lng: 139.7674 }
  });

  markerManager = new MarkerDataManager(mapManager);

  // イベントリスナーを設定
  setupEventListeners();

  // ダミーデータを読み込む（実装時はFirebaseから取得）
  await loadSampleTrips();
}

/**
 * イベントリスナーを設定
 */
function setupEventListeners() {
  const addTripBtn = document.getElementById('addTripBtn');
  const searchInput = document.getElementById('searchInput');
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  addTripBtn?.addEventListener('click', () => {
    console.log('新規トリップ作成');
    // 実装は後の章で
  });

  searchInput?.addEventListener('input', (e) => {
    filterTrips(e.target.value);
  });

  loginBtn?.addEventListener('click', () => {
    console.log('ログイン処理');
    // 実装は後の章で
  });

  logoutBtn?.addEventListener('click', () => {
    console.log('ログアウト処理');
    // 実装は後の章で
  });
}

/**
 * サンプルトリップを読み込む
 */
async function loadSampleTrips() {
  const sampleTrips = [
    {
      id: '1',
      title: '東京タワー',
      description: '東京のシンボル的存在',
      location: { lat: 35.6586, lng: 139.7454 },
      color: '#FF0000'
    },
    {
      id: '2',
      title: '浅草寺',
      description: '古都の風情を感じられる',
      location: { lat: 35.7148, lng: 139.7967 },
      color: '#00FF00'
    },
    {
      id: '3',
      title: '渋谷スクランブル交差点',
      description: 'エネルギッシュな街',
      location: { lat: 35.6595, lng: 139.7004 },
      color: '#0000FF'
    }
  ];

  trips.push(...sampleTrips);
  displayTrips(sampleTrips);
}

/**
 * トリップを表示
 */
function displayTrips(tripsToDisplay) {
  const tripsList = document.getElementById('trips');
  tripsList.innerHTML = '';

  markerManager.clearAll();

  tripsToDisplay.forEach(trip => {
    // マーカーを作成
    markerManager.createMarkerFromTrip(trip);

    // リストアイテムを作成
    const li = document.createElement('li');
    li.className = 'trip-item';
    li.textContent = trip.title;
    li.addEventListener('click', () => {
      selectTrip(trip.id);
    });
    tripsList.appendChild(li);
  });
}

/**
 * トリップを選択
 */
function selectTrip(tripId) {
  // ハイライトを更新
  document.querySelectorAll('.trip-item').forEach(item => {
    item.classList.remove('active');
  });
  event.target.classList.add('active');

  // マーカーをハイライト
  mapManager.highlightMarker(tripId);

  // 地図の中心を移動
  const trip = trips.find(t => t.id === tripId);
  if (trip) {
    mapManager.setCenter(trip.location.lat, trip.location.lng);
  }
}

/**
 * トリップを絞り込む
 */
function filterTrips(searchTerm) {
  const filtered = trips.filter(trip =>
    trip.title.toLowerCase().includes(searchTerm.toLowerCase())
  );
  displayTrips(filtered);
}

// ページ読み込み時にアプリを初期化
document.addEventListener('DOMContentLoaded', initializeApp);
```

## 4.6 動作確認

```bash
# サーバーを起動
npm start

# またはhttp-serverを直接実行
http-server -p 8000
```

ブラウザで `http://localhost:8000` にアクセスすると、3つのトリップがマップに表示されます。

---

**次章へ**: 第5章では、Claude APIを統合してAI機能を追加します。
