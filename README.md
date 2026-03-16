# Air — 地図と写真でエア旅行

GPS付き写真をアップロードすると撮影場所を地図上に表示し、スライドショーで楽しめるWebアプリ。Google ログインで Firestore にトリップを保存・共有。

**URL**: https://air.ktrips.net

## 機能

- **写真×地図**: EXIF GPS から座標を取得し、地図上にマーカー表示
- **スライドショー**: 1/3/5秒間隔で写真を自動切り替え、地図を追従
- **GPX連携**: ルートファイルを地図に重ね表示
- **トリップ管理**: 複数トリップを Firestore に保存・編集・公開
- **Google ログイン**: 自分のトリップのみ編集可能。公開トリップは閲覧のみ可能
- **AI旅行記生成**: 写真・説明・URL・動画・GPS情報から旅行記を自動生成（Gemini / OpenAI / Anthropic）
- **AIアニメ生成**: 生成したAI旅行記を元にスタイルを適用し、Nano Banana Pro2で画像を生成したスライドショー（8スタイル）

## セットアップ

### 1. Firebase プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com/) でプロジェクトを作成
2. **Authentication** → サインイン方法で **Google** を有効化
3. **Firestore Database** → 作成（ネイティブモード・asia-northeast1）
4. **Storage** → 作成（Firestore と同じリージョン推奨）
5. **Firestore のルール** を `firestore.rules`、**Storage のルール** を `storage.rules` でデプロイ

### 2. 設定ファイル

```bash
cp firebase-config.example.js firebase-config.js
# firebase-config.js に Firebase Console の値を入力
```

### 3. ローカル起動

```bash
python3 -m http.server 8080
# ブラウザで http://localhost:8080
```

### 4. デプロイ（Firebase Hosting）

```bash
firebase login
firebase use --add  # プロジェクトを選択
firebase deploy
```

### 5. カスタムドメイン（air.ktrips.net）

Firebase Hosting の設定でカスタムドメインを追加し、DNS を設定。

### 6. Googleログインが「このアプリのリクエストは無効です」になる場合

本番URLからログインする際にエラーが出る場合は、`GOOGLE_LOGIN_SETUP.md` を参照し、Google Cloud Console で OAuth の認可済みドメインを追加してください。

### 7. AI機能を使う場合（オプション）

ログイン後、メニュー → AI設定 で以下を設定：

- **AIプロバイダー**: Google Gemini / OpenAI / Anthropic から選択（旅行記生成用）
- **API キー**: 選択したプロバイダーのAPIキーを入力（旅行記生成用）
- **画像生成用（Nano Banana Pro2）**: AIアニメ生成用。defapi.org のAPIキーを入力

1. AI旅行記生成で旅行記を作成 → 2. スタイルを選択してAIアニメ生成で画像スライドショーを生成

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フロントエンド | HTML5, CSS3, JavaScript（ビルド不要） |
| 地図 | Leaflet 1.9.4 |
| EXIF/GPS | exifr |
| 認証・DB | Firebase Auth (Google), Firestore, Storage |

## 注意事項

- **写真**: Firebase Storage に保存。Firestore には URL のみ保存するため、1MB制限の影響を受けにくい
- **GPS情報**: スマートフォンで位置情報をオンにして撮影した写真を推奨
- **AI API キー**: Firestore の `users` コレクションにユーザーごとに保存。共有環境では使用しないこと
