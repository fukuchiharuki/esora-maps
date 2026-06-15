// =====================================================================
// 車両移動 (車・バスのモデルと走行ルール、スポーン/デスポーン)
//
// 車両は道路部品の通行パス (roadpart.lanePath) 上の距離パラメータ s だけで
// 動き、道路から外れない。ルールベース:
//  - 前方車への追従減速 / 交差点・カーブでの減速
//  - 交差点はクラスタ単位の予約ロックで 1 台ずつ通過 (待つ)
//    予約取得は「踏み込む瞬間」だけ → 交差点外で握ったまま詰まらない
//  - バスは停留所相当の位置で短く停車
//  - 12 秒以上完全停止した車は撤去 (グリッドロックの自己回復)。
//    ただし parked (確保された車など、意図的に停止中) は対象外でスクロールでのみ消える。
// =====================================================================
import { TILE, DX, DY, OPP } from './config.js';
import { hash, rnd01 } from './rng.js';
import { lanePath, pathPoint } from './roadpart.js';
import { tileInfo, clusterKey } from './map.js';
import { cam, view, rect } from './camera.js';

const CAR_COLORS = ['#e05d5d', '#5d8fe0', '#5dc08a', '#e0b25d', '#9b7fd4', '#5dc6cf', '#d97fb0', '#8a93a3'];
let vehicleId = 0;
export const vehicles = [];
const junctionRes = new Map(); // 交差点予約: クラスタキー → vehicle

export function makeVehicle(tx, ty, din, dout, isBus) {
  const v = {
    id: ++vehicleId,
    bus: isBus,
    tx, ty, din, dout,
    path: lanePath(din, dout),
    s: 0,
    speed: 0,
    vmax: isBus ? 30 : 36 + rnd01(vehicleId, 5, 77) * 12,
    len: isBus ? 22 : 13,
    wid: isBus ? 9 : 7.5,
    color: isBus ? '#f2a93b' : CAR_COLORS[hash(vehicleId, 9, 31) % CAR_COLORS.length],
    dwell: 0,          // バス停での残り停車時間
    served: false,     // このタイルの停留所に停車済みか
    stuckT: 0,         // 連続停止時間 (グリッドロック自己回復用)
    role: null,        // シナリオ役割 ('flee' | 'police' など) / 通常は null
    steer: null,       // シナリオ操舵フック: (tile, din) => dout | -1。null なら通常選択
    parked: false,     // true = 意図的に停止中 (確保された車など)。グリッドロック撤去の対象外
    juncCap: 18,       // 交差点内の速度上限。シナリオで上書き可 (チェイス車は減速控えめ=高め)
    curveCap: 15,      // カーブの速度上限。同上
    accel: 26,         // 加速度上限。シナリオで上書き可
    decel: 80,         // 減速度上限。同上 (チェイス車は高速でも前方車に追突しないよう強め)
    lat: 0,            // 路肩への横オフセット (車線中心からさらに路肩側へ。0=車線)
    latTarget: 0,      // 横オフセットの目標 (pullOver=寄せる / returnToLane=戻す)
    aside: false,      // true=路肩に十分寄った状態。他車から「存在しない」ものとして扱われる
    x: 0, y: 0, hx: 1, hy: 0,
  };
  updateVehiclePos(v);
  return v;
}

// 路肩寄せ量 (車線中心からさらに路肩側へずらす距離) と横移動の速さ・aside 判定しきい値
const SHOULDER_OFF = 8;
const LAT_RATE = 24;                  // 横移動 (units/秒)
const ASIDE_LAT = SHOULDER_OFF * 0.5; // これ以上寄れば他車から無視される
const YIELD_R = 80;                   // この距離に現役パトカーが居れば乗用車/バスは路肩へ寄せる
const YIELD_SPEED = 0;                // 路肩へ寄せている間の速度上限 (0=停止して道を譲る)

const _pp = { x: 0, y: 0, hx: 1, hy: 0 };
function updateVehiclePos(v) {
  // 横ずれは直線でのみ許す不変条件をここで担保 (位置へ効かせる唯一の地点)。タイル遷移直後など、
  // 非直線タイルに居て横ずれが残っていると舗装外に出るので 0 に戻す。
  if (v.lat !== 0 && !onStraightTile(v)) v.lat = 0;
  pathPoint(v.path, v.s, _pp);
  // 路肩寄せ: 進行方向の左 (左側通行の路肩側) へ v.lat ずらす。左 = (hy, -hx)。
  v.x = v.tx * TILE + _pp.x + _pp.hy * v.lat;
  v.y = v.ty * TILE + _pp.y - _pp.hx * v.lat;
  v.hx = _pp.hx; v.hy = _pp.hy;
}

// 路肩へ寄せる / 車線へ戻す (走行ルール・シナリオから使う基本操作)。実際の横移動は毎フレーム補間。
export function pullOver(v) { v.latTarget = SHOULDER_OFF; }
export function returnToLane(v) { v.latTarget = 0; }

// 直線タイル上か。路肩寄せは直線でのみ行う (カーブ/交差点で横へずらすと舗装外に出るため)。
function onStraightTile(v) {
  const t = tileInfo(v.tx, v.ty), c = t.conns;
  return !t.junction && ((c[0] && c[2] && !c[1] && !c[3]) || (c[1] && c[3] && !c[0] && !c[2]));
}

// 近くに現役 (確保前) のパトカーが居るか。乗用車/バスが道を譲る (路肩へ寄せる) 判定に使う。
function nearActivePolice(v) {
  for (const o of vehicles) {
    if (o.role !== 'police' || o.parked) continue;
    const dx = o.x - v.x, dy = o.y - v.y;
    if (dx * dx + dy * dy < YIELD_R * YIELD_R) return true;
  }
  return false;
}

// 退避状態 (路肩へ寄せて道を譲る) の遷移ロジック (通常車 = role===null 用)。直線でのみ寄せられる
// (カーブ/交差点では横へずらすと舗装外に出るため戻す)。latTarget>0 を「退避状態」とみなす
// (退避中の車は YIELD_SPEED=0 で停止しているのでタイルを跨がない → 状態を持っても破綻しない)。
//  - 退避状態への移行: 通常車線に居て、パトカーが接近したら寄せる
//  - 退避状態の維持:   退避中でパトカーが近いうちは寄せたまま
//  - 退避状態からの復帰: 退避中でパトカーが離れたら車線へ戻す
function updateYieldState(v) {
  if (!onStraightTile(v)) { v.latTarget = 0; return; } // 直線でなければ寄せられない
  const aside = v.latTarget > 0;
  if (!aside) {
    if (nearActivePolice(v)) v.latTarget = SHOULDER_OFF; // 移行
  } else if (canReturnToLane(v)) {
    v.latTarget = 0;                                     // 復帰
  }
  // それ以外 (退避中 かつ 復帰条件を満たさない) は SHOULDER_OFF のまま = 維持
}

// 退避状態から通常車線へ復帰してよいか。パトカーが離れ、かつ復帰先 (車線) に向けて走行中の
// 他車が接近していないとき (= 車線が空いたとき) だけ復帰する。
function canReturnToLane(v) {
  return !nearActivePolice(v) && !trafficApproaching(v);
}

// 復帰先 (車線中心) の近くを走行中の他車が通っているか。退避を解いて車線へ戻る前に確認する。
const RETURN_CLEAR_R = 16; // 復帰先からこの距離内に走行車両が居れば復帰しない (対向車線 18 は除外)
function trafficApproaching(v) {
  const cx = v.x - v.hy * v.lat, cy = v.y + v.hx * v.lat; // 路肩オフセットを戻した車線中心
  for (const o of vehicles) {
    if (o === v || o.speed <= 3) continue; // 走行中 (停止/退避中でない) の他車のみ
    const dx = o.x - cx, dy = o.y - cy;
    if (dx * dx + dy * dy < RETURN_CLEAR_R * RETURN_CLEAR_R) return true;
  }
  return false;
}

// v から見て前方の他車 o が課す許容速度 (追従減速)。無関係 (遠い/後方/対向/別車線) なら null。
function followLimit(v, o) {
  if (o.aside) return null;                      // 路肩に寄せた車は存在しない扱い (通行の邪魔をしない)
  const rx = o.x - v.x, ry = o.y - v.y;
  if (rx * rx + ry * ry > 70 * 70) return null;
  const fwd = rx * v.hx + ry * v.hy;            // 進行方向の距離
  if (fwd <= 0) return null;                    // 後方は無視
  const police = v.role === 'police';
  const chaseTarget = police && o.role === 'flee'; // 同一ルートを追走する当事者ペア
  // パトカーは直線では逃走車との車間で減速しない → 背後に詰めて確保へ (確保は直線限定)。
  if (chaseTarget && onStraightTile(v) && onStraightTile(o)) return null;
  if (o.hx * v.hx + o.hy * v.hy < -0.2 && o.speed > 4) return null; // 動いている対向車は無視
  // 側方ゲート: 対向/別車線 (横ずれ 18) を除外。パトカーは交差点・カーブで減速せず高速で前方車に
  // 迫るため、アーク状の横ずれで前方車を取りこぼすと追突する → 対向車線 (18) は外しつつ広め (15)。
  // パト×逃走車は同一ルートの追走なので側方ゲート無し (カーブのアーク状横ずれでも必ず追従)。
  if (!chaseTarget && Math.abs(rx * v.hy - ry * v.hx) > (police ? 15 : 7)) return null;
  const gap = fwd - (v.len + o.len) / 2 - 4;
  return Math.max(0, gap * 2.2);
}

// 次の退出口を選ぶ (U ターン禁止、直進を優先)
function chooseExit(tile, din, isBus) {
  const opts = [];
  for (let d = 0; d < 4; d++) {
    if (!tile.conns[d] || d === din) continue;
    const w = d === OPP(din) ? (isBus ? 6 : 3) : 1;
    for (let i = 0; i < w; i++) opts.push(d);
  }
  if (opts.length === 0) return OPP(din); // 念のため (行き止まりは生成上発生しない)
  return opts[hash(tile.tx + vehicleId, tile.ty + (Math.random() * 1e6) | 0, 53) % opts.length];
}

function updateVehicle(v, dt) {
  // 乗用車/バスはパトカー接近で路肩へ寄せ・維持し、条件を満たせば戻す (役割車=チェイスは
  // scenario が latTarget を制御)。路肩寄せは直線タイル限定 (カーブ/交差点では寄せず通過)。
  if (v.role === null) updateYieldState(v);
  // 路肩への横移動を毎フレーム補間 (latTarget へ寄せる/戻す)。aside は lat 由来の派生状態。
  // 横ずれは直線でのみ許す。非直線 (カーブ/交差点) では横へずらすと舗装外に出るので、戻りきる前に
  // 進入しても道路外に出ないよう横ずれを残さない (車線中心に戻す)。
  if (onStraightTile(v)) v.lat += Math.max(-LAT_RATE * dt, Math.min(LAT_RATE * dt, v.latTarget - v.lat));
  else v.lat = 0;
  v.aside = v.lat > ASIDE_LAT;

  // バス停で停車中
  if (v.dwell > 0) {
    v.dwell -= dt;
    v.speed = 0;
    v.stuckT = 0;
    updateVehiclePos(v); // 寄せ/戻しの横移動を反映
    return;
  }

  const tile = tileInfo(v.tx, v.ty);
  let target = v.vmax;

  // 交差点内・カーブでは減速 (上限は車ごと: 通常 18/15、チェイス車は減速控えめで高め)
  if (tile.junction) target = Math.min(target, v.juncCap);
  if (v.dout !== OPP(v.din)) target = Math.min(target, v.curveCap);

  // ---- バス停接近 (このタイルの停留所が自分の進行方向のとき)
  let stopS = -1;
  if (v.bus && !v.served && tile.stop && tile.stop.dir === v.dout) {
    stopS = v.path.len * 0.55;
    const ahead = stopS - v.s;
    if (ahead > 0 && ahead < 28) target = Math.min(target, Math.max(5, ahead * 1.8));
  }

  // ---- 前方車両への追従減速
  for (const o of vehicles) {
    if (o === v) continue;
    const lim = followLimit(v, o);
    if (lim !== null) target = Math.min(target, lim);
  }

  // ---- 路肩へ寄せている間は道を譲って減速 (停止)
  if (v.role === null && v.latTarget > 0) target = Math.min(target, YIELD_SPEED);

  // ---- 路肩に寄せ切った (aside) まま路肩へ留まる (latTarget>0) 車両は移動できない (req: 路肩寄せ中は
  // 動けない)。寄せる途中 (aside 前) は徐行可 → 収集車が回収位置まで詰める。車線へ戻る最中 (latTarget=0)
  // は寄せ解除なので対象外 → 従来どおり車線へ復帰できる。確保車は vmax=0 でもとより停止。
  if (v.aside && v.latTarget > 0) target = Math.min(target, 0);

  // ---- 交差点進入待ち
  // 予約の「取得」は実際に踏み込む瞬間 (遷移処理) だけで行う。接近フェーズではここで
  // 取得しない。これにより交差点の外で予約を握ったまま前方車に詰まる hold-and-wait が
  // 起きず、車は物理的に交差点内にいる間しかロックを持たない (クラスタ間で循環待ちが不能)。
  const remain = v.path.len - v.s;
  const ntx = v.tx + DX[v.dout], nty = v.ty + DY[v.dout];
  const ntile = tileInfo(ntx, nty);
  if (remain < 34 && ntile.junction) {
    const holder = junctionRes.get(clusterKey(ntx, nty));
    if (holder && holder !== v) {
      target = Math.min(target, Math.max(0, (remain - 9) * 2.5)); // 占有中 → 停止線で待つ
    } else if (remain < 18) {
      target = Math.min(target, Math.max(20, v.juncCap)); // 進入直前は減速 (取得失敗時の急停止を和らげる)
    }
  }

  // ---- 速度更新 (加速/減速は車ごと: 通常 26/80、チェイス車は強め)
  const dv = target - v.speed;
  v.speed += Math.max(-v.decel * dt, Math.min(v.accel * dt, dv));
  if (v.speed < 0.05 && target < 1) v.speed = 0;

  let ns = v.s + v.speed * dt;

  // バス停に到達 → 停車開始
  if (stopS >= 0 && v.s < stopS && ns >= stopS) {
    ns = stopS;
    v.dwell = 2.2;
    v.served = true;
    v.speed = 0;
  }

  // ---- 部品の終端 → 次の部品へ遷移
  while (ns >= v.path.len) {
    const ntx = v.tx + DX[v.dout], nty = v.ty + DY[v.dout];
    const ntile = tileInfo(ntx, nty);
    const nextKey = ntile.junction ? clusterKey(ntx, nty) : null;
    if (nextKey) {
      const holder = junctionRes.get(nextKey);
      if (holder && holder !== v) { // 予約が取れていなければ端で停止
        ns = v.path.len - 0.1;
        v.speed = 0;
        break;
      }
      junctionRes.set(nextKey, v);
    }
    // 出ていくクラスタの予約を解放 (同じクラスタ内移動なら保持)
    if (tile.junction) {
      const curKey = clusterKey(v.tx, v.ty);
      if (curKey !== nextKey && junctionRes.get(curKey) === v) junctionRes.delete(curKey);
    }
    ns -= v.path.len;
    v.tx = ntx; v.ty = nty;
    v.din = OPP(v.dout);
    // シナリオ操舵フック (チェイス等) が有効なら進路を委ねる。無効・無効値なら通常選択。
    let nd = v.steer ? v.steer(ntile, v.din) : -1;
    if (nd < 0 || nd > 3 || !ntile.conns[nd] || nd === v.din) nd = chooseExit(ntile, v.din, v.bus);
    v.dout = nd;
    v.path = lanePath(v.din, v.dout);
    v.served = false;
    break;
  }
  v.s = ns;
  updateVehiclePos(v);
  // グリッドロック検出 (恒久停止の自己回復は manageVehicles 側で撤去)
  v.stuckT = v.speed < 0.3 ? v.stuckT + dt : 0;
}

function releaseVehicle(v) {
  for (const [k, h] of junctionRes) if (h === v) junctionRes.delete(k);
}

// 車両を即時撤去 (予約解放 + 配列から除去)。シナリオの後始末用。
export function removeVehicle(v) {
  const i = vehicles.indexOf(v);
  if (i < 0) return;
  releaseVehicle(v);
  vehicles.splice(i, 1);
}

// s / tx / ty から x,y と向きを再計算 (シナリオが s を直接いじった後に使う)
export function repositionVehicle(v) { updateVehiclePos(v); }

// 全車両を 1 フレーム進める
export function updateAll(dt) {
  for (const v of vehicles) updateVehicle(v, dt);
}

let bootTime = null;
// 視界に応じてスポーン / デスポーン。now は現在時刻 (フレームのタイムスタンプ)。
export function manageVehicles(now) {
  if (bootTime === null) bootTime = now;
  const r = rect(3);
  const tilesInView = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  const desired = Math.max(18, Math.min(100, Math.round(tilesInView * 0.10)));

  // 視界から大きく外れた車両を除去
  const margin = 6 * TILE;
  const wx0 = r.x0 * TILE - margin, wy0 = r.y0 * TILE - margin;
  const wx1 = (r.x1 + 1) * TILE + margin, wy1 = (r.y1 + 1) * TILE + margin;
  for (let i = vehicles.length - 1; i >= 0; i--) {
    const v = vehicles[i];
    // 視界外なら撤去。視界内でも 12 秒以上完全停止ならグリッドロックとみなし撤去するが、
    // parked (確保) や aside (路肩へ寄せ中=道を譲って待機) は意図的な停止なので対象外。
    // 特別な車両 (role!==null: パト/逃走車/収集車) は画面表示中はデスポーンさせない → グリッドロック
    // 撤去は通常車 (role===null) のみ。特別車は画面外 (offView) でだけ撤去される。
    const offView = v.x < wx0 || v.x > wx1 || v.y < wy0 || v.y > wy1;
    if (offView || (v.stuckT > 12 && !v.parked && !v.aside && v.role === null)) {
      releaseVehicle(v);
      vehicles.splice(i, 1);
    }
  }

  if (vehicles.length >= desired) return;
  const booting = now - bootTime < 2500; // 起動直後は画面内スポーンを許可
  for (let attempt = 0; attempt < 8 && vehicles.length < desired; attempt++) {
    const tx = r.x0 + Math.floor(Math.random() * (r.x1 - r.x0 + 1));
    const ty = r.y0 + Math.floor(Math.random() * (r.y1 - r.y0 + 1));
    const tile = tileInfo(tx, ty);
    if (!tile.road || tile.junction) continue;
    // 非交差点 = ちょうど 2 口 (直線=相対 / カーブ=直角)。din を片方、dout をもう片方に。
    const dirs = [];
    for (let d = 0; d < 4; d++) if (tile.conns[d]) dirs.push(d);
    const din = dirs[Math.floor(Math.random() * dirs.length)];
    const dout = dirs[0] === din ? dirs[1] : dirs[0];
    const v = makeVehicle(tx, ty, din, dout, Math.random() < 0.18);
    // 画面内へのポップイン防止 (起動直後を除く)
    if (!booting) {
      const sx = (v.x - cam.x) * cam.zoom + view.cssW / 2;
      const sy = (v.y - cam.y) * cam.zoom + view.cssH / 2;
      if (sx > -40 && sx < view.cssW + 40 && sy > -40 && sy < view.cssH + 40) continue;
    }
    // 近くに既存車両がいれば中止
    let blocked = false;
    for (const o of vehicles) {
      const dx = o.x - v.x, dy = o.y - v.y;
      if (dx * dx + dy * dy < 45 * 45) { blocked = true; break; }
    }
    if (!blocked) vehicles.push(v);
  }
}
