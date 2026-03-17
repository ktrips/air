# Firebase セットアップ手順

エラーを解決するための手順です。

## 問題の原因

1. **CORS エラー**: Firebase Storage へのローカル開発環境からのアクセスがブロックされています
2. **Firestore 権限エラー**: セキュリティルールの問題
3. **ネットワークエラー**: 接続テストが失敗

## 解決手順

### 1. Firebase Storage の CORS 設定

ターミナルで以下を実行してください：

```bash
# プロジェクトディレクトリに移動
cd /Users/kenichi.yoshida/Git/air

# Google Cloud SDK がインストールされていない場合はインストール
# https://cloud.google.com/sdk/docs/install

# CORS 設定を適用
gsutil cors set cors.json gs://airgo-trip.appspot.com
```

**Google Cloud SDK のインストール（必要な場合）**:
```bash
# Homebrew でインストール
brew install --cask google-cloud-sdk

# インストール後、初期化
gcloud init
```

### 2. Firestore セキュリティルールのデプロイ

```bash
# Firebase CLI がインストールされていない場合
npm install -g firebase-tools

# Firebase にログイン
firebase login

# セキュリティルールをデプロイ
firebase deploy --only firestore:rules

# Storage のルールもデプロイ
firebase deploy --only storage
```

### 3. Firebase Console での確認

ブラウザで Firebase Console を開いて確認：
https://console.firebase.google.com/project/airgo-trip

#### Firestore のインデックス作成
1. 左メニューから「Firestore Database」を選択
2. 「インデックス」タブをクリック
3. 必要なインデックスが自動的に作成されているか確認
4. エラーログにインデックス作成のリンクがある場合はクリック

#### Storage の確認
1. 左メニューから「Storage」を選択
2. 「ルール」タブで現在のルールを確認
3. CORS 設定が反映されているか確認

### 4. ローカルサーバーの再起動

```bash
# Ctrl+C でサーバーを停止してから再起動
python3 -m http.server 8080
```

ブラウザで `http://localhost:8080` を開き、Ctrl+Shift+R で強制リロード

### 5. 動作確認

ブラウザのコンソール（F12）を開いて以下を実行：

```javascript
checkFirebaseStatus()
```

すべてのステータスが ✓ になっているか確認してください。

## トラブルシューティング

### CORS エラーが解決しない場合

Firebase Console で手動設定：
1. https://console.cloud.google.com/storage/browser
2. `airgo-trip.appspot.com` バケットを選択
3. 「権限」タブ → 「CORS 構成」を編集
4. 以下を設定：
```json
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD", "PUT", "POST", "DELETE"],
    "maxAgeSeconds": 3600
  }
]
```

### Firestore 権限エラーが解決しない場合

開発中は一時的にルールを緩和：
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;  // 開発中のみ！本番環境では使用禁止
    }
  }
}
```

**注意**: 開発完了後は必ず適切なセキュリティルールに戻してください。

## 確認コマンド

```bash
# CORS 設定の確認
gsutil cors get gs://airgo-trip.appspot.com

# Firebase プロジェクトの確認
firebase projects:list

# 現在のルールを確認
firebase firestore:rules:list
```

## 参考リンク

- Firebase Storage CORS: https://firebase.google.com/docs/storage/web/download-files#cors_configuration
- Firestore セキュリティルール: https://firebase.google.com/docs/firestore/security/get-started
- Google Cloud SDK: https://cloud.google.com/sdk/docs/install
