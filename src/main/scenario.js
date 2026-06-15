// =====================================================================
// ScenarioEvent — 道路を「出来事の舞台装置」にする仕組み
//
// 道路は単なる経路ではなく、稀に起きる出来事 (ScenarioEvent) の舞台になる。
// このモジュールはその汎用フレームワークと、第一弾「カーチェイス」を持つ。
//
// 【フレームワーク】
//   ScenarioEvent インスタンス = { update(dt, now), done:boolean, cleanup?() }
//   イベント定義 = { id, weight, spawn(now) -> event | null }
//   registerEvent(def) で定義を登録すると、マネージャ (updateScenarios) が
//   稀に (一度に 1 つ) スポーンし、毎フレーム update し、done で後始末する。
//
// 【契約の維持】
//   イベントが操る車両も、走行は通常車と同じ vehicles.js のルールに従う
//   (通行パス上のみ・追従減速・交差点予約)。シナリオが上書きするのは
//   「交差点での進路選択 (v.steer フック)」「速度上限」「見た目 (v.role)」だけ。
//   → 道路から外れない / 乗り物が重ならない / 交差点で待つ は保たれる。
//   確保時も特別扱いはせず vmax=0 で止めるだけ (v.parked で停止を許容)。
// =====================================================================
import { DX, DY, OPP, TILE } from './config.js';
import { vehicles, makeVehicle, removeVehicle, repositionVehicle, pullOver, returnToLane } from './vehicles.js';
import { tileInfo } from './map.js';
import { rect } from './camera.js';
import { litter, nearestLitter, collectAround, removeLitter, setHighlight, clearHighlight } from './litter.js';
import { addRipple } from './effects.js';

// 出来事の発生間隔 (秒)。次の発生までこの範囲のランダム時間あける = 稀。
const SCENARIO_MIN_GAP = 55;
const SCENARIO_MAX_GAP = 140;

// ---- フレームワーク本体 ----
const EVENT_DEFS = [];
export function registerEvent(def) { EVENT_DEFS.push(def); }

const active = [];
export const events = active;           // 進行中イベント (読み取り用)
let nextSpawnT = null;                   // 次にスポーンを許す時刻 (ms)
let lastNow = 0;                         // 直近フレームの時刻 (tapWorld のスポーン時刻に使う)

const randGap = () => (SCENARIO_MIN_GAP + Math.random() * (SCENARIO_MAX_GAP - SCENARIO_MIN_GAP)) * 1000;

function pickWeighted(defs) {
  let total = 0;
  for (const d of defs) total += d.weight || 1;
  let r = Math.random() * total;
  for (const d of defs) { r -= d.weight || 1; if (r <= 0) return d; }
  return defs[defs.length - 1];
}

// 毎フレーム: 進行中イベントを更新 → 終了を後始末 → 稀に新規スポーン
export function updateScenarios(dt, now) {
  lastNow = now;
  if (nextSpawnT === null) nextSpawnT = now + randGap();

  for (const ev of active) ev.update(dt, now);
  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i].done) {
      if (active[i].cleanup) active[i].cleanup();
      active.splice(i, 1);
      nextSpawnT = now + randGap();
    }
  }

  if (active.length === 0 && now >= nextSpawnT && EVENT_DEFS.length) {
    const ev = pickWeighted(EVENT_DEFS).spawn(now);
    if (ev) active.push(ev);
    else nextSpawnT = now + 4000; // 条件が整わなければ少し後に再試行
  }
}

// 即時スポーン (テスト/デモ用にレアタイマーを迂回)。成功すれば管理下に入れる。
export function forceSpawn(now, id = 'chase') {
  const def = EVENT_DEFS.find(d => d.id === id);
  if (!def) return null;
  const ev = def.spawn(now);
  if (ev) active.push(ev);
  return ev;
}

// =====================================================================
// 第一弾イベント: カーチェイス (逃走車 vs パトカー)
// =====================================================================

// 追跡: 交差点で、進行先タイルが逃走車に最も近づく口を選ぶ (貪欲追跡)
function pursue(tile, din, target) {
  let best = -1, bestD = Infinity;
  for (let d = 0; d < 4; d++) {
    if (!tile.conns[d] || d === din) continue;
    const cx = (tile.tx + DX[d]) * TILE + 50, cy = (tile.ty + DY[d]) * TILE + 50;
    const dd = (cx - target.x) ** 2 + (cy - target.y) ** 2;
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}

// 逃走: 基本は直進してその場から逃げ切り (= 一貫した方向にコミットして視界を抜けていく)、
// ときどき追跡車から最も遠ざかる口へ折れる。単調に巡回せず街を横切って逃げる。
function evade(tile, din, chaser) {
  const opts = [];
  for (let d = 0; d < 4; d++) if (tile.conns[d] && d !== din) opts.push(d);
  if (!opts.length) return -1;
  const straight = OPP(din);
  if (opts.includes(straight) && Math.random() < 0.7) return straight; // 大半は直進
  let best = -1, bestD = -Infinity; // 折れるときは追跡車から最も遠ざかる方へ
  for (const d of opts) {
    const cx = (tile.tx + DX[d]) * TILE + 50, cy = (tile.ty + DY[d]) * TILE + 50;
    const dd = (cx - chaser.x) ** 2 + (cy - chaser.y) ** 2;
    if (dd > bestD) { bestD = dd; best = d; }
  }
  return best;
}

// 役割を解除して通常車に戻す (逃げ切り時など。撤去せず交通に溶け込ませる)。
// 昇格前に控えた色・速度があれば復元する。
function normalize(v) {
  if (vehicles.indexOf(v) < 0) return;
  v.role = null;
  v.steer = null;
  v.vmax = v._origVmax != null ? v._origVmax : 38;
  v.juncCap = 18; v.curveCap = 15; // 通常車の既定値に戻す (チェイス用の控えめ減速を解除)
  v.accel = 26; v.decel = 80;      // 加減速も既定値に戻す
  v.lat = 0; v.latTarget = 0; v.aside = false; // 路肩寄せ状態も解除 (車線へ戻す)
  if (v._origColor != null) v.color = v._origColor;
  v._origColor = null; v._origVmax = null;
}

// チェイス挙動パラメータ
const CHASE_SPAWN_BAND = 4;     // 視界の外側この範囲 (タイル) からスポーン
const CHASE_DESPAWN_MARGIN = 3; // 視界からこのタイル数以上離れたら撤去 (逃げ切り経路)
const CHASE_MAX_LIFE = 60000;   // 安全策: 視界内を巡回し続けた場合この時間で打ち切り (ms)
const CHASE_JUNC_CAP = 30;      // チェイス車の交差点速度上限 (通常車 18 より速い = 減速控えめ)
const CHASE_CURVE_CAP = 24;     // チェイス車のカーブ速度上限 (通常車 15 より速い = 減速控えめ)
const CHASE_ACCEL = 60;         // チェイス車の加速度 (通常車 26 より機敏)
const CHASE_DECEL = 200;        // チェイス車の減速度 (通常車 80 より強い → 高速でも追突回避)
const CHASE_POLICE_DECEL = 320; // パトカーの減速度 (高 vmax + カーブ無減速でも前方車に追従し追突回避)
const CAPTURE_DIST = 30;        // パトカーが逃走車をこの距離 (中心間) まで詰めたら確保。
                                // 追従減速の定常車間 (直線で約 40) より小さく、カーブ/渋滞/交差点
                                // 手前で逃走車が落ちた時だけ届く値 → 開けた直線では逃げ切れる。
const CAPTURE_HOLD = 0.05;      // この秒数だけ接近を維持したら確保確定 (一瞬の誤検出は防ぎつつ、
                               // 直線で詰めるパトカーが逃走車に重なる前に急停止できるよう短め)

// 確保: その場で急停止 (speed=0) し路肩へ寄せて、以後動かさない。役割・見た目はそのまま
// (パトカーは点灯継続)。parked にしてグリッドロック撤去の対象外とし、通常車と同じくスクロール
// でのみデスポーンさせる。逃走車・パトカーの双方に対して呼ぶ (接近 → 確保 → 両者急停止)。
function capture(v) {
  pullOver(v);   // 路肩に寄せる (横移動は毎フレーム補間)
  v.steer = null;
  v.speed = 0;   // 減速ではなく急停止
  v.vmax = 0;
  v.stuckT = 0;
  v.parked = true;
}

// 確保可能か: 直線上で、パトカーが逃走車を「同方向に・至近距離まで」詰めているとき。
// 直線限定なのは、確保後に両車を路肩へ寄せる際カーブ/交差点だと舗装外に出てしまうため
// (交差点内は予約ロック保持/重なりの問題もあるので元から除外)。
const isStraightTile = (t) => {
  const c = t.conns;
  return !t.junction && ((c[0] && c[2] && !c[1] && !c[3]) || (c[1] && c[3] && !c[0] && !c[2]));
};
function canCapture(police, flee) {
  const ftile = tileInfo(Math.floor(flee.x / TILE), Math.floor(flee.y / TILE));
  const ptile = tileInfo(Math.floor(police.x / TILE), Math.floor(police.y / TILE));
  if (!isStraightTile(ftile) || !isStraightTile(ptile)) return false;
  const dx = flee.x - police.x, dy = flee.y - police.y;
  if (dx * dx + dy * dy > CAPTURE_DIST * CAPTURE_DIST) return false;
  return police.hx * flee.hx + police.hy * flee.hy >= 0.3; // 背後に詰めた (向きが揃った) ときだけ
}

// 現在の可視範囲のワールド矩形
function viewBoxWorld() {
  const r = rect(0);
  return { x0: r.x0 * TILE, y0: r.y0 * TILE, x1: (r.x1 + 1) * TILE, y1: (r.y1 + 1) * TILE };
}
const inBox = (v, b) => v.x >= b.x0 && v.x <= b.x1 && v.y >= b.y0 && v.y <= b.y1;
// 可視範囲を margin タイル広げた矩形の外にいるか
function outsideBy(v, margin) {
  const b = viewBoxWorld(), m = margin * TILE;
  return v.x < b.x0 - m || v.x > b.x1 + m || v.y < b.y0 - m || v.y > b.y1 + m;
}

function makeChaseEvent(flee, police, now) {
  return {
    id: 'chase', flee, police, t0: now, seen: false, captured: false, closeT: 0, done: false,
    update(dt, t) {
      const alive = v => vehicles.indexOf(v) >= 0;

      // 確保後: 両車は停止 (vmax=0 / parked) したまま。通常の乗用車と同じく、画面の
      // スクロールで視界外へ出たとき manageVehicles に撤去される。両方が消えたら終了。
      if (this.captured) {
        if (!alive(flee) && !alive(police)) this.done = true;
        return;
      }

      // 確保前にどちらかが (グリッドロック撤去などで) 消えたら、役割を戻して終了
      if (!alive(flee) || !alive(police)) { normalize(flee); normalize(police); this.done = true; return; }

      // 一度でも視界に入ったか
      const b = viewBoxWorld();
      if (!this.seen && (inBox(flee, b) || inBox(police, b))) this.seen = true;

      // ---- 確保判定: パトカーが逃走車を至近距離まで (一瞬でなく継続して) 詰めたら確保。
      //      確保後は両車とも停止し、デスポーンは通常車と同じ (スクロール) になる。
      if (canCapture(police, flee)) {
        this.closeT += dt;
        if (this.closeT >= CAPTURE_HOLD) { capture(flee); capture(police); this.captured = true; return; }
      } else {
        this.closeT = 0;
      }

      // ---- 逃げ切り (従来どおり): 視界に入った後、両車が視界外へ十分離れたら撤去
      if (this.seen && outsideBy(flee, CHASE_DESPAWN_MARGIN) && outsideBy(police, CHASE_DESPAWN_MARGIN)) {
        removeVehicle(flee); removeVehicle(police); this.done = true;
      } else if (t - this.t0 > CHASE_MAX_LIFE) {
        // 安全策 (視界内を巡回し続けた等): 通常車に戻し、自然に視界外で消えるに任せる
        normalize(flee); normalize(police); this.done = true;
      }
    },
  };
}

// スポーン: 走っている乗用車の 1 台を逃走車 (黒) に昇格させ、それを追うパトカーを出す。
function spawnChase(now) {
  if (active.some(e => e.id === 'chase')) return null; // 同時に 2 つ以上出さない
  // 1) 逃走車にする乗用車を選ぶ: 見えている通常車 (非バス) を優先。視界内に無ければ
  //    すぐ外 (1 タイル) まで許容。それも無ければ出さない。
  //    (見えている車が逃走車になる演出。パトカーは画面外から向かってくる)。
  const b = viewBoxWorld(), M = TILE;
  const cars = vehicles.filter(v => !v.bus && !v.role);
  const strict = cars.filter(v => inBox(v, b));
  const pool = strict.length ? strict
    : cars.filter(v => v.x >= b.x0 - M && v.x <= b.x1 + M && v.y >= b.y0 - M && v.y <= b.y1 + M);
  if (!pool.length) return null;
  const flee = pool[(Math.random() * pool.length) | 0];

  // 2) パトカーを生成 (努力目標: 画面外)。置けなければ昇格させずに中止。
  const police = spawnPolice(flee);
  if (!police) return null;

  // 3) 逃走車に昇格 (黒い乗用車)。元の色・速度は控えて、解除時に戻せるようにする。
  //    チェイス車 (逃走車/パトカー) はカーブ・交差点での減速を控えめにする (通常車より速く抜ける)。
  flee._origColor = flee.color; flee._origVmax = flee.vmax;
  flee.role = 'flee'; flee.color = '#1b1d22'; flee.vmax = 50;
  flee.juncCap = CHASE_JUNC_CAP; flee.curveCap = CHASE_CURVE_CAP;
  flee.accel = CHASE_ACCEL; flee.decel = CHASE_DECEL;
  // パトカーは交差点・カーブで減速しない (上限なし)。位置関係由来の減速 (前方車への追従減速・
  // 交差点予約待ち) は vehicles.js 側に残るので、他車に追突したり予約中の交差点へ突っ込まない。
  // 減速度は強め (高速 vmax でも前方の遅い車・逃走車にカーブで追突しないよう追従目標へ追従できる)。
  police.juncCap = Infinity; police.curveCap = Infinity;
  police.accel = CHASE_ACCEL; police.decel = CHASE_POLICE_DECEL;
  flee.steer = (tile, dn) => evade(tile, dn, police);
  police.steer = (tile, dn) => pursue(tile, dn, flee);
  vehicles.push(police);
  return makeChaseEvent(flee, police, now);
}

// パトカーを生成して返す (まだ push しない)。努力目標として画面外の直線道路 (逃走車の
// 背後側) を優先し、無ければ逃走車近傍 (画面内可) の背後にフォールバック。前方には湧かせない。
function spawnPolice(flee) {
  const r = rect(0), N = CHASE_SPAWN_BAND;
  const isH = c => c[1] && c[3] && !c[0] && !c[2];     // 横の直線
  const isV = c => c[0] && c[2] && !c[1] && !c[3];     // 縦の直線
  const cands = []; // { t, din, dout }
  const add = (tx, ty, want, din, dout) => {
    const t = tileInfo(tx, ty);
    if (t.road && !t.junction && want(t.conns)) cands.push({ t, din, dout });
  };
  // 画面外バンド (4 辺) → 視界へ入る向き
  for (let ty = r.y0; ty <= r.y1; ty++) {
    for (let tx = r.x0 - N; tx <= r.x0 - 1; tx++) add(tx, ty, isH, 3, 1); // 左外 → 東進
    for (let tx = r.x1 + 1; tx <= r.x1 + N; tx++) add(tx, ty, isH, 1, 3); // 右外 → 西進
  }
  for (let tx = r.x0; tx <= r.x1; tx++) {
    for (let ty = r.y0 - N; ty <= r.y0 - 1; ty++) add(tx, ty, isV, 0, 2); // 上外 → 南進
    for (let ty = r.y1 + 1; ty <= r.y1 + N; ty++) add(tx, ty, isV, 2, 0); // 下外 → 北進
  }
  // 逃走車の進行方向 (前方) には湧かせない (向かってくる逃走車と正面ですれ違うため)。
  // 画面外バンドのうち背後〜側方 (ahead<=0) の候補だけを残す。
  const ahead = c => (c.t.tx * TILE + 50 - flee.x) * flee.hx + (c.t.ty * TILE + 50 - flee.y) * flee.hy;
  let pick = cands.filter(c => ahead(c) <= 0);

  // 画面外バンドに背後候補が無ければ、逃走車近傍 (画面内も可) の背後タイルにフォールバック。
  // (逃走車が来た側＝背後には道路がある事が多いので、ほぼ必ず背後から出せる。前方には出さない)。
  if (!pick.length) {
    const ftx = Math.floor(flee.x / TILE), fty = Math.floor(flee.y / TILE);
    const near = [];
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (Math.abs(dx) + Math.abs(dy) < 3) continue;
      const tx = ftx + dx, ty = fty + dy, t = tileInfo(tx, ty);
      if (!t.road || t.junction || !(isH(t.conns) || isV(t.conns))) continue;
      const cx = tx * TILE + 50, cy = ty * TILE + 50, dirs = [];
      for (let d = 0; d < 4; d++) if (t.conns[d]) dirs.push(d);
      let dout = dirs[0], bs = -Infinity;
      for (const d of dirs) { const sc = DX[d] * (flee.x - cx) + DY[d] * (flee.y - cy); if (sc > bs) { bs = sc; dout = d; } }
      near.push({ t, din: dirs[0] === dout ? dirs[1] : dirs[0], dout });
    }
    pick = near.filter(c => ahead(c) <= 0);
  }
  if (!pick.length) return null;

  // 逃走車に近い順に試す
  const dist = c => (c.t.tx * TILE + 50 - flee.x) ** 2 + (c.t.ty * TILE + 50 - flee.y) ** 2;
  pick.sort((a, b) => dist(a) - dist(b));
  for (const { t, din, dout } of pick) {
    const p = makeVehicle(t.tx, t.ty, din, dout, false);
    // パトカーは逃走車 (vmax 50) より明確に速い → 画面外から追いつき、減速地点 (カーブ/
    // 渋滞/交差点手前) で背後に詰めて確保しうる。直線では追従減速で車間が開くので逃げ切りも残る。
    p.role = 'police'; p.color = '#eaf0f7'; p.vmax = 120;
    p.s = p.path.len * 0.5; repositionVehicle(p);
    if (vehicles.some(o => (o.x - p.x) ** 2 + (o.y - p.y) ** 2 < 28 * 28)) continue; // 近接で却下
    return p;
  }
  return null;
}

registerEvent({ id: 'chase', weight: 1, spawn: spawnChase });

// =====================================================================
// 第二弾イベント: ゴミ収集 (ゴミ収集車 vs 路肩のゴミ)
//
// 路肩のゴミ (litter.js) を回収して回る収集車。稀に湧き、同時に 1 台 (努力目標)。
// ユーザーの操作なしにはゴミを探索しない: 目的地 (タップで「ハイライト」されたゴミ) があるときだけ
// それへ向かい、回収できる距離まで来たら路肩へ寄せて (= 停止して) 回収する。ハイライトが無ければ
// ただ走る。ゴミをタップするとそのゴミがハイライトされ目的地になる (居なければスポーンして向かう)。
// =====================================================================
const GARBAGE_PULLOVER_R = 14;  // 目的地のゴミがこの沿道距離 (前方) に来たら路肩へ寄せ始める (= 寄せ切ると停止して回収)
const GARBAGE_COLLECT_R = 40;   // 路肩へ寄せ切った収集車がこの距離内のゴミを回収 (道路幅をまたいで対向路肩も届く / 並行路≧約66 は届かない)
const GARBAGE_LANE_R = 44;      // この横 (車線差) 距離内のゴミだけ対象 (同じ道路の両車線=最大約34。並行する別の道路≧約66 は除外)
const GARBAGE_DRIVE_VMAX = 28;  // 通常走行速度 (トラックなので控えめ)
const GARBAGE_COLLECT_SPEED = 6;// 回収位置まで路肩を詰める徐行速度 (寄せ切れば aside で停止)
const GARBAGE_COLLECT_DELAY = 1.0; // 路肩へ寄せ切ってから回収するまでの待ち (秒。路肩作業の演出)
const GARBAGE_MAX_LIFE = 90000; // 安全策: この時間で打ち切り (ms)
const GARBAGE_TAP_R = 40;       // タップ点からこの距離内のゴミを「タップした」とみなす

// 目的地のゴミが「回収できる距離」に来たか。直線タイル上のみ (寄せは直線限定)。
// - 沿道 (進行軸) 方向: 真横手前 PULLOVER_R で寄せ始め、寄せ切って停止後は真横〜後方 COLLECT_R まで寄せたまま。
//   対向車線のゴミも走行車線のゴミと同じ沿道距離で回収可能にするため、横 (車線差) は距離に含めない。
// - 横 (車線差) 方向: LANE_R 内に限る → 同じ道路の両車線 (最大約34) だけを対象にし、並行する別の道路
//   (横に1タイル以上=約66 離れる) のゴミでは走行中の道路で寄せない (= 別の道路へ向かって走り続ける)。
function destReachable(truck, g) {
  const ti = tileInfo(Math.floor(truck.x / TILE), Math.floor(truck.y / TILE));
  if (!isStraightTile(ti)) return false;
  const rx = g.x - truck.x, ry = g.y - truck.y;
  const fwd = rx * truck.hx + ry * truck.hy;          // 進行軸 (沿道) 方向の距離
  const lat = Math.abs(rx * truck.hy - ry * truck.hx); // 横 (車線差) 方向の距離
  if (lat > GARBAGE_LANE_R) return false;             // 並行する別の道路のゴミは対象外
  return fwd < GARBAGE_PULLOVER_R && fwd > -GARBAGE_COLLECT_R;
}

function makeGarbageEvent(truck, now) {
  return {
    id: 'garbage', truck, t0: now, seen: false, done: false, dest: null, asideT: 0,
    cleanup() { clearHighlight(); }, // 出来事終了時にハイライトを残さない
    update(dt, t) {
      if (vehicles.indexOf(truck) < 0) { clearHighlight(); this.done = true; return; } // グリッドロック撤去等で消えた
      // ハイライトされた目的地があるときだけ動く。回収できる距離まで来たら走行車線の路肩へ寄せ (停止し)、
      // 寄せ切った (aside) ら少し待って回収する (req: 路肩に寄せずに回収しない / 対向車線でも自車線の路肩で回収)。
      // ハイライトが無ければ探索せずただ走る (req: 操作なしに探索しない)。
      if (this.dest && litter.indexOf(this.dest) >= 0) {
        if (destReachable(truck, this.dest)) {
          pullOver(truck);
          truck.vmax = GARBAGE_COLLECT_SPEED;
          if (truck.aside) {
            // 寄せ切ってから COLLECT_DELAY 待って回収 (路肩作業の演出)。目的地は確実に、近くの同じ道路の
            // ゴミ (走行車線・対向車線の両方) もまとめて回収する。
            this.asideT += dt;
            if (this.asideT >= GARBAGE_COLLECT_DELAY) {
              removeLitter(this.dest);
              collectAround(truck.x, truck.y, GARBAGE_COLLECT_R);
            }
          } else this.asideT = 0; // 寄せ切る前 (徐行中) はカウントしない
        } else {
          returnToLane(truck);
          truck.vmax = GARBAGE_DRIVE_VMAX;
          this.asideT = 0;
        }
      } else {
        if (this.dest) { this.dest = null; truck.steer = null; clearHighlight(); } // 回収/消滅 → 誘導解除
        returnToLane(truck);
        truck.vmax = GARBAGE_DRIVE_VMAX;
        this.asideT = 0;
      }
      // 視界に一度入ったか → 入った後に視界外へ十分離れたら撤去 (チェイスと同様)。
      // 特別車は画面表示中はデスポーンさせない → 撤去は必ず画面外のときだけ (寿命超過の安全策も画面外限定)。
      if (!this.seen && inBox(truck, viewBoxWorld())) this.seen = true;
      if (outsideBy(truck, 3) && (this.seen || t - this.t0 > GARBAGE_MAX_LIFE)) {
        clearHighlight(); removeVehicle(truck); this.done = true;
      }
    },
  };
}

// ゴミ収集車を画面外の直線道路 (無ければ視界内) に生成して返す。同時 1 台。
function spawnGarbage(now) {
  if (active.some(e => e.id === 'garbage')) return null; // 同時に 2 台以上出さない
  const r = rect(0), N = 4;
  const isH = c => c[1] && c[3] && !c[0] && !c[2];
  const isV = c => c[0] && c[2] && !c[1] && !c[3];
  const cands = [];
  const add = (tx, ty, want, din, dout) => { const t = tileInfo(tx, ty); if (t.road && !t.junction && want(t.conns)) cands.push({ t, din, dout }); };
  for (let ty = r.y0; ty <= r.y1; ty++) {
    for (let tx = r.x0 - N; tx <= r.x0 - 1; tx++) add(tx, ty, isH, 3, 1); // 左外 → 東進
    for (let tx = r.x1 + 1; tx <= r.x1 + N; tx++) add(tx, ty, isH, 1, 3); // 右外 → 西進
  }
  for (let tx = r.x0; tx <= r.x1; tx++) {
    for (let ty = r.y0 - N; ty <= r.y0 - 1; ty++) add(tx, ty, isV, 0, 2); // 上外 → 南進
    for (let ty = r.y1 + 1; ty <= r.y1 + N; ty++) add(tx, ty, isV, 2, 0); // 下外 → 北進
  }
  if (!cands.length) { // フォールバック: 視界内の直線 (稀なのでポップイン許容)
    for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) {
      const t = tileInfo(tx, ty); if (!t.road || t.junction) continue;
      if (isV(t.conns)) cands.push({ t, din: 0, dout: 2 });
      else if (isH(t.conns)) cands.push({ t, din: 3, dout: 1 });
    }
  }
  if (!cands.length) return null;
  const pick = cands[(Math.random() * cands.length) | 0];
  const truck = makeVehicle(pick.t.tx, pick.t.ty, pick.din, pick.dout, false);
  truck.role = 'garbage'; truck.color = '#7ec8dc'; truck.len = 20; truck.wid = 9;
  truck.vmax = GARBAGE_DRIVE_VMAX;
  truck.s = truck.path.len * 0.5; repositionVehicle(truck);
  vehicles.push(truck);
  return makeGarbageEvent(truck, now);
}

registerEvent({ id: 'garbage', weight: 1, spawn: spawnGarbage });

// ゴミをタップ → そのゴミをハイライトし、収集車を向かわせる (居なければスポーン)。タップが効いた
// 合図として共通の波紋エフェクトを出す。ゴミ以外のタップは何もしない (false を返し、ダブルタップ
// ズーム等を妨げない)。
export function tapWorld(wx, wy) {
  const g = nearestLitter(wx, wy, GARBAGE_TAP_R);
  if (!g) return false;                                   // ゴミを指していない → 非消費
  addRipple(wx, wy, lastNow);                             // 共通エフェクト: タップが効いた合図 (波紋)
  let ev = active.find(e => e.id === 'garbage');
  if (!ev) { ev = spawnGarbage(lastNow); if (ev) active.push(ev); } // 不在ならスポーンして管理下へ
  if (ev && ev.truck) {                                   // タップしたゴミをハイライト → 目的地に
    setHighlight(g);                                      // 別のゴミをタップするとハイライトが移る
    ev.dest = g;
    ev.truck.steer = (tile, din) => pursue(tile, din, g);
  }
  return true;                                            // ゴミを指したタップは消費
}
