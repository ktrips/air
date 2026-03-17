#!/usr/bin/env node
/**
 * Air トリップデータ バックアップ＆クリア
 *
 * 1. Firestore の trips と users をバックアップ
 * 2. GPX を URL から取得してバックアップに含める
 * 3. 写真を backup/photos/ にダウンロード（オプション）
 * 4. Storage の trips/* を削除
 * 5. Firestore の trips コレクションを削除
 * 6. users の tripOrder をクリア
 *
 * 使い方:
 *   cd air && npm install && node scripts/backup-and-clear.js [--no-download-photos] [--dry-run]
 *
 * 事前準備:
 *   Firebase Console > プロジェクトの設定 > サービスアカウント > 新しい秘密鍵の生成
 *   → ダウンロードした JSON を air/service-account.json に保存
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_PHOTO_DOWNLOAD = args.includes('--no-download-photos');

const BACKUP_DIR = path.join(__dirname, '..', 'backup');
const PHOTOS_DIR = path.join(BACKUP_DIR, 'photos');
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'service-account.json');

async function main() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.error('エラー: service-account.json が見つかりません。');
    console.error('Firebase Console > プロジェクトの設定 > サービスアカウント > 新しい秘密鍵の生成');
    console.error('ダウンロードした JSON を air/service-account.json に保存してください。');
    process.exit(1);
  }

  const admin = require('firebase-admin');
  const serviceAccount = require(SERVICE_ACCOUNT_PATH);

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  const db = admin.firestore();
  const bucketName = serviceAccount.project_id + '.firebasestorage.app';
  const bucket = admin.storage().bucket(bucketName);

  console.log('=== Air トリップ バックアップ＆クリア ===');
  if (DRY_RUN) console.log('※ DRY-RUN モード（実際の削除は行いません）\n');

  // 1. バックアップディレクトリ作成
  if (!DRY_RUN) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (!SKIP_PHOTO_DOWNLOAD) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  }

  // 2. Firestore: trips を取得
  const tripsSnap = await db.collection('trips').get();
  const trips = [];
  for (const doc of tripsSnap.docs) {
    trips.push({ id: doc.id, ...doc.data() });
  }
  console.log(`トリップ: ${trips.length} 件`);

  // 3. Firestore: users を取得
  const usersSnap = await db.collection('users').get();
  const users = [];
  for (const doc of usersSnap.docs) {
    users.push({ id: doc.id, ...doc.data() });
  }
  console.log(`ユーザー: ${users.length} 件`);

  // 4. 各トリップの GPX を取得
  for (const trip of trips) {
    if (trip.gpxDataUrl) {
      try {
        const res = await fetch(trip.gpxDataUrl);
        if (res.ok) {
          trip.gpxContent = await res.text();
        }
      } catch (e) {
        console.warn(`  GPX 取得失敗 ${trip.id}:`, e.message);
      }
    }
  }

  // 5. 写真をダウンロード（オプション）
  if (!SKIP_PHOTO_DOWNLOAD && !DRY_RUN) {
    for (const trip of trips) {
      const photos = trip.photos || [];
      if (photos.length === 0) continue;
      const tripPhotosDir = path.join(PHOTOS_DIR, trip.id);
      fs.mkdirSync(tripPhotosDir, { recursive: true });
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        if (!p.url) continue;
        try {
          const res = await fetch(p.url);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            const ext = (p.mime || 'image/jpeg').includes('png') ? 'png' : 'jpg';
            const fname = `${i}_${(p.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;
            fs.writeFileSync(path.join(tripPhotosDir, fname), buf);
          }
        } catch (e) {
          console.warn(`  写真取得失敗 ${trip.id}/${i}:`, e.message);
        }
      }
      console.log(`  写真ダウンロード: ${trip.id} (${photos.length}枚)`);
    }
  }

  // 6. バックアップ JSON を保存
  const backupData = {
    exportedAt: new Date().toISOString(),
    trips,
    users,
  };
  const backupPath = path.join(BACKUP_DIR, `backup_${Date.now()}.json`);
  if (!DRY_RUN) {
    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf8');
    console.log(`\nバックアップ保存: ${backupPath}`);
  } else {
    console.log(`\n[DRY-RUN] バックアップ先: ${backupPath}`);
  }

  // 7. クリア処理
  if (DRY_RUN) {
    console.log('\n[DRY-RUN] 以下を削除予定:');
    console.log('  - Storage: trips/*');
    console.log('  - Firestore: trips コレクション');
    console.log('  - Firestore: users の tripOrder');
    return;
  }

  // Storage: trips/* を削除
  try {
    const [files] = await bucket.getFiles({ prefix: 'trips/' });
    if (files.length > 0) {
      await bucket.deleteFiles({ prefix: 'trips/' });
      console.log(`Storage 削除: trips/* (${files.length} ファイル)`);
    } else {
      console.log('Storage: trips/* は空です');
    }
  } catch (e) {
    console.error('Storage 削除エラー:', e.message);
  }

  // Firestore: trips を削除
  const batch = db.batch();
  for (const doc of tripsSnap.docs) {
    batch.delete(doc.ref);
  }
  if (tripsSnap.docs.length > 0) {
    await batch.commit();
    console.log(`Firestore 削除: trips ${tripsSnap.docs.length} 件`);
  }

  // Firestore: users の tripOrder をクリア
  for (const doc of usersSnap.docs) {
    const data = doc.data();
    if (data.tripOrder && data.tripOrder.length > 0) {
      await doc.ref.update({ tripOrder: [] });
    }
  }
  console.log('users.tripOrder をクリアしました');

  console.log('\n完了: トリップ関連データをクリアしました。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
