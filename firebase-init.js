/**
 * Firebase 初期化
 * air.ktrips.net のとき authDomain を同一ホストに設定（iOS Safari 対策）
 */
(function() {
  if (typeof firebase === 'undefined') {
    console.warn('Firebase: CDN が読み込まれていません');
    return;
  }
  const config = typeof FIREBASE_CONFIG !== 'undefined' ? FIREBASE_CONFIG : window.FIREBASE_CONFIG;
  if (typeof config === 'undefined') {
    console.error('Firebase: firebase-config.js が読み込まれていません');
    console.error('→ ローカルサーバーで起動してください: python3 -m http.server 8080');
    console.error('→ 現在のURL:', window.location.href);
    return;
  }
  if (!config.apiKey || config.apiKey === 'YOUR_API_KEY') {
    console.error('Firebase: firebase-config.js に Firebase Console の値を入力してください');
    console.error('→ firebase-config.example.js を参考に設定してください');
    return;
  }
  console.log('Firebase: 設定ファイル読み込み完了', {
    projectId: config.projectId,
    authDomain: config.authDomain,
    storageBucket: config.storageBucket
  });
  try {
    const cfg = { ...config };
    const host = window.location.hostname || '';
    if (/^air\.ktrips\.net$/.test(host)) {
      cfg.authDomain = host;
      console.log('Firebase: authDomain を', host, 'に設定');
    }
    const app = firebase.initializeApp(cfg);
    window.firebaseApp = app;
    window.firebaseAuth = firebase.auth(app);

    // ログイン状態を永続化（ローカルストレージに保存）
    window.firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
      .then(() => {
        console.log('Firebase: 認証の永続化を設定しました（LOCAL）');
        console.log('Firebase: LocalStorageが利用可能です');
      })
      .catch((err) => {
        console.warn('Firebase: 認証の永続化設定エラー:', err);
        if (err.code === 'auth/web-storage-unsupported') {
          console.error('Firebase: ブラウザがLocalStorageをサポートしていません');
          console.error('→ プライベートモードを解除するか、Cookieを有効にしてください');
        }
      });
    const db = firebase.firestore(app);
    db.settings({
      ignoreUndefinedProperties: true,
      // プロキシ環境などWebSocket/gRPCが使えない場合のみ自動でロングポーリングにフォールバック。
      // 常時強制すると通常のブラウザでもストリーミング接続の恩恵を受けられず、
      // onSnapshot の初回到達や更新伝播に無駄なレイテンシが乗っていた。
      experimentalAutoDetectLongPolling: true
    });
    window.firebaseDb = db;
    window.firebaseStorage = firebase.storage(app);

    // Firestore 接続状態の監視
    db.enableNetwork().then(() => {
      console.log('Firebase: Firestore ネットワーク有効化完了');
    }).catch(err => {
      console.warn('Firebase: Firestore ネットワーク有効化エラー:', err);
    });

    console.log('Firebase: 初期化完了');
    window.dispatchEvent(new CustomEvent('firebase-ready'));
  } catch (err) {
    console.error('Firebase: 初期化エラー', err);
  }
})();
