# 第2章: 環境セットアップ

## 2.1 Google Cloud Projectの作成

Google Maps APIを使用するために、Google Cloud Platformでプロジェクトを作成します。

### ステップ1: GCPコンソールにアクセス
1. [Google Cloud Console](https://console.cloud.google.com/)にアクセス
2. Google アカウントでログイン（まだの場合は作成）
3. 「プロジェクトを作成」をクリック

### ステップ2: プロジェクト情報を入力
```
プロジェクト名: AIR Map Application
```

### ステップ3: 必要なAPIを有効化
作成したプロジェクトで、以下のAPIを有効化します：

1. **Google Maps JavaScript API**
   - APIライブラリから検索
   - 「有効にする」をクリック

2. **Geolocation API**
   - ユーザーの現在位置取得に必要

3. **Maps Static API**
   - 静的地図の生成に使用（オプション）

### ステップ4: APIキーの生成
```
1. 左のメニューから「認証情報」を選択
2. 「+認証情報を作成」 → 「APIキー」
3. キーが生成され、コンソールに表示されます
4. このキーを安全に保管してください
```

**注意**: APIキーは公開されないようにしてください。本番環境では制限を設定します。

## 2.2 Claude APIの設定

### ステップ1: Anthropicアカウント作成
1. [Anthropic Console](https://console.anthropic.com/)にアクセス
2. アカウント登録（メール認証が必要）
3. 課金情報を設定（無料クレジットで試行可能）

### ステップ2: APIキー生成
```
1. ダッシュボードから「API Keys」を選択
2. 「Create Key」ボタンをクリック
3. キー名を入力（例: "AIR Development"）
4. キーをコピーして保管
```

### ステップ3: レート制限の確認
無料アカウントでのレート制限を確認します：
- リクエスト数: 分単位での制限
- 月額上限: $5のクレジット

本番環境では有料プランへの切り替えが必要になる可能性があります。

## 2.3 Firebaseプロジェクトの作成

### ステップ1: Firebase Consoleへアクセス
1. [Firebase Console](https://console.firebase.google.com/)にアクセス
2. Googleアカウントでログイン
3. 「プロジェクトを追加」をクリック

### ステップ2: プロジェクト設定
```
プロジェクト名: AIR
リージョン: asia-northeast1（日本）
分析有効: OFF（初期設定時）
```

### ステップ3: Google Analytics（オプション）
本書では使用しないため、無効のままで問題ありません。

### ステップ4: Firestoreの初期化
プロジェクト作成後：
```
1. 「Firestore Database」を選択
2. 「データベースを作成」をクリック
3. 本番モードで開始
4. ロケーション: asia-northeast1
```

### ステップ5: セキュリティルールの設定
初期段階ではテスト用ルールを設定：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## 2.4 Google Authenticationの設定

### ステップ1: Firebaseで認証を有効化
```
1. Firebase Consoleで「Authentication」を選択
2. 「Sign-in method」タブを開く
3. 「Google」プロバイダを選択
4. 有効にしてから「保存」
```

### ステップ2: OAuth同意画面の設定
```
1. GCP Consoleに戻る
2. 「OAuth consent screen」を選択
3. ユーザータイプ: 外部
4. 必要な情報を入力（アプリ名など）
```

## 2.5 ローカル開発環境のセットアップ

### ステップ1: Nodeとnpmのインストール

macOSの場合（Homebrewを使用）:
```bash
brew install node
node --version  # v16以上であることを確認
npm --version
```

### ステップ2: プロジェクトディレクトリの作成
```bash
mkdir air-app
cd air-app
npm init -y
```

### ステップ3: 必要なパッケージのインストール
```bash
# Firebase SDK
npm install firebase

# Anthropic Claude SDK
npm install @anthropic-ai/sdk

# 開発用サーバー（オプション）
npm install -D http-server
```

### ステップ4: package.jsonの更新
```json
{
  "name": "air-app",
  "version": "1.0.0",
  "scripts": {
    "start": "http-server -p 8000 -o",
    "dev": "http-server -p 8000"
  },
  "dependencies": {
    "firebase": "^9.0.0",
    "@anthropic-ai/sdk": "^1.0.0"
  }
}
```

## 2.6 環境変数の設定

プロジェクトルートに`.env.example`ファイルを作成：

```env
# Google API
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here

# Claude API
CLAUDE_API_KEY=your_claude_api_key_here

# Firebase
FIREBASE_API_KEY=your_firebase_api_key
FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_STORAGE_BUCKET=your_project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=your_sender_id
FIREBASE_APP_ID=your_app_id
```

実開発用に`.env`ファイルを作成（**.gitignoreに追加**）：

```bash
cp .env.example .env
# エディタで.envを開き、実際の値を入力
```

## 2.7 Firebase CLI（オプション）の設定

デプロイ時に便利なFirebase CLIをインストール：

```bash
npm install -g firebase-tools
firebase login
firebase init
```

### 初期化時の選択
```
? Which Firebase features do you want to set up for this directory?
  → Hosting
  → Firestore Rules
  → Firestore Indexes

? Which file should be used for Hosting?
  → index.html

? Single-page app (rewrite all urls to /index.html)?
  → No（静的HTMLの場合）
  → Yes（SPAの場合）
```

## 2.8 動作確認

### ステップ1: HTMLファイルの作成
プロジェクトルートに`index.html`を作成：

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AIR - Trip Management App</title>
</head>
<body>
    <h1>AIR - Trip Management Application</h1>
    <div id="map" style="width: 100%; height: 400px;"></div>
    <script src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY"></script>
    <script src="app.js"></script>
</body>
</html>
```

### ステップ2: ローカルサーバーの起動
```bash
npm start
# またはhttp-serverを直接実行
http-server -p 8000
```

### ステップ3: ブラウザで確認
```
http://localhost:8000
```

ページが読み込まれれば、セットアップは成功です。

## 2.9 トラブルシューティング

### APIキーが機能しない場合
```
1. キーにアクセス制限が設定されていないか確認
2. 対象のAPIが有効化されているか確認
3. キーをコピー時に空白が含まれていないか確認
```

### Firebase接続エラー
```
1. プロジェクトIDが正確に入力されているか確認
2. Firestoreが初期化されているか確認
3. セキュリティルールが正しく設定されているか確認
```

### CLIツールのインストール失敗
```bash
# npmをアップデート
npm install -g npm@latest

# または yarn を使用
npm install -g yarn
yarn install
```

---

**次章へ**: 第3章では、Google Maps APIの基本的な概念と実装方法を学びます。
