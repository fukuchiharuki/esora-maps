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
        const dd = Math.hypot(vs[i].x - vs[j].x, vs[i].y - vs[j].y); if (dd < minGap) minGap = dd;
      }
      for (const v of vs) { if (v.parked) { es.set(v.id, simT); continue; }
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
    let cap = false;
    for (let f = 0; f < 60 && !cap; f++) { ev.update(1 / 60, t); t += 1000 / 60; cap = ev.captured; }
    if (!cap) fail('E: 確保が発生しなかった');
    if (!(flee.parked && police.parked)) fail('E: 確保後に parked になっていない');
    if (flee.vmax !== 0 || police.vmax !== 0) fail('E: 確保後に停止 (vmax=0) になっていない');
    { const ic = render.chaseIconState(); if (ic.flee || ic.police) fail('E: 無力化(確保)後もアイコンが残る'); }
    const fx = flee.x, fy = flee.y, px = police.x, py = police.y;
    for (let f = 0; f < 120; f++) vehicles.updateAll(1 / 60);
    if (Math.hypot(flee.x - fx, flee.y - fy) > 0.5 || Math.hypot(police.x - px, police.y - py) > 0.5) fail('E: 確保後に車が動いた');
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
