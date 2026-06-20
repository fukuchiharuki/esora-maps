// =====================================================================
// 道路部品の契約 (ビルディングブロックの契約面)
//
// 道路部品は 100x100 のタイル。契約は次の 2 面からなる:
//
//  1. 接続口 (connection ports): 部品は 4 辺 [N, E, S, W] それぞれに
//     接続口を持つ (conns[d]: boolean)。接続口は「辺」上に定義される規約な
//     ので、隣接する部品は同じ辺を共有する。したがって
//        部品 A の口 d  ==  隣接部品 B の口 OPP(d)
//     が常に成り立つ (この一致を保証するのがマップ配置側 = map.js の責務)。
//     接続口の本数で部品の種類が決まる: 2=直線/カーブ, 3=T字, 4=十字。
//     口が 3 つ以上 (= 交差点) かどうかで車両側の扱いが変わる。
//
//  2. 通行パス (traversal path): 車両は (進入辺 din, 退出辺 dout) で決まる
//     パス上だけを走る (lanePath)。左側通行 = 進行方向の左の車線を通る。
//     全部品で共通の幾何なので、(din, dout) の 12 通りだけで完結する。
//
// このモジュールは「部品とは何か」(契約) を定義し、どこに配置されるか
// (map.js)・誰が走るか (vehicles.js)・どう描くか (render.js) からは独立。
// =====================================================================
import { TILE, LANE_OFF, DX, DY, OPP } from './config.js';

// 進入点: 辺 d から入る車両 (左側通行 = 進行方向の左の車線を走る)
export const ENTRY = [
  { x: 50 + LANE_OFF, y: 0 },    // from N (南向きに進入 → 左 = 東側)
  { x: TILE, y: 50 + LANE_OFF }, // from E (西向き → 左 = 南側)
  { x: 50 - LANE_OFF, y: TILE }, // from S (北向き → 左 = 西側)
  { x: 0, y: 50 - LANE_OFF },    // from W (東向き → 左 = 北側)
];
// 退出点: 辺 d から出る車両
export const EXIT = [
  { x: 50 - LANE_OFF, y: 0 },    // to N (北向き → 左 = 西側)
  { x: TILE, y: 50 - LANE_OFF }, // to E (東向き → 左 = 北側)
  { x: 50 + LANE_OFF, y: TILE }, // to S (南向き → 左 = 東側)
  { x: 0, y: 50 + LANE_OFF },    // to W (西向き → 左 = 南側)
];

// (進入辺, 退出辺) → サンプル済みポリラインパス。全部品共通なのでキャッシュは 12 通り。
const pathCache = new Map();
export function lanePath(din, dout) {
  const key = din * 4 + dout;
  let p = pathCache.get(key);
  if (p) return p;
  const a = ENTRY[din], b = EXIT[dout];
  const pts = [];
  if (dout === OPP(din)) {
    pts.push({ x: a.x, y: a.y }, { x: b.x, y: b.y });
  } else {
    // 直角カーブ: 進入線と退出線の交点を制御点とする 2 次ベジェ
    const vin = { x: DX[OPP(din)], y: DY[OPP(din)] }; // 進入時の進行方向
    const c = vin.x === 0 ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
    const N = 14;
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      pts.push({
        x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
        y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
      });
    }
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  p = { pts, cum, len: cum[cum.length - 1] };
  pathCache.set(key, p);
  return p;
}

// 路肩点 (沿道オブジェクトの位置): dir 方向に走る車の左路肩 (左側通行なので、その方向の
// 特別車が寄せたとき横へ並ぶ側) のタイル内ローカル座標 (0..100)。along = 進行軸の位置 [0..1]。
// ゴミ・郵便ポスト・郵便物が同じ路肩位置に乗るための共有幾何 (回収幾何を一致させる)。
const SHOULDER_LAT = LANE_OFF + 8; // 車線中心から路肩 (= 寄せた特別車) までの横距離 ≒ 17
export function shoulderPoint(dir, along) {
  const hx = DX[dir], hy = DY[dir];   // 進行方向
  const lx = hy, ly = -hx;            // その左 (= 路肩側)
  const a = (along - 0.5) * 60;       // 進行軸に沿ったオフセット (±30 でタイル内に収める)
  return { x: 50 + lx * SHOULDER_LAT + hx * a, y: 50 + ly * SHOULDER_LAT + hy * a };
}

// パス上の距離 s → ローカル座標と接線方向 (out にインプレース書き込み)
export function pathPoint(path, s, out) {
  const { pts, cum, len } = path;
  s = Math.max(0, Math.min(s, len));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const segLen = cum[i] - cum[i - 1] || 1;
  const t = (s - cum[i - 1]) / segLen;
  const p0 = pts[i - 1], p1 = pts[i];
  out.x = p0.x + (p1.x - p0.x) * t;
  out.y = p0.y + (p1.y - p0.y) * t;
  out.hx = (p1.x - p0.x) / segLen;
  out.hy = (p1.y - p0.y) / segLen;
}
