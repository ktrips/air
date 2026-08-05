# 第6章: Firebaseとの統合

## 6.1 Firestoreデータモデル設計

### 6.1.1 データ構造

AIRアプリケーションのデータモデルは階層構造になっています：

```
firestore
└── users（コレクション）
    └── {userId}（ドキュメント）
        ├── email: string
        ├── name: string
        ├── createdAt: timestamp
        └── trips（サブコレクション）
            └── {tripId}（ドキュメント）
                ├── title: string
                ├── description: string
                ├── location: {lat: number, lng: number}
                ├── category: string
                ├── color: string
                ├── createdAt: timestamp
                ├── updatedAt: timestamp
                └── children（サブコレクション）
                    └── {childTripId}（ドキュメント）
                        ├── title: string
                        ├── location: {lat: number, lng: number}
                        └── ...
```

### 6.1.2 ドキュメント定義

```javascript
/**
 * ユーザードキュメントの型定義
 */
class User {
  constructor(id, email, name) {
    this.id = id;
    this.email = email;
    this.name = name;
    this.createdAt = new Date();
    this.preferences = {
      theme: 'light',
      language: 'ja'
    };
  }
}

/**
 * トリップドキュメントの型定義
 */
class Trip {
  constructor(title, location, description = '') {
    this.title = title;
    this.location = location;  // {lat: number, lng: number}
    this.description = description;
    this.category = null;
    this.color = '#FF0000';
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.aiGenerated = false;
    this.tags = [];
  }
}

/**
 * 子トリップドキュメントの型定義
 */
class ChildTrip {
  constructor(parentTripId, title, location, order = 0) {
    this.parentTripId = parentTripId;
    this.title = title;
    this.location = location;
    this.order = order;
    this.visited = false;
    this.notes = '';
    this.createdAt = new Date();
  }
}
```

## 6.2 Firebase認証の実装

### 6.2.1 ユーザー認証フロー

```javascript
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';

class AuthManager {
  constructor(firebaseApp) {
    this.auth = getAuth(firebaseApp);
    this.currentUser = null;
    this.isAuthenticated = false;
  }

  /**
   * Googleでサインイン
   */
  async signInWithGoogle() {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(this.auth, provider);
      
      this.currentUser = result.user;
      this.isAuthenticated = true;

      console.log('ユーザーがログインしました:', result.user.email);
      return result.user;
    } catch (error) {
      console.error('サインインエラー:', error);
      throw error;
    }
  }

  /**
   * サインアウト
   */
  async signOut() {
    try {
      await signOut(this.auth);
      this.currentUser = null;
      this.isAuthenticated = false;
      console.log('ユーザーがログアウトしました');
    } catch (error) {
      console.error('サインアウトエラー:', error);
      throw error;
    }
  }

  /**
   * 認証状態を監視
   */
  onAuthStateChanged(callback) {
    return onAuthStateChanged(this.auth, (user) => {
      if (user) {
        this.currentUser = user;
        this.isAuthenticated = true;
        console.log('ユーザーが検出されました:', user.email);
      } else {
        this.currentUser = null;
        this.isAuthenticated = false;
        console.log('ユーザーがログアウト状態です');
      }
      callback(user);
    });
  }

  /**
   * ユーザーIDを取得
   */
  getUserId() {
    return this.currentUser?.uid;
  }

  /**
   * ユーザーメールを取得
   */
  getUserEmail() {
    return this.currentUser?.email;
  }
}
```

### 6.2.2 ユーザープロフィール初期化

```javascript
import { doc, setDoc, getDoc } from 'firebase/firestore';

class UserProfileManager {
  constructor(db, auth) {
    this.db = db;
    this.auth = auth;
  }

  /**
   * ユーザープロフィールを作成
   */
  async createUserProfile(user) {
    const userRef = doc(this.db, 'users', user.uid);
    
    // 既存プロフィールをチェック
    const existingProfile = await getDoc(userRef);
    if (existingProfile.exists()) {
      console.log('プロフィールは既に存在します');
      return existingProfile.data();
    }

    // 新しいプロフィールを作成
    const userProfile = new User(
      user.uid,
      user.email,
      user.displayName || 'User'
    );

    await setDoc(userRef, userProfile);
    console.log('ユーザープロフィールを作成しました');
    return userProfile;
  }

  /**
   * ユーザープロフィールを取得
   */
  async getUserProfile(userId) {
    const userRef = doc(this.db, 'users', userId);
    const snapshot = await getDoc(userRef);
    
    if (snapshot.exists()) {
      return snapshot.data();
    }
    return null;
  }

  /**
   * ユーザー設定を更新
   */
  async updateUserPreferences(userId, preferences) {
    const userRef = doc(this.db, 'users', userId);
    await updateDoc(userRef, {
      preferences: preferences
    });
  }
}
```

## 6.3 トリップデータの操作

### 6.3.1 トリップのCRUD操作

```javascript
import { 
  collection, 
  addDoc, 
  getDocs, 
  updateDoc, 
  deleteDoc, 
  doc,
  query,
  where 
} from 'firebase/firestore';

class TripManager {
  constructor(db, userId) {
    this.db = db;
    this.userId = userId;
    this.tripsCollection = collection(db, 'users', userId, 'trips');
  }

  /**
   * トリップを追加
   */
  async addTrip(tripData) {
    try {
      const trip = new Trip(
        tripData.title,
        tripData.location,
        tripData.description
      );

      const docRef = await addDoc(this.tripsCollection, {
        ...trip,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      console.log('トリップを追加しました:', docRef.id);
      return {
        id: docRef.id,
        ...trip
      };
    } catch (error) {
      console.error('トリップ追加エラー:', error);
      throw error;
    }
  }

  /**
   * すべてのトリップを取得
   */
  async getAllTrips() {
    try {
      const snapshot = await getDocs(this.tripsCollection);
      const trips = [];

      snapshot.forEach(doc => {
        trips.push({
          id: doc.id,
          ...doc.data()
        });
      });

      console.log(`${trips.length}個のトリップを取得しました`);
      return trips;
    } catch (error) {
      console.error('トリップ取得エラー:', error);
      throw error;
    }
  }

  /**
   * トリップを更新
   */
  async updateTrip(tripId, updates) {
    try {
      const tripRef = doc(this.tripsCollection, tripId);
      await updateDoc(tripRef, {
        ...updates,
        updatedAt: new Date()
      });

      console.log('トリップを更新しました:', tripId);
    } catch (error) {
      console.error('トリップ更新エラー:', error);
      throw error;
    }
  }

  /**
   * トリップを削除
   */
  async deleteTrip(tripId) {
    try {
      const tripRef = doc(this.tripsCollection, tripId);
      await deleteDoc(tripRef);

      console.log('トリップを削除しました:', tripId);
    } catch (error) {
      console.error('トリップ削除エラー:', error);
      throw error;
    }
  }

  /**
   * カテゴリでトリップを検索
   */
  async getTripsByCategory(category) {
    try {
      const q = query(
        this.tripsCollection,
        where('category', '==', category)
      );
      const snapshot = await getDocs(q);
      
      const trips = [];
      snapshot.forEach(doc => {
        trips.push({
          id: doc.id,
          ...doc.data()
        });
      });

      return trips;
    } catch (error) {
      console.error('検索エラー:', error);
      throw error;
    }
  }
}
```

### 6.3.2 子トリップの管理

```javascript
class ChildTripManager {
  constructor(db, userId, parentTripId) {
    this.db = db;
    this.userId = userId;
    this.parentTripId = parentTripId;
    this.childTripsCollection = collection(
      db,
      'users',
      userId,
      'trips',
      parentTripId,
      'children'
    );
  }

  /**
   * 子トリップを追加
   */
  async addChildTrip(childTripData) {
    try {
      const childTrip = new ChildTrip(
        this.parentTripId,
        childTripData.title,
        childTripData.location,
        childTripData.order || 0
      );

      const docRef = await addDoc(this.childTripsCollection, childTrip);

      return {
        id: docRef.id,
        ...childTrip
      };
    } catch (error) {
      console.error('子トリップ追加エラー:', error);
      throw error;
    }
  }

  /**
   * 親トリップのすべての子トリップを取得
   */
  async getChildTrips() {
    try {
      const snapshot = await getDocs(this.childTripsCollection);
      const childTrips = [];

      snapshot.forEach(doc => {
        childTrips.push({
          id: doc.id,
          ...doc.data()
        });
      });

      // orderフィールドでソート
      childTrips.sort((a, b) => a.order - b.order);

      return childTrips;
    } catch (error) {
      console.error('子トリップ取得エラー:', error);
      throw error;
    }
  }

  /**
   * 子トリップを更新
   */
  async updateChildTrip(childTripId, updates) {
    try {
      const childTripRef = doc(this.childTripsCollection, childTripId);
      await updateDoc(childTripRef, {
        ...updates,
        updatedAt: new Date()
      });
    } catch (error) {
      console.error('子トリップ更新エラー:', error);
      throw error;
    }
  }
}
```

## 6.4 リアルタイムデータ同期

### 6.4.1 リアルタイムリスナーの実装

```javascript
import { onSnapshot } from 'firebase/firestore';

class RealtimeTripSync {
  constructor(tripManager) {
    this.tripManager = tripManager;
    this.listeners = new Map();
  }

  /**
   * トリップの変更をリアルタイムで監視
   */
  subscribeToTrips(callback) {
    const unsubscribe = onSnapshot(
      this.tripManager.tripsCollection,
      (snapshot) => {
        const trips = [];
        const changes = {
          added: [],
          modified: [],
          removed: []
        };

        snapshot.docChanges().forEach((change) => {
          const data = {
            id: change.doc.id,
            ...change.doc.data()
          };

          if (change.type === 'added') {
            changes.added.push(data);
            console.log('新規トリップ:', data);
          } else if (change.type === 'modified') {
            changes.modified.push(data);
            console.log('更新トリップ:', data);
          } else if (change.type === 'removed') {
            changes.removed.push(data);
            console.log('削除トリップ:', data);
          }

          trips.push(data);
        });

        callback({
          allTrips: trips,
          changes: changes
        });
      },
      (error) => {
        console.error('リアルタイム同期エラー:', error);
      }
    );

    // リスナーIDを保存（後で購読を解除するため）
    const listenerId = Date.now();
    this.listeners.set(listenerId, unsubscribe);

    return listenerId;
  }

  /**
   * 特定の子トリップをリアルタイムで監視
   */
  subscribeToChildTrips(parentTripId, callback) {
    const childTripsRef = collection(
      this.tripManager.db,
      'users',
      this.tripManager.userId,
      'trips',
      parentTripId,
      'children'
    );

    const unsubscribe = onSnapshot(childTripsRef, (snapshot) => {
      const childTrips = [];

      snapshot.forEach(doc => {
        childTrips.push({
          id: doc.id,
          ...doc.data()
        });
      });

      // orderでソート
      childTrips.sort((a, b) => a.order - b.order);

      callback(childTrips);
    });

    const listenerId = Date.now();
    this.listeners.set(listenerId, unsubscribe);

    return listenerId;
  }

  /**
   * リスナーを解除
   */
  unsubscribe(listenerId) {
    const unsubscribe = this.listeners.get(listenerId);
    if (unsubscribe) {
      unsubscribe();
      this.listeners.delete(listenerId);
      console.log('リスナーを解除しました');
    }
  }

  /**
   * すべてのリスナーを解除
   */
  unsubscribeAll() {
    this.listeners.forEach(unsubscribe => unsubscribe());
    this.listeners.clear();
  }
}
```

## 6.5 セキュリティルール

### 6.5.1 本番環境のセキュリティルール

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // ユーザードキュメント
    match /users/{userId} {
      // 本人のみアクセス可能
      allow read, write: if request.auth.uid == userId;

      // トリップサブコレクション
      match /trips/{tripId} {
        allow read, write: if request.auth.uid == userId;

        // 子トリップサブコレクション
        match /children/{childTripId} {
          allow read, write: if request.auth.uid == userId;
        }
      }
    }

    // その他のアクセスは拒否
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### 6.5.2 ルール検証テスト

```javascript
/**
 * Firebaseセキュリティルールをテスト
 */
describe('Firestore Security Rules', () => {
  it('ユーザーは自分のトリップのみ読み書きできる', async () => {
    const db = firebase.firestore();
    const user1 = 'user1';
    const user2 = 'user2';

    // user1がuser2のトリップにアクセスすると失敗
    const user2Trip = db.collection('users').doc(user2)
      .collection('trips').doc('trip1');

    await expectFirebaseError(
      user2Trip.get(),
      'permission-denied'
    );
  });
});
```

## 6.6 バッチ処理とトランザクション

### 6.6.1 複数トリップを一括更新

```javascript
import { writeBatch } from 'firebase/firestore';

async function batchUpdateTrips(db, userId, updates) {
  const batch = writeBatch(db);

  updates.forEach(({ tripId, data }) => {
    const tripRef = doc(db, 'users', userId, 'trips', tripId);
    batch.update(tripRef, {
      ...data,
      updatedAt: new Date()
    });
  });

  await batch.commit();
  console.log('バッチ更新が完了しました');
}

// 使用例
await batchUpdateTrips(db, userId, [
  { tripId: 'trip1', data: { category: '観光地' } },
  { tripId: 'trip2', data: { category: 'グルメ' } }
]);
```

## 6.7 オフライン対応

### 6.7.1 オフラインの有効化

```javascript
import { enableIndexedDbPersistence } from 'firebase/firestore';

async function enableOfflineSupport(db) {
  try {
    await enableIndexedDbPersistence(db);
    console.log('オフラインサポートが有効化されました');
  } catch (err) {
    if (err.code === 'failed-precondition') {
      console.log('複数のタブで使用されています');
    } else if (err.code === 'unimplemented') {
      console.log('このブラウザではサポートされていません');
    }
  }
}
```

---

**次章へ**: 第7章では、パフォーマンス最適化と応用機能を学びます。
