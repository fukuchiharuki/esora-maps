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
import { TILE, ROAD_W, SIDE_W, LANE_OFF, DX, DY } from './config.js';
import { hash, rnd01 } from './rng.js';
import { shoulderPoint } from './roadpart.js';
import { tileInfo } from './map.js';
import { vehicles } from './vehicles.js';
import { litter } from './litter.js';
import { mail, BUBBLE_DY } from './mail.js';
import { effects, RIPPLE_DUR } from './effects.js';
import { cam, view, rect, setViewport, drawScale } from './camera.js';

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
  // 郵便ポスト: 路肩点 (shoulderPoint = 郵便物が乗る座標と同一) に描く。日本スタイル =
  // 赤い四角の箱を赤い棒 (支柱) が支える形。棒は短く・四角は縦長。棒の下端 (= 接地点) が
  // 路肩点に来るよう全体を上へ積む (= 道路上に立っているように見えない)。
  if (tile.post) {
    const p = shoulderPoint(tile.post.dir, 0.5);
    const cx = ox + p.x, cy = oy + p.y; // 棒の下端 (接地点) がこの位置
    ctx.fillStyle = '#b02a24';                                // 支柱 (短い棒。下端 = cy)
    ctx.fillRect(cx - 1.6, cy - 4, 3.2, 4);
    ctx.fillStyle = '#d2362f';                                // 箱本体 (赤い四角・縦長)
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(cx - 4.5, cy - 16, 9, 12, 2); else ctx.rect(cx - 4.5, cy - 16, 9, 12);
    ctx.fill();
    ctx.fillStyle = '#b02a24';                                // 天面の縁 (帽子)
    ctx.fillRect(cx - 4.5, cy - 16, 9, 2);
    ctx.fillStyle = 'rgba(20,20,20,0.7)';                     // 投入口 (横長スリット)
    ctx.fillRect(cx - 3, cy - 12, 6, 1.6);
  }
}

// 路肩のゴミ袋 (車両以外のオブジェクト)。車両と同じく引きで大きく描く (タップしやすく)。
// 描画拡大率は camera.drawScale (描画と当たり判定で同じ値を使う単一ソース)。
// ハイライト中 (収集車の目的地) はゆっくり「ピョーンピョーン」と跳ね、強調リングを添える。
function drawLitter(g) {
  ctx.save();
  ctx.translate(g.x, g.y);
  const ds = drawScale();
  ctx.scale(ds, ds);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';                       // 影 (地面に残り跳ねない)
  ctx.beginPath(); ctx.ellipse(0.6, 1.6, 4.4, 2.4, 0, 0, Math.PI * 2); ctx.fill();
  let bounce = 0;
  if (g.hl) {                                              // ハイライト: 強調リング + ゆっくり上下に跳ねる
    const ph = (performance.now() % 900) / 900;            // 0..1 のループ (ゆっくり)
    bounce = -Math.abs(Math.sin(ph * Math.PI)) * 5;        // 上方向へピョーン
    ctx.strokeStyle = 'rgba(126,200,220,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.translate(0, bounce);                                // 袋本体だけ跳ねる (影は残す)
  ctx.fillStyle = '#86cfe0';                                // 水色のゴミ袋
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-4, -3.5, 8, 7, 3); else ctx.rect(-4, -3.5, 8, 7);
  ctx.fill();
  ctx.fillStyle = '#5aa6b8';                                // 結び目 (濃いめの水色)
  ctx.beginPath(); ctx.moveTo(-2, -3.2); ctx.lineTo(0, -5); ctx.lineTo(2, -3.2); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// 郵便物。座標 (g.x,g.y) はポスト上だが、見た目はポストに対し「吹き出し」として上に出す。
// ハイライト中 (郵便車の目的地) はポスト点を囲む赤いリングを添え、吹き出しがゆっくり跳ねる。
function drawMail(g) {
  ctx.save();
  ctx.translate(g.x, g.y);                                  // = ポスト点
  const ds = drawScale();
  ctx.scale(ds, ds);
  let bounce = 0;
  if (g.hl) {                                               // ハイライト: ポストを囲むリング + 吹き出しが跳ねる
    const ph = (performance.now() % 900) / 900;             // 0..1 のループ (ゆっくり)
    bounce = -Math.abs(Math.sin(ph * Math.PI)) * 4;
    ctx.strokeStyle = 'rgba(210,54,47,0.9)';                // 赤系のリング (郵便)
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.stroke();
  }
  const by = -BUBBLE_DY + bounce;                           // 吹き出しの中心 (背の高い箱の上に浮かせる)
  ctx.fillStyle = 'rgba(255,255,255,0.96)';                 // 吹き出し本体 (白)
  ctx.beginPath(); ctx.moveTo(-2, by + 4.5); ctx.lineTo(2, by + 4.5); ctx.lineTo(0, by + 8.5); ctx.closePath(); ctx.fill(); // 尾
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-6, by - 5, 12, 9, 2.5); else ctx.rect(-6, by - 5, 12, 9);
  ctx.fill();
  ctx.strokeStyle = '#d2362f';                              // 封筒 (赤枠 + フラップ)
  ctx.lineWidth = 0.8;
  ctx.strokeRect(-4.5, by - 3.4, 9, 6);
  ctx.beginPath(); ctx.moveTo(-4.5, by - 3.4); ctx.lineTo(0, by + 0.6); ctx.lineTo(4.5, by - 3.4); ctx.stroke();
  ctx.restore();
}

// タップ波紋 (共通の視覚エフェクト)。ワールド座標で広がりながら薄れる白い輪。線幅は画面上で一定。
function drawEffects() {
  if (!effects.length) return;
  const now = performance.now();
  for (const e of effects) {
    const p = (now - e.t0) / RIPPLE_DUR;                   // 0..1 の進捗
    if (p < 0 || p > 1) continue;
    ctx.strokeStyle = `rgba(255,255,255,${(1 - p) * 0.8})`;
    ctx.lineWidth = 2 / cam.zoom;                          // 画面上で一定の太さ
    ctx.beginPath(); ctx.arc(e.x, e.y, 6 + p * 26, 0, Math.PI * 2); ctx.stroke();
  }
}

function drawVehicle(v) {
  const flash = (performance.now() % 440) < 220; // 赤青灯の点滅位相
  ctx.save();
  ctx.translate(v.x, v.y);
  const ds = drawScale();
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
  // 郵便車: 赤いバン (頭も赤)。前方=+x の運転台はやや濃い赤で区別し、窓と白帯で前方/郵便を示す。
  if (v.role === 'post') {
    const cab = L * 0.32; // 運転台の長さ
    ctx.fillStyle = v.color; // 赤い荷台 (車体全体)
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-L / 2, -W / 2, L, W, 2.4); else ctx.rect(-L / 2, -W / 2, L, W);
    ctx.fill();
    ctx.fillStyle = '#b02a24'; // 運転台 (頭も赤。やや濃い赤で頭を区別)
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(L / 2 - cab, -W / 2, cab, W, 2.4); else ctx.rect(L / 2 - cab, -W / 2, cab, W);
    ctx.fill();
    ctx.fillStyle = 'rgba(40,55,75,0.78)'; // 運転台の窓 (前)
    ctx.fillRect(L / 2 - cab * 0.62, -W / 2 + 1.4, cab * 0.4, W - 2.8);
    ctx.fillStyle = '#fff'; // 荷台側面の白い帯 (郵便を示す)
    ctx.fillRect(-L / 2 + 1.5, -1, L - cab - 3, 2);
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
// 特別車 (パト/逃走車/収集車) の位置インジケータ
//
// 対象車両の位置を知らせる。対象が画面外なら、その方向の画面端にアイコンを出す
// (車両の座標に合わせる: x が画面外なら y を合わせ、y が画面外なら x を合わせ、両軸とも
// 外なら画面端=角)。対象が画面内なら、アイコンは出さず車両に白い (透過) ハイライトを描く。
// 無力化 (確保=parked) された車両は対象外 (知らせ終わり)。収集車は目的地のゴミへ向かって回収する
// 間だけ対象 (v.targeting)。
// =====================================================================
const ICON_R = 21;          // アイコンの白丸半径
const ICON_MARGIN = ICON_R + 8; // 画面端からの内側マージン (アイコン全体が見えるように)
const HIGHLIGHT_R = 15;     // 車両ハイライトの半径 (全車種共通の大きさ。車体長 len には依存しない)

// その車両が位置インジケータの対象 (役割) か。収集車/郵便車は目的地へ向かう間だけ (targeting)。
function indicatorKind(v) {
  if (v.parked) return null;                         // 無力化済みは知らせない
  if (v.role === 'garbage') return v.targeting ? 'garbage' : null; // 目的地へ向かう間だけ
  if (v.role === 'post') return v.targeting ? 'post' : null;       // 同上 (郵便車)
  if (v.role === 'flee') return 'flee';
  if (v.role === 'police') return 'police';
  return null;
}

// 各特別車の位置インジケータ情報。onScreen=画面内 (ハイライト) / 画面外 (画面端 ix,iy にアイコン)。
export function targetIndicators() {
  const out = [], W = view.cssW, H = view.cssH, z = cam.zoom;
  for (const v of vehicles) {
    const kind = indicatorKind(v);
    if (!kind) continue;
    const sx = (v.x - cam.x) * z + W / 2, sy = (v.y - cam.y) * z + H / 2; // 車両のスクリーン座標
    const onScreen = sx >= 0 && sx <= W && sy >= 0 && sy <= H;
    // 画面端に寄せる (x が範囲内なら x はそのまま=合わせる、外なら端へ。y も同様)
    const ix = Math.max(ICON_MARGIN, Math.min(W - ICON_MARGIN, sx));
    const iy = Math.max(ICON_MARGIN, Math.min(H - ICON_MARGIN, sy));
    out.push({ v, kind, onScreen, ix, iy });
  }
  return out;
}

// 既存テスト互換: 各役割で「位置インジケータの対象車両が居るか」(収集車/郵便車は targeting のときだけ)。
export function chaseIconState() {
  let flee = false, police = false, garbage = false, post = false;
  for (const v of vehicles) {
    const kind = indicatorKind(v);
    if (kind === 'flee') flee = true;
    else if (kind === 'police') police = true;
    else if (kind === 'garbage') garbage = true;
    else if (kind === 'post') post = true;
  }
  return { flee, police, garbage, post };
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
  else if (kind === 'post') drawMiniCar('#d2362f', false); // 郵便車 = 赤いミニカー
  else drawMiniCar(kind === 'flee' ? '#1b1d22' : '#eaf0f7', kind === 'police');
  ctx.restore();
}

// 画面内の対象車両に白い (透過) ハイライトを描く (ワールド座標。車両の上に淡い光輪)。
// 半径は全車種で共通 (HIGHLIGHT_R) → 収集車もパト/逃走車と同じ大きさ。
function drawTargetHighlight(v) {
  ctx.save();
  ctx.translate(v.x, v.y);
  const ds = drawScale();
  ctx.scale(ds, ds);
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.beginPath();
  ctx.arc(0, 0, HIGHLIGHT_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// 画面外の対象車両を、その方向の画面端アイコンで知らせる (スクリーン座標 = CSS px)。
function drawTargetIcons(list) {
  if (!list.length) return;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); // スクリーン座標 (CSS px) に戻す
  for (const ind of list) drawIcon(ind.ix, ind.iy, ICON_R, ind.kind);
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
  for (const g of mail) {
    if (g.x >= wx0 && g.x <= wx1 && g.y >= wy0 && g.y <= wy1) drawMail(g);
  }
  for (const v of vehicles) {
    if (v.x >= wx0 && v.x <= wx1 && v.y >= wy0 && v.y <= wy1) drawVehicle(v);
  }

  // 特別車の位置インジケータ: 画面内 → 車両に白いハイライト (ワールド座標) /
  //                          画面外 → 画面端にアイコン (スクリーン座標)。
  const inds = targetIndicators();
  for (const ind of inds) if (ind.onScreen) drawTargetHighlight(ind.v);

  drawEffects();    // タップ波紋 (共通の視覚エフェクト・ワールド座標)
  drawTargetIcons(inds.filter(i => !i.onScreen)); // HUD: 画面外の特別車を端のアイコンで指す
}
