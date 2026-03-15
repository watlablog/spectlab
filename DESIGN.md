# DESIGN.md

## 1. Purpose

このプロジェクトは、**マイク入力をブラウザで取得し、スペクトログラムをリアルタイム描画する静的Webアプリ**を最小構成で実装するための設計書です。  
デプロイ先は **Firebase Hosting** を前提とし、アプリ本体は **Vite + TypeScript** で構築します。  
認証は **Firebase Authentication の Google ログインのみ**を採用し、サーバーサイドの独自APIや常時稼働バックエンドは持ちません。

この設計の中心思想は次の3点です。

- **静的ホスティングで完結すること**
- **音声解析はすべてブラウザ側で行うこと**
- **最初は最小構成で作り、後から録音保存・共有・解析拡張へ進めること**

Firebase Hosting は静的ファイル配信に適しており、単一ページアプリ（SPA）の配信にも向いています。Firebase Authentication は Web SDK から Google サインインを実装できます。音声の取得と周波数解析はブラウザの Web Audio API により実現します。 citeturn330493search0turn330493search1turn330493search4turn330493search10

---

## 2. Goals and Non-Goals

### 2.1 Goals

このフェーズで実現すること:

- ブラウザからマイク入力を取得する
- リアルタイムにスペクトログラムを描画する
- Firebase Hosting に `npm run build` → `firebase deploy --only hosting` でデプロイできる
- Google アカウントでログイン/ログアウトできる
- ログイン状態に応じて UI を切り替えられる
- 将来、録音保存や追加機能を入れやすい構成にする

### 2.2 Non-Goals

このフェーズではやらないこと:

- Python バックエンド
- 独自サーバーAPI
- 音声ファイルのクラウド保存
- ユーザーごとの録音履歴管理
- 高度な認可設計
- リアルタイム共同編集
- 重い機械学習推論をサーバーで実行する仕組み

---

## 3. Design Principles

### 3.1 Keep the app static-first

最初のリリースでは、**静的サイトとして成立すること**を優先します。  
アプリの本体は HTML / CSS / TypeScript のビルド成果物のみで構成し、Firebase Hosting から配信します。これにより、構成が単純になり、開発・デプロイ・保守が楽になります。Firebase Hosting は静的アセット配信と SPA 配信に適しています。 citeturn330493search0turn330493search4turn330493search6

### 3.2 Do DSP in the browser

スペクトログラム生成のコア処理は **ブラウザ側**で行います。  
具体的には、`getUserMedia()` でマイク入力を取得し、`AudioContext` と `AnalyserNode` を使って周波数データを得て、`canvas` に時系列で描画します。これにより、サーバー費用や通信待ちを減らし、無料枠でも成立しやすくなります。Web Audio API には可視化向けの標準的な流れがあります。 citeturn330493search0

### 3.3 Separate concerns clearly

将来拡張を考え、責務を分離します。

- Firebase 初期化
- 認証
- 音声入力
- スペクトログラム計算
- 描画
- UI 制御

この分離により、たとえば後で `AnalyserNode` から `AudioWorklet` に置き換える場合でも影響範囲を局所化できます。

### 3.4 Start with login as an app-shell feature

Google ログインは「機能本体」と強く結合させず、**アプリシェルの一部**として設計します。  
つまり、ログインそのものは録音・描画のコア処理と独立しておきます。これにより、後で

- 未ログインでも試用可能
- ログイン時のみ録音保存可能
- ログイン時のみ設定同期可能

のような段階的拡張がしやすくなります。

---

## 4. Architecture Overview

全体像は以下です。

```text
[Browser]
  ├─ UI (HTML/CSS)
  ├─ App State
  ├─ Firebase Web SDK
  │    ├─ Firebase App
  │    └─ Firebase Auth (Google)
  ├─ MediaDevices.getUserMedia()
  ├─ Web Audio API
  │    ├─ AudioContext
  │    ├─ MediaStreamAudioSourceNode
  │    └─ AnalyserNode
  └─ Canvas Rendering

[Firebase]
  ├─ Hosting
  └─ Authentication (Google provider)
```

ポイント:

- **Hosting** は静的ファイルを配信するだけ
- **Auth** は Google ログイン状態を管理
- **音声処理と描画はすべてクライアント内**
- **バックエンドAPIなし**

---

## 5. Recommended Tech Stack

### 5.1 Frontend

- **Vite**
- **TypeScript**
- 必要に応じて素の DOM 操作、または軽量な状態管理
- 描画は **HTML Canvas**

Vite は軽量で高速な開発サーバーとビルドを提供し、Firebase Hosting 用の静的成果物を作るのに相性が良いです。

### 5.2 Firebase

- **Firebase Hosting**
- **Firebase Authentication**
  - Google Provider のみ

Firebase の JavaScript セットアップでは、Web アプリを登録し、Firebase 構成オブジェクトを用いて SDK を初期化します。Google サインインは Firebase Auth の Web SDK で扱えます。 citeturn330493search1turn330493search10

### 5.3 Browser APIs

- `navigator.mediaDevices.getUserMedia`
- `AudioContext`
- `MediaStreamAudioSourceNode`
- `AnalyserNode`
- `requestAnimationFrame`
- `CanvasRenderingContext2D`

---

## 6. Authentication Strategy

### 6.1 Why Google sign-in only

最初の段階では認証方式を増やしません。

理由:

- Firebase Auth で導入しやすい
- 個人開発で UX がわかりやすい
- パスワード管理を自前で考えなくてよい
- 将来ユーザー識別子として `uid` を使いやすい

Firebase では Google 認証をプロバイダとして有効化し、Web SDK の `GoogleAuthProvider` とサインインAPIで実装できます。 citeturn330493search1turn330493search3

### 6.2 UI policy

最初の段階では、次のどちらかの方針を取れます。

#### Option A: ログイン必須で使う

- 未ログインではアプリを使えない
- ログイン後に録音・スペクトログラム開始が可能

#### Option B: 試用は誰でも可能、ログインは付加機能用

- 未ログインでもマイク入力と描画は可能
- ログインユーザーだけ追加機能を使える

**おすすめは Option B** です。  
理由は、音声可視化というコア機能の体験障壁を下げられるからです。

### 6.3 Auth state subscription

アプリ起動時に認証状態を購読し、UI を即座に切り替えます。

想定:

- `signed-out`
- `loading`
- `signed-in`

この3状態を明示的に持つと UI の見通しがよくなります。

---

## 7. Audio Processing Strategy

### 7.1 Minimum viable approach

最小構成では **`AnalyserNode` ベース** を推奨します。

理由:

- 実装が短い
- ブラウザ標準で扱える
- リアルタイム表示用途には十分
- 最初の成功体験が早い

流れ:

1. `getUserMedia({ audio: true })`
2. `AudioContext` 作成
3. `createMediaStreamSource(stream)`
4. `createAnalyser()`
5. `source.connect(analyser)`
6. 周波数データを取得
7. `canvas` に1列ずつ描画

### 7.2 Future upgrade path

将来、以下に進化できます。

- `AudioWorklet` によるより細かな制御
- 自前 FFT
- 窓関数の変更
- オーバーラップ処理の明示化
- 対数周波数軸表示
- メルスペクトログラム表示

ただし第1フェーズではやりません。

---

## 8. Spectrogram Rendering Strategy

### 8.1 Rendering model

スペクトログラムは「時間方向に流れる画像」として描画します。

一般的な方法:

- 新しいスペクトル列を右端に描画
- 既存画像を左へ1pxずつシフト
- 振幅に応じて色を決定

### 8.2 Color mapping

最初は単純なグレースケールまたは簡易ヒートマップを採用します。

例:

- 小振幅: 黒〜紺
- 中振幅: 青〜緑
- 大振幅: 黄〜赤

将来は以下も可能:

- dB スケール補正
- perceptual colormap
- 22色マップなど独自表現

### 8.3 Coordinate policy

- 横軸: 時間
- 縦軸: 周波数
- 下が低周波、上が高周波

最初は線形ビン表示で十分です。必要になれば対数変換します。

---

## 9. State Design

最小状態は以下で足ります。

```ts
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in'

export interface AppState {
  authStatus: AuthStatus
  userName: string | null
  isRecording: boolean
  hasMicPermission: boolean
  audioReady: boolean
}
```

補足:

- `isRecording` は厳密には「描画中」に近い意味でも良い
- `audioReady` は AudioContext や Analyser 準備完了を示す
- 複雑なグローバル状態管理ライブラリは不要

---

## 10. Folder Structure

推奨フォルダ構成は次の通りです。

```text
project-root/
├─ public/
│  └─ favicon.svg
├─ src/
│  ├─ main.ts
│  ├─ style.css
│  ├─ app/
│  │  ├─ app.ts
│  │  ├─ state.ts
│  │  └─ types.ts
│  ├─ firebase/
│  │  ├─ config.ts
│  │  ├─ init.ts
│  │  └─ auth.ts
│  ├─ audio/
│  │  ├─ microphone.ts
│  │  ├─ analyser.ts
│  │  └─ spectrogram.ts
│  ├─ render/
│  │  ├─ canvas.ts
│  │  └─ colorMap.ts
│  ├─ ui/
│  │  ├─ dom.ts
│  │  ├─ authView.ts
│  │  └─ controlsView.ts
│  └─ utils/
│     ├─ env.ts
│     └─ errors.ts
├─ .env.example
├─ .firebaserc
├─ firebase.json
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
└─ DESIGN.md
```

---

## 11. Folder Responsibilities

### `src/main.ts`

エントリーポイント。  
Firebase 初期化、アプリ初期化、イベント登録を呼び出します。

### `src/app/`

アプリ全体の制御。

- `app.ts`: 起動処理と全体フロー
- `state.ts`: 状態の保持と更新
- `types.ts`: 共通型

### `src/firebase/`

Firebase 関連を隔離します。

- `config.ts`: 環境変数から Firebase 設定を組み立てる
- `init.ts`: Firebase app / auth の初期化
- `auth.ts`: signIn / signOut / onAuthStateChanged のラッパー

### `src/audio/`

音声取得と周波数解析。

- `microphone.ts`: `getUserMedia`, stream 管理
- `analyser.ts`: `AudioContext`, `AnalyserNode` 構築
- `spectrogram.ts`: 周波数列取得や dB 変換など

### `src/render/`

描画専用。

- `canvas.ts`: canvas 初期化、スクロール描画
- `colorMap.ts`: 振幅→色のマッピング

### `src/ui/`

DOM 操作を担当。

- `dom.ts`: 要素取得ユーティリティ
- `authView.ts`: ログイン状態表示
- `controlsView.ts`: 開始/停止ボタン等

### `src/utils/`

汎用補助関数。

---

## 12. Example Environment Variables

`.env.example`

```env
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890
VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef123456
```

注意:

- これらはクライアントに配布される想定の公開設定値
- 秘密鍵ではない
- ただし **Security Rules や Auth 設定を正しく行うことが前提**

Firebase の Web セットアップでは、Web アプリ登録後に設定オブジェクトを取得してアプリへ組み込みます。 citeturn330493search10

---

## 13. Firebase Project Setup

### 13.1 Console side

Firebase コンソールで行うこと:

1. プロジェクト作成
2. Web アプリ登録
3. Authentication を有効化
4. Google プロバイダを有効化
5. Hosting を有効化

Google 認証は Firebase Authentication のサインイン方法として有効化します。Hosting は配信用です。 citeturn330493search1turn330493search6

### 13.2 Local side

ローカルで行うこと:

1. `npm create vite@latest`
2. Firebase SDK インストール
3. Firebase CLI セットアップ
4. `firebase init hosting`
5. 出力ディレクトリを `dist` に設定
6. SPA rewrite を設定

Firebase Hosting では `public` にデプロイ対象ディレクトリを指定でき、Vite の `dist` をそのまま使えます。SPA では rewrite 設定が有効です。 citeturn330493search4turn330493search6

---

## 14. Suggested `firebase.json`

```json
{
  "hosting": {
    "public": "dist",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  }
}
```

この rewrite は SPA ルーティング時の直接アクセス対策として有効です。Firebase Hosting の設定では、`public` ディレクトリと rewrites を定義できます。 citeturn330493search4

---

## 15. Module Design Notes

### 15.1 `firebase/init.ts`

責務:

- `initializeApp()` を呼ぶ
- `getAuth()` を返す
- 二重初期化を避ける

### 15.2 `firebase/auth.ts`

責務:

- `signInWithPopup` もしくは `signInWithRedirect` のラップ
- `signOut` のラップ
- `onAuthStateChanged` の購読

Google ログインは Firebase Auth の JavaScript SDK で実装できます。 citeturn330493search1turn330493search3

### 15.3 `audio/microphone.ts`

責務:

- マイク許可要求
- `MediaStream` の取得
- stop 処理

### 15.4 `audio/analyser.ts`

責務:

- `AudioContext` 作成
- `AnalyserNode` 作成
- FFT サイズや smoothing の設定

### 15.5 `audio/spectrogram.ts`

責務:

- `Uint8Array` / `Float32Array` の受け取り
- 描画用の周波数列へ整形
- 必要なら dB スケーリング

### 15.6 `render/canvas.ts`

責務:

- canvas サイズ調整
- 1列描画
- スクロール処理
- 再描画ループ

---

## 16. UX Policy

### 16.1 Initial screen

最初の画面に欲しいもの:

- タイトル
- 説明文
- Google ログインボタン
- ログインなしで試すボタン（任意）
- マイク開始ボタン
- 停止ボタン
- canvas 表示領域

### 16.2 Permission flow

マイク権限は **ユーザー操作の直後** に要求します。  
ページロード直後にいきなり要求しない方が UX が良いです。

### 16.3 Error messages

最低限ハンドリングすべきケース:

- マイク権限拒否
- AudioContext 開始失敗
- Firebase 初期化失敗
- Google ログイン失敗
- canvas 要素取得失敗

---

## 17. Security Considerations

### 17.1 Client-side config is public by design

Firebase の Web 設定値はフロントエンドに入ります。  
そのため「見えてはいけない秘密情報」として扱わず、代わりに Auth 設定・許可ドメイン・Rules で防御する設計にします。Firebase の Web セットアップでもクライアント側初期化が前提です。 citeturn330493search10

### 17.2 Restrict auth domains

Google ログインを使う場合は、承認済みドメインや本番URLを適切に管理します。

### 17.3 Do not trust UI state alone

後で Firestore や Storage を使う段階になったら、**UIで隠すだけでなく Rules で保護する**必要があります。

---

## 18. Deployment Flow

想定コマンド:

```bash
npm install
npm run build
firebase deploy --only hosting
```

Firebase Hosting はビルド済みの静的成果物を配信します。クイックスタートでも、Firebase CLI による初期化とデプロイの流れが案内されています。 citeturn330493search6

---

## 19. Development Phases

### Phase 1: Static spectrogram prototype

目標:

- マイク入力取得
- スペクトログラム描画
- Firebase なしでもローカルで動く

完了条件:

- `npm run dev` で動く
- 開始/停止ができる
- canvas にリアルタイム表示される

### Phase 2: Firebase Hosting integration

目標:

- Vite build 結果を Hosting に載せる
- SPA として配信できる

完了条件:

- `npm run build` 成功
- `firebase deploy --only hosting` 成功
- 本番URLでアクセス可能

### Phase 3: Google sign-in integration

目標:

- Firebase Auth 初期化
- Google ログイン/ログアウト
- ログイン状態反映

完了条件:

- ログインボタンが機能する
- 表示名またはメールを UI に出せる
- サインアウトできる

### Phase 4: UX hardening

目標:

- エラー表示改善
- モバイル対応
- 権限取得導線改善

### Phase 5: Optional future expansion

候補:

- Firestore にユーザー設定保存
- Storage に録音保存
- 録音再生
- 画像保存
- 対数周波数軸
- ML 推論連携

---

## 20. Testing Strategy

### 20.1 Manual test checklist

#### Audio

- マイク権限が要求される
- 許可すると描画開始できる
- 停止で描画が止まる
- 再開できる

#### Auth

- ログインボタンで Google 認証が開く
- 成功後にユーザー情報が表示される
- リロード後も状態が反映される
- ログアウトできる

#### Deploy

- Firebase Hosting 上で表示される
- HTTPS でマイクが使える
- 直接URLアクセスでも SPA が壊れない

### 20.2 Browser coverage

最低確認対象:

- Chrome desktop
- Safari (macOS / iPhone)
- Edge

補足:

- Safari 系は AudioContext 開始タイミングに注意
- HTTPS 環境でのマイク動作確認が重要

---

## 21. Future Expansion Ideas

この設計は、次のような機能に拡張しやすいようにしてあります。

- ログインユーザーごとの設定保存
- 録音波形 + スペクトログラムの同時表示
- ピーク周波数や基本周波数の推定
- 楽器練習向け UI
- 音声学習データ収集UI
- WebAssembly や ONNX Runtime Web による推論
- AudioWorklet ベースの高度解析

ただし、これらは**最初の成功体験を壊さない範囲で段階追加**するべきです。

---

## 22. Final Recommendation

最初に採用するべき方針は次の通りです。

- **Vite + TypeScript** で静的アプリを作る
- **Firebase Hosting** で配信する
- **Firebase Authentication の Google ログインだけ**を追加する
- **音声解析は Web Audio API でブラウザ側完結**にする
- **録音保存やバックエンドは後回し**にする

この構成は、最小限の複雑さで「ログインできるリアルタイム音声可視化アプリ」を成立させるうえで非常にバランスがよいです。Firebase Hosting は静的SPA配信に向いており、Firebase Authentication は Google ログインをWeb SDKで統合できます。 citeturn330493search0turn330493search1turn330493search4turn330493search6turn330493search10

