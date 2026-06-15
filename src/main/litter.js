// =====================================================================
// litter — 路肩のゴミ (車両以外のワールドオブジェクト)
//
// 直線道路の路肩にゴミ袋が湧き、ゴミ収集車 (scenario.js) が回収する。
// ゴミは「ある方向に走る車の左路肩」に置く (左側通行なので、その方向の収集車が
// 寄せたときに横へ並ぶ位置)。タップのヒットテストと収集車の回収に使う座標を持つだけ。
//
// 動的コンテンツなので乱数源は Math.random (map.js の決定論とは別。交通・チェイスと同じ扱い)。
// =====================================================================
import { TILE, DX, DY, LANE_OFF } from './config.js';
import { tileInfo } from './map.js';
import { rect } from './camera.js';

export const litter = []; // { id, x, y, dir, hl }  dir = この袋を回収できる走行方向 (その左路肩に置く) / hl = ハイライト中
let litterId = 0;

const SHOULDER_LAT = LANE_OFF + 8; // 車線中心からゴミ (= 寄せた収集車) までの横距離 ≒ 17
const MAX_LITTER = 6;              // 視界付近に保つ最大数
const SPAWN_CHANCE = 0.05;         // 1 フレームあたりのスポーン確率 (少なめに湧く)

// 直線タイル (2 口・相対) ならその通行方向ペアを返す。違えば null。
export function straightDirs(t) {
  const c = t.conns;
  if (c[0] && c[2] && !c[1] && !c[3]) return [0, 2];
  if (c[1] && c[3] && !c[0] && !c[2]) return [1, 3];
  return null;
}

// dir 方向に走る車の左路肩のタイル内ローカル座標 (0..100)。along = 進行軸の位置 [0..1]。
function litterLocal(dir, along) {
  const hx = DX[dir], hy = DY[dir];   // 進行方向
  const lx = hy, ly = -hx;            // その左 (= 路肩側)
  const a = (along - 0.5) * 60;       // 進行軸に沿ったオフセット (±30 でタイル内に収める)
  return { x: 50 + lx * SHOULDER_LAT + hx * a, y: 50 + ly * SHOULDER_LAT + hy * a };
}

// 直線タイル (tx,ty) の、通行方向 dir の左路肩にゴミを作る。
export function makeLitter(tx, ty, dir, along = 0.5) {
  const p = litterLocal(dir, along);
  const g = { id: ++litterId, x: tx * TILE + p.x, y: ty * TILE + p.y, dir, hl: false };
  litter.push(g);
  return g;
}

export function removeLitter(g) {
  const i = litter.indexOf(g);
  if (i >= 0) litter.splice(i, 1);
}

// ハイライト (収集車が目的地にしているゴミ) は一度に 1 つ。render が「ゆっくり跳ねる」演出に使う。
// g=null で全解除。タップでの誘導切替・回収/誘導解除のたびに呼ぶ (常に最新の目的地だけが光る)。
export function setHighlight(g) {
  for (const o of litter) o.hl = (o === g);
}
export function clearHighlight() {
  for (const o of litter) o.hl = false;
}

// (x,y) に最も近いゴミを maxR 以内で返す (タップのヒットテスト用)。無ければ null。
export function nearestLitter(x, y, maxR) {
  let best = null, bestD = maxR * maxR;
  for (const g of litter) {
    const dd = (g.x - x) ** 2 + (g.y - y) ** 2;
    if (dd <= bestD) { bestD = dd; best = g; }
  }
  return best;
}

// (x,y) 半径 r 内のゴミを回収 (除去)。回収した数を返す。
export function collectAround(x, y, r) {
  let n = 0;
  for (let i = litter.length - 1; i >= 0; i--) {
    const g = litter[i];
    if ((g.x - x) ** 2 + (g.y - y) ** 2 <= r * r) { litter.splice(i, 1); n++; }
  }
  return n;
}

// 視界外のゴミを除去し、視界内の直線路肩に稀に新しいゴミを湧かせる (車両の manageVehicles 相当)。
export function manageLitter() {
  const r = rect(2), margin = 3 * TILE;
  const x0 = r.x0 * TILE - margin, y0 = r.y0 * TILE - margin;
  const x1 = (r.x1 + 1) * TILE + margin, y1 = (r.y1 + 1) * TILE + margin;
  for (let i = litter.length - 1; i >= 0; i--) {
    const g = litter[i];
    if (g.x < x0 || g.x > x1 || g.y < y0 || g.y > y1) litter.splice(i, 1);
  }
  if (litter.length >= MAX_LITTER || Math.random() > SPAWN_CHANCE) return;
  const vr = rect(0);
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx = vr.x0 + Math.floor(Math.random() * (vr.x1 - vr.x0 + 1));
    const ty = vr.y0 + Math.floor(Math.random() * (vr.y1 - vr.y0 + 1));
    const t = tileInfo(tx, ty);
    if (!t.road || t.junction) continue;
    const dirs = straightDirs(t);
    if (!dirs) continue;
    const dir = dirs[Math.floor(Math.random() * 2)];
    const along = 0.25 + Math.random() * 0.5;
    const p = litterLocal(dir, along), wx = tx * TILE + p.x, wy = ty * TILE + p.y;
    let tooClose = false;
    for (const o of litter) { if ((o.x - wx) ** 2 + (o.y - wy) ** 2 < 28 * 28) { tooClose = true; break; } }
    if (tooClose) continue;
    makeLitter(tx, ty, dir, along);
    return;
  }
}
