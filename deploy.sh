#!/bin/bash

# Air アプリケーションのデプロイスクリプト
# Firebase Hostingにデプロイします

set -e

echo "🚀 Air デプロイ開始..."

# config.jsの存在確認と自動作成
if [ ! -f "config.js" ]; then
  echo "⚠️  警告: config.js が見つかりません"
  if [ -f "config.template.js" ]; then
    echo "📝 config.template.js から config.js を作成します..."
    cp config.template.js config.js
    echo "✓ config.js を作成しました"
  else
    echo "❌ エラー: config.template.js も見つかりません"
    read -p "デプロイを続行しますか？ (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      exit 1
    fi
  fi
fi

# firebase-config.jsの存在確認
if [ ! -f "firebase-config.js" ]; then
  echo "❌ エラー: firebase-config.js が見つかりません"
  echo "firebase-config.example.js をコピーしてfirebase-config.jsを作成してください"
  exit 1
fi

# Firebaseプロジェクトの確認
echo "📦 Firebaseプロジェクト: airgo-trip"

# デプロイオプションの選択
echo ""
echo "デプロイ対象を選択してください:"
echo "  1) すべて (hosting, firestore:rules, storage)"
echo "  2) hosting のみ"
echo "  3) firestore:rules のみ"
echo "  4) storage のみ"
read -p "選択 (1-4) [1]: " choice
choice=${choice:-1}

case $choice in
  1)
    TARGET="hosting,firestore:rules,storage"
    ;;
  2)
    TARGET="hosting"
    ;;
  3)
    TARGET="firestore:rules"
    ;;
  4)
    TARGET="storage"
    ;;
  *)
    echo "❌ 無効な選択です"
    exit 1
    ;;
esac

echo ""
echo "🔧 デプロイ対象: $TARGET"
echo ""

# Firebase CLI のインストール確認
if ! command -v firebase &> /dev/null; then
  echo "❌ Firebase CLI が見つかりません"
  echo "インストール: npm install -g firebase-tools"
  exit 1
fi

# デプロイ実行
echo "🚀 デプロイを開始します..."
firebase deploy --only "$TARGET" --project airgo-trip

echo ""
echo "✅ デプロイ完了!"
echo "🌐 https://air.ktrips.net"
