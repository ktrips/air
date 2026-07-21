# Air — 地図と写真でエア旅行

GPS付き写真をアップロードすると撮影場所を地図上に表示し、スライドショーで楽しめるWebアプリ。Google ログインで Firestore にトリップを保存・共有。

**URL**: https://air.ktrips.net  
**バージョン**: a.1.9.3

## 最新アップデート（a.1.9.3）

- 🧭 **トリップメニューにナビゲーションボタン追加**: トリップ一覧の各トリップに「→」移動ボタンと「📖」旅行記ボタンを追加
- 🎬 **モバイル自動再生の動画サイズ拡大**: 横長・縦長動画ともに表示サイズを約1.33倍に拡大
- ⏱️ **自動再生の写真表示時間を調整**: デフォルトを5秒に変更

## 過去のアップデート（a.1.9.2）

- 🐛 **ホームURL初回アクセス時の親トリップ表示修正**: 初回アクセス時に親トリップが地図に表示されない不具合を修正
- 🏠 **親トリップ表示の改善**: ホームアクセス時のデフォルト表示を親トリップの一覧状態に変更、子トリップリンク一覧表示を削除
- 🤖 **AI機能の強化**:
  - アニメ生成でユーザー設定の AI プロバイダーを使用するよう改善
  - 旅行記生成モデルを最新版にアップグレード（モデル名を画面表示）
  - **Gemini 画像生成**: リーズナブル/標準/ハイスペックモデルを選択可能
  - **OpenAI 画像生成**: gpt-image-1-mini をデフォルトに設定
- 📊 **ハンバーガーメニュー最下部に AI Usage リンク追加**: Gemini API・Claude API・OpenAI API の使用状況を確認できるリンクを追加
- 🎯 **ホームURL初回アクセス時の親トリップ表示修正**: URL パラメータ（?trip=...）でトリップ指定時の動作を改善
- 📱 **PWA 対応**: Web App Manifest とアプリアイコンを追加、ホーム画面にインストール可能に

### 過去のアップデート（a.1.7.6）

- 📺 **ビデオサムネイル表示改善**: 地図上のビデオマーカーに動画のサムネイル画像と再生ボタンを表示
  - モバイルとデスクトップで異なるサイズに対応（40x40px / 56x56px）
  - サムネイル上に半透明オーバーレイと再生ボタンアイコンを配置
- 🗺️ **マーカー表示最適化**: トリップ選択時に最初と最後の写真マーカーのみを地図に表示（ビジュアルノイズを削減）
- 🔗 **URLパラメータで親トリップ指定**: `?trip=親トリップ名` で直接親トリップを指定・表示
  - 完全一致・部分一致の両方で検索（トリップ名の微妙な違いに対応）
  - 親トリップのみを表示（子トリップは表示されない）
  - 地図は親トリップのマーカー・ルートのみ表示
- 🔧 **Firebase Storage CORS設定**: Firebase Storage から画像・GPXファイルを読み込むためのCORS設定を追加

### 過去のアップデート（a.1.7.3）

- 🏠 **親トリップ自動選択**: ドメイン別に自動的にデフォルト親トリップを選択
  - `ohenro.ktrips.net` → 「しまなみ街道と四国お遍路旅」を自動選択
  - `air.ktrips.net` および `airj.ktrips.net`, `air.jp.ktrips.net`, `airg.ktrips.net`, `air.gl.ktrips.net` → 最初の親トリップを自動選択
- 📱 **モバイル動画表示サイズ最適化**: 自動再生時の縦長動画を画面の下から 2/3 のサイズで表示
- 📖 **Help モーダルにAI使用量チェックリンク追加**: Gemini API・Claude API の使用状況を確認できるリンク

## 機能

### 基本機能
- **写真×地図**: EXIF GPS から座標を取得し、地図上にマーカー表示
- **スライドショー**: 自動再生で写真を順番に表示、地図がカメラ追従
- **GPX連携**: ルートファイルを地図に重ね表示
- **トリップ管理**: 複数トリップを Firestore に保存・編集・公開
- **親子トリップ**: フォルダ構造で複数のトリップを整理
- **3つの地図レイヤー**: 地図・地形・航空写真を切り替え可能
- **モバイル対応**: ヘッダー自動非表示でトリップ名が地図上に移動

### 閲覧機能
- **ログインなしで閲覧**: 公開トリップはログインなしで閲覧可能
- **トリップ所在フィルタ**: 日本のトリップのみ / グローバルのトリップのみを表示
- **動画再生**: トリップに動画URLを追加して地図上で再生（YouTube・Vimeo・YouTube Shorts対応）
- **動画コントロール**: 動画表示中は画面上中央に ⏮⏸▶⏭✕ のコントロールバーを表示
- **動画自動連続再生**: 動画終了後に自動で次の動画へ移動
- **旅行記表示**: AI生成された旅行記を表示。PC は地図と目次を横並び、モバイルはアコーディオン折り畳み
- **動画ポイント**: 動画URLがあるポイントは旅行記内でサムネイルをメイン表示しクリックで再生
- **スタンプラリー**: ランドマークを巡るスタンプラリー機能
- **親トリップのインライン表示**: 親トリップ選択時、全子トリップのアニメサムネイルをまとめてインライン表示。各子トリップ名の横に📖旅行記・🎬動画の小ボタン表示。親トリップの動画再生時は子トリップの動画を連続再生

### 編集機能（ログイン必要）
- **Google ログイン**: 自分のトリップのみ編集可能
- **写真アップロード**: ドラッグ&ドロップで複数枚一括アップロード
- **写真管理**: 右側メニューで写真をドラッグして並び替え、✕で削除
- **GPS自動検出**: 写真のGPS情報から自動で地名を取得、トリップ名・説明に自動入力
- **GPS追加**: 右側メニューまたは地図上でGPSポイントを手動追加
- **ポイント編集**: 写真の位置、名前、説明を編集
- **GPS位置変更**: 地図上のマーカーをドラッグして新しい位置に移動 → 保存バーで確定またはキャンセル
- **写真削除**: 写真のみ削除/ポイントごと削除の2モード
- **ルートカラー**: 15色からトリップカラーを選択

### AI機能（オプション）
- **AI旅行記生成**: 写真・説明・URL・動画・GPS情報から旅行記を自動生成（Gemini / OpenAI / Anthropic）
  - ランドマーク一覧をサマリー直下に目次として表示（折り畳み式）
  - 動画URLがあるポイントは動画サムネイルをメイン画像として使用
  - 旅行記履歴を右側メニューから表示・削除可能
  - **旅行記シェア**: Twitter / Instagram（URL コピー）/ Facebook でシェア可能
- **AIアニメ生成**: 生成した旅行記を元にスタイルを適用して画像を生成（Gemini画像生成）
  - 表紙タイトルをトリップ名から自動生成（「Day7 淡路島の走り方」→「淡路島の歩き方」）
  - 地球の歩き方表紙風には手描きミニマップを表紙に追加
  - 生成済みアニメを ← → で並び替え、✕ で削除
  - 詳細4ページ（旅行記マンガ形式）と表紙スタイル（地球の歩き方風・少年ジャンプ風・旅行雑誌風）
  - **出来事生成**: 旅の印象的な出来事をキャラアニメ 5 コマで生成（キャラ画像必須・テキスト入力）
  - サマリー直下に詳細アニメをストリップ表示（旅の内容を一目で把握）

## セットアップ

### 1. Firebase プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com/) でプロジェクトを作成
2. **Authentication** → サインイン方法で **Google** を有効化
   - 承認済みドメインに本番URL（例: air.ktrips.net）を追加
3. **Firestore Database** → 作成（ネイティブモード・asia-northeast1）
4. **Storage** → 作成（Firestore と同じリージョン推奨）
5. **Firestore のルール** を `firestore.rules`、**Storage のルール** を `storage.rules` でデプロイ

### 2. ローカル開発

#### 2-0. Git ユーザー設定

```bash
# グローバル設定（全リポジトリ共通）
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"

# または、このリポジトリのみ設定
git config user.name "Your Name"
git config user.email "your.email@example.com"

# 確認
git config user.name
git config user.email
```

#### 2-1. Firebase設定ファイルを作成

```bash
cp firebase-config.example.js firebase-config.js
```

#### 2-2. Firebase Console から設定値を取得

1. [Firebase Console](https://console.firebase.google.com/) → プロジェクト設定 → 全般
2. 「マイアプリ」セクションの構成をコピー
3. `firebase-config.js` に貼り付け

#### 2-3. Mapboxトークンを設定（オプション・3D地図用）

```bash
cp config.example.js config.js
```

`config.js` を開き、[Mapbox](https://account.mapbox.com/) のアクセストークンを設定してください。  
設定しない場合、自動再生中の 3D 地図表示はスキップされます（2D 地図で動作）。

#### 2-4. ローカルサーバーで起動

```bash
python3 -m http.server 8080
# ブラウザで http://localhost:8080
```

**注意**: `firebase-config.js` と `config.js` は `.gitignore` に含まれており、GitHubにはコミットされません。

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

**MAPBOX_TOKEN**（オプション・3D地図用）:
- [Mapbox](https://account.mapbox.com/) のアクセストークンを設定
- 設定しない場合、自動再生中の 3D 地図表示はスキップ（2D 地図で動作）

#### 3-2. 自動デプロイ

`main` ブランチにプッシュすると、GitHub Actionsが自動的に以下を実行:
1. `firebase-config.js` を GitHub Secrets から生成
2. Firebase Hosting にデプロイ
3. Firestore Rules と Storage Rules を更新

デプロイ状況は [Actions タブ](../../actions) で確認できます。

**デプロイが失敗する場合:**
- GitHub Actions ログで "Generated firebase-config.js:" の出力を確認
- `FIREBASE_CONFIG` Secret に改行が含まれていないか確認（1行である必要があります）
- `FIREBASE_SERVICE_ACCOUNT` Secret が有効な JSON 形式か確認

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
3. **承認済みの JavaScript 生成元** と **承認済みのリダイレクト URI** に本番URLを追加:
   - `https://your-domain.com`
   - `https://your-domain.com/__/auth/handler`

詳細は `GOOGLE_LOGIN_SETUP.md` を参照。

### 7. AI機能を使う場合（オプション）

ログイン後、メニュー → AI設定 で以下を設定：

- **AIプロバイダー**: Google Gemini / OpenAI / Anthropic から選択（旅行記生成用）
- **API キー**: 選択したプロバイダーのAPIキーを入力（旅行記生成用）
- **画像生成用（Nano Banana Pro2）**: AIアニメ生成用。defapi.org のAPIキーを入力

1. AI旅行記生成で旅行記を作成 → 2. スタイルを選択してAIアニメ生成で画像を生成

## 使い方

### 閲覧（ログインなし）

1. [air.ktrips.net](https://air.ktrips.net) にアクセス
2. 右側パネルから公開トリップを選択
3. 写真サムネイルをクリックして地図上で表示
4. 「▶ 再生」でスライドショー自動再生
5. 右上メニューから動画・旅行記・スタンプラリーを表示

**写真ナビゲーション**: 写真が非表示の状態で「次へ」を押すと最初の写真を表示。表示中は次/前の写真へ移動。

**親トリップ選択時**: 全子トリップのアニメサムネイルをまとめてインライン表示（クリックでスライドショー）。旅行記一覧では各子トリップ名の横に📖旅行記ボタン・🎬動画ボタンを表示。スタンプラリーがある場合は🎫スタンプ一覧ボタンも表示。親トリップの動画再生時は子トリップ・各ポイントの動画を順番に連続再生。

**トリップ所在で絞り込み**: ドメイン（airj.ktrips.net＝日本、airg.ktrips.net＝グローバル）やURLパラメータ（`?region=japan` / `?region=global`）で表示を絞り込めます。ログイン時はトリップ一覧の選択リスト（All / Japan / Global）で切り替え可能。

### 編集（ログイン必要）

1. **ログイン**: 右上メニュー → 「Googleでログイン」
2. **新規トリップ**: 右上メニュー → 「新規」
3. **写真追加**: 画面に写真をドラッグ＆ドロップ
   - GPS情報がある写真は自動で地名検出
   - トリップ名・説明が未入力の場合は自動入力
4. **写真管理**: 右側メニューのサムネイル
   - ドラッグで写真の順序を変更
   - ✕ボタンで写真を削除
5. **GPS追加**: 右側メニュー → 📍GPS ボタン → 地図上をクリック
6. **GPX追加**: 右上メニュー → 「GPXアップロード」
7. **ポイント編集**: 地図上のマーカークリック → ✏️編集
   - **GPS位置変更**: マーカーをドラッグ → 地図下部の保存バーで「保存」または「元に戻す」
   - **写真削除**: 📷写真削除（ポイント残す）または 🗑️全削除（ポイントごと）
8. **トリップ設定**: 右上メニューで名前・説明・URL・動画・色を設定
9. **保存**: 「保存」ボタンをクリック
10. **公開**: 「公開する」にチェックで誰でも閲覧可能に

### AI機能（オプション）

1. **AI設定**: 右上メニュー → 「AI設定」
   - プロバイダー選択（Gemini/OpenAI/Anthropic）
   - APIキーを入力
   - Nano Banana Pro2 のAPIキーを入力（アニメ生成用）
2. **旅行記生成**: 右側メニュー → 「AI旅行記生成」
   - 旅行記はサマリー・目次・地図・ランドマーク別詳細の構成で生成
   - 動画URLがあるポイントは動画サムネイルをメイン画像として表示
   - 右側メニューの旅行記履歴ボタン横の ✕ で過去の旅行記を削除可能
3. **アニメ生成**: 右側メニュー → スタイル選択 → 「アニメ生成」
   - **地球の歩き方表紙風**: ルートのミニマップを表紙に含む。タイトルはトリップ名から自動生成
   - **少年ジャンプの表紙風**: マンガ誌風の表紙
   - **旅行雑誌の表紙風**: 高品質な旅行雑誌風
   - **詳細4ページ**: 旅行記全体を4枚のマンガ形式で表現
   - 生成後は ← → ボタンで並び替え、✕ で削除可能
   - 旅行記のサマリー下に詳細アニメをプレビュー表示

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フロントエンド | HTML5, CSS3, JavaScript（ビルド不要） |
| 地図 | Leaflet 1.9.4, MapLibre GL JS 4.7.1, Mapbox GL JS 3.0.1 (3D地図) |
| タイル | OpenStreetMap, USGS（地形）, Esri（航空写真）, Mapbox |
| EXIF/GPS | exifr 7.1.3 |
| 認証・DB | Firebase Auth (Google), Firestore, Storage |
| キャッシュ | IndexedDB (GPX 24時間キャッシュ), Service Worker (PWA) |
| ホスティング | Firebase Hosting |
| CI/CD | GitHub Actions |
| AI | Google Gemini / OpenAI / Anthropic Claude |
| 画像生成 | Nano Banana Pro2 (Stable Diffusion) |

## 注意事項

### セキュリティ
- **firebase-config.js**: ローカル開発用。`.gitignore` に含まれており、GitHubにコミットされません
- **GitHub Secrets**: 本番環境では GitHub Secrets から自動生成されます
- **AI API キー**: Firestore の `users` コレクションにユーザーごとに保存。共有環境では使用しないこと

### データ管理
- **写真**: Firebase Storage に保存。Firestore には URL のみ保存するため、1MB制限の影響を受けにくい
- **旅行記HTML**: Firebase Storage に保存（Firestore の1MB制限回避）。過去の旅行記は履歴として保持
- **GPS情報**: スマートフォンで位置情報をオンにして撮影した写真を推奨
- **公開トリップ**: 「公開する」にチェックを入れると、ログインなしで誰でも閲覧可能になります

### 機能
- **親子トリップ**: 親トリップはフォルダとして機能し、写真やGPXは持ちません。親トリップ選択時は全子トリップのアニメサムネイルをまとめてインライン表示し、旅行記一覧では各子トリップに📖旅行記・🎬動画ボタンを表示します
- **自動再生（スライドショー）**: 再生中は3Dマップ上でルート・ポイントをグロー付きで強調表示。再生終了後は地図全体表示に戻ります
- **写真削除**: 📷写真削除（ポイント情報は残る）と🗑️全削除（ポイントごと削除）の2種類があります
- **レイヤー選択**: 地図・地形・航空写真の3種類を右上のボタンから切り替え
- **モバイルヘッダー**: 隠れたヘッダーはプルダウンバーを下スワイプ、または地図上部50pxからのスワイプで表示できます
- **旅行記の地図・目次**: PCは横並び表示（地図左・目次右）、モバイルはアコーディオンでデフォルト閉じ

## スクリーンショット

- 地図上に写真マーカーを表示
- スライドショーで自動再生（3Dマップのルート・ポイントをグロー強調）
- GPXルートを重ね表示
- AI生成の旅行記（地図と目次を横並び、詳細アニメをストリップ表示）
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
- A: GitHub Secrets に以下を設定確認:
  - `FIREBASE_CONFIG`: JSON形式（1行） 例: `{"apiKey":"...","projectId":"airgo-trip",...}`
  - `FIREBASE_SERVICE_ACCOUNT`: Firebase Console → プロジェクト設定 → サービスアカウント → 秘密鍵
- A: Firebase プロジェクトのサービスアカウントに必要な権限があるか確認
  - Firebase Admin
  - Service Usage Consumer
  - Firebase Hosting Admin
  - Cloud Datastore User
  - Storage Admin
- A: GitHub Actions ログで "Generated firebase-config.js:" を確認し、JSON が正しく生成されているか確認

### その他

**Q: 写真にGPS情報がない**
- A: スマートフォンのカメラで位置情報をオンにして撮影してください
- A: GPS情報がない場合は、地図をクリックして手動で位置を指定できます

**Q: GPXファイルが表示されない**
- A: GPXファイルのフォーマットが正しいか確認してください
- A: ブラウザのコンソールでエラーメッセージを確認してください

**Q: 旅行記の動画が表示されない**
- A: ポイントに動画URLを設定してください（YouTube・Vimeo対応）
- A: 旅行記を再生成すると動画サムネイルが反映されます

**Q: AIアニメ生成でタイトルがトリップ名と違う**
- A: 地球の歩き方表紙風は「〇〇の歩き方」形式のタイトルを自動生成します（Day番号・活動名を除去して地名を抽出）

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
