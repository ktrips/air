#!/bin/bash

# Firebase Storage CORS 設定スクリプト

echo "=========================================="
echo "Firebase Storage CORS 設定"
echo "=========================================="
echo ""

# Google Cloud SDK がインストールされているか確認
if ! command -v gsutil &> /dev/null; then
    echo "❌ Google Cloud SDK (gsutil) がインストールされていません。"
    echo ""
    echo "以下のコマンドでインストールしてください："
    echo ""
    echo "  brew install --cask google-cloud-sdk"
    echo ""
    echo "または、以下のURLからダウンロード："
    echo "  https://cloud.google.com/sdk/docs/install"
    echo ""
    exit 1
fi

echo "✓ Google Cloud SDK がインストールされています"
echo ""

# プロジェクト ID を設定
PROJECT_ID="airgo-trip"
BUCKET="gs://${PROJECT_ID}.firebasestorage.app"

echo "プロジェクト: ${PROJECT_ID}"
echo "バケット: ${BUCKET}"
echo ""

# 認証確認
echo "Google アカウントで認証されているか確認中..."
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &> /dev/null; then
    echo "❌ 認証されていません。以下のコマンドで認証してください："
    echo ""
    echo "  gcloud auth login"
    echo ""
    exit 1
fi

ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)")
echo "✓ 認証済み: ${ACCOUNT}"
echo ""

# プロジェクトを設定
echo "プロジェクトを設定中..."
gcloud config set project ${PROJECT_ID}
echo ""

# CORS 設定を適用
echo "CORS 設定を適用中..."
if gsutil cors set cors.json ${BUCKET}; then
    echo ""
    echo "✅ CORS 設定が正常に適用されました！"
    echo ""

    # 設定を確認
    echo "=========================================="
    echo "適用された CORS 設定："
    echo "=========================================="
    gsutil cors get ${BUCKET}
    echo ""

    echo "=========================================="
    echo "次のステップ"
    echo "=========================================="
    echo ""
    echo "1. ブラウザのキャッシュをクリアしてください"
    echo "   Chrome: Cmd+Shift+Delete (Mac) / Ctrl+Shift+Delete (Windows)"
    echo ""
    echo "2. ページを強制リロードしてください"
    echo "   Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows)"
    echo ""
    echo "3. http://127.0.0.1:8080 を開いて確認してください"
    echo ""
else
    echo ""
    echo "❌ CORS 設定の適用に失敗しました"
    echo ""
    echo "トラブルシューティング："
    echo "1. プロジェクトへのアクセス権限があるか確認"
    echo "2. Firebase Console で権限を確認："
    echo "   https://console.firebase.google.com/project/${PROJECT_ID}/settings/iam"
    echo ""
    exit 1
fi
