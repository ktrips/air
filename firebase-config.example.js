/**
 * Firebase 設定（テンプレート）
 * このファイルを firebase-config.js にコピーし、Firebase Console の値を入力してください。
 * cp firebase-config.example.js firebase-config.js
 *
 * Firebase Console: https://console.firebase.google.com/
 * プロジェクト設定 → 一般 → マイアプリ → 設定オブジェクト
 *
 * air.ktrips.net 用: Firestore はネイティブモード・asia-northeast1 で作成してください。
 */
const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
