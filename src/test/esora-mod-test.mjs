// =====================================================================
// Esora Maps ヘッドレステスト (自己完結 / 依存なし)
//
// src/main の各 ES モジュールを Node で読み込み、道路部品の契約・走行の
// 不変条件・カーチェイス・発生アイコン・決定論を検証する。golden ファイル
// 等の外部依存は持たない (どのシードでも通る)。実行: node src/test/esora-mod-test.mjs
// =====================================================================
import { tileInfo, clusterKey } from '../main/map.js';
import { ENTRY, EXIT, lanePath, pathPoint } from '../main/roadpart.js';
import * as camera from '../main/camera.js';
import * as vehicles from '../main/vehicles.js';
import * as scenario from '../main/scenario.js';
import * as render from '../main/render.js';
import { DX, DY, OPP, TILE } from '../main/config.js';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL:', m); };

// 道路逸脱判定: 車線帯 (中心±18) か、隅切りフィレット (直角2口の角, 半径10) の内側か
const CORNER = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
function offRoadOf(v) {
  const ti = tileInfo(v.tx, v.ty);
  if (!ti.road) return true;
  const lx = v.x - v.tx * TILE, ly = v.y - v.ty * TILE;
  if (lx < -0.01 || lx > 100.01 || ly < -0.01 || ly > 100.01) return true;
  if (Math.abs(lx - 50) <= 18.01 || Math.abs(ly - 50) <= 18.01) return false;
  for (let d = 0; d < 4; d++) {
    if (!(ti.conns[d] && ti.conns[(d + 1) % 4])) continue;
    if (Math.hypot(lx - (50 + CORNER[d][0] * 18), ly - (50 + CORNER[d][1] * 18)) <= 10.01) return false;
  }
  return true;
}

// ---- 検証 A: 道路トポロジ (接続口一致 / 行き止まりゼロ / 部品語彙 / バス停率) ----
{
  let portMismatch = 0, deadEnd = 0, road = 0, junc = 0, straight = 0, curve = 0, tj = 0, cross = 0;
  let straightAll = 0, stops = 0;
  for (let ty = -100; ty < 100; ty++) for (let tx = -100; tx < 100; tx++) {
    const t = tileInfo(tx, ty);
    if (t.road) road++; if (t.junction) junc++;
    for (let d = 0; d < 4; d++) if (t.conns[d] !== tileInfo(tx + DX[d], ty + DY[d]).conns[OPP(d)]) portMismatch++;
    const c = t.conns, n = c.filter(Boolean).length;
    if (t.road && n === 1) deadEnd++;
    if (n === 2) (((c[0] && c[2]) || (c[1] && c[3])) ? straight++ : curve++);
    else if (n === 3) tj++; else if (n === 4) cross++;
    const isStraight = (c[0] && c[2] && !c[1] && !c[3]) || (c[1] && c[3] && !c[0] && !c[2]);
    if (isStraight) { straightAll++; if (t.stop) stops++; }
  }
  console.log(`検証A: 道路 ${road} (直線${straight} カーブ${curve} T字${tj} 十字${cross}), 交差点 ${junc}, 接続口不一致 ${portMismatch}, 行き止まり ${deadEnd}`);
  if (portMismatch) fail(`接続口不一致 ${portMismatch} (チャンク境界で道路が途切れる)`);
  if (deadEnd) fail(`行き止まり ${deadEnd}`);
  if (curve < 50) fail('カーブが少ない'); if (tj < 50) fail('T字が少ない'); if (cross < 50) fail('十字が少ない');
  const busRate = stops / straightAll;
  console.log(`検証A(バス停): 直線 ${straightAll} 中 ${stops} (${(busRate * 100).toFixed(1)}% ≒ 1/12=8.3%)`);
  if (busRate < 0.06 || busRate > 0.11) fail(`バス停率が約1/12でない (${(busRate * 100).toFixed(1)}%)`);
}

// ---- 検証 B: 通行パスの契約 (端点が ENTRY/EXIT に一致 + 部品間の車線連続性) ----
{
  let bErr = 0; const pp = { x: 0, y: 0, hx: 0, hy: 0 };
  for (let din = 0; din < 4; din++) for (let dout = 0; dout < 4; dout++) {
    if (din === dout) continue;
    const path = lanePath(din, dout);
    if (!(path.len > 0)) { bErr++; continue; }
    pathPoint(path, 0, pp);
    if (Math.abs(pp.x - ENTRY[din].x) > 1e-6 || Math.abs(pp.y - ENTRY[din].y) > 1e-6) bErr++;
    pathPoint(path, path.len, pp);
    if (Math.abs(pp.x - EXIT[dout].x) > 1e-6 || Math.abs(pp.y - EXIT[dout].y) > 1e-6) bErr++;
  }
  // 部品 A の EXIT[d] は、共有辺で隣接部品 B の ENTRY[OPP(d)] と一致する (車線が境界で繋がる)
  for (let d = 0; d < 4; d++) {
    const bx = ENTRY[OPP(d)].x + DX[d] * TILE, by = ENTRY[OPP(d)].y + DY[d] * TILE;
    if (Math.abs(EXIT[d].x - bx) > 1e-6 || Math.abs(EXIT[d].y - by) > 1e-6) bErr++;
  }
  console.log(`検証B: 通行パス端点 + 部品間連続性 (不整合 ${bErr})`);
  if (bErr) fail(`通行パス契約の不整合 ${bErr}`);
}

// ---- 検証 C: 走行シミュレーションの不変条件 (逸脱/重なり/デッドロック無し 等) ----
let t = 1000;
{
  camera.setViewport(1200, 800, 2);
  camera.placeCamera();
  const vs = vehicles.vehicles;
  let minPair = Infinity, offRoad = 0, maxV = 0, maxStuck = 0, slowed = false;
  const distMap = new Map(), stuckSince = new Map();
  for (let f = 0; f < 5400; f++) {
    t += 1000 / 60;
    camera.stepAnim(t);
    vehicles.manageVehicles(t);
    vehicles.updateAll(1 / 60);
    maxV = Math.max(maxV, vs.length);
    if (f % 600 === 599) { camera.cam.x += 800; camera.cam.y += 500; }
    const simT = (t - 1000) / 1000;
    if (f % 3 === 0) {
      for (const v of vs) {
        if (offRoadOf(v)) offRoad++;
        distMap.set(v.id, (distMap.get(v.id) || 0) + v.speed / 60);
        if (v.speed > 0.5 && v.speed < v.vmax * 0.5 && v.dwell <= 0) slowed = true;
      }
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        if (vs[i].aside || vs[j].aside) continue; // 路肩に寄せた車は存在しない扱い (重なり判定から除外)
        const dd = Math.hypot(vs[i].x - vs[j].x, vs[i].y - vs[j].y); if (dd < minPair) minPair = dd;
      }
    }
    for (const v of vs) { if (v.speed > 0.3 || v.dwell > 0 || !stuckSince.has(v.id)) stuckSince.set(v.id, simT);
      maxStuck = Math.max(maxStuck, simT - stuckSince.get(v.id)); }
    for (const id of [...stuckSince.keys()]) if (!vs.some((v) => v.id === id)) stuckSince.delete(id);
  }
  const moved = [...distMap.values()].filter((d) => d > 50).length;

  // バス停車は決定的に検証 (ランダム遭遇に依存しない): バス停タイルにバスを置いて停車を確認
  let busDwellDet = false;
  {
    const saved = vs.splice(0, vs.length);
    let st = null;
    for (let ty = -60; ty <= 60 && !st; ty++) for (let tx = -60; tx <= 60; tx++) {
      const ti = tileInfo(tx, ty);
      if (ti.stop && ti.road && !ti.junction) { st = { tx, ty, dir: ti.stop.dir }; break; }
    }
    if (!st) fail('C: バス停タイルが見つからない');
    else {
      const bus = vehicles.makeVehicle(st.tx, st.ty, OPP(st.dir), st.dir, true);
      vs.push(bus);
      for (let f = 0; f < 240 && !busDwellDet; f++) { vehicles.updateAll(1 / 60); if (bus.dwell > 0) busDwellDet = true; }
    }
    vs.length = 0; for (const v of saved) vs.push(v);
  }

  console.log(`検証C: 最大車両 ${maxV}, 移動車 ${moved}, 最小車間 ${minPair.toFixed(1)}, 逸脱 ${offRoad}, 最大停止 ${maxStuck.toFixed(1)}s, バス停車=${busDwellDet}, 減速=${slowed}`);
  if (offRoad > 0) fail(`道路逸脱 ${offRoad}`);
  if (minPair < 7) fail(`重なり 車間${minPair.toFixed(2)}`);
  if (moved < 10) fail('動いていない');
  if (!busDwellDet) fail('バス停でバスが停車しない');
  if (!slowed) fail('減速なし');
  if (maxStuck > 18) fail(`デッドロック疑い ${maxStuck.toFixed(1)}s`);
  if (maxV < 14) fail('車両少');
}

// ---- 検証 D: カーチェイス (既存車→黒い逃走車 / パト新規・画面外 / 単一 / 操舵 / 視界外デスポーン) ----
{
  const vs = vehicles.vehicles;
  const camBox = () => { const r = camera.rect(0); return { x0: r.x0 * TILE, y0: r.y0 * TILE, x1: (r.x1 + 1) * TILE, y1: (r.y1 + 1) * TILE }; };
  const outsideBox = (v, b, m = 0) => v.x < b.x0 - m * TILE || v.x > b.x1 + m * TILE || v.y < b.y0 - m * TILE || v.y > b.y1 + m * TILE;
  const inBox = (v, b) => v.x >= b.x0 && v.x <= b.x1 && v.y >= b.y0 && v.y <= b.y1;
  let runs = 0, removedOutsideRuns = 0, policeOffscreenRuns = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    camera.placeCamera(); camera.zoomAt(600, 400, 1.2);
    for (let f = 0; f < 300; f++) { t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60); }
    let ev = null, snap = null, nBefore = 0;
    for (let tries = 0; tries < 240 && !ev; tries++) {
      snap = new Set(vs); nBefore = vs.length; ev = scenario.forceSpawn(t, 'chase');
      if (!ev) {
        t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60);
        if (tries % 60 === 59) { camera.cam.x += 1300; camera.cam.y += 800; } // 別エリアへ移り母数確保
      }
    }
    if (!ev) { fail('D: カーチェイスをスポーンできなかった'); break; }
    runs++;
    const flee = ev.flee, police = ev.police;
    if (!snap.has(flee)) fail('D: 逃走車が既存の乗用車でない');
    if (flee.role !== 'flee' || flee.color !== '#1b1d22') fail('D: 逃走車が黒の役割車でない');
    if (snap.has(police) || police.role !== 'police') fail('D: パトカーが新規スポーンでない');
    if (vs.length !== nBefore + 1) fail(`D: 増車数が想定外 (${vs.length - nBefore})`);
    const polOutside = outsideBox(police, camBox());
    if (polOutside) policeOffscreenRuns++;
    if (scenario.forceSpawn(t, 'chase') !== null || scenario.events.length !== 1) fail('D: チェイスが同時に複数');
    // 合成 T 字 (N から進入, E/W のみ) で操舵を直接確認
    {
      const synth = { tx: 99999, ty: 99999, conns: [true, true, false, true] };
      const ec = (d) => ({ x: (synth.tx + DX[d]) * TILE + 50, y: (synth.ty + DY[d]) * TILE + 50 });
      const near = (o, x, y) => o.reduce((a, b) => ((ec(a).x - x) ** 2 + (ec(a).y - y) ** 2) <= ((ec(b).x - x) ** 2 + (ec(b).y - y) ** 2) ? a : b);
      const far = (o, x, y) => o.reduce((a, b) => ((ec(a).x - x) ** 2 + (ec(a).y - y) ** 2) >= ((ec(b).x - x) ** 2 + (ec(b).y - y) ** 2) ? a : b);
      if (police.steer(synth, 0) !== near([1, 3], flee.x, flee.y)) fail('D: パトカーが逃走車へ向かう操舵をしない');
      if (flee.steer(synth, 0) !== far([1, 3], police.x, police.y)) fail('D: 逃走車がパトカーから離れる操舵をしない');
    }
    let minGap = Infinity, eOff = 0, eMaxStuck = 0, ended = false, sawP = false, sawF = false, enteredView = false;
    const es = new Map();
    for (let f = 0; f < 4500 && !ended; f++) {
      t += 1000 / 60;
      vehicles.manageVehicles(t);
      scenario.updateScenarios(1 / 60, t);
      vehicles.updateAll(1 / 60);
      const simT = t / 1000, bx = camBox();
      for (const v of vs) { if (offRoadOf(v)) eOff++; if (v.role === 'police') sawP = true; if (v.role === 'flee') sawF = true; }
      if (inBox(flee, bx) || inBox(police, bx)) enteredView = true;
      // 最初の 2 秒は逃走車にカメラを乗せ確実に視界へ、その後は一定方向にスクロールして退場させる
      if (f < 120) { if (vs.includes(flee)) { camera.cam.x = flee.x; camera.cam.y = flee.y; } }
      else { camera.cam.x += 0.7 * TILE; }
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        if (vs[i].aside || vs[j].aside) continue; // 路肩に寄せた車は存在しない扱い
        const dd = Math.hypot(vs[i].x - vs[j].x, vs[i].y - vs[j].y); if (dd < minGap) minGap = dd;
      }
      for (const v of vs) { if (v.parked || v.aside) { es.set(v.id, simT); continue; } // 確保/路肩待機は除外
        if (v.speed > 0.3 || v.dwell > 0 || !es.has(v.id)) es.set(v.id, simT);
        eMaxStuck = Math.max(eMaxStuck, simT - es.get(v.id)); }
      for (const id of [...es.keys()]) if (!vs.some((v) => v.id === id)) es.delete(id);
      if (ev.done) ended = true;
    }
    const removed = !vs.includes(flee) && !vs.includes(police);
    const despOutside = removed && outsideBox(flee, camBox()) && outsideBox(police, camBox());
    if (removed && despOutside) removedOutsideRuns++;
    const endKind = removed ? (despOutside ? '視界外で撤去' : '視界内で撤去(NG)') : '通常車化(安全策)';
    console.log(`検証D#${attempt + 1}: 既存車→黒 パト新規(画面外=${polOutside}) 進入=${enteredView} 確保=${ev.captured} 終了=${ended}(${endKind}) 車間${minGap.toFixed(1)} 逸脱${eOff} 停止${eMaxStuck.toFixed(1)}s`);
    if (eOff > 0) fail(`D: チェイス中に道路逸脱 ${eOff}`);
    if (minGap < 7) fail(`D: チェイス中に重なり ${minGap.toFixed(2)}`);
    if (eMaxStuck > 18) fail(`D: チェイス中デッドロック ${eMaxStuck.toFixed(1)}s`);
    if (!ended) fail('D: チェイスが終了しなかった');
    if (!enteredView) fail('D: チェイスが視界に入らなかった');
    if (removed && !despOutside) fail('D: チェイスが視界内でデスポーンした');
    if (!sawP || !sawF) fail('D: 役割が設定されていない');
  }
  if (runs > 0 && removedOutsideRuns === 0) fail('D: 視界外デスポーン(主経路)が観測されない');
  if (runs > 0 && policeOffscreenRuns === 0) fail('D: パトカーが一度も画面外スポーンしない');
  console.log(`検証D: ${runs} 回 (画面外パト ${policeOffscreenRuns}, 視界外デスポーン ${removedOutsideRuns})`);
}

// ---- 検証 E: 確保 → その場停止 (維持) → スクロールでデスポーン ----
{
  const vs = vehicles.vehicles;
  let stx, sty, sdin, sdout;
  search: for (let ty = -30; ty <= 30; ty++) for (let tx = -30; tx <= 30; tx++) {
    const ti = tileInfo(tx, ty); if (!ti.road || ti.junction) continue;
    if (ti.conns[1] && ti.conns[3] && !ti.conns[0] && !ti.conns[2]) { stx = tx; sty = ty; sdin = 3; sdout = 1; break search; }
    if (ti.conns[0] && ti.conns[2] && !ti.conns[1] && !ti.conns[3]) { stx = tx; sty = ty; sdin = 0; sdout = 2; break search; }
  }
  if (stx === undefined) fail('E: 直線タイルが見つからない');
  camera.placeCamera(); camera.zoomAt(600, 400, 1.2);
  for (let f = 0; f < 360; f++) { t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60); }
  let ev = null;
  for (let tries = 0; tries < 240 && !ev; tries++) {
    t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60);
    if (tries % 60 === 59) { camera.cam.x += 1300; camera.cam.y += 800; } // 別エリアへ移り母数確保
    ev = scenario.forceSpawn(t, 'chase');
  }
  if (!ev) fail('E: チェイスをスポーンできなかった');
  else {
    const flee = ev.flee, police = ev.police, lp = lanePath(sdin, sdout);
    { const ic = render.chaseIconState(); if (!ic.flee || !ic.police) fail('E: 昇格/スポーンでアイコンが立たない'); }
    flee.tx = stx; flee.ty = sty; flee.din = sdin; flee.dout = sdout; flee.path = lp; flee.s = lp.len * 0.6; flee.steer = null; flee.speed = 0;
    police.tx = stx; police.ty = sty; police.din = sdin; police.dout = sdout; police.path = lp; police.s = lp.len * 0.6 - 16; police.steer = null; police.speed = 0;
    vehicles.repositionVehicle(flee); vehicles.repositionVehicle(police);
    // 確保前は両車とも走行中 (急停止を確認するため非ゼロ速度から確保させる)
    flee.speed = 40; police.speed = 80;
    let cap = false;
    for (let f = 0; f < 60 && !cap; f++) { ev.update(1 / 60, t); t += 1000 / 60; cap = ev.captured; }
    if (!cap) fail('E: 確保が発生しなかった');
    if (!(flee.speed === 0 && police.speed === 0)) fail(`E: 確保で急停止しない (flee=${flee.speed.toFixed(1)}, police=${police.speed.toFixed(1)})`);
    if (!(flee.parked && police.parked)) fail('E: 確保後に parked になっていない');
    if (flee.vmax !== 0 || police.vmax !== 0) fail('E: 確保後に停止 (vmax=0) になっていない');
    if (!(flee.latTarget > 0 && police.latTarget > 0)) fail('E: 確保後に路肩へ寄せない');
    { const ic = render.chaseIconState(); if (ic.flee || ic.police) fail('E: 無力化(確保)後もアイコンが残る'); }
    const fs = flee.s, ps = police.s; // 前進しないこと (横方向の路肩寄せでは動く) を s で確認
    for (let f = 0; f < 120; f++) vehicles.updateAll(1 / 60);
    if (Math.abs(flee.s - fs) > 0.5 || Math.abs(police.s - ps) > 0.5) fail('E: 確保後に前進した');
    if (!(flee.aside && police.aside)) fail('E: 確保後に路肩(aside)にならない');
    for (let f = 0; f < 900; f++) { t += 1000 / 60; camera.cam.x = flee.x; camera.cam.y = flee.y;
      vehicles.manageVehicles(t); scenario.updateScenarios(1 / 60, t); vehicles.updateAll(1 / 60); }
    if (!(vs.includes(flee) && vs.includes(police))) fail('E: スクロール無しで確保車が撤去された');
    if (ev.done) fail('E: 確保車が視界内のまま出来事が終了した');
    for (let f = 0; f < 800 && !ev.done; f++) { t += 1000 / 60; camera.cam.x += 0.7 * TILE;
      vehicles.manageVehicles(t); scenario.updateScenarios(1 / 60, t); vehicles.updateAll(1 / 60); }
    if (vs.includes(flee) || vs.includes(police)) fail('E: スクロールで確保車がデスポーンしなかった');
    if (!ev.done) fail('E: 確保車のデスポーン後も出来事が終了しなかった');
    console.log('検証E: 確保→停止維持(グリッドロック非対象)→スクロールでデスポーン OK');
  }
}

// ---- 検証 F: 発生アイコンの表示/非表示ロジック ----
{
  const vs = vehicles.vehicles; vs.splice(0, vs.length);
  const mk = (role) => { const v = vehicles.makeVehicle(0, 0, 0, 2, false); v.role = role; vs.push(v); return v; };
  let s = render.chaseIconState();
  if (s.flee || s.police) fail('F: チェイス不在でアイコンが出る');
  const f = mk('flee'); s = render.chaseIconState();
  if (!s.flee || s.police) fail('F: 昇格でアイコン(逃走車)が出ない');
  const p = mk('police'); s = render.chaseIconState();
  if (!s.flee || !s.police) fail('F: スポーンでアイコン(パトカー)が出ない');
  f.parked = true; p.parked = true; s = render.chaseIconState();
  if (s.flee || s.police) fail('F: 無力化(確保)でアイコンが消えない');
  f.parked = false; p.parked = false;
  vehicles.removeVehicle(f); vehicles.removeVehicle(p); s = render.chaseIconState();
  if (s.flee || s.police) fail('F: デスポーンでアイコンが消えない');
  console.log('検証F: アイコンは 昇格/スポーンで表示・無力化(確保)/デスポーンで非表示 OK');
}

// ---- 検証 G: 発生アイコンが右下に描画される (呼び出し記録コンテキスト) ----
{
  const calls = [];
  const recNames = new Set(['setTransform', 'arc', 'roundRect', 'rect', 'fillRect', 'strokeRect', 'beginPath', 'fill', 'stroke', 'save', 'restore', 'translate', 'rotate', 'moveTo', 'lineTo', 'setLineDash', 'ellipse', 'closePath', 'clearRect']);
  const recCtx = new Proxy({}, { get: (_t, p) => recNames.has(p) ? (...a) => { calls.push([p, a]); } : undefined, set: () => true });
  render.initRender({ getContext: () => recCtx });
  camera.setViewport(1200, 800, 2); camera.placeCamera();
  const vs = vehicles.vehicles; vs.splice(0, vs.length);
  const isHud = (c) => c[0] === 'setTransform' && c[1][4] === 0 && c[1][5] === 0 && c[1][0] === 2;
  calls.length = 0; render.drawScene();
  if (calls.some(isHud)) fail('G: チェイス不在なのに HUD 描画が走った');
  const mk = (role) => { const v = vehicles.makeVehicle(0, 0, 0, 2, false); v.role = role; vs.push(v); };
  mk('flee'); mk('police');
  calls.length = 0; render.drawScene();
  const hudIdx = calls.findIndex(isHud);
  if (hudIdx < 0) fail('G: HUD のスクリーン座標変換が無い');
  else {
    const after = calls.slice(hudIdx);
    const circles = after.filter((c) => c[0] === 'arc' && Math.abs(c[1][2] - 21) < 0.01);
    const br = circles.filter((c) => c[1][0] > 1000 && c[1][1] > 700);
    if (circles.length < 2) fail(`G: 白丸が2つ以上描かれない (${circles.length})`);
    if (br.length < 2) fail('G: アイコンが右下に配置されていない');
  }
  vs.splice(0, vs.length);
  console.log('検証G: 発生アイコンは右下に白丸で描画される OK');
}

// ---- 検証 H: パトカーは逃走車の進行方向 (前方) からはスポーンしない (正面すれ違い防止) ----
{
  const vs = vehicles.vehicles;
  let spawned = 0, aheadCount = 0, minCos = Infinity, maxCos = -Infinity;
  for (let run = 0; run < 12; run++) {
    camera.placeCamera(); camera.zoomAt(600, 400, 1.2);
    camera.cam.x += run * 1500; camera.cam.y += run * 900; // run ごとに別エリアへ (スポーン母数を安定確保)
    for (let f = 0; f < 300; f++) { t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60); }
    let ev = null;
    for (let tr = 0; tr < 150 && !ev; tr++) { t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60); ev = scenario.forceSpawn(t, 'chase'); }
    if (!ev) continue;
    spawned++;
    const f = ev.flee, p = ev.police;
    const dot = (p.x - f.x) * f.hx + (p.y - f.y) * f.hy;
    const cos = dot / (Math.hypot(p.x - f.x, p.y - f.y) || 1);
    minCos = Math.min(minCos, cos); maxCos = Math.max(maxCos, cos);
    if (cos > 0.25) aheadCount++; // 進行方向の前方コーン (約75°以内) に湧いたら NG (側方/背後は可)
    vehicles.removeVehicle(p); vehicles.removeVehicle(f);
    scenario.updateScenarios(1 / 60, t);
  }
  if (spawned < 5) fail(`H: スポーン回数が少ない (${spawned})`);
  if (aheadCount > 0) fail(`H: パトカーが逃走車の前方からスポーンした (${aheadCount}/${spawned})`);
  console.log(`検証H: パトカーは前方から湧かない (${spawned} 回中 前方 ${aheadCount}, cos ${minCos.toFixed(2)}〜${maxCos.toFixed(2)})`);
}

// ---- 検証 I: 決定論 (セッション内は同一に再生成 / シードでマップが変わる) ----
{
  // I-1: タイルキャッシュを溢れさせても同じタイルは同一に再生成される (離れて戻ると同地形)
  const sample = [[3, 5], [120, -77], [-44, 200], [9999, -9999], [0, 0]];
  const before = sample.map(([x, y]) => JSON.stringify(tileInfo(x, y)));
  let k = 0;
  for (let y = 0; y < 200 && k < 21000; y++) for (let x = 0; x < 200 && k < 21000; x++, k++) tileInfo(50000 + x, 50000 + y);
  const after = sample.map(([x, y]) => JSON.stringify(tileInfo(x, y)));
  let same = true;
  for (let i = 0; i < sample.length; i++) if (before[i] !== after[i]) same = false;
  if (!same) fail('I: 同じタイルが再生成で別物になった (セッション内の決定論が壊れている)');

  // I-2: 別プロセスで ESORA_SEED を変える → 別地形 / 同じ → 同地形
  const mapURL = new URL('../main/map.js', import.meta.url).href;
  const probePath = `${tmpdir()}/esora-seedprobe.mjs`;
  writeFileSync(probePath, `import { tileInfo as ti } from '${mapURL}';
let s=''; for (let y=-6;y<=6;y++) for (let x=-6;x<=6;x++){ const t=ti(x,y); s+=(t.road?1:0)+(t.junction?1:0)+t.conns.map(c=>c?1:0).join(''); }
process.stdout.write(s);\n`);
  const sig = (seed) => execSync(`node ${probePath}`, { env: { ...process.env, ESORA_SEED: String(seed) } }).toString();
  const s1a = sig(111), s1b = sig(111), s2 = sig(222);
  if (s1a !== s1b) fail('I: 同じシードでマップが一致しない (クロスプロセス決定論が壊れている)');
  else if (s1a === s2) fail('I: 異なるシードでマップが変わらない (リロードで別地形にならない)');
  else console.log('検証I: セッション内は同一再生成 / シードで別地形 (リロードで街が変わる) OK');
}

// ---- 検証 J: 路肩寄せの仕組み (lat 横ずれ / aside は他車から「存在しない」扱い / 寄せ・戻し) ----
{
  const vs = vehicles.vehicles;
  const clearAll = () => { while (vs.length) vehicles.removeVehicle(vs[0]); };
  let stx, sty;
  for (let ty = -40; ty <= 40 && stx === undefined; ty++) for (let tx = -40; tx <= 40; tx++) {
    const ti = tileInfo(tx, ty);
    if (ti.road && !ti.junction && ti.conns[0] && ti.conns[2] && !ti.conns[1] && !ti.conns[3]) { stx = tx; sty = ty; break; }
  }
  if (stx === undefined) fail('J: 縦の直線タイルが見つからない');
  else {
    // J1: lat は進行方向の左 (路肩側) に位置をずらす。南向き heading=(0,1) の路肩側=(hy,-hx)=(1,0)=+x。
    clearAll();
    const v = vehicles.makeVehicle(stx, sty, 0, 2, false); // 南向き (din N, dout S)
    v.s = v.path.len * 0.5; v.lat = 0; vehicles.repositionVehicle(v);
    const bx = v.x, by = v.y;
    v.lat = 5; vehicles.repositionVehicle(v);
    if (Math.abs((v.x - bx) - 5) > 1e-6 || Math.abs(v.y - by) > 1e-6) fail(`J1: lat の横ずれが不正 (dx=${(v.x - bx).toFixed(2)}, dy=${(v.y - by).toFixed(2)})`);

    // J2: aside の車は追従減速で無視される (車線中央に置き、フラグだけで挙動を切替えて確認)
    const runBlocked = (aside) => {
      clearAll();
      const follower = vehicles.makeVehicle(stx, sty, 0, 2, false);
      follower.s = 8; follower.speed = follower.vmax; vehicles.repositionVehicle(follower);
      const blocker = vehicles.makeVehicle(stx, sty, 0, 2, false);
      blocker.s = 34; blocker.speed = 0; blocker.vmax = 0; blocker.role = 'flee'; // role!=null=挙動層に latTarget を触らせない
      // aside は lat 由来 (派生)。lat=5 は aside 閾値(4)超 かつ 横ずれ閾値(7)以下 → aside フラグの効果だけを切り分け。
      blocker.lat = aside ? 5 : 0; blocker.latTarget = blocker.lat; vehicles.repositionVehicle(blocker);
      vs.push(follower, blocker);
      let dist = 0;
      for (let f = 0; f < 90; f++) { if (!vs.includes(follower)) break; vehicles.updateAll(1 / 60); dist += follower.speed / 60; }
      return { dist, spd: follower.speed };
    };
    const blocked = runBlocked(false); // 通常: 前方車で減速・停止
    const ignored = runBlocked(true);  // aside: 無視して進む
    if (!(blocked.spd < 3)) fail(`J2: 前方の通常車で減速しない (spd=${blocked.spd.toFixed(1)})`);
    if (!(ignored.dist > blocked.dist * 2)) fail(`J2: aside の車を無視できていない (ignored=${ignored.dist.toFixed(1)} vs blocked=${blocked.dist.toFixed(1)})`);

    // J3: latTarget (寄せ→戻し) で lat がアニメし aside が立つ/降りる
    clearAll();
    const w = vehicles.makeVehicle(stx, sty, 0, 2, false);
    w.s = w.path.len * 0.4; w.speed = 0; w.vmax = 0; w.role = 'flee'; // role!=null=挙動層に latTarget を触らせない
    vehicles.repositionVehicle(w);
    vs.push(w);
    w.latTarget = 8; // 路肩へ寄せる
    for (let f = 0; f < 120; f++) vehicles.updateAll(1 / 60);
    if (!(w.lat > 6) || !w.aside) fail(`J3: 路肩へ寄らない (lat=${(w.lat || 0).toFixed(1)}, aside=${w.aside})`);
    w.latTarget = 0; // 車線へ戻す
    for (let f = 0; f < 120; f++) vehicles.updateAll(1 / 60);
    if (!(w.lat < 1) || w.aside) fail(`J3: 車線に戻らない (lat=${(w.lat || 0).toFixed(1)}, aside=${w.aside})`);
    clearAll();
    console.log('検証J: 路肩寄せの仕組み (lat 横ずれ / aside 無視 / 寄せ・戻し) OK');
  }
}

// ---- 検証 K: 乗用車/バスはパトカー接近で路肩へ寄せ・減速、離れると車線へ戻り再開 ----
{
  const vs = vehicles.vehicles;
  const clearAll = () => { while (vs.length) vehicles.removeVehicle(vs[0]); };
  let stx, sty;
  for (let ty = -40; ty <= 40 && stx === undefined; ty++) for (let tx = -40; tx <= 40; tx++) {
    const ti = tileInfo(tx, ty);
    if (ti.road && !ti.junction && ti.conns[0] && ti.conns[2] && !ti.conns[1] && !ti.conns[3]) { stx = tx; sty = ty; break; }
  }
  if (stx === undefined) fail('K: 縦の直線タイルが見つからない');
  else {
    // 近傍に静止した現役パトカーを置き、乗用車が路肩へ寄せて減速するか
    const setup = (isBus) => {
      clearAll();
      const car = vehicles.makeVehicle(stx, sty, 0, 2, isBus);
      car.s = 18; car.speed = car.vmax; vehicles.repositionVehicle(car);
      const police = vehicles.makeVehicle(stx, sty, 0, 2, false);
      police.role = 'police'; police.vmax = 0; police.s = 40; vehicles.repositionVehicle(police);
      vs.push(car, police);
      return { car, police };
    };
    // K1: 乗用車はパト接近で路肩へ寄せて減速 (aside)
    const { car, police } = setup(false);
    for (let f = 0; f < 120; f++) vehicles.updateAll(1 / 60);
    if (!(car.latTarget > 0)) fail(`K1: パト接近で路肩へ寄せない (latTarget=${car.latTarget})`);
    if (!car.aside) fail(`K1: 路肩(aside)にならない (lat=${(car.lat || 0).toFixed(1)})`);
    if (!(car.speed < 5)) fail(`K1: 道を譲って減速しない (spd=${car.speed.toFixed(1)})`);
    // K2: パトカーが離れる (撤去) → 車線へ戻り走行再開。再開は瞬間速度でなく前進量で見る
    // (到達先がカーブ/交差点だと計測時点でたまたま減速中のことがあるため)。
    vehicles.removeVehicle(police);
    let resumeDist = 0;
    for (let f = 0; f < 180; f++) { vehicles.updateAll(1 / 60); resumeDist += car.speed / 60; }
    if (car.latTarget !== 0) fail(`K2: パト離脱後も寄せたまま (latTarget=${car.latTarget})`);
    if (!(car.lat < 1) || car.aside) fail(`K2: 車線に戻らない (lat=${(car.lat || 0).toFixed(1)}, aside=${car.aside})`);
    if (!(resumeDist > 20)) fail(`K2: 走行を再開しない (前進 ${resumeDist.toFixed(1)})`);
    // K3: バスも同様に寄せる (乗用車・バス共通経路 = role===null)
    const r = setup(true);
    for (let f = 0; f < 120; f++) vehicles.updateAll(1 / 60);
    if (!r.car.aside) fail(`K3: バスがパト接近で路肩へ寄せない (lat=${(r.car.lat || 0).toFixed(1)})`);
    clearAll();
    console.log('検証K: 乗用車/バスはパト接近で路肩へ寄せ・離脱で車線へ戻る OK');
  }
}

// ---- 検証 L: パトカーは交差点・カーブで減速しない (位置関係由来の減速のみ残す) ----
//   本番のパトカー (spawnChase の設定) を取り出し、カーブ/交差点タイルに単独配置して、
//   減速控えめの逃走車 (上限あり) より明確に速く出ること = 上限が外れていることを確認する。
{
  const vs = vehicles.vehicles;
  const clearAll = () => { while (vs.length) vehicles.removeVehicle(vs[0]); };
  clearAll();
  camera.placeCamera(); camera.zoomAt(600, 400, 1.2);
  for (let f = 0; f < 360; f++) { t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60); }
  let ev = null;
  for (let tries = 0; tries < 240 && !ev; tries++) {
    t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60);
    if (tries % 60 === 59) { camera.cam.x += 1300; camera.cam.y += 800; }
    ev = scenario.forceSpawn(t, 'chase');
  }
  if (!ev) fail('L: チェイスをスポーンできなかった');
  else {
    const police = ev.police, flee = ev.flee;
    // カーブタイル (2口・直交) と 直進できる交差点タイル (対向口あり) を探す
    let cv, jn;
    for (let ty = -40; ty <= 40 && (!cv || !jn); ty++) for (let tx = -40; tx <= 40; tx++) {
      const ti = tileInfo(tx, ty); if (!ti.road) continue; const c = ti.conns;
      if (!jn && ti.junction) { for (let d = 0; d < 2; d++) if (c[d] && c[d + 2]) { jn = { tx, ty, din: d, dout: d + 2 }; break; } }
      if (!cv && !ti.junction && c.filter(Boolean).length === 2 && !((c[0] && c[2]) || (c[1] && c[3]))) {
        const ds = []; for (let d = 0; d < 4; d++) if (c[d]) ds.push(d); cv = { tx, ty, din: ds[0], dout: ds[1] };
      }
    }
    if (!cv) fail('L: カーブタイルが見つからない');
    if (!jn) fail('L: 直進できる交差点タイルが見つからない');
    if (cv && jn) {
      // 単独配置して「開始タイルに居る間の最大速度」を測る (他車なし=位置関係由来の減速は発生しない)
      const maxOnTile = (v, cell) => {
        clearAll();
        v.tx = cell.tx; v.ty = cell.ty; v.din = cell.din; v.dout = cell.dout; v.path = lanePath(cell.din, cell.dout);
        v.s = 0; v.speed = 0; v.dwell = 0; v.served = false; v.steer = null; v.parked = false;
        v.lat = 0; v.latTarget = 0; v.aside = false; v.stuckT = 0;
        vehicles.repositionVehicle(v); vs.push(v);
        let mx = 0;
        for (let f = 0; f < 200; f++) { vehicles.updateAll(1 / 60); if (v.tx !== cell.tx || v.ty !== cell.ty) break; mx = Math.max(mx, v.speed); }
        return mx;
      };
      const cP = maxOnTile(police, cv), cF = maxOnTile(flee, cv);
      const jP = maxOnTile(police, jn), jF = maxOnTile(flee, jn);
      clearAll();
      console.log(`検証L: カーブ パト${cP.toFixed(0)}/逃走車${cF.toFixed(0)}, 交差点 パト${jP.toFixed(0)}/逃走車${jF.toFixed(0)}`);
      if (!(cP > cF + 3)) fail(`L: パトカーがカーブで減速している (パト${cP.toFixed(1)} ≦ 逃走車${cF.toFixed(1)}+3)`);
      if (!(jP > jF + 3)) fail(`L: パトカーが交差点で減速している (パト${jP.toFixed(1)} ≦ 逃走車${jF.toFixed(1)}+3)`);
    }
  }
}

// ---- 検証 M: パトカーは直線で逃走車との車間で減速しない (背後に詰める) / カーブでは追従して追突しない ----
{
  const vs = vehicles.vehicles;
  const clearAll = () => { while (vs.length) vehicles.removeVehicle(vs[0]); };
  let stx, sty, cv;
  for (let ty = -40; ty <= 40 && stx === undefined; ty++) for (let tx = -40; tx <= 40; tx++) {
    const ti = tileInfo(tx, ty);
    if (ti.road && !ti.junction && ti.conns[0] && ti.conns[2] && !ti.conns[1] && !ti.conns[3]) { stx = tx; sty = ty; break; }
  }
  for (let ty = -40; ty <= 40 && !cv; ty++) for (let tx = -40; tx <= 40; tx++) {
    const ti = tileInfo(tx, ty); if (!ti.road || ti.junction) continue; const c = ti.conns;
    if (c.filter(Boolean).length === 2 && !((c[0] && c[2]) || (c[1] && c[3]))) { const ds = []; for (let d = 0; d < 4; d++) if (c[d]) ds.push(d); cv = { tx, ty, din: ds[0], dout: ds[1] }; }
  }
  if (stx === undefined) fail('M: 縦の直線タイルが見つからない');
  else if (!cv) fail('M: カーブタイルが見つからない');
  else {
    // 直線: 前方に停止した逃走車 (flee)・後方に追従車。通常車は追従して停止、パトカーは無視して走り続ける。
    const runStraight = (role) => {
      clearAll();
      const lead = vehicles.makeVehicle(stx, sty, 0, 2, false);
      lead.s = lead.path.len * 0.6; lead.speed = 0; lead.vmax = 0; lead.role = 'flee'; vehicles.repositionVehicle(lead);
      const fol = vehicles.makeVehicle(stx, sty, 0, 2, false);
      fol.s = lead.path.len * 0.05; fol.vmax = 40; fol.speed = 40; fol.role = role; vehicles.repositionVehicle(fol);
      vs.push(lead, fol);
      let dist = 0;
      for (let f = 0; f < 120; f++) { if (!vs.includes(fol)) break; vehicles.updateAll(1 / 60); dist += fol.speed / 60; }
      return { dist, spd: fol.speed };
    };
    const normal = runStraight(null);     // 通常車: 前方の逃走車に追従して停止
    const police = runStraight('police');  // パトカー: 直線では逃走車を無視して詰める (止まらない)
    // カーブ: パトカーも追従減速する (位置関係由来の減速は残す) → 停止した逃走車を追い越さない
    clearAll();
    const lead = vehicles.makeVehicle(cv.tx, cv.ty, cv.din, cv.dout, false);
    lead.s = lead.path.len * 0.6; lead.speed = 0; lead.vmax = 0; lead.role = 'flee'; vehicles.repositionVehicle(lead);
    const fol = vehicles.makeVehicle(cv.tx, cv.ty, cv.din, cv.dout, false);
    fol.s = lead.path.len * 0.05; fol.vmax = 40; fol.speed = 40; fol.role = 'police'; vehicles.repositionVehicle(fol);
    vs.push(lead, fol);
    let passedOnCurve = false;
    for (let f = 0; f < 120; f++) { vehicles.updateAll(1 / 60); if (fol.tx !== cv.tx || fol.ty !== cv.ty) break; if (fol.s > lead.s - 1) passedOnCurve = true; }
    clearAll();
    console.log(`検証M: 直線 通常 spd${normal.spd.toFixed(0)}/走行${normal.dist.toFixed(0)}, パト spd${police.spd.toFixed(0)}/走行${police.dist.toFixed(0)}, カーブ追突=${passedOnCurve}`);
    if (!(normal.spd < 5)) fail(`M: 通常車が前方の逃走車で停止しない (spd=${normal.spd.toFixed(1)})`);
    if (!(police.spd > 15)) fail(`M: パトカーが直線で逃走車との車間で減速した (spd=${police.spd.toFixed(1)})`);
    if (passedOnCurve) fail('M: パトカーがカーブで逃走車を無視して追突した (カーブでは追従減速すべき)');
  }
}

// ---- 検証 N: 横ずれ (lat) は非直線タイル (カーブ/交差点) では残さない ----
//   寄せた状態 (lat>0) のまま非直線タイルに居ると、車線中心から外れて舗装外に出る
//   (例: 道を譲った車が戻りきる前にカーブ/交差点へ進入)。非直線タイルでは横ずれを許さない
//   契約を直接確認する (直線では許す)。
{
  const vs = vehicles.vehicles;
  const clearAll = () => { while (vs.length) vehicles.removeVehicle(vs[0]); };
  const findTile = (pred) => { for (let ty = -40; ty <= 40; ty++) for (let tx = -40; tx <= 40; tx++) {
    const ti = tileInfo(tx, ty); if (!ti.road) continue; const r = pred(ti); if (r) return { tx, ty, ...r }; } return null; };
  const curve = findTile((ti) => { if (ti.junction) return null; const c = ti.conns;
    if (c.filter(Boolean).length !== 2 || (c[0] && c[2]) || (c[1] && c[3])) return null; const ds = []; for (let d = 0; d < 4; d++) if (c[d]) ds.push(d); return { din: ds[0], dout: ds[1] }; });
  const junc = findTile((ti) => { if (!ti.junction) return null; for (let d = 0; d < 2; d++) if (ti.conns[d] && ti.conns[d + 2]) return { din: d, dout: d + 2 }; return null; });
  const straight = findTile((ti) => { if (ti.junction) return null; const c = ti.conns;
    if (c[0] && c[2] && !c[1] && !c[3]) return { din: 0, dout: 2 }; if (c[1] && c[3] && !c[0] && !c[2]) return { din: 1, dout: 3 }; return null; });
  if (!curve || !junc || !straight) fail('N: カーブ/交差点/直線タイルが揃わない');
  else {
    // 非直線タイルに lat=8 を持つ車を置いて 1 フレーム進めると、横ずれは 0 に落ちる (=道路外に出ない)
    const latAfter = (cell) => {
      clearAll();
      const v = vehicles.makeVehicle(cell.tx, cell.ty, cell.din, cell.dout, false);
      v.role = 'flee'; v.s = v.path.len * 0.5; v.speed = 0; v.vmax = 0; v.lat = 8; v.latTarget = 8;
      vehicles.repositionVehicle(v); vs.push(v);
      vehicles.updateAll(1 / 60); const after = v.lat; const off = offRoadOf(v); clearAll(); return { after, off };
    };
    const cv = latAfter(curve), jn = latAfter(junc), st = latAfter(straight);
    console.log(`検証N: 横ずれ後 lat カーブ${cv.after.toFixed(1)} 交差点${jn.after.toFixed(1)} 直線${st.after.toFixed(1)}`);
    if (cv.after > 0.01 || cv.off) fail(`N: カーブで横ずれが残る (lat=${cv.after.toFixed(2)}, 逸脱=${cv.off})`);
    if (jn.after > 0.01 || jn.off) fail(`N: 交差点で横ずれが残る (lat=${jn.after.toFixed(2)}, 逸脱=${jn.off})`);
    if (!(st.after > 7)) fail(`N: 直線で横ずれが許されない (lat=${st.after.toFixed(2)})`); // 直線では路肩寄せ可
  }
}

// ---- 検証 O: パトカーは交差点・カーブで減速しなくても前方車に追突しない (追従減速は残る) ----
//   パトカーはカーブ/交差点で速度上限が無い (検証L) ため、前方車 (カーブで減速) へ高速で迫る。
//   アーク状の横ずれを側方ゲートで取りこぼすと追従減速が効かず追突する。多エリアで強制スポーン
//   した実チェイスを走らせ、「パトカーが関わるペア」の最小車間で追突しないことを確認する。
//   (通常車どうしの車間は路肩待避まわりの別課題なので、ここではパトカー由来の追突に絞る)
{
  const vs = vehicles.vehicles;
  const clearAll = () => { while (vs.length) vehicles.removeVehicle(vs[0]); };
  clearAll();
  scenario.events.length = 0; // 先行テストが残した進行中チェイスを掃除 (spawnChase は同時 1 件まで)
  camera.placeCamera(); camera.zoomAt(600, 400, 1.4);
  let chases = 0, minGap = Infinity;
  for (let area = 0; area < 24 && chases < 16; area++) {
    clearAll(); scenario.events.length = 0; // エリアごとに独立させる (前エリアのチェイス車を残さない)
    camera.cam.x += 2100; camera.cam.y += 1300; // 別エリアへ (重複しない地形でチェイスを起こす)
    for (let f = 0; f < 200; f++) { t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60); }
    let ev = null;
    for (let tries = 0; tries < 120 && !ev; tries++) { t += 1000 / 60; vehicles.manageVehicles(t); vehicles.updateAll(1 / 60); ev = scenario.forceSpawn(t, 'chase'); }
    if (!ev) continue;
    chases++;
    const flee = ev.flee;
    for (let f = 0; f < 1500 && !ev.done; f++) {
      t += 1000 / 60;
      const tgt = vs.includes(flee) ? flee : null; if (tgt) { camera.cam.x = tgt.x; camera.cam.y = tgt.y; } // 視界に留めて確保まで観察
      vehicles.manageVehicles(t); scenario.updateScenarios(1 / 60, t); vehicles.updateAll(1 / 60);
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        if (vs[i].aside || vs[j].aside) continue;
        if (vs[i].role !== 'police' && vs[j].role !== 'police') continue; // パトカーが関わるペアに絞る
        const dd = Math.hypot(vs[i].x - vs[j].x, vs[i].y - vs[j].y); if (dd < minGap) minGap = dd;
      }
      if (ev.captured) break; // 確保後は両車停止 → このエリアは観察終了
    }
  }
  clearAll();
  console.log(`検証O: 多エリア強制チェイス ${chases} 件, パト関与の最小車間 ${minGap.toFixed(1)}`);
  if (chases < 4) fail(`O: チェイスが十分起きない (${chases})`);
  if (minGap < 7) fail(`O: パトカーが前方車に追突した (車間 ${minGap.toFixed(1)})`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
