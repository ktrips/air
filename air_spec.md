# Airの包括的仕様書

## 1. 概要

### 1.1 製品概要

**Air** は、GPS付き写真をアップロードすると撮影場所を地図上に表示し、自動で地図を動かしながら写真をスライドショーするWebアプリケーションである。「地図と写真でエア旅行した気分になる」をコンセプトに、旅行記・サイクリング記録・フォトアルバムの作成・閲覧・共有を支援する。

### 1.2 主な特徴

| 特徴 | 説明 |
|------|------|
| **写真×地図** | EXIF GPSから座標を取得し、地図上にマーカー表示 |
| **スライドショー** | 1/3/5秒間隔で写真を自動切り替え、地図を追従 |
| **GPX連携** | ルートファイルを重ね表示、ルート順に写真をソート |
| **トリップ管理** | 複数トリップを保存・編集・公開 |
| **Firebase連携** | Googleログインによりその人だけのトリップを保存。公開にすると全ての人に見れる。トリップ、写真、GPX等は全てFirestoreに保存され、ローカルでもインターネットからも常に同じ情報が見れる。|
| **AI旅行記** | 写真・説明・URL・動画・GPSから旅行記を自動生成（Gemini/OpenAI/Anthropic） |
| **AIアニメ** | 写真を表紙風に変換したスライドショー（8スタイル対応） |

### 1.3 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フロントエンド | HTML5, CSS3, JavaScript（ビルド不要） |
| 地図 | Leaflet 1.9.4 |
| EXIF/GPS | exifr |
| 認証・DB | Firebase Auth, Firestore（オプション） |
| フォント | DM Sans（Google Fonts） |

---

## 2. システム構成

### 2.1 アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                        ブラウザ                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  index.html │  │   app.js    │  │     style.css        │ │
│  │  (UI構造)   │  │ (ロジック)   │  │   (スタイル)          │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│         │                  │                                │
│         └──────────────────┼─────────────────────────────
```

---

## 3. データモデル

### 3.1 Trip（トリップ）

| フィールド | 型 | 説明 |
|------------|-----|------|
| `id` | string | 一意識別子（例: `trip_1700000000000`） |
| `name` | string | トリップ名 |
| `description` | string \| null | 説明文 |
| `url` | string \| null | ブログURL |
| `videoUrl` | string \| null | 動画URL |
| `public` | boolean | 公開フラグ（ログインなし閲覧可） |
| `color` | string | ルート・マーカー色（例: `#e1306c`） |
| `createdAt` | number | 作成日時（Unix ms） |
| `updatedAt` | number | 更新日時（Unix ms） |
| `parentId` | string \| null | 親トリップID（子トリップの場合） |
| `date` | string \| null | datetime-local値（GPSなし時の並び順） |
| `photos` | Photo[] | 写真配列 |
| `gpxData` | string \| null | GPX XML文字列 |
| `travelogueHtml` | string \| null | 旅行記HTML |
| `animeList` | Array \| null | 旅行アニメデータ |
| `stampPhotos` | Object \| null | スタンプ写真 |
| `thumbnail` | Object \| null | サムネイル |
| `userId` | string | Firestore用（所有者UID） |

### 3.2 Photo（写真）

| フィールド | 型 | 説明 |
|------------|-----|------|
| `url` | string | 表示用URL（Firebase Storage の downloadURL、または従来の data:） |
| `mime` | string | MIMEタイプ（例: image/jpeg） |
| `lat` | number \| null | 緯度 |
| `lng` | number \| null | 経度 |
| `name` | string | ファイル名・表示名 |
| `placeName` | string | 逆ジオコーディング地名 |
| `description` | string | 説明文 |
| `landmarkNo` | string | ランドマーク番号（地図表示用） |
| `landmarkName` | string | ランドマーク名 |
| `date` | Date | 撮影日時 |
| `gpxData` | Object | GPX連携データ（speed, temp, ele, hr） |

---

## 4. 機能仕様

### 4.1 写真・地図

#### 4.1.1 写真アップロード

- **方式**: ドラッグ＆ドロップ、またはファイル選択
- **対応形式**: JPG/JPEG/PNG等（`image/*`）
- **処理フロー**: `handleFiles()` → `loadPhotoWithExif()` → EXIF解析 → GPS座標から地名（`placeName`）を自動取得
- **EXIF取得**: exifr で `latitude`, `longitude`, `DateTimeOriginal` を取得、DMS→十進度変換

#### 4.1.3 地図表示

- **ライブラリ**: Leaflet 1.9.4
- **レイヤー**:
  - OpenStreetMap（標準）
  - Esri 航空写真
  - ハイブリッド（ラベル）
- **マーカー**: 写真位置、ランドマーク番号表示、トリップ色で区別
  - **マーカー表示最適化**: トリップ選択時に最初と最後の写真マーカーのみ表示してビジュアルノイズを削減
  - **ビデオマーカー**: 動画URLを持つポイントはサムネイル画像と再生ボタンアイコンを表示（モバイル: 40x40px, デスクトップ: 56x56px）
- **デフォルト**: 中心（日本）、ズームレベル適宜

#### 4.1.4 地名検索

- **入力**: `mapSearchInput`
- **API**: Nominatim search
- **動作**: 検索結果クリックで地図を該当座標に移動

### 4.2 GPX

#### 4.2.1 ルート表示

- **形式**: GPX 1.0/1.1
- **要素**: `trkpt`, `rtept`, `wpt` から `[lat, lon]` を抽出
- **表示**: Leaflet Polyline で地図に重ね描画

#### 4.2.2 GPX順ソート

- **関数**: `sortPhotosByGpxOrder()`
- **ロジック**: 各写真の座標をGPXルート上の最近傍点にマッピングし、ルート順に並べ替え

#### 4.2.3 拡張データ

- **対応**: `extensions` 内の `speed`, `temp`, `ele`, `hr` 等
- **表示**: 再生オーバーレイに速度・標高・気温・心拍数を表示

### 4.3 トリップ管理

#### 4.3.1 親子トリップ

- **親トリップ**: 写真・GPS不要のフォルダ。子トリップをまとめる
- **子トリップ**: `parentId` で親を指定
- **一覧**: 親のみデフォルト表示、クリックで子を展開
- **URLパラメータ指定**: `?trip=親トリップ名` で直接親トリップを指定・表示
  - 完全一致・部分一致の両方で検索
  - 指定時は親トリップのみ表示（子トリップは表示されない）
  - 地図には親トリップのマーカー・ルートのみ表示
  - 例: `?trip=しまなみ街道と四国お遍路旅`

#### 4.3.2 トリップカラー

- **12色**: ピンク〜濃い紫のレインボー順
- **用途**: 地図マーカー・ルート線の色分け

#### 4.3.3 保存・読み込み

- **保存**: Firestoreに保存
- **キャッシュ**: `_mergedTripsCache` で無駄な再取得を防止

### 4.4 再生（スライドショー）

- **間隔**: 3秒
- **流れ**: `startPlay()` → `playTimer` で `showPhotoWithPopup()` を繰り返し
- **オーバーレイ**: 写真、GPXデータ、説明、URL、地名を表示
- **地図**: 写真の座標に地図を自動移動

### 4.5 公開・共有

- **公開フラグ**: `tripPublicInput` で「公開する」にチェック
- **閲覧**: ログイン不要で誰でも閲覧可能

---

## 5. AI機能

### 5.1 AI設定

- **プロバイダー選択**: Google Gemini / OpenAI / Anthropic（旅行記生成用）
- **API キー**: 選択したプロバイダーのキーを1つ入力（旅行記生成用）
- **画像生成用（Nano Banana Pro2）**: AIアニメ生成で使用。defapi.org の API キーを入力
- **保存先**: Firestore `users/{userId}` に `aiProvider`, `aiApiKey`, `aiImageApiKey` をユーザーごとに保存

### 5.2 旅行記生成

- **関数**: `generateTravelogueWithAI()` → `fetchWikipediaForPlace()`
- **入力**: トリップ名・説明・URL・動画URL、写真情報（順番・地名・説明・URL）、GPXメタ
- **Wikipedia**: 各写真の座標または地名でja.wikipedia.orgを検索し、詳しい情報を取得
- **出力**: HTML形式の日本語旅行記。写真は`<img>`で差し込み、`知っ得情報：`としてWikipediaの内容を含む。冒頭に全体感の地図を表示
- **モデル（リーズナブル）**:

| プロバイダー | モデル |
|-------------|--------|
| Google Gemini | gemini-2.5-flash |
| OpenAI | gpt-3.5-turbo |
| Anthropic | claude-3-haiku-20240307 |

### 5.3 旅行アニメ生成

- **関数**: `showAnimeModal()` → `parseTravelogueSections()` → `generateImageWithNanoBananaPro2()`
- **入力**: 生成済みAI旅行記（`travelogueHtml`）をパースしてセクション（h3/p）ごとに画像生成。旅行記の内容を主な参照として表紙画像を作成
- **スタイル**: 地球の歩き方表紙風、地球の歩き方おすすめスポット風、少年ジャンプの表紙風、旅行雑誌の表紙風、個別ページ1/4〜4/4
- **モデル**: Nano Banana Pro2（`google/nano-banana-2`、defapi.org）※画像生成用APIキー必須
- **表示**: 4秒間隔で自動再生、再生/停止ボタンで制御

---

## 6. Firebase連携

### 6.1 認証

- **プロバイダー**: Google のみ
- **方式**: ポップアップ（デスクトップ）、リダイレクト（モバイル）
- **カスタムドメイン**: `air.ktrips.net` のとき `authDomain` を同一ホストに設定（iOS Safari 対策）

### 6.2 Firestore

- **コレクション**: `trips`, `users`
- **trips クエリ**:
  - 自分のトリップ: `userId == uid`
  - 公開トリップ: `public == true`
- **users**: `users/{userId}` に `tripOrder`, `aiProvider`, `aiApiKey`, `aiImageApiKey` を保存
- **ルール**: 作成・更新・削除は `resource.userId == auth.uid` を要する（trips）。users は `auth.uid == userId` で読み書き

### 6.4 設定

- **ファイル**: `firebase-config.js`（`firebase-config.example.js` をコピーして編集）
- **必須項目**: `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`

---

## 7. UI仕様

### 7.1 レイアウト

| 領域 | 説明 |
|------|------|
| **ヘッダー** | トリップ名、再生・前後・旅行記・動画ボタン（ログイン時は編集用メニュー表示） |
| **メニュー** | 右スライド。ログイン、トリップ管理、AI生成、写真・GPXアップロード、ヘルプ |
| **AI生成** | AI生成＋AI設定、AI旅行記生成、スタイル＋AIアニメ生成（ログイン時のみ） |
| **メイン** | 地図コンテナ、検索ボックス、動画オーバーレイ |
| **トリップパネル** | 右側。トリップ一覧 |
| **サムネイルストリップ** | 下部。写真サムネイル |

### 7.2 モーダル

| ID | 用途 |
|----|------|
| `helpModal` | ヘルプ（使い方） |
| `blogModal` | ブログURL表示（iframe） |
| `animeModal` | 旅行アニメ（表紙風スライドショー） |
| `travelogueModal` | 旅行記表示 |
| `aiSettingsModal` | AI設定（プロバイダー・APIキー） |

### 7.3 レスポンシブ

- **ブレークポイント**: 768px（`isMobileView()`）
- **モバイル**: ヘッダー表示、コンパクトナビ、ピンチでパネル展開、URLはモーダル内 iframe
- **デスクトップ**: ヘッダー非表示、URLはポップアップ

---

## 8. ユーザーフロー

### 8.1 閲覧（ログイン不要）

1. アプリ起動
2. 公開トリップパネルからトリップを選択
3. 写真サムネイルクリックで拡大、地図マーカー表示
4. 「▶ 再生」「前へ」「次へ」でスライドショー

### 8.2 編集（ログイン必要）

1. メニュー → 「ログイン」で Google 認証
2. 写真アップロード（ドラッグ＆ドロップ or ファイル選択）
3. （任意）GPX アップロード
4. トリップ名・説明・URL・動画URL 入力、「保存」
5. 「公開する」にチェックで公開トリップに

### 8.3 AI機能（ログイン必要）

1. メニュー → AI設定 でプロバイダー（Gemini/OpenAI/Anthropic）とAPIキーを設定
2. **AI旅行記生成**: トリップ選択後、メニュー → AI旅行記生成 で生成。ヘッダーの「旅行記」ボタンで表示
3. **AIアニメ生成**: スタイルを選択し、AIアニメ生成 で表紙風スライドショーを生成

---

## 9. デプロイ・運用

### 9.1 デプロイ先

- **Cloud Run**: https://air.ktrips.net
- **Firebase Hosting**: プロジェクト airgo-trip

### 9.2 必要な GitHub Secrets

| Secret | 用途 |
|--------|------|
| `GCP_PROJECT_ID` | Cloud Run デプロイ |
| `GCP_SA_KEY` | Cloud Run デプロイ |
| `FIREBASE_CONFIG_JS` | 本番用 firebase-config.js |
| `FIREBASE_SERVICE_ACCOUNT_AIRGO_TRIP` | Firebase Hosting デプロイ |

### 9.3 起動方法

```bash
# ローカル開発
python3 -m http.server 8080
# ブラウザで http://localhost:8080
```

---

## 10. Firebase Storage設定

### 10.1 CORS設定

Firebase Storage からの画像・GPXファイル読み込みを有効にするには、CORS (Cross-Origin Resource Sharing) を設定する必要があります。

**設定内容** (`cors.json`)：
```json
[
  {
    "origin": [
      "https://air.ktrips.net",
      "https://ohenro.ktrips.net",
      "http://localhost:*",
      "https://localhost:*"
    ],
    "method": ["GET", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Accept-Ranges", "Content-Length"],
    "maxAgeSeconds": 3600
  }
]
```

**設定方法**：
```bash
gcloud storage buckets cors set ./cors.json gs://airgo-trip.appspot.com
```

---

## 11. 制限・注意事項

- **GPS情報**: スマートフォンで「位置情報をオン」にして撮影した写真を推奨
- **ファイル読み込み**: 一部ブラウザで `index.html` 直接開きに制限がある場合はローカルサーバーを推奨
- **AI API Key**: Firestore `users` にユーザーごとに保存。共有環境では使用しないこと
- **Firestore**: ネイティブモード・asia-northeast1 で作成すること
- **Firebase Storage CORS**: 画像やGPXファイルが読み込めない場合、上記CORS設定を確認すること

---

## 付録 A: 主要関数一覧

| 関数 | 用途 |
|------|------|
| `initMap()` | Leaflet 地図初期化 |
| `initMapSearch()` | 地名検索初期化 |
| `updateMapMarkers()` | 地図マーカー更新（フォルタリング・表示制御含む） |
| `getTripsForDisplay()` | 表示用トリップをフィルタリング（URLパラメータ・リージョン対応） |
| `handleFiles(files)` | 写真アップロード処理 |
| `parseGpx(xml)` | GPX パース |
| `saveTrip(opts)` | トリップ保存（UI連携） |
| `loadTripById(id)` | トリップ読み込み |
| `generateTravelogueWithAI()` | AI 旅行記生成（写真差し込み・Wikipedia情報含む） |
| `fetchWikipediaForPlace(lat, lng, placeName)` | Wikipediaから場所の詳しい情報を取得 |
| `showAnimeModal()` | AI アニメ生成・表示（旅行記ベース、Nano Banana Pro2） |
| `parseTravelogueSections(html)` | 旅行記HTMLをh3/pセクションにパース |
| `generateImageWithNanoBananaPro2(prompt, cfg)` | テキスト→画像（Nano Banana Pro2） |
| `generateImageWithAI(prompt, imageUrl, cfg)` | 画像生成（他用途・プロバイダー別） |
| `loadUserAiConfig()` | AI設定読み込み |
| `saveUserAiConfig(cfg)` | AI設定保存 |

---

## 付録 B: 用語集

| 用語 | 説明 |
|------|------|
| **トリップ** | 写真・GPX・メタデータのまとまり。1つの旅行・ルートに対応 |
| **公開トリップ** | ログインなしで閲覧可能なトリップ |
| **親トリップ** | 子トリップをまとめるフォルダ。写真・GPS不要 |
| **子トリップ** | 親に紐づくトリップ |
| **スタンプ** | 写真に付与するラベル（例: スタート、ゴール） |
| **スタンプラリー** | ランドマークにしたポイントを一覧表示。写真が付いていればスタンプ済みとして表示 |
| **旅行記** | AI で生成するHTML形式のテキスト。トリップに保存 |
| **旅行アニメ** | 写真をアニメ風に変換した画像 |

