// 決定論的ハッシュ。同じ (x, y, salt) からは常に同じ値を返す。
// マップ生成と装飾 (建物色・公園の木など) の唯一の乱数源。
import { SEED } from './config.js';

export function hash(x, y, salt) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul((salt + SEED) | 0, 0x9e3779b9);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
export const rnd01 = (x, y, s) => hash(x, y, s) / 4294967296;
export const fmod = (n, m) => ((n % m) + m) % m;
