// =====================================================================
// litter — 路肩のゴミ (車両以外のワールドオブジェクト)
//
// 直線道路の路肩にゴミ袋が湧き、ゴミ収集車 (scenario.js) が回収する。
// ゴミは「ある方向に走る車の左路肩」に置く (左側通行なので、その方向の収集車が
// 寄せたときに横へ並ぶ位置 = roadpart.shoulderPoint)。タップのヒットテストと収集車の
// 回収・ハイライトは収集プール (collectible.js) に委譲する。
//
// 動的コンテンツなので乱数源は Math.random (map.js の決定論とは別。交通・チェイスと同じ扱い)。
// =====================================================================
import { TILE } from './config.js';
import { shoulderPoint } from './roadpart.js';
import { tileInfo } from './map.js';
import { rect } from './camera.js';
import { createCollectiblePool } from './collectible.js';

// ゴミの収集プール。litter は items への別名 (既存 API 互換)。要素 = { id, x, y, dir, hl }。
export const litterPool = createCollectiblePool();
export const litter = litterPool.items;

const MAX_LITTER = 6;              // 視界付近に保つ最大数
const SPAWN_CHANCE = 0.05;         // 1 フレームあたりのスポーン確率 (少なめに湧く)

// 直線タイル (2 口・相対) ならその通行方向ペアを返す。違えば null。
export function straightDirs(t) {
  const c = t.conns;
  if (c[0] && c[2] && !c[1] && !c[3]) return [0, 2];
  if (c[1] && c[3] && !c[0] && !c[2]) return [1, 3];
  return null;
}

// 直線タイル (tx,ty) の、通行方向 dir の左路肩にゴミを作る。
export function makeLitter(tx, ty, dir, along = 0.5) {
  const p = shoulderPoint(dir, along);
  return litterPool.add({ x: tx * TILE + p.x, y: ty * TILE + p.y, dir });
}

// 以下はプールへの委譲 (既存 API を維持)。ハイライトはゴミプール内で一度に 1 つ。
export function removeLitter(g) { litterPool.remove(g); }
export function setHighlight(g) { litterPool.setHighlight(g); }
export function clearHighlight() { litterPool.clearHighlight(); }
export function nearestLitter(x, y, maxR) { return litterPool.nearest(x, y, maxR); }
export function collectAround(x, y, r) { return litterPool.collectAround(x, y, r); }

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
    const p = shoulderPoint(dir, along), wx = tx * TILE + p.x, wy = ty * TILE + p.y;
    let tooClose = false;
    for (const o of litter) { if ((o.x - wx) ** 2 + (o.y - wy) ** 2 < 28 * 28) { tooClose = true; break; } }
    if (tooClose) continue;
    makeLitter(tx, ty, dir, along);
    return;
  }
}
