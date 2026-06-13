// 共有定数と方向テーブル。アプリ全体で使う素の設定値だけを置く。
export const TILE = 100;       // 道路部品の一辺 (ワールド単位)
export const ROAD_W = 36;      // 車道幅 (2車線)
export const SIDE_W = 46;      // 歩道込みの幅
export const LANE_OFF = 9;     // 中心線から車線中心までのオフセット
export const BAND = 5;         // 通りの配置バンド幅 (タイル数)
// マップ生成シード。リロード (ページ再読込) ごとに変わるが、セッション中は不変。
//   hash は (x, y, salt + SEED) の純関数なので、SEED がセッション内で固定であれば
//   同じタイルは何度でも同一に再生成される → スクロールで離れて戻っても同じ地形。
//   ページを読み込み直すと新しい SEED になり、別の街並みになる。
//   (テスト等で固定したい場合は環境変数 ESORA_SEED に数値を渡す)
export const SEED = (() => {
  if (typeof process !== 'undefined' && process.env && process.env.ESORA_SEED != null) {
    const n = parseInt(process.env.ESORA_SEED, 10);
    if (Number.isFinite(n)) return n | 0;
  }
  return Math.floor(Math.random() * 0x7fffffff) | 0;
})();
export const MIN_ZOOM = 0.3, MAX_ZOOM = 3.2;

// 方向: 0=N 1=E 2=S 3=W
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
export const OPP = d => (d + 2) % 4;
