# 第8章: デプロイメント

## 8.1 本番環境の準備

### 8.1.1 環境設定の分離

本番環境と開発環境で異なる設定を使用します：

```javascript
// config.js
const ENV = {
  development: {
    firebase: {
      apiKey: process.env.FIREBASE_DEV_API_KEY,
      authDomain: 'air-dev.firebaseapp.com',
      projectId: 'air-dev',
      storageBucket: 'air-dev.appspot.com'
    },
    claude: {
      apiKey: process.env.CLAUDE_DEV_API_KEY
    },
    maps: {
      apiKey: process.env.GOOGLE_MAPS_DEV_KEY
    }
  },
  production: {
    firebase: {
      apiKey: process.env.FIREBASE_PROD_API_KEY,
      authDomain: 'air.firebaseapp.com',
      projectId: 'air',
      storageBucket: 'air.appspot.com'
    },
    claude: {
      apiKey: process.env.CLAUDE_PROD_API_KEY
    },
    maps: {
      apiKey: process.env.GOOGLE_MAPS_PROD_KEY
    }
  }
};

const currentEnv = process.env.NODE_ENV || 'development';
export default ENV[currentEnv];
```

### 8.1.2 ビルドプロセス

```bash
# package.json
{
  "scripts": {
    "dev": "http-server -p 8000",
    "build": "npm run minify && npm run optimize",
    "minify": "uglify-js js/*.js -o js/bundle.min.js",
    "optimize": "cleancss css/style.css -o css/style.min.css",
    "deploy": "npm run build && firebase deploy"
  }
}
```

### 8.1.3 セキュリティチェックリスト

本番デプロイ前に確認すべき項目：

```markdown
## セキュリティチェックリスト

- [ ] APIキーが`.env`に配置されている
- [ ] `.env`が`.gitignore`に含まれている
- [ ] Firebase認証のセッション時間制限を設定
- [ ] CORS設定が本番ドメインのみを許可
- [ ] CSP（Content Security Policy）ヘッダーを設定
- [ ] XSS対策としてDOMメソッドでのHTMLエスケープを確認
- [ ] SQLインジェクション対策（Firestoreなのでほぼ不要だが確認）
- [ ] レート制限を有効化
- [ ] 監視とロギングが有効化
```

## 8.2 Firebase Hostingへのデプロイ

### 8.2.1 Firebase CLIのセットアップ

```bash
# Firebase CLIをインストール
npm install -g firebase-tools

# Firebaseにログイン
firebase login

# プロジェクトを初期化
firebase init hosting
```

### 8.2.2 firebase.jsonの設定

```json
{
  "hosting": {
    "public": ".",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**",
      ".env",
      ".env.example"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ],
    "headers": [
      {
        "source": "**/*.{js,css}",
        "headers": [
          {
            "key": "Cache-Control",
            "value": "max-age=31536000"
          }
        ]
      },
      {
        "source": "/index.html",
        "headers": [
          {
            "key": "Cache-Control",
            "value": "max-age=3600"
          }
        ]
      }
    ]
  }
}
```

### 8.2.3 デプロイコマンド

```bash
# テスト版をデプロイ
firebase deploy --only hosting

# 全機能をデプロイ（Firestore Rules含む）
firebase deploy

# 特定バージョンをロールバック
firebase deploy --only hosting:version_name
```

## 8.3 CI/CDパイプライン

### 8.3.1 GitHub Actionsでの自動デプロイ

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to Firebase

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Run tests
        run: npm test

      - name: Build
        run: npm run build

      - name: Deploy to Firebase
        uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: '${{ secrets.GITHUB_TOKEN }}'
          firebaseServiceAccount: '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}'
          channelId: live
          projectId: 'air'

      - name: Notify deployment
        if: success()
        run: echo "Deploy successful!"
```

### 8.3.2 サービスアカウントキーの生成

```bash
# Firebase CLIで生成
firebase login
firebase functions:config:set secrets.service_account="$(cat /path/to/serviceAccountKey.json)"

# または、GCP Consoleから手動生成
# 1. GCP Console → サービスアカウント
# 2. キーを生成 → JSON形式で保存
# 3. GitHub Secrets に登録
```

## 8.4 パフォーマンス最適化

### 8.4.1 リソースの圧縮と最適化

```bash
# JavaScriptの圧縮
npm install -D terser
terser js/app.js -o js/app.min.js

# CSSの圧縮
npm install -D cssnano
cssnano css/style.css -o css/style.min.css

# 画像最適化
npm install -D imagemin
imagemin img/**/* --out-dir=img/optimized
```

### 8.4.2 ラージバンドルの分割

```javascript
// webpack.config.js
module.exports = {
  mode: 'production',
  entry: './js/app.js',
  output: {
    filename: 'js/bundle.[contenthash].js'
  },
  optimization: {
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          priority: 10
        },
        common: {
          minChunks: 2,
          priority: 5,
          reuseExistingChunk: true
        }
      }
    }
  }
};
```

### 8.4.3 Lighthouse による監査

```bash
# Lighthouseをインストール
npm install -g lighthouse

# サイトを監査
lighthouse https://your-site.com --view

# 継続的監視の設定
npm install -D @lhci/cli
```

## 8.5 監視とロギング

### 8.5.1 Cloud Loggingの設定

```javascript
// backend/logging.js
import { Logging } from '@google-cloud/logging';

const logging = new Logging({
  projectId: 'air'
});

const log = logging.log('air-app');

export async function logEvent(severity, message, metadata = {}) {
  const entry = log.entry(
    { severity, ...metadata },
    message
  );

  await log.write(entry);
}

// 使用例
await logEvent('INFO', 'ユーザーがログインしました', {
  userId: user.id,
  email: user.email
});

await logEvent('ERROR', 'Claude API呼び出しエラー', {
  error: error.message,
  prompt: truncatedPrompt
});
```

### 8.5.2 エラーモニタリング（Sentry）

```javascript
// app.js
import * as Sentry from "@sentry/browser";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  beforeSend: (event) => {
    // 機密情報を除外
    if (event.request) {
      delete event.request.cookies;
      delete event.request.headers['Authorization'];
    }
    return event;
  }
});

// エラーをキャッチ
try {
  // リスクのある処理
} catch (error) {
  Sentry.captureException(error, {
    contexts: {
      trip: {
        tripId: currentTripId
      }
    }
  });
}
```

## 8.6 ロールバック手順

### 8.6.1 デプロイのロールバック

```bash
# 前のバージョンを確認
firebase hosting:versions:list

# 特定バージョンにロールバック
firebase hosting:versions:promote <version_id>

# または、特定ファイルを復元
firebase hosting:clone --source=v1 --target=v2
```

### 8.6.2 Firestore設定のロールバック

```bash
# バックアップから復元
gcloud firestore import gs://your-bucket/backup

# または、手動で前のバージョンを適用
firebase deploy --only firestore:rules
```

## 8.7 本番運用

### 8.7.1 定期メンテナンス

```bash
# 定期実行スクリプト（cron）
0 2 * * * /usr/bin/firebase-backup.sh  # 毎日2時にバックアップ
0 6 * * * /usr/bin/check-quotas.sh      # 毎日6時にクォータ確認
```

### 8.7.2 アラート設定

Firebase Consoleから設定：

```
1. Cloud Monitoring → ポリシー
2. 新しいアラートを作成
3. 条件:
   - Firestore documents読み取り > 100,000/日
   - API エラー率 > 5%
   - レスポンスタイム > 2秒
```

---

**次章へ**: 第9章では、全体のまとめと次のステップを説明します。
