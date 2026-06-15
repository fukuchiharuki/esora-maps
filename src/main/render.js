// =====================================================================
// 描画 (Canvas 2D)
//
// マップ (map.tileInfo) と車両 (vehicles.vehicles) を、カメラ変換
// (camera) に従って毎フレーム描く。シミュレーションには触れない。
//  - 街区 (建物・公園・芝)
//  - 道路部品 (歩道 → 車道 → 中央線/横断歩道/バス停)。隅切りフィレットで
//    カーブ・T字・十字の右左折パスを舗装上に収める。
//  - 車両 (画面内のみ)
// =====================================================================
import { TILE, ROAD_W, SIDE_W, LANE_OFF, DX, DY, MIN_ZOOM, MAX_ZOOM } from './config.js';
import { hash, rnd01 } from './rng.js';
import { tileInfo } from './map.js';
import { vehicles } from './vehicles.js';
import { litter } from './litter.js';
import { cam, view, rect, setViewport } from './camera.js';

let canvas = null, ctx = null;

const BLD_COLORS = ['#d8c8b0', '#cfd4dc', '#e2cfc0', '#d4ddc6', '#dcd0d8', '#c9d6d2'];
const ROOF_DARK = 'rgba(0,0,0,0.10)';
// 口 d と (d+1) の間の角 (の符号)。0:N-E=右上, 1:E-S=右下, 2:S-W=左下, 3:W-N=左上
const CORNER = [[1, -1], [1, 1], [-1, 1], [-1, -1]];

export function initRender(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
}

// 画面リサイズ: キャンバスの実ピクセル寸法を設定し、カメラへ寸法を渡す
export function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cssW = window.innerWidth, cssH = window.innerHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  setViewport(cssW, cssH, dpr);
}

function drawBlockTile(tx, ty, detailed) {
  const ox = tx * TILE, oy = ty * TILE;
  const r = hash(tx, ty, 301) % 100;
  if (r < 18) {
    // 公園
    ctx.fillStyle = '#aacb8e';
    ctx.fillRect(ox + 6, oy + 6, TILE - 12, TILE - 12);
    if (detailed) {
      const n = 3 + hash(tx, ty, 302) % 3;
      ctx.fillStyle = '#6f9e55';
      for (let i = 0; i < n; i++) {
        const px = ox + 16 + rnd01(tx * 7 + i, ty, 303) * (TILE - 32);
        const py = oy + 16 + rnd01(tx, ty * 7 + i, 304) * (TILE - 32);
        ctx.beginPath();
        ctx.arc(px, py, 6 + rnd01(tx + i, ty + i, 305) * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (r < 82) {
    // 建物 (1〜2 棟)
    const two = hash(tx, ty, 306) % 3 === 0;
    const draw = (bx, by, bw, bh, salt) => {
      ctx.fillStyle = BLD_COLORS[hash(tx + salt, ty, 307) % BLD_COLORS.length];
      ctx.fillRect(bx, by, bw, bh);
      if (detailed) {
        ctx.fillStyle = ROOF_DARK;
        ctx.fillRect(bx + bw - 5, by, 5, bh);
        ctx.fillRect(bx, by + bh - 5, bw, 5);
      }
    };
    if (two) {
      draw(ox + 10, oy + 10, 38, TILE - 20, 1);
      draw(ox + 54, oy + 10, 36, TILE - 20, 2);
    } else {
      const m = 10 + hash(tx, ty, 308) % 8;
      draw(ox + m, oy + m, TILE - 2 * m, TILE - 2 * m, 3);
    }
  }
  // 残りは芝のまま
}

function drawRoadBase(tile, pass) {
  // pass 0: 歩道 (幅 SIDE_W) / pass 1: 車道 (幅 ROAD_W)
  const ox = tile.tx * TILE, oy = tile.ty * TILE;
  const w = pass === 0 ? SIDE_W : ROAD_W;
  const h = w / 2;
  ctx.fillStyle = pass === 0 ? '#a9adb4' : '#565b63';
  if (tile.conns[0]) ctx.fillRect(ox + 50 - h, oy, w, 50);
  if (tile.conns[2]) ctx.fillRect(ox + 50 - h, oy + 50, w, 50);
  if (tile.conns[1]) ctx.fillRect(ox + 50, oy + 50 - h, 50, w);
  if (tile.conns[3]) ctx.fillRect(ox, oy + 50 - h, 50, w);
  ctx.fillRect(ox + 50 - h, oy + 50 - h, w, w);
  // 隅切り: 直角に隣り合う 2 口がある角だけフィレット舗装する。
  // → カーブ(1角)・T字(2角)・十字(4角) の右左折パスが必ず舗装上を通る。直線は対象外。
  const fr = pass === 0 ? 15 : 10;
  const c = ROAD_W / 2;
  for (let d = 0; d < 4; d++) {
    if (!(tile.conns[d] && tile.conns[(d + 1) % 4])) continue;
    const sx = CORNER[d][0], sy = CORNER[d][1];
    ctx.beginPath();
    ctx.arc(ox + 50 + sx * c, oy + 50 + sy * c, fr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRoadDetail(tile) {
  const ox = tile.tx * TILE, oy = tile.ty * TILE;
  if (!tile.junction) {
    // 中央線 (破線): 各口から中心へ。直線→1本線、カーブ→中心で折れた線
    ctx.strokeStyle = '#e8d27a';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    for (let d = 0; d < 4; d++) {
      if (!tile.conns[d]) continue;
      ctx.moveTo(ox + 50, oy + 50);
      ctx.lineTo(ox + 50 + DX[d] * 50, oy + 50 + DY[d] * 50);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    // 交差点: 各進入口に横断歩道
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let d = 0; d < 4; d++) {
      if (!tile.conns[d]) continue;
      for (let i = -2; i <= 2; i++) {
        const off = i * 7;
        if (d === 0) ctx.fillRect(ox + 48 + off, oy + 4, 4, 8);
        if (d === 2) ctx.fillRect(ox + 48 + off, oy + TILE - 12, 4, 8);
        if (d === 1) ctx.fillRect(ox + TILE - 12, oy + 48 + off, 8, 4);
        if (d === 3) ctx.fillRect(ox + 4, oy + 48 + off, 8, 4);
      }
    }
  }
  // バス停
  if (tile.stop) {
    const d = tile.stop.dir;
    const vx = DX[d], vy = DY[d];
    const rx = vy, ry = -vx; // 進行方向の左 (左側通行の路肩側 = バスが停まる側)
    const cx = ox + 50, cy = oy + 50;
    // 車線上の停車マーク (白の網掛け)
    ctx.save();
    ctx.translate(cx + rx * LANE_OFF + vx * 5, cy + ry * LANE_OFF + vy * 5);
    ctx.rotate(Math.atan2(vy, vx));
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(-11, -8, 22, 16);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(-11, -8, 22, 16);
    ctx.restore();
    // 歩道側の標識
    const sx = cx + rx * 27 + vx * 5, sy = cy + ry * 27 + vy * 5;
    ctx.strokeStyle = '#4a5360';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sx, sy + 2); ctx.lineTo(sx, sy - 6); ctx.stroke();
    ctx.fillStyle = '#3b82c4';
    ctx.beginPath(); ctx.arc(sx, sy - 8, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(sx, sy - 8, 1.6, 0, Math.PI * 2); ctx.fill();
  }
}

// 引き (低ズーム) ほど車両を大きく描く描画専用スケール。最寄り (MAX_ZOOM) = 実寸 (現状どおり)、
// 最引き (MIN_ZOOM) = 片車線 (ROAD_W/2=18) を超える程度。len/wid は変えないので当たり判定には影響しない。
const VEHICLE_DRAW_SCALE_MAX = 3.0; // 乗用車 幅7.5 × 3.0 ≒ 22.5 ≒ 片車線 18 をしっかり超える
function vehicleDrawScale() {
  const t = (MAX_ZOOM - cam.zoom) / (MAX_ZOOM - MIN_ZOOM); // 0 = 最寄り … 1 = 最引き
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 + c * (VEHICLE_DRAW_SCALE_MAX - 1);
}

// 路肩のゴミ袋 (車両以外のオブジェクト)。車両と同じく引きで大きく描く (タップしやすく)。
function drawLitter(g) {
  ctx.save();
  ctx.translate(g.x, g.y);
  const ds = vehicleDrawScale();
  ctx.scale(ds, ds);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';                       // 影
  ctx.beginPath(); ctx.ellipse(0.6, 1.6, 4.4, 2.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#86cfe0';                                // 水色のゴミ袋
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-4, -3.5, 8, 7, 3); else ctx.rect(-4, -3.5, 8, 7);
  ctx.fill();
  ctx.fillStyle = '#5aa6b8';                                // 結び目 (濃いめの水色)
  ctx.beginPath(); ctx.moveTo(-2, -3.2); ctx.lineTo(0, -5); ctx.lineTo(2, -3.2); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawVehicle(v) {
  const flash = (performance.now() % 440) < 220; // 赤青灯の点滅位相
  ctx.save();
  ctx.translate(v.x, v.y);
  const ds = vehicleDrawScale();
  ctx.scale(ds, ds); // 引きほど大きく (描画専用 / 当たり判定は len・wid のまま)
  // パトカーのサイレン光 (無回転の円なので rotate 前に描く)
  if (v.role === 'police') {
    ctx.fillStyle = flash ? 'rgba(70,120,255,0.28)' : 'rgba(255,70,70,0.28)';
    ctx.beginPath();
    ctx.arc(0, 0, v.len * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.rotate(Math.atan2(v.hy, v.hx));
  const L = v.len, W = v.wid;
  // 影
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(-L / 2 + 1, -W / 2 + 1.5, L, W);
  // ゴミ収集車: 頭 (前方=+x) 白 / 後方コンテナ 水色 の 2 色
  if (v.role === 'garbage') {
    const cab = L * 0.36; // 頭の長さ
    ctx.fillStyle = '#7ec8dc'; // コンテナ (水色)
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-L / 2, -W / 2, L, W, 2.4); else ctx.rect(-L / 2, -W / 2, L, W);
    ctx.fill();
    ctx.fillStyle = '#f2f5f8'; // 頭 (白)
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(L / 2 - cab, -W / 2, cab, W, 2.4); else ctx.rect(L / 2 - cab, -W / 2, cab, W);
    ctx.fill();
    ctx.fillStyle = '#3b4250'; // コンテナの仕切り線
    ctx.fillRect(L / 2 - cab - 1, -W / 2 + 0.6, 1.4, W - 1.2);
    ctx.fillStyle = 'rgba(40,55,75,0.78)'; // 頭の窓 (前)
    ctx.fillRect(L / 2 - cab * 0.62, -W / 2 + 1.4, cab * 0.4, W - 2.8);
    ctx.restore();
    return;
  }
  // 車体
  ctx.fillStyle = v.color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-L / 2, -W / 2, L, W, 2.2);
  else ctx.rect(-L / 2, -W / 2, L, W);
  ctx.fill();
  // 窓
  ctx.fillStyle = 'rgba(40,55,75,0.78)';
  if (v.bus) {
    for (let i = 0; i < 4; i++) ctx.fillRect(-L / 2 + 4 + i * 4.6, -W / 2 + 1.4, 3, W - 2.8);
    ctx.fillRect(L / 2 - 4.5, -W / 2 + 1.4, 2.6, W - 2.8);
  } else {
    ctx.fillRect(L * 0.08, -W / 2 + 1.2, L * 0.26, W - 2.4);
    ctx.fillRect(-L * 0.34, -W / 2 + 1.2, L * 0.2, W - 2.4);
  }
  // パトカーの装飾: サイドライン + ルーフの赤青灯
  if (v.role === 'police') {
    ctx.fillStyle = '#2b5bd0';
    ctx.fillRect(-L / 2, -W / 2, L, 1.6);
    ctx.fillRect(-L / 2, W / 2 - 1.6, L, 1.6);
    ctx.fillStyle = flash ? '#3b6dff' : '#ff3b3b';
    ctx.fillRect(-2.4, -W / 2 + 1, 2.2, W - 2);
    ctx.fillStyle = flash ? '#ff3b3b' : '#3b6dff';
    ctx.fillRect(0.2, -W / 2 + 1, 2.2, W - 2);
  }
  ctx.restore();
}

// =====================================================================
// HUD: カーチェイス発生アイコン (右下)
//
// 「乗用車が逃走車に昇格」「パトカーがスポーン」した = イベント発生を知らせる。
// 白丸の中に逃走車 (黒い車) / パトカー (赤青灯の車) を描く。逃走車・パトカーが
// 存在する間は出し続け、デスポーン (撤去) または無力化 (確保=parked) され次第消す。
// =====================================================================
export function chaseIconState() {
  let flee = false, police = false, garbage = false;
  for (const v of vehicles) {
    if (v.role === 'garbage') { garbage = true; continue; } // 収集車は存在する間ずっと表示
    if (v.parked) continue;              // 無力化 (確保) 済みは知らせ終わり → 非表示
    if (v.role === 'flee') flee = true;
    else if (v.role === 'police') police = true;
  }
  return { flee, police, garbage };
}

// 白丸の中に上向きのミニカーを描く (原点中心)
function drawMiniCar(color, isPolice) {
  const W = 13, L = 21;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-W / 2, -L / 2, W, L, 3);
  else ctx.rect(-W / 2, -L / 2, W, L);
  ctx.fill();
  ctx.fillStyle = 'rgba(40,55,75,0.82)';            // 窓 (前後)
  ctx.fillRect(-W / 2 + 2, -L / 2 + L * 0.16, W - 4, L * 0.22);
  ctx.fillRect(-W / 2 + 2, L / 2 - L * 0.30, W - 4, L * 0.18);
  if (isPolice) {
    const flash = (performance.now() % 440) < 220;  // 赤青灯の点滅 (車両本体と同位相)
    ctx.fillStyle = flash ? '#3b6dff' : '#ff3b3b';
    ctx.fillRect(-W / 2 + 1.5, -1.8, (W - 3) / 2 - 0.4, 3.6);
    ctx.fillStyle = flash ? '#ff3b3b' : '#3b6dff';
    ctx.fillRect(0.4, -1.8, (W - 3) / 2 - 0.4, 3.6);
    ctx.fillStyle = '#2b5bd0';                       // サイドライン
    ctx.fillRect(-W / 2, -L / 2, W, 1.6);
    ctx.fillRect(-W / 2, L / 2 - 1.6, W, 1.6);
  }
}

// 白丸の中に上向きのミニ収集車を描く (頭=上=白 / コンテナ=下=水色)
function drawMiniTruck() {
  const W = 13, L = 21, cab = L * 0.36;
  ctx.fillStyle = '#7ec8dc';                         // コンテナ (水色)
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-W / 2, -L / 2, W, L, 3); else ctx.rect(-W / 2, -L / 2, W, L);
  ctx.fill();
  ctx.fillStyle = '#f2f5f8';                         // 頭 (白)
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-W / 2, -L / 2, W, cab, 3); else ctx.rect(-W / 2, -L / 2, W, cab);
  ctx.fill();
  ctx.fillStyle = 'rgba(40,55,75,0.82)';             // 窓
  ctx.fillRect(-W / 2 + 2, -L / 2 + 2, W - 4, cab * 0.5);
}

function drawIcon(cx, cy, R, kind) {
  ctx.save();                                        // 白丸 + 影
  ctx.shadowColor = 'rgba(0,0,0,0.30)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';              // 枠
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.translate(cx, cy);
  if (kind === 'garbage') drawMiniTruck();
  else drawMiniCar(kind === 'flee' ? '#1b1d22' : '#eaf0f7', kind === 'police');
  ctx.restore();
}

function drawChaseIcons() {
  const st = chaseIconState();
  if (!st.flee && !st.police && !st.garbage) return;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); // スクリーン座標 (CSS px) に戻す
  const R = 21, pad = 18, gap = 12;
  const cy = view.cssH - pad - R;
  const list = [];                                   // 右端から左へ: パトカー → 逃走車 → 収集車
  if (st.police) list.push('police');
  if (st.flee) list.push('flee');
  if (st.garbage) list.push('garbage');
  for (let i = 0; i < list.length; i++) {
    drawIcon(view.cssW - pad - R - i * (2 * R + gap), cy, R, list[i]);
  }
}

// 1 フレーム分のシーンを描く
export function drawScene() {
  const z = cam.zoom;
  ctx.setTransform(view.dpr * z, 0, 0, view.dpr * z,
    view.dpr * (view.cssW / 2 - cam.x * z), view.dpr * (view.cssH / 2 - cam.y * z));
  const r = rect(0);
  const detailed = z > 0.6;

  // 背景 (芝)
  ctx.fillStyle = '#bfd6a4';
  ctx.fillRect(r.x0 * TILE, r.y0 * TILE, (r.x1 - r.x0 + 1) * TILE, (r.y1 - r.y0 + 1) * TILE);

  const roadTiles = [];
  for (let ty = r.y0; ty <= r.y1; ty++) {
    for (let tx = r.x0; tx <= r.x1; tx++) {
      const t = tileInfo(tx, ty);
      if (t.road) roadTiles.push(t);
      else drawBlockTile(tx, ty, detailed);
    }
  }
  for (const t of roadTiles) drawRoadBase(t, 0); // 歩道
  for (const t of roadTiles) drawRoadBase(t, 1); // 車道
  if (detailed) for (const t of roadTiles) drawRoadDetail(t);

  // 路肩のゴミ → 車両 (いずれも画面内のみ)
  const m = 40 / z;
  const wx0 = cam.x - view.cssW / 2 / z - m, wx1 = cam.x + view.cssW / 2 / z + m;
  const wy0 = cam.y - view.cssH / 2 / z - m, wy1 = cam.y + view.cssH / 2 / z + m;
  for (const g of litter) {
    if (g.x >= wx0 && g.x <= wx1 && g.y >= wy0 && g.y <= wy1) drawLitter(g);
  }
  for (const v of vehicles) {
    if (v.x >= wx0 && v.x <= wx1 && v.y >= wy0 && v.y <= wy1) drawVehicle(v);
  }

  drawChaseIcons(); // HUD: カーチェイス発生アイコン (右下)
}
