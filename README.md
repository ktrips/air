# Air — 地図と写真でエア旅行

GPS付き写真をアップロードすると撮影場所を地図上に表示し、スライドショーで楽しめるWebアプリ。Google ログインで Firestore にトリップを保存・共有。

**URL**: https://air.ktrips.net

## 機能

### 基本機能
- **写真×地図**: EXIF GPS から座標を取得し、地図上にマーカー表示
- **スライドショー**: 1/3/5秒間隔で写真を自動切り替え、地図を追従
- **GPX連携**: ルートファイルを地図に重ね表示
- **トリップ管理**: 複数トリップを Firestore に保存・編集・公開
- **親子トリップ**: フォルダ構造で複数のトリップを整理
- **3つの地図レイヤー**: 地図・地形・航空写真を切り替え可能

### 閲覧機能
- **ログインなしで閲覧**: 公開トリップはログインなしで閲覧可能
- **トリップ所在フィルタ**: 日本のトリップのみ / グローバルのトリップのみを表示（ログイン時は選択リストで切り替え）
- **動画再生**: トリップに動画URLを追加して地図上で再生
- **旅行記表示**: AI生成された旅行記を御朱印帳風に表示
- **スタンプラリー**: ランドマークを巡るスタンプラリー機能
- **親トリップのインライン表示**: 親トリップ選択時、子トリップのアニメサムネイルをトリップ名・📖旅行記・🎬動画ボタンとともにインライン表示

### 編集機能（ログイン必要）
- **Google ログイン**: 自分のトリップのみ編集可能
- **写真アップロード**: ドラッグ&ドロップで複数枚一括アップロード
- **ポイント編集**: 写真の位置、名前、説明を編集
- **写真削除**: 写真のみ削除/ポイントごと削除の2モード
- **ルートカラー**: 12色からトリップカラーを選択

### AI機能（オプション）
- **AI旅行記生成**: 写真・説明・URL・動画・GPS情報から旅行記を自動生成（Gemini / OpenAI / Anthropic）
- **AIアニメ生成**: 生成したAI旅行記を元にスタイルを適用し、Nano Banana Pro2で画像を生成（8スタイル）

## セットアップ

### 1. Firebase プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com/) でプロジェクトを作成
2. **Authentication** → サインイン方法で **Google** を有効化
   - 承認済みドメインに本番URL（例: air.ktrips.net）を追加
3. **Firestore Database** → 作成（ネイティブモード・asia-northeast1）
4. **Storage** → 作成（Firestore と同じリージョン推奨）
5. **Firestore のルール** を `firestore.rules`、**Storage のルール** を `storage.rules` でデプロイ

### 2. ローカル開発

#### 2-1. Firebase設定ファイルを作成

```bash
cp firebase-config.example.js firebase-config.js
```

#### 2-2. Firebase Console から設定値を取得

1. [Firebase Console](https://console.firebase.google.com/) → プロジェクト設定 → 全般
2. 「マイアプリ」セクションの構成をコピー
3. `firebase-config.js` に貼り付け

#### 2-3. ローカルサーバーで起動

```bash
python3 -m http.server 8080
# ブラウザで http://localhost:8080
```

**注意**: `firebase-config.js` は `.gitignore` に含まれており、GitHubにはコミットされません。

### 3. 本番デプロイ（GitHub Actions）

#### 3-1. GitHub Secretsの設定

1. GitHubリポジトリ → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret** で以下を追加:

**FIREBASE_SERVICE_ACCOUNT**
- Firebase Console → プロジェクト設定 → サービスアカウント → 「新しい秘密鍵を生成」
- ダウンロードしたJSONファイルの内容をそのまま貼り付け

**FIREBASE_CONFIG**（JSON形式、改行なし、1行で入力）:
```json
{"apiKey":"YOUR_API_KEY","authDomain":"YOUR_PROJECT.firebaseapp.com","projectId":"YOUR_PROJECT","storageBucket":"YOUR_PROJECT.appspot.com","messagingSenderId":"YOUR_ID","appId":"YOUR_APP_ID","measurementId":"YOUR_MEASUREMENT_ID"}
```

#### 3-2. 自動デプロイ

`main` ブランチにプッシュすると、GitHub Actionsが自動的に以下を実行:
1. `firebase-config.js` を GitHub Secrets から生成
2. Firebase Hosting にデプロイ
3. Firestore Rules と Storage Rules を更新

デプロイ状況は [Actions タブ](../../actions) で確認できます。

### 4. 手動デプロイ（オプション）

```bash
firebase login
firebase use --add  # プロジェクトを選択
firebase deploy --only hosting,firestore:rules,storage
```

### 5. カスタムドメイン

Firebase Hosting の設定でカスタムドメインを追加し、DNS を設定。

**例**: air.ktrips.net
- Firebase Console → Hosting → カスタムドメインを追加
- DNS レコードを設定（A レコードまたは CNAME）

**トリップ所在フィルタ用ドメイン**（アクセス時に自動でフィルタを適用）:
| ドメイン | デフォルト表示 |
|----------|----------------|
| airj.ktrips.net / air.jp.ktrips.net | 日本のトリップのみ |
| airg.ktrips.net / air.gl.ktrips.net | グローバル（日本以外）のトリップのみ |

URLパラメータ `?region=japan` または `?region=global` でも指定可能。

### 6. Google OAuth の設定

本番URLからログインする際にエラーが出る場合:

1. [Google Cloud Console](https://console.cloud.google.com/) → APIとサービス → 認証情報
2. OAuth 2.0 クライアントID を選択
3. **承認済みの JavaScript 生成元** と **承認済きのリダイレクト URI** に本番URLを追加:
   - `https://your-domain.com`
   - `https://your-domain.com/__/auth/handler`

詳細は `GOOGLE_LOGIN_SETUP.md` を参照。

### 7. AI機能を使う場合（オプション）

ログイン後、メニュー → AI設定 で以下を設定：

- **AIプロバイダー**: Google Gemini / OpenAI / Anthropic から選択（旅行記生成用）
- **API キー**: 選択したプロバイダーのAPIキーを入力（旅行記生成用）
- **画像生成用（Nano Banana Pro2）**: AIアニメ生成用。defapi.org のAPIキーを入力

1. AI旅行記生成で旅行記を作成 → 2. スタイルを選択してAIアニメ生成で画像スライドショーを生成

## 使い方

### 閲覧（ログインなし）

1. [air.ktrips.net](https://air.ktrips.net) にアクセス
2. 右側パネルから公開トリップを選択
3. 写真サムネイルをクリックして地図上で表示
4. 「▶ 再生」でスライドショー（1/3/5秒間隔）
5. 右上メニューから動画・旅行記・スタンプラリーを表示

**親トリップ選択時（デスクトップ）**: 子トリップのアニメサムネイルがインライン表示され、各子トリップ名の横に📖（旅行記）・🎬（動画）の小ボタンが表示されます。スタンプラリーがある場合は🎫スタンプ一覧ボタンも表示。

**トリップ所在で絞り込み**: ドメイン（airj.ktrips.net＝日本、airg.ktrips.net＝グローバル）やURLパラメータ（`?region=japan` / `?region=global`）で表示を絞り込めます。ログイン時はトリップ一覧の選択リスト（All / Japan / Global）で切り替え可能。

### 編集（ログイン必要）

1. **ログイン**: 右上メニュー → 「Googleでログイン」
2. **新規トリップ**: 右上メニュー → 「新規」
3. **写真追加**: 画面に写真をドラッグ＆ドロップ
4. **GPX追加**: 右上メニュー → 「GPXアップロード」
5. **ポイント編集**: 地図上のマーカークリック → ✏️編集
   - **写真削除**: 📷写真削除（ポイント残す）または 🗑️全削除（ポイントごと）
6. **トリップ設定**: 右上メニューで名前・説明・URL・動画・色を設定
7. **保存**: 「保存」ボタンをクリック
8. **公開**: 「公開する」にチェックで誰でも閲覧可能に

### AI機能（オプション）

1. **AI設定**: 右上メニュー → 「AI設定」
   - プロバイダー選択（Gemini/OpenAI/Anthropic）
   - APIキーを入力
   - Nano Banana Pro2 のAPIキーを入力（アニメ生成用）
2. **旅行記生成**: 右上メニュー → 「AI旅行記生成」
3. **アニメ生成**: 右上メニュー → 「AIアニメ生成」→ スタイル選択

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フロントエンド | HTML5, CSS3, JavaScript（ビルド不要） |
| 地図 | Leaflet 1.9.4, MapLibre GL JS 4.7.1 |
| タイル | OpenStreetMap, USGS（地形）, Esri（航空写真） |
| EXIF/GPS | exifr 7.1.3 |
| 認証・DB | Firebase Auth (Google), Firestore, Storage |
| ホスティング | Firebase Hosting |
| CI/CD | GitHub Actions |
| AI | Google Gemini / OpenAI / Anthropic Claude |
| 画像生成 | Nano Banana Pro2（8スタイル） |

## 注意事項

### セキュリティ
- **firebase-config.js**: ローカル開発用。`.gitignore` に含まれており、GitHubにコミットされません
- **GitHub Secrets**: 本番環境では GitHub Secrets から自動生成されます
- **AI API キー**: Firestore の `users` コレクションにユーザーごとに保存。共有環境では使用しないこと

### データ管理
- **写真**: Firebase Storage に保存。Firestore には URL のみ保存するため、1MB制限の影響を受けにくい
- **GPS情報**: スマートフォンで位置情報をオンにして撮影した写真を推奨
- **公開トリップ**: 「公開する」にチェックを入れると、ログインなしで誰でも閲覧可能になります

### 機能
- **親子トリップ**: 親トリップはフォルダとして機能し、写真やGPXは持ちません。親トリップ選択時（デスクトップ）は子トリップのアニメサムネイル・旅行記ボタン・動画ボタンをインライン表示します
- **写真削除**: 📷写真削除（ポイント情報は残る）と🗑️全削除（ポイントごと削除）の2種類があります
- **レイヤー選択**: 地図・地形・航空写真の3種類を右上のボタンから切り替え
- **モバイルヘッダー**: 隠れたヘッダーはプルダウンバーを下スワイプ、または地図上部50pxからのスワイプで表示できます

## スクリーンショット

- 地図上に写真マーカーを表示
- スライドショーで自動再生
- GPXルートを重ね表示
- AI生成の旅行記を御朱印帳風に表示
- スタンプラリー機能でランドマークを巡る

## トラブルシューティング

### ローカル開発

**Q: 「firebase-config.js が読み込まれていません」**
- A: `firebase-config.example.js` をコピーして `firebase-config.js` を作成し、Firebase Console の値を入力してください

**Q: 写真がアップロードできない**
- A: Firebase Storage Rules が正しく設定されているか確認してください（`storage.rules`）

### 本番環境（air.ktrips.net）

**Q: トリップが表示されない**
- A: GitHub Secrets に `FIREBASE_CONFIG` が正しく設定されているか確認してください
- A: GitHub Actions のログで "Generated firebase-config.js:" を確認してください
- A: ブラウザのコンソール（F12）で Firebase 初期化ログを確認してください

**Q: ログインできない（「このアプリのリクエストは無効です」）**
- A: Firebase Authentication の承認済みドメインに本番URLを追加してください
- A: Google Cloud Console の OAuth 認証情報に本番URLを追加してください

**Q: GitHub Actionsでデプロイが失敗する**
- A: `FIREBASE_SERVICE_ACCOUNT` Secret が正しく設定されているか確認
- A: Firebase プロジェクトのサービスアカウントに必要な権限があるか確認
  - Firebase Admin
  - Service Usage Consumer
  - Firebase Hosting Admin
  - Cloud Datastore User
  - Storage Admin

### その他

**Q: 写真にGPS情報がない**
- A: スマートフォンのカメラで位置情報をオンにして撮影してください
- A: GPS情報がない場合は、地図をクリックして手動で位置を指定できます

**Q: GPXファイルが表示されない**
- A: GPXファイルのフォーマットが正しいか確認してください
- A: ブラウザのコンソールでエラーメッセージを確認してください

## 開発

### ローカル開発サーバー

```bash
python3 -m http.server 8080
```

### ファイル構成

```
air/
├── index.html              # メインHTML
├── app.js                  # アプリケーションロジック
├── style.css               # スタイル
├── firebase-init.js        # Firebase初期化
├── firebase-config.js      # Firebase設定（ローカルのみ、.gitignore）
├── firebase-config.example.js  # 設定テンプレート
├── firestore.rules         # Firestore セキュリティルール
├── storage.rules           # Storage セキュリティルール
├── .github/workflows/      # GitHub Actions
│   └── firebase-deploy.yml # 自動デプロイ設定
└── README.md
```

## ライセンス

このプロジェクトは個人利用・学習目的で公開されています。
