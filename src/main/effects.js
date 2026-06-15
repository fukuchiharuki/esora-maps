// =====================================================================
// effects — アプリ共通の一時的な視覚エフェクト
//
// 特定のオブジェクト (ゴミ等) の振る舞いではなく、アプリ全体で使い回す軽量な
// 視覚フィードバックを集約する。第一弾はタップ波紋 (タップが効いた合図)。
// 描画は render.js が担当し (drawScene 内・ワールド座標)、ここは状態 (寿命管理) だけを持つ。
//
// 動的な見た目なので決定論 (map) とは無関係。時刻はフレームのタイムスタンプ (ms) を受け取る。
// =====================================================================
export const effects = [];      // { x, y, t0 }  ワールド座標で広がる波紋
export const RIPPLE_DUR = 460;  // 波紋の寿命 (ms)

// (x,y) にタップ波紋を 1 つ足す (now = 発生時刻 ms)。
export function addRipple(x, y, now) {
  effects.push({ x, y, t0: now });
}

// 寿命を過ぎたエフェクトを取り除く (毎フレーム呼ぶ)。
export function updateEffects(now) {
  for (let i = effects.length - 1; i >= 0; i--) {
    if (now - effects[i].t0 >= RIPPLE_DUR) effects.splice(i, 1);
  }
}
