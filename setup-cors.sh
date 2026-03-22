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

# CORS 設定を適用（cors.json はスクリプトと同じディレクトリにあること）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}" || exit 1

if [ ! -f "cors.json" ]; then
    echo "❌ cors.json が見つかりません。${SCRIPT_DIR} に cors.json があるか確認してください。"
    exit 1
fi

echo "CORS 設定を適用中..."
APPLIED=0
# firebasestorage.app と appspot.com の両方を試す
for BUCKET in "gs://${PROJECT_ID}.firebasestorage.app" "gs://${PROJECT_ID}.appspot.com"; do
  echo "  試行: ${BUCKET}"
  if gsutil cors set cors.json "${BUCKET}" 2>/dev/null; then
    echo ""
    echo "✅ ${BUCKET} に CORS 設定が適用されました"
    APPLIED=1
    break
  else
    echo "    （このバケットは存在しないか、権限がありません）"
  fi
done

if [ "${APPLIED}" -eq 1 ]; then
    echo ""
    echo "=========================================="
    echo "適用された CORS 設定："
    echo "=========================================="
    gsutil cors get "${BUCKET}"
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
    echo "3. アニメ表示・GPX 読み込みが正常になるか確認してください"
    echo ""
else
    echo ""
    echo "❌ CORS 設定の適用に失敗しました（両方のバケットで試行済み）"
    echo ""
    echo "トラブルシューティング："
    echo "1. プロジェクトへのアクセス権限があるか確認"
    echo "2. firebase-config.js の storageBucket の値を確認（.appspot.com か .firebasestorage.app）"
    echo "3. 以下を手動で実行してみてください："
    echo "   gsutil cors set cors.json gs://${PROJECT_ID}.firebasestorage.app"
    echo "   gsutil cors set cors.json gs://${PROJECT_ID}.appspot.com"
    echo ""
    echo "詳細: CORS_SETUP.md を参照"
    echo ""
    exit 1
fi
