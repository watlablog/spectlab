# SpectLab

Vite + TypeScript で構築した静的SPAです。`/login` でGoogleログインし、`/recording` へ遷移後にマイク入力を取得してリアルタイムでスペクトログラムを描画します。グラフはTime/Frequency軸をヒートマップ本体と同一Canvas上で描画し、横軸は10秒固定です。分析設定として `Frame size (512-8192)`、`Overlap [%] (0-99)`、`Upper [Hz] (5000/10000/20000)` を指定できます（初期値: `4096`, `75%`, `10000`）。`Upper [Hz]` に応じて `AudioContext` のサンプルレートは Nyquist 条件（`sampleRate >= 2 * Upper`）を満たす値を要求します。dB表示はPCM時間波形（-1〜1）からSTFTで振幅を算出し、`20 * log10(LIN / 2e-5)` で変換します。モバイルでは適応品質制御（FPS/DPR/解析頻度の段階調整）で長時間動作の安定化を行います。振幅レンジの初期値は `-20..80 dB` で、`Freq.Min / Freq.Max / Amp.Min / Amp.Max / Time.Min / Time.Max` をグラフ下の入力とダブルスライダで操作できます。停止中は現在の表示範囲の音声を `WAV` としてローカル保存できます。

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
- 録音中は `Frame size` と `Overlap [%]` と `Upper [Hz]` が無効化（グレーアウト）される
- `Overlap [%]` は Enter で確定し、`0-99` 範囲外や非数値は復帰する
- dBカラーバーに目盛りが表示され、`Max/Min` のEnter確定で色レンジが更新される
- 停止中に `表示範囲を保存` で現在の `Time.Min..Time.Max` がWAV保存される
- 停止時に直近10秒の取得PCMから再解析し、最終表示を補正する

### Auth
- Googleログイン成功後にユーザー表示が切り替わる
- リロード後にログイン状態が復元される
- ログアウトできる
- ポップアップ不可時にリダイレクトへフォールバックする

### Hosting
- `firebase deploy --only hosting` が成功する
- 本番URLでマイクが利用できる（HTTPS）
- 直接URLアクセスでもSPAが壊れない
