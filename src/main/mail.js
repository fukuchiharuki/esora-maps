// =====================================================================
// mail — 郵便物 (車両以外のワールドオブジェクト)
//
// 郵便ポスト (map.js の tile.post) の上にだけ稀に郵便物が湧き、郵便車 (scenario.js) が
// 回収する。郵便物の座標はポスト上 (= roadpart.shoulderPoint の点。ゴミと同じ路肩位置なので
// 回収幾何が収集車と一致する)。描画 (render.js) ではポストに対し吹き出しのように出すが、
// 当たり判定・回収・誘導に使う座標はこのポスト点。タップ/回収/ハイライトは収集プール
// (collectible.js) に委譲する。
//
// 動的コンテンツなので乱数源は Math.random (map.js の決定論とは別。交通・ゴミと同じ扱い)。
// =====================================================================
import { TILE } from './config.js';
import { shoulderPoint } from './roadpart.js';
import { tileInfo } from './map.js';
import { rect } from './camera.js';
import { createCollectiblePool } from './collectible.js';

// 郵便物の収集プール。mail は items への別名。要素 = { id, x, y, dir, hl }。dir = ポストの向き。
export const mailPool = createCollectiblePool();
export const mail = mailPool.items;

const MAX_MAIL = 4;          // 視界付近に保つ最大数 (ゴミより控えめ)
const SPAWN_CHANCE = 0.04;   // 1 フレームあたりのスポーン確率 (稀に湧く)

// 郵便物アイコン (吹き出し) をポスト点の上に出すオフセット (未スケール)。render が描画位置に、
// scenario がタップ判定の追加点 (吹き出しでもタップ可) に使う。実際の世界距離は ×drawScale。
export const BUBBLE_DY = 21;

// ポスト (tx,ty。向き dir) の上に郵便物を作る。座標はポスト点 (shoulderPoint(dir, 0.5))。
export function makeMail(tx, ty, dir) {
  const p = shoulderPoint(dir, 0.5);
  return mailPool.add({ x: tx * TILE + p.x, y: ty * TILE + p.y, dir });
}

// 回収済みで再湧きを抑制中のポスト (タイルキー "tx,ty")。郵便車が回収した直後は同じポストに
// 郵便物を湧かせない。この抑制はポストが画面表示範囲 (rect(0)) の外へ出たら解除する (manageMail)。
const collectedPosts = new Set();
const postKey = (tx, ty) => tx + ',' + ty;

// 郵便物が回収されたら、その所在ポスト (タイル) を抑制リストへ。座標 (x,y) はポスト点なので
// floor で所在タイルが求まる。scenario の収集フック (cfg.onCollect) から各回収物に対して呼ばれる。
export function noteCollected(item) {
  collectedPosts.add(postKey(Math.floor(item.x / TILE), Math.floor(item.y / TILE)));
}

// 視界外の郵便物を除去し、視界内のポスト上に稀に新しい郵便物を湧かせる (manageLitter 相当だが
// 対象は郵便ポストのみ → ゴミのように路肩全体には湧かず、ポスト上にだけ現れる)。
export function manageMail() {
  const r = rect(2), margin = 3 * TILE;
  const x0 = r.x0 * TILE - margin, y0 = r.y0 * TILE - margin;
  const x1 = (r.x1 + 1) * TILE + margin, y1 = (r.y1 + 1) * TILE + margin;
  for (let i = mail.length - 1; i >= 0; i--) {
    const g = mail[i];
    if (g.x < x0 || g.x > x1 || g.y < y0 || g.y > y1) mail.splice(i, 1);
  }
  // 画面表示範囲 (rect(0)) の外へ出た抑制ポストは解除する (= 再び郵便物を湧かせてよい)。
  const vr = rect(0);
  for (const key of [...collectedPosts]) {
    const c = key.indexOf(','), tx = +key.slice(0, c), ty = +key.slice(c + 1);
    if (tx < vr.x0 || tx > vr.x1 || ty < vr.y0 || ty > vr.y1) collectedPosts.delete(key);
  }
  if (mail.length >= MAX_MAIL || Math.random() > SPAWN_CHANCE) return;
  // 視界内のポストタイルのうち、まだ郵便物が無く・回収後抑制中でないものを集めて 1 つに湧かせる。
  const free = [];
  for (let ty = vr.y0; ty <= vr.y1; ty++) for (let tx = vr.x0; tx <= vr.x1; tx++) {
    const t = tileInfo(tx, ty);
    if (!t.post) continue;
    if (collectedPosts.has(postKey(tx, ty))) continue; // 回収後・画面内のうちは再湧きしない
    const p = shoulderPoint(t.post.dir, 0.5), wx = tx * TILE + p.x, wy = ty * TILE + p.y;
    if (mail.some(o => (o.x - wx) ** 2 + (o.y - wy) ** 2 < 4 * 4)) continue; // 既に郵便物あり
    free.push({ tx, ty, dir: t.post.dir });
  }
  if (!free.length) return;
  const pick = free[Math.floor(Math.random() * free.length)];
  makeMail(pick.tx, pick.ty, pick.dir);
}
