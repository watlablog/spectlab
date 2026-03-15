# SpectLab

Vite + TypeScript で構築した静的SPAです。`/login` でGoogleログインし、`/recording` へ遷移後にマイク入力を取得してリアルタイムでスペクトログラムを描画します。グラフはTime/Frequencyの目盛り付きで、横軸は10秒固定です。

## 1. Setup

```bash
cp .env.example .env.local
# .env.local に Firebase Web App の値を入力
npm install
npm run dev
```

## 2. Build

```bash
npm run build
npm run preview
```

## 3. Firebase Hosting Deploy

前提: Firebase プロジェクト作成済み、Google プロバイダ有効化済み、`firebase login` 済み。

```bash
firebase use <your_firebase_project_id>
npm run build
firebase deploy --only hosting
```

## 4. Manual Test Checklist

### Audio
- 開始クリック後にマイク許可ダイアログが表示される
- 許可後にスペクトログラムが連続更新される
- 停止で更新が止まり、再開できる
- 権限拒否時にエラーが表示される

### Auth
- Googleログイン成功後にユーザー表示が切り替わる
- リロード後にログイン状態が復元される
- ログアウトできる
- ポップアップ不可時にリダイレクトへフォールバックする

### Hosting
- `firebase deploy --only hosting` が成功する
- 本番URLでマイクが利用できる（HTTPS）
- 直接URLアクセスでもSPAが壊れない
