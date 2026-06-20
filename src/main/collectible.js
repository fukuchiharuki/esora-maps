// =====================================================================
// collectible — 収集可能なワールドオブジェクトのプール (共有メカニクス)
//
// 路肩のゴミ (litter.js) と郵便物 (mail.js) は「タップでハイライトされ、特別車が
// 向かって路肩へ寄せ、範囲内をまとめて回収する」点で同じ振る舞いを持つ。その共通部分
// (配列の管理・最寄り探索・範囲回収・ハイライト) をプールとして 1 箇所に集約する。
// 生成側 (litter / mail) は座標 (x,y) や dir 等を載せて add し、回収/タップ/誘導は
// プールの純操作を通す。各プールのハイライトは独立 (= ゴミと郵便物で別々に光る)。
//
// オブジェクトは少なくとも { id, x, y, hl } を持つ (id/hl は add が付与する)。
// 動的コンテンツなので決定論 (map) とは無関係。
// =====================================================================
let poolObjId = 0; // 全プール横断で一意な id (識別用)

export function createCollectiblePool() {
  const items = [];
  return {
    items,
    // オブジェクトを追加 (id と hl=false を付与して返す)。x,y,dir 等は呼び出し側が設定済み。
    add(obj) { obj.id = ++poolObjId; obj.hl = false; items.push(obj); return obj; },
    // 取り除く (回収/消滅)
    remove(obj) { const i = items.indexOf(obj); if (i >= 0) items.splice(i, 1); },
    // (x,y) に最も近いオブジェクトを maxR 以内で返す (タップのヒットテスト用)。無ければ null。
    nearest(x, y, maxR) {
      let best = null, bestD = maxR * maxR;
      for (const o of items) {
        const dd = (o.x - x) ** 2 + (o.y - y) ** 2;
        if (dd <= bestD) { bestD = dd; best = o; }
      }
      return best;
    },
    // (x,y) 半径 r 内のオブジェクトを回収 (除去)。回収した要素の配列を返す (件数は .length)。
    collectAround(x, y, r) {
      const removed = [];
      for (let i = items.length - 1; i >= 0; i--) {
        const o = items[i];
        if ((o.x - x) ** 2 + (o.y - y) ** 2 <= r * r) { items.splice(i, 1); removed.push(o); }
      }
      return removed;
    },
    // ハイライト (特別車の目的地) は一度に 1 つ。obj=null で全解除。タップでの誘導切替・
    // 回収/誘導解除のたびに呼ぶ (常に最新の目的地だけが光る)。
    setHighlight(obj) { for (const o of items) o.hl = (o === obj); },
    clearHighlight() { for (const o of items) o.hl = false; },
  };
}
