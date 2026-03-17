# Googleログイン設定ガイド

## エラー 400: redirect_uri_mismatch の解決方法

`air.ktrips.net` でログイン時にこのエラーが出る場合、**認可済みのリダイレクト URI** に以下を追加してください。

### クイック手順

1. [認証情報（airgo-trip）](https://console.cloud.google.com/apis/credentials?project=airgo-trip) を開く
2. **OAuth 2.0 クライアント ID** の一覧で、種類が **「ウェブアプリケーション」** のものをクリック
3. **認可済みのリダイレクト URI** に以下を**正確に**追加（コピー＆ペースト推奨）：
   ```
   https://air.ktrips.net/__/auth/handler
   ```
4. **保存** をクリック
5. 数分待ってから再度ログインを試す

**注意**: `__` はアンダースコア2つです。末尾のスラッシュは不要です。

**複数の OAuth クライアントがある場合**: Firebase が自動作成した「ウェブアプリケーション」タイプのクライアントを編集してください。Firebase Console → Authentication → Sign-in method → Google で表示される「ウェブクライアント ID」と一致するものを選びます。

---

## 「アクセスをブロック: このアプリのリクエストは無効です」の解決方法

インターネット（本番環境）からGoogleログインする際にこのエラーが出る場合、**認可済みの JavaScript 生成元** の設定が必要です。

## 手順

### 1. Google Cloud Console を開く

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクト **airgo-trip** を選択

### 2. OAuth 2.0 クライアント ID を編集

1. [認証情報](https://console.cloud.google.com/apis/credentials?project=airgo-trip) を開く
2. **OAuth 2.0 クライアント ID** の一覧から、種類が「ウェブアプリケーション」のものをクリック
3. 以下の URI を追加

#### 認可済みの JavaScript 生成元

アプリが動作するドメインを追加します：

| ドメイン | 用途 |
|----------|------|
| `https://airgo-trip.web.app` | Firebase Hosting のデフォルトURL |
| `https://airgo-trip.firebaseapp.com` | Firebase の authDomain |
| `https://air.ktrips.net` | カスタムドメイン（本番） |
| `http://localhost:8080` | ローカル開発 |
| `http://127.0.0.1:8080` | ローカル開発（必要に応じて） |

カスタムドメインを使っている場合は、そのドメインも追加してください。

#### 認可済みのリダイレクト URI

Firebase Auth 用の URI を追加します。**カスタムドメイン（air.ktrips.net）を使う場合は、そのドメインの URI も必須です**：

| URI |
|-----|
| `https://airgo-trip.firebaseapp.com/__/auth/handler` |
| `https://air.ktrips.net/__/auth/handler` |

※ `air.ktrips.net` では authDomain が同一ホストに設定されるため、上記リダイレクト URI を追加しないと「redirect_uri_mismatch」エラーになります。

### 3. Firebase Console で認可済みドメインを確認

1. [Firebase Console](https://console.firebase.google.com/) → プロジェクト **airgo-trip** を選択
2. **Authentication** → **Settings** → **Authorized domains**
3. アプリのドメインが一覧にあるか確認
4. なければ **Add domain** で追加（例: `airgo-trip.web.app`、カスタムドメイン）

### 4. 保存して再試行

設定を保存し、数分待ってから再度ログインを試してください。

---

## 補足

- **localhost** では動くが **本番URL** ではエラーになる場合 → 本番ドメインが「認可済みの JavaScript 生成元」に含まれていない可能性が高いです
- カスタムドメインを使う場合 → そのドメインを両方（GCP と Firebase）に追加してください
- `www` あり/なしで別ドメイン扱いになるため、両方使う場合は両方追加してください
