# 第3章: 基本概念

## 3.1 Google Maps JavaScript APIの基礎

### 3.1.1 APIの読み込み

HTMLファイルで以下のように読み込みます：

```html
<script src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&libraries=places,geometry"></script>
```

**パラメータの意味**:
- `key`: 先ほど取得したAPIキー
- `libraries`: 追加ライブラリ
  - `places`: 場所検索機能
  - `geometry`: 距離計算機能

### 3.1.2 地図の初期化

JavaScriptコードで地図を初期化します：

```javascript
// 地図を表示するコンテナ
const mapContainer = document.getElementById('map');

// 地図の初期設定
const mapOptions = {
  zoom: 12,           // ズームレベル（0-21）
  center: {
    lat: 35.6762,     // 東京駅の緯度
    lng: 139.7674     // 東京駅の経度
  },
  mapTypeId: 'roadmap' // 'roadmap', 'satellite', 'hybrid', 'terrain'
};

// 地図オブジェクトの作成
const map = new google.maps.Map(mapContainer, mapOptions);
```

### 3.1.3 ズームレベルの目安

| ズームレベル | 表示範囲 |
|------------|--------|
| 1 | 世界全体 |
| 5 | 大陸 |
| 10 | 都道府県 |
| 15 | 街中 |
| 20 | 建物の詳細 |

## 3.2 マーカーの基本

### 3.2.1 単一マーカーの追加

```javascript
// マーカーを作成
const marker = new google.maps.Marker({
  position: {
    lat: 35.6762,
    lng: 139.7674
  },
  map: map,
  title: '東京駅'
});
```

### 3.2.2 複数マーカーの管理

```javascript
class MarkerManager {
  constructor(map) {
    this.map = map;
    this.markers = new Map(); // ID -> Marker の対応
  }

  // マーカーを追加
  addMarker(id, lat, lng, title) {
    const marker = new google.maps.Marker({
      position: { lat, lng },
      map: this.map,
      title: title
    });
    this.markers.set(id, marker);
    return marker;
  }

  // マーカーを削除
  removeMarker(id) {
    const marker = this.markers.get(id);
    if (marker) {
      marker.setMap(null);
      this.markers.delete(id);
    }
  }

  // マーカーの位置を更新
  updateMarker(id, lat, lng) {
    const marker = this.markers.get(id);
    if (marker) {
      marker.setPosition({ lat, lng });
    }
  }

  // すべてのマーカーを削除
  clearMarkers() {
    this.markers.forEach(marker => marker.setMap(null));
    this.markers.clear();
  }
}
```

### 3.2.3 マーカーのイベント処理

```javascript
// マーカークリック時のイベント
marker.addListener('click', () => {
  console.log('マーカーがクリックされました');
  // ここで詳細情報を表示など
});

// マーカードラッグ時のイベント
marker.addListener('dragend', (event) => {
  console.log('新しい位置:', event.latLng.lat(), event.latLng.lng());
  // ここで位置の更新処理
});
```

## 3.3 Claude API の基礎

### 3.3.1 APIリクエストの基本形式

```javascript
// Claude APIを呼び出す基本的なパターン
async function callClaudeAPI(prompt) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.content[0].text;
  } catch (error) {
    console.error('Claude API呼び出しエラー:', error);
    throw error;
  }
}
```

### 3.3.2 プロンプトエンジニアリングの基本

プロンプトは3つの要素で構成されます：

1. **コンテキスト**: 背景情報を提供
2. **指示**: 何をしてほしいか明確に
3. **形式**: 出力形式を指定

```javascript
// 効果的なプロンプトの例
const prompt = `
## コンテキスト
あなたは旅行ガイドの専門家です。

## 指示
以下の位置情報について、簡潔な説明を100字以内で作成してください。
- 位置: 東京タワー
- 緯度: 35.6586
- 経度: 139.7454

## 出力形式
JSONで以下の構造で返してください:
{
  "title": "場所の名前",
  "description": "場所の説明",
  "tips": "訪問のコツ"
}
`;
```

### 3.3.3 モデルの選択

| モデルID | 特徴 | 用途 |
|---------|------|------|
| claude-3-5-sonnet-20241022 | バランス型 | 汎用用途 |
| claude-3-opus-20250219 | 最高精度 | 複雑なタスク |
| claude-3-haiku-20250307 | 高速・低コスト | リアルタイム処理 |

## 3.4 Firebaseの基本概念

### 3.4.1 Firebaseの初期化

```javascript
// Firebase SDKのインポート
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// Firebase設定
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Firebaseアプリの初期化
const app = initializeApp(firebaseConfig);

// Firestoreの初期化
const db = getFirestore(app);

// Authenticationの初期化
const auth = getAuth(app);
```

### 3.4.2 Firestoreのデータ構造

Firestoreはドキュメント指向データベースで、以下の構造です：

```
プロジェクト
└── コレクション（trips）
    └── ドキュメント（tripId）
        ├── title: string
        ├── location: {lat: number, lng: number}
        ├── created: timestamp
        └── children: subcollection
            └── ドキュメント
```

### 3.4.3 基本的なCRUD操作

```javascript
import { collection, addDoc, getDocs, updateDoc, deleteDoc, doc } from 'firebase/firestore';

// Create: ドキュメント追加
async function addTrip(tripData) {
  const docRef = await addDoc(collection(db, 'trips'), {
    ...tripData,
    created: new Date()
  });
  return docRef.id;
}

// Read: すべてのトリップを取得
async function getTrips() {
  const snapshot = await getDocs(collection(db, 'trips'));
  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

// Update: トリップを更新
async function updateTrip(tripId, updates) {
  await updateDoc(doc(db, 'trips', tripId), updates);
}

// Delete: トリップを削除
async function deleteTrip(tripId) {
  await deleteDoc(doc(db, 'trips', tripId));
}
```

### 3.4.4 リアルタイム同期

```javascript
import { onSnapshot } from 'firebase/firestore';

// リアルタイムリスナーを設定
const unsubscribe = onSnapshot(
  collection(db, 'trips'),
  (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        console.log('新規トリップ:', change.doc.data());
      } else if (change.type === 'modified') {
        console.log('更新トリップ:', change.doc.data());
      } else if (change.type === 'removed') {
        console.log('削除トリップ:', change.doc.data());
      }
    });
  }
);

// リスナーを停止する場合
// unsubscribe();
```

## 3.5 認証の基本

### 3.5.1 Google Authenticationでログイン

```javascript
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';

const googleProvider = new GoogleAuthProvider();

async function loginWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    console.log('ユーザーがログインしました:', user.email);
    return user;
  } catch (error) {
    console.error('ログインエラー:', error);
  }
}
```

### 3.5.2 ログアウト

```javascript
import { signOut } from 'firebase/auth';

async function logout() {
  try {
    await signOut(auth);
    console.log('ログアウトしました');
  } catch (error) {
    console.error('ログアウトエラー:', error);
  }
}
```

## 3.6 座標系と距離計算

### 3.6.1 緯度経度の基本

```javascript
// 東京の座標
const tokyo = {
  lat: 35.6762,  // 北緯35.6762度
  lng: 139.7674  // 東経139.7674度
};

// 日本の座標範囲
const japanBounds = {
  north: 45.5,    // 北限
  south: 24.3,    // 南限
  east: 145.8,    // 東限
  west: 123.0     // 西限
};
```

### 3.6.2 2点間の距離計算

```javascript
// 2点間の距離をメートル単位で計算
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球の半径（メートル）
  const rad1 = (lat1 * Math.PI) / 180;
  const rad2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad1) * Math.cos(rad2) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // メートル単位の距離
}

// 使用例
const distanceInMeters = calculateDistance(35.6762, 139.7674, 35.6586, 139.7454);
console.log(`距離: ${(distanceInMeters / 1000).toFixed(2)}km`);
```

---

**次章へ**: 第4章では、これらの基本知識を活用して、実際に地図とマーカーを実装していきます。
