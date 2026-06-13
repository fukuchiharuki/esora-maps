# Esora Maps

架空のミニチュア交通マップ。**HTML / CSS / JS + Canvas 2D のみ**で動く自己完結アプリ。
サーバ・外部データ・ビルド・依存ライブラリは無し。

## 壊してはいけない前提
- **道路部品の接続契約**: 接続口は共有エッジの純関数（map.js の `portV`/`portH`）。隣接部品は必ず一致 → チャンク境界で道路が途切れない。
- **車両は通行パス上だけを走る**（`roadpart.lanePath`）。道路外に出さない。
- **交差点はデッドロックフリー**: クラスタ予約（`map.clusterKey`）は「踏み込む瞬間」にだけ取得する（接近中に握らない＝hold-and-wait 禁止）。
- **左側通行**。
- **タップで何も起こさない**（詳細表示・投稿・評価・検索・ログイン・現在地・外部遷移は禁止）。
- 起動は **HTTP 配信が必要**（ES モジュールは `file://` 不可）。PWA インストール / Service Worker は **HTTPS か localhost** が前提。

## マップ生成の決定論
- 乱数源は rng.js の `hash(x,y,salt)` のみ。**map.js / rng.js では `Math.random` を使わない**。
- `SEED`（config.js）は**読み込みごとにランダム・セッション中は固定** → スクロールで離れて戻ると同じ地形、リロードで別の街。環境変数 `ESORA_SEED` で固定可。
- `Math.random` は交通（vehicles.js）とカーチェイス（scenario.js）だけ → これらはリロードで変わる。

## モジュール構成（責務分割。main.js は初期化と接続のみ）
- config.js — 定数・方向テーブル・`SEED`
- rng.js — 決定論ハッシュ
- roadpart.js — 道路部品の契約（接続口＋通行パス）
- map.js — 道路網生成・接続トポロジ・バス停・交差点クラスタ
- vehicles.js — 車両モデルと走行ルール（追従減速・交差点予約・バス停車）
- camera.js — ビュー変換・ズーム
- render.js — 描画 ＋ カーチェイス発生アイコン（右下 HUD）
- input.js — ドラッグ / ピンチ / ホイール / ダブルタップ
- scenario.js — ScenarioEvent 基盤 ＋ カーチェイス（逃走車 vs パトカー。確保 or 逃げ切り）
- PWA: index.html ＋ manifest.webmanifest / sw.js / icon-*.png

## 規約
- コメントは日本語、既存スタイルに合わせる。
- 依存追加・ビルド導入はしない。Canvas 2D のみ。

## 動作確認
- ローカル表示: `python3 -m http.server` で配信 → ブラウザで開く。
- ヘッドレステスト（**リポジトリ外** `/tmp/esora-mod-test.mjs`。無ければ要再作成）:
  `ESORA_SEED=1923 node /tmp/esora-mod-test.mjs`
  （検証 A が固定シードの基準と道路トポロジを比較するため SEED 固定が必要）。
  マップ一致・通行パス・走行の不変条件（道路逸脱/重なり/デッドロック無し）・チェイス・アイコン・スポーン方向・決定論を検証。
