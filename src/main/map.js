// =====================================================================
// マップ配置 (道路網生成)
//
// 道路部品を無限平面上のどこに置くかを決め、roadpart.js の接続契約
// (隣接部品の接続口が一致する) を必ず満たすように生成する。
//
//  - アーテリアル: 各バンドに縦/横の通りを 1 本ずつ配置 (無限直線)。
//  - コネクタ: ブロック (アーテリアルで囲まれた内部) を貫通する
//    スパー/L字。T 字・カーブを生むが、必ずアーテリアル間を貫通する
//    経路なので行き止まり (次数 1) を作らない。
//  - 接続口は「辺」の純関数 (portV/portH) として定義 → 隣接タイルは
//    同じ辺を参照するので、どのタイルを単独生成しても一致する。
//  - clusterKey: 隣接する交差点を 1 予約単位にまとめる (デッドロック回避)。
// =====================================================================
import { BAND, DX, DY } from './config.js';
import { hash, fmod } from './rng.js';

// 各バンド (幅 BAND タイル) に縦/横の通りを 1 本ずつ。
// バンド内オフセットを 1..BAND-2 に絞ることで通り同士の最小間隔を確保。
export function isStreetCol(tx) {
  const k = Math.floor(tx / BAND);
  return fmod(tx, BAND) === 1 + hash(k, 71, 11) % (BAND - 2);
}
export function isStreetRow(ty) {
  const k = Math.floor(ty / BAND);
  return fmod(ty, BAND) === 1 + hash(97, k, 23) % (BAND - 2);
}

// 最寄りアーテリアル探索 (バンド内に必ず 1 本あるので有限ステップ)
function prevArtCol(x) { while (!isStreetCol(x)) x--; return x; }
function nextArtCol(x) { while (!isStreetCol(x)) x++; return x; }
function prevArtRow(y) { while (!isStreetRow(y)) y--; return y; }
function nextArtRow(y) { while (!isStreetRow(y)) y++; return y; }

// ブロック (隣接アーテリアルで囲まれた内部矩形) ごとの「コネクタ」。
// 各コネクタは必ず境界アーテリアル間を貫通する経路 (直線スパー / L字) なので、
// 通過タイルは必ず次数 2 以上 → 行き止まり (次数 1) を生まない。
// セグメントは辺インデックス (portV/portH の引数) で表現する。
const blockCache = new Map();
function connectorsForBlock(cL, cR, rT, rB) {
  const key = cL + ',' + rT;
  let b = blockCache.get(key);
  if (b) return b;
  const vsegs = [], hsegs = [];
  const iw = cR - cL - 1, ih = rB - rT - 1; // 内部の幅・高さ (タイル数)
  if (iw >= 1 && ih >= 1) {
    // スパー/曲がり角はブロック中央寄りに置く (=アーテリアル交差点から離す)。
    // T 字が交差点クロスに近接して短いループを作るとグリッドロックしやすいため。
    const mid = (lo, span, salt) => span <= 2 ? lo + 1 + hash(cL, rT, salt) % span
                                              : lo + 2 + hash(cL, rT, salt) % (span - 2);
    const cS = mid(cL, iw, 701); // [cL+2, cR-2] (内部が広い時) / 端寄り許容 (狭い時)
    const rS = mid(rT, ih, 702);
    const pick = hash(cL, rT, 911) % 100;
    if (pick < 12) {                 // 縦スパー (両端 T 字)
      vsegs.push({ c: cS, y0: rT + 1, y1: rB });
    } else if (pick < 24) {          // 横スパー
      hsegs.push({ r: rS, x0: cL + 1, x1: cR });
    } else if (pick < 33) {          // L字: 上→右 (曲がり角 N+E)
      vsegs.push({ c: cS, y0: rT + 1, y1: rS }); hsegs.push({ r: rS, x0: cS + 1, x1: cR });
    } else if (pick < 42) {          // L字: 上→左 (N+W)
      vsegs.push({ c: cS, y0: rT + 1, y1: rS }); hsegs.push({ r: rS, x0: cL + 1, x1: cS });
    } else if (pick < 51) {          // L字: 下→右 (S+E)
      vsegs.push({ c: cS, y0: rS + 1, y1: rB }); hsegs.push({ r: rS, x0: cS + 1, x1: cR });
    } else if (pick < 60) {          // L字: 下→左 (S+W)
      vsegs.push({ c: cS, y0: rS + 1, y1: rB }); hsegs.push({ r: rS, x0: cL + 1, x1: cS });
    }                                // 60..99 (40%) はコネクタなし。ブロック内十字は廃止 (ループ過密回避)
  }
  b = { vsegs, hsegs };
  blockCache.set(key, b);
  return b;
}

// 接続口は「辺」の純関数 → 隣接タイルは同じ辺を参照するので必ず一致する。
// portV(tx,ty): タイル (tx,ty-1) と (tx,ty) の間の横辺を縦road が跨ぐか (= (tx,ty)の N 口)
function portV(tx, ty) {
  if (isStreetCol(tx)) return true;          // 縦アーテリアル
  const rT = prevArtRow(ty - 1), rB = nextArtRow(ty);
  if (rB - rT - 1 < 1) return false;
  const cL = prevArtCol(tx), cR = nextArtCol(tx);
  const blk = connectorsForBlock(cL, cR, rT, rB);
  for (const s of blk.vsegs) if (s.c === tx && ty >= s.y0 && ty <= s.y1) return true;
  return false;
}
// portH(tx,ty): タイル (tx-1,ty) と (tx,ty) の間の縦辺を横road が跨ぐか (= (tx,ty)の W 口)
function portH(tx, ty) {
  if (isStreetRow(ty)) return true;          // 横アーテリアル
  const cL = prevArtCol(tx - 1), cR = nextArtCol(tx);
  if (cR - cL - 1 < 1) return false;
  const rT = prevArtRow(ty), rB = nextArtRow(ty);
  const blk = connectorsForBlock(cL, cR, rT, rB);
  for (const s of blk.hsegs) if (s.r === ty && tx >= s.x0 && tx <= s.x1) return true;
  return false;
}

// タイル情報 (接続口の組 = 道路部品) を座標から決定論的に得る
const tileCache = new Map();
export function tileInfo(tx, ty) {
  const key = tx + ',' + ty;
  let t = tileCache.get(key);
  if (t) return t;
  // 接続口 [N, E, S, W] — すべて辺の純関数なので隣接と必ず一致
  const conns = [portV(tx, ty), portH(tx + 1, ty), portV(tx, ty + 1), portH(tx, ty)];
  const n = (conns[0] ? 1 : 0) + (conns[1] ? 1 : 0) + (conns[2] ? 1 : 0) + (conns[3] ? 1 : 0);
  const road = n > 0;
  const junction = n > 2;                    // T 字(3)・十字(4) は交差点
  // バス停・郵便ポスト: 直線部品 (相対する 2 口のみ) の一部に設置 (進行方向つき)。
  // ポストはバス停より少しまばらで、視覚衝突を避けるためバス停タイルには置かない。
  let stop = null, post = null;
  if (road && !junction) {
    const vert = conns[0] && conns[2] && !conns[1] && !conns[3];
    const horiz = conns[1] && conns[3] && !conns[0] && !conns[2];
    const straight = vert || horiz;
    if (straight && hash(tx, ty, 37) % 12 === 0) {
      const dir = vert ? (hash(tx, ty, 41) % 2 ? 0 : 2) : (hash(tx, ty, 41) % 2 ? 1 : 3);
      stop = { dir };
    }
    if (straight && !stop && hash(tx, ty, 53) % 14 === 0) {
      const dir = vert ? (hash(tx, ty, 59) % 2 ? 0 : 2) : (hash(tx, ty, 59) % 2 ? 1 : 3);
      post = { dir };
    }
  }
  t = { tx, ty, road, conns, junction, stop, post };
  if (tileCache.size > 20000) { tileCache.clear(); blockCache.clear(); clusterCache.clear(); }
  tileCache.set(key, t);
  return t;
}

// 交差点クラスタ: 隣接する交差点タイルを 1 つの予約単位にまとめる。
// これにより「隣り合う交差点」でも相互ロックによるデッドロックが起きない。
const clusterCache = new Map();
export function clusterKey(tx, ty) {
  const k0 = tx + ',' + ty;
  const cached = clusterCache.get(k0);
  if (cached) return cached;
  let mnx = tx, mny = ty, n = 0;
  const seen = new Set([k0]);
  const stack = [[tx, ty]];
  while (stack.length && n < 24) {
    const [x, y] = stack.pop(); n++;
    if (y < mny || (y === mny && x < mnx)) { mnx = x; mny = y; }
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d], kk = nx + ',' + ny;
      if (!seen.has(kk) && tileInfo(nx, ny).junction) { seen.add(kk); stack.push([nx, ny]); }
    }
  }
  const key = mnx + ',' + mny;
  for (const m of seen) clusterCache.set(m, key);
  return key;
}
