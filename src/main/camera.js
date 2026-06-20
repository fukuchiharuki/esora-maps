// =====================================================================
// カメラ / ビュー変換
//
// ワールド座標と画面座標の対応、ズーム、可視タイル矩形、初期配置、
// ダブルタップズームのアニメーションを一手に持つ。DOM には触れない
// (キャンバスのリサイズは render.js が行い、寸法を setViewport で渡す)。
// =====================================================================
import { TILE, MIN_ZOOM, MAX_ZOOM } from './config.js';
import { isStreetCol, isStreetRow } from './map.js';

export const cam = { x: TILE * 1.5, y: TILE * 1.5, zoom: 1.1 };
export const view = { cssW: 0, cssH: 0, dpr: 1 }; // 画面寸法 (render.resize が更新)
let zoomAnim = null;

export function setViewport(cssW, cssH, dpr) {
  view.cssW = cssW; view.cssH = cssH; view.dpr = dpr;
}

export function screenToWorld(sx, sy) {
  return {
    x: cam.x + (sx - view.cssW / 2) / cam.zoom,
    y: cam.y + (sy - view.cssH / 2) / cam.zoom,
  };
}

export function zoomAt(sx, sy, newZoom) {
  newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  const w = screenToWorld(sx, sy);
  cam.zoom = newZoom;
  cam.x = w.x - (sx - view.cssW / 2) / cam.zoom;
  cam.y = w.y - (sy - view.cssH / 2) / cam.zoom;
}

// 可視範囲を覆うタイル矩形 (marginTiles 分だけ外側に拡張)
export function rect(marginTiles) {
  const hw = view.cssW / 2 / cam.zoom, hh = view.cssH / 2 / cam.zoom;
  return {
    x0: Math.floor((cam.x - hw) / TILE) - marginTiles,
    y0: Math.floor((cam.y - hh) / TILE) - marginTiles,
    x1: Math.floor((cam.x + hw) / TILE) + marginTiles,
    y1: Math.floor((cam.y + hh) / TILE) + marginTiles,
  };
}

// 引き (低ズーム) ほど世界オブジェクト (車両・ゴミ・郵便物) を大きく描く描画スケール。
// 最寄り (MAX_ZOOM)=実寸(1)、最引き (MIN_ZOOM)=DRAW_SCALE_MAX 倍。render の描画と、
// 拡大表示されたアイコンの当たり判定 (郵便物の吹き出し位置) で同じ値を使う (単一ソース)。
const DRAW_SCALE_MAX = 3.0; // 乗用車 幅7.5 × 3.0 ≒ 22.5 ≒ 片車線 18 をしっかり超える
export function drawScale() {
  const t = (MAX_ZOOM - cam.zoom) / (MAX_ZOOM - MIN_ZOOM); // 0 = 最寄り … 1 = 最引き
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 + c * (DRAW_SCALE_MAX - 1);
}

// カメラを通りの交差点近くから開始
export function placeCamera() {
  for (let x = 0; x < 30; x++) {
    if (!isStreetCol(x)) continue;
    for (let y = 0; y < 30; y++) {
      if (!isStreetRow(y)) continue;
      cam.x = x * TILE + TILE / 2;
      cam.y = y * TILE + TILE / 2;
      return;
    }
  }
}

// ダブルタップズーム: 開始 / 取り消し / 毎フレームの前進
export function beginDoubleTapZoom(sx, sy, now) {
  const z1 = cam.zoom > 2.4 ? 1.1 : cam.zoom * 1.8;
  zoomAnim = { t0: now, dur: 240, z0: cam.zoom, z1: Math.min(MAX_ZOOM, z1), sx, sy };
}
export function cancelAnim() { zoomAnim = null; }
export function stepAnim(now) {
  if (!zoomAnim) return;
  const k = Math.min(1, (now - zoomAnim.t0) / zoomAnim.dur);
  const e = 1 - (1 - k) * (1 - k);
  zoomAt(zoomAnim.sx, zoomAnim.sy, zoomAnim.z0 + (zoomAnim.z1 - zoomAnim.z0) * e);
  if (k >= 1) zoomAnim = null;
}
