# Firebase Storage CORS 設定手順

## エラー症状
```
Access to fetch at 'https://firebasestorage.googleapis.com/...'
from origin 'http://127.0.0.1:8080' has been blocked by CORS policy
```

このエラーは Firebase Storage へのアクセスが CORS によりブロックされています。**アニメ画像の表示**や **GPX ファイルの読み込み**が失敗する原因になります。

## クイック修正（推奨）

```bash
cd /path/to/air   # プロジェクトフォルダに移動
./setup-cors.sh
```

`setup-cors.sh` が `firebasestorage.app` と `appspot.com` の両方のバケットに CORS を設定します。成功後、ブラウザのキャッシュをクリアしてページを再読み込みしてください。

## 解決方法（手動）

### 方法1: gsutil コマンドを使用（推奨）

#### 1. Google Cloud SDK のインストール

**macOS の場合:**
```bash
# Homebrew でインストール
brew install --cask google-cloud-sdk

# インストール後、初期化
gcloud init
```

**その他の OS:**
https://cloud.google.com/sdk/docs/install からダウンロード

#### 2. Firebase プロジェクトにログイン

```bash
# Google アカウントでログイン
gcloud auth login

# プロジェクト ID を設定
gcloud config set project airgo-trip
```

#### 3. CORS 設定を適用

```bash
# プロジェクトディレクトリに移動
cd /Users/kenichi.yoshida/Git/air

# CORS 設定を適用
gsutil cors set cors.json gs://airgo-trip.firebasestorage.app
```

#### 4. 設定を確認

```bash
# CORS 設定が適用されたか確認
gsutil cors get gs://airgo-trip.firebasestorage.app
```

以下のような出力が表示されれば成功です：
```json
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD", "PUT", "POST", "DELETE"],
    "maxAgeSeconds": 3600
  }
]
```

### 方法2: Firebase Console から手動設定

1. Google Cloud Console を開く
   https://console.cloud.google.com/storage/browser

2. `airgo-trip.firebasestorage.app` バケットを選択

3. 「構成」タブを開く

4. 「CORS」セクションで編集ボタンをクリック

5. 以下の JSON を追加：
```json
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD", "PUT", "POST", "DELETE"],
    "maxAgeSeconds": 3600
  }
]
```

6. 保存

### 方法3: Firebase CLI を使用

```bash
# Firebase CLI がインストールされていない場合
npm install -g firebase-tools

# Firebase にログイン
firebase login

# プロジェクトディレクトリに移動
cd /Users/kenichi.yoshida/Git/air

# Storage のルールとともに CORS を設定
firebase deploy --only storage
```

**注意**: この方法では `firebase.json` に storage の設定が必要です。

## 設定後の確認

### 1. ブラウザのキャッシュをクリア
- Chrome: Cmd+Shift+Delete (Mac) / Ctrl+Shift+Delete (Windows)
- 「キャッシュされた画像とファイル」をチェックして削除

### 2. ページを強制リロード
- Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows)

### 3. コンソールでエラーを確認
- F12 を押してデベロッパーツールを開く
- Console タブで CORS エラーが消えているか確認

## トラブルシューティング

### エラー: "You do not have permission to access this bucket"

**原因**: Google Cloud のアクセス権限がない

**解決策**:
1. Firebase Console にログイン
2. プロジェクト設定 → ユーザーと権限
3. 自分のアカウントに「編集者」または「オーナー」権限があるか確認

### エラー: "gsutil: command not found"

**原因**: Google Cloud SDK がインストールされていない

**解決策**:
上記の「方法1」に従って Google Cloud SDK をインストール

### CORS 設定が反映されない

**原因**: ブラウザのキャッシュが残っている

**解決策**:
1. ブラウザのキャッシュを完全にクリア
2. プライベートウィンドウで開く
3. 別のブラウザで試す

### それでもエラーが出る場合

**一時的な回避策**: 開発中は Firestore にGPXデータを直接保存する
```javascript
// GPX ファイルをアップロードせず、データを直接保存
// app.js の該当部分で gpxData を使用
```

## 本番環境での設定

本番環境（https://air.ktrips.net）では、より厳格な CORS 設定を推奨：

```json
[
  {
    "origin": ["https://air.ktrips.net"],
    "method": ["GET", "HEAD"],
    "maxAgeSeconds": 3600
  }
]
```

## 参考リンク

- Firebase Storage CORS: https://firebase.google.com/docs/storage/web/download-files#cors_configuration
- Google Cloud SDK: https://cloud.google.com/sdk/docs/install
- gsutil CORS 設定: https://cloud.google.com/storage/docs/configuring-cors
