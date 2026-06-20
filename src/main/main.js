// =====================================================================
// Esora Maps — エントリポイント (初期化と接続のみ)
//
// 各モジュールを組み立ててフレームループを回すだけ。実処理は持たない。
//   config   — 定数・方向
//   rng      — 決定論的ハッシュ
//   roadpart — 道路部品の契約 (接続口 + 通行パス)
//   map      — マップ配置 (道路網生成・接続トポロジ)
//   vehicles — 車両移動
//   camera   — ビュー変換・ズーム
//   render   — 描画
//   input    — 操作
// =====================================================================
import * as camera from './camera.js';
import * as vehicles from './vehicles.js';
import * as scenario from './scenario.js';
import * as litter from './litter.js';
import * as mail from './mail.js';
import * as effects from './effects.js';
import * as render from './render.js';
import { initInput } from './input.js';

const canvas = document.getElementById('map');

// 初期化
render.initRender(canvas);
render.resize();
window.addEventListener('resize', render.resize);
camera.placeCamera();
// タップ: ゴミを指したら収集車をそのゴミへ (消費=true でダブルタップズームを抑止)。それ以外は従来どおり。
initInput(canvas, (wx, wy) => scenario.tapWorld(wx, wy));

// フレームループ: 更新 (カメラ → 車両) → 描画 を毎フレーム接続する
let lastT = performance.now();
function frame(now) {
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.05) dt = 0.05;

  camera.stepAnim(now);          // ダブルタップズームのアニメーション
  vehicles.manageVehicles(now);  // 車両スポーン / デスポーン
  litter.manageLitter(now);      // 路肩のゴミ スポーン / デスポーン
  mail.manageMail(now);          // 郵便ポスト上の郵便物 スポーン / デスポーン
  scenario.updateScenarios(dt, now); // 出来事 (カーチェイス・ゴミ収集・郵便回収) のスポーン/進行/後始末
  effects.updateEffects(now);    // 一時的な視覚エフェクト (タップ波紋) の寿命管理
  vehicles.updateAll(dt);        // 走行
  render.drawScene();            // 描画

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ヒントを数秒後にフェードアウト
setTimeout(() => document.getElementById('hint').classList.add('fade'), 6000);
