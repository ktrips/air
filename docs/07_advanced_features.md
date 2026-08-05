# 第7章: 応用機能とパフォーマンス最適化

## 7.1 ページング処理

### 7.1.1 大量データのページング

```javascript
import { query, limit, startAfter, getDocs, orderBy, QueryConstraint } from 'firebase/firestore';

class PaginatedTripLoader {
  constructor(tripManager) {
    this.tripManager = tripManager;
    this.pageSize = 10;
    this.lastDoc = null;
  }

  /**
   * 最初のページを読み込む
   */
  async loadFirstPage() {
    const q = query(
      this.tripManager.tripsCollection,
      orderBy('createdAt', 'desc'),
      limit(this.pageSize)
    );

    const snapshot = await getDocs(q);
    const trips = [];

    snapshot.forEach(doc => {
      trips.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // 次のページのための参照を保存
    if (snapshot.docs.length > 0) {
      this.lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    return trips;
  }

  /**
   * 次のページを読み込む
   */
  async loadNextPage() {
    if (!this.lastDoc) {
      return [];
    }

    const q = query(
      this.tripManager.tripsCollection,
      orderBy('createdAt', 'desc'),
      startAfter(this.lastDoc),
      limit(this.pageSize)
    );

    const snapshot = await getDocs(q);
    const trips = [];

    snapshot.forEach(doc => {
      trips.push({
        id: doc.id,
        ...doc.data()
      });
    });

    if (snapshot.docs.length > 0) {
      this.lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    return trips;
  }

  /**
   * ページング状態をリセット
   */
  reset() {
    this.lastDoc = null;
  }
}
```

## 7.2 インデックスの最適化

### 7.2.1 複合インデックスの設定

```javascript
// firestore.indexes.json
{
  "indexes": [
    {
      "collectionGroup": "trips",
      "queryScope": "Collection",
      "fields": [
        {
          "fieldPath": "userId",
          "order": "Ascending"
        },
        {
          "fieldPath": "category",
          "order": "Ascending"
        },
        {
          "fieldPath": "createdAt",
          "order": "Descending"
        }
      ]
    },
    {
      "collectionGroup": "children",
      "queryScope": "Collection",
      "fields": [
        {
          "fieldPath": "parentTripId",
          "order": "Ascending"
        },
        {
          "fieldPath": "order",
          "order": "Ascending"
        }
      ]
    }
  ]
}
```

## 7.3 検索機能の実装

### 7.3.1 クライアント側でのテキスト検索

```javascript
class TripSearch {
  constructor(trips = []) {
    this.trips = trips;
    this.index = new Map();
    this.buildIndex();
  }

  /**
   * 検索インデックスを構築
   */
  buildIndex() {
    this.trips.forEach((trip, idx) => {
      const keywords = this.extractKeywords(trip);
      keywords.forEach(keyword => {
        if (!this.index.has(keyword)) {
          this.index.set(keyword, []);
        }
        this.index.get(keyword).push(idx);
      });
    });
  }

  /**
   * キーワードを抽出
   */
  extractKeywords(trip) {
    const text = `${trip.title} ${trip.description} ${trip.category || ''}`.toLowerCase();
    return text.split(/\s+/).filter(word => word.length > 1);
  }

  /**
   * トリップを検索
   */
  search(query) {
    if (!query || query.length < 2) {
      return [];
    }

    const searchTerm = query.toLowerCase();
    const results = new Set();

    // 完全一致を優先
    if (this.index.has(searchTerm)) {
      this.index.get(searchTerm).forEach(idx => results.add(idx));
    }

    // 部分一致を追加
    this.index.forEach((indices, keyword) => {
      if (keyword.includes(searchTerm) || searchTerm.includes(keyword)) {
        indices.forEach(idx => results.add(idx));
      }
    });

    return Array.from(results).map(idx => this.trips[idx]);
  }

  /**
   * 検索インデックスを更新
   */
  updateTrips(trips) {
    this.trips = trips;
    this.index.clear();
    this.buildIndex();
  }
}
```

### 7.3.2 Algoliaを使用した高度な検索

```javascript
import algoliasearch from 'algoliasearch';

class AlgoliaSearchManager {
  constructor(appId, apiKey) {
    this.client = algoliasearch(appId, apiKey);
    this.tripsIndex = this.client.initIndex('trips');
  }

  /**
   * トリップを検索インデックスに追加
   */
  async indexTrip(trip) {
    await this.tripsIndex.saveObject({
      objectID: trip.id,
      title: trip.title,
      description: trip.description,
      category: trip.category,
      location: {
        lat: trip.location.lat,
        lng: trip.location.lng
      },
      createdAt: trip.createdAt
    });
  }

  /**
   * トリップを検索
   */
  async search(query, options = {}) {
    const results = await this.tripsIndex.search(query, {
      hitsPerPage: options.hitsPerPage || 20,
      page: options.page || 0,
      facets: ['category'],
      ...options
    });

    return results.hits;
  }

  /**
   * 位置情報ベースの検索
   */
  async searchNearby(lat, lng, radius = 10) {
    const results = await this.tripsIndex.search('', {
      aroundLatLng: `${lat}, ${lng}`,
      aroundRadius: radius * 1000 // メートル単位
    });

    return results.hits;
  }

  /**
   * トリップを削除
   */
  async deleteTrip(tripId) {
    await this.tripsIndex.deleteObject(tripId);
  }
}
```

## 7.4 キャッシング戦略

### 7.4.1 メモリキャッシュの実装

```javascript
class TripCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.accessOrder = [];
  }

  /**
   * キャッシュに値を設定
   */
  set(key, value, ttl = 3600000) { // デフォルト1時間
    // 最大サイズに達した場合、最もアクセスが古いものを削除
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.accessOrder.shift();
      this.cache.delete(oldestKey);
    }

    const expiresAt = Date.now() + ttl;
    this.cache.set(key, { value, expiresAt });
    this.accessOrder.push(key);
  }

  /**
   * キャッシュから値を取得
   */
  get(key) {
    if (!this.cache.has(key)) {
      return null;
    }

    const { value, expiresAt } = this.cache.get(key);

    // TTLが切れていたら削除
    if (Date.now() > expiresAt) {
      this.cache.delete(key);
      this.accessOrder = this.accessOrder.filter(k => k !== key);
      return null;
    }

    // アクセス順序を更新
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);

    return value;
  }

  /**
   * キャッシュをクリア
   */
  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }
}

// 使用例
const tripCache = new TripCache(50);

// キャッシュにトリップを保存（1時間有効）
tripCache.set(`trip_${tripId}`, tripData, 3600000);

// キャッシュからトリップを取得
const cached = tripCache.get(`trip_${tripId}`);
```

## 7.5 エラーハンドリング

### 7.5.1 包括的なエラー処理

```javascript
class ErrorHandler {
  static handle(error, context = '') {
    console.error(`エラー（${context}）:`, error);

    // Firebaseエラー
    if (error.code) {
      switch (error.code) {
        case 'permission-denied':
          return { message: 'アクセス権限がありません' };
        case 'not-found':
          return { message: 'データが見つかりません' };
        case 'unavailable':
          return { message: 'サービスが一時的に利用できません' };
        case 'auth/user-not-found':
          return { message: 'ユーザーが見つかりません' };
        case 'auth/wrong-password':
          return { message: 'パスワードが間違っています' };
        case 'auth/email-already-in-use':
          return { message: 'このメールアドレスは既に使用されています' };
        default:
          return { message: 'エラーが発生しました: ' + error.code };
      }
    }

    // Claude APIエラー
    if (error.status === 429) {
      return { message: 'API呼び出しが多すぎます。しばらく待ってから再度お試しください' };
    }

    if (error.status === 401) {
      return { message: 'APIキーが無効です' };
    }

    // Google Mapsエラー
    if (error.message && error.message.includes('map')) {
      return { message: '地図の読み込みに失敗しました' };
    }

    return { message: 'ネットワークエラーが発生しました' };
  }

  /**
   * エラーをログに記録
   */
  static log(error, context) {
    const errorLog = {
      timestamp: new Date().toISOString(),
      context,
      error: error.toString(),
      stack: error.stack
    };

    // ここでログサービスに送信（例：Sentry、LogRocket）
    console.error(JSON.stringify(errorLog));
  }
}
```

## 7.6 分析とモニタリング

### 7.6.1 ユーザーイベントの追跡

```javascript
class Analytics {
  constructor(userId) {
    this.userId = userId;
    this.events = [];
  }

  /**
   * イベントを記録
   */
  trackEvent(eventName, eventData = {}) {
    const event = {
      userId: this.userId,
      eventName,
      eventData,
      timestamp: new Date().toISOString()
    };

    this.events.push(event);

    // イベント数がしきい値に達したら送信
    if (this.events.length >= 10) {
      this.sendEvents();
    }

    console.log('イベントを記録しました:', eventName);
  }

  /**
   * イベントをサーバーに送信
   */
  async sendEvents() {
    if (this.events.length === 0) return;

    try {
      await fetch('/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: this.events })
      });

      this.events = [];
    } catch (error) {
      console.error('イベント送信エラー:', error);
    }
  }

  /**
   * ページ離脱時にイベントを送信
   */
  setupUnloadListener() {
    window.addEventListener('beforeunload', () => {
      this.sendEvents();
    });
  }
}

// 使用例
const analytics = new Analytics(userId);

// イベントを追跡
analytics.trackEvent('trip_created', { tripId, category: '観光地' });
analytics.trackEvent('trip_viewed', { tripId });
analytics.trackEvent('ai_generated', { tripId, type: 'description' });
```

## 7.7 無限スクロール実装

### 7.7.1 無限スクロールUIコンポーネント

```javascript
class InfiniteScrollManager {
  constructor(containerSelector, loader) {
    this.container = document.querySelector(containerSelector);
    this.loader = loader;
    this.isLoading = false;
    this.hasMore = true;

    this.setupIntersectionObserver();
  }

  /**
   * Intersection Observerを設定
   */
  setupIntersectionObserver() {
    const options = {
      root: this.container,
      rootMargin: '100px',
      threshold: 0.1
    };

    this.observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !this.isLoading && this.hasMore) {
          this.loadMore();
        }
      });
    }, options);
  }

  /**
   * 次のページを読み込む
   */
  async loadMore() {
    if (this.isLoading) return;

    this.isLoading = true;
    const loader = document.createElement('div');
    loader.className = 'loader';
    this.container.appendChild(loader);

    try {
      const items = await this.loader.loadNextPage();

      loader.remove();

      if (items.length === 0) {
        this.hasMore = false;
      }

      items.forEach(item => {
        const element = this.createItemElement(item);
        this.container.appendChild(element);
      });
    } catch (error) {
      console.error('読み込みエラー:', error);
      loader.remove();
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * アイテム要素を作成
   */
  createItemElement(item) {
    const div = document.createElement('div');
    div.className = 'trip-item';
    div.textContent = item.title;
    return div;
  }
}
```

---

**次章へ**: 第8章では、本番環境へのデプロイメント方法を説明します。
