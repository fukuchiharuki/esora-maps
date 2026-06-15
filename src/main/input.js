// =====================================================================
// 操作 (ドラッグ移動 / ピンチズーム / ホイールズーム / ダブルタップズーム / タップ)
//
// ジェスチャを解釈してカメラへ指示する。単発タップは onTap(worldX, worldY) へ渡し、
// ハンドラが「消費した (true)」場合はダブルタップズームに使わない (例: ゴミのタップ)。
// 消費されなければ従来どおり (タップ単体は何も起こさず、2 連続でズーム)。
// 禁止インタラクション (詳細表示・投稿・評価・検索・ログイン・現在地・外部遷移) は引き続き無し。
// Safari のページピンチも無効化。
// =====================================================================
import { cam, zoomAt, beginDoubleTapZoom, cancelAnim, screenToWorld } from './camera.js';

export function initInput(canvas, onTap) {
  const pointers = new Map();
  let lastTap = { t: 0, x: 0, y: 0 };
  let downPos = null, moved = false;

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { downPos = { x: e.clientX, y: e.clientY }; moved = false; }
    cancelAnim();
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    if (pointers.size === 1) {
      cam.x -= (e.clientX - p.x) / cam.zoom;
      cam.y -= (e.clientY - p.y) / cam.zoom;
      if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 12) moved = true;
    } else if (pointers.size === 2) {
      const ids = [...pointers.keys()];
      const o1 = pointers.get(ids[0]), o2 = pointers.get(ids[1]);
      const n1 = e.pointerId === ids[0] ? { x: e.clientX, y: e.clientY } : o1;
      const n2 = e.pointerId === ids[1] ? { x: e.clientX, y: e.clientY } : o2;
      const oldMid = { x: (o1.x + o2.x) / 2, y: (o1.y + o2.y) / 2 };
      const newMid = { x: (n1.x + n2.x) / 2, y: (n1.y + n2.y) / 2 };
      const oldD = Math.hypot(o1.x - o2.x, o1.y - o2.y) || 1;
      const newD = Math.hypot(n1.x - n2.x, n1.y - n2.y) || 1;
      cam.x -= (newMid.x - oldMid.x) / cam.zoom;
      cam.y -= (newMid.y - oldMid.y) / cam.zoom;
      zoomAt(newMid.x, newMid.y, cam.zoom * (newD / oldD));
      moved = true;
    }
    p.x = e.clientX; p.y = e.clientY;
  });

  function pointerEnd(e) {
    if (!pointers.has(e.pointerId)) return;
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) canvas.classList.remove('dragging');
    // 単発タップ (動かしていない単独タップ) → まず onTap へ。消費されたら以降の処理はしない。
    if (wasSingle && !moved && e.type === 'pointerup') {
      const w = screenToWorld(e.clientX, e.clientY);
      if (onTap && onTap(w.x, w.y)) { lastTap.t = 0; return; } // 消費 (ゴミのタップ等) → ズームに使わない
      // ダブルタップズーム (動かしていない単独タップ × 2)
      const now = performance.now();
      if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 32) {
        beginDoubleTapZoom(e.clientX, e.clientY, now);
        lastTap.t = 0;
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    cancelAnim();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0016));
    zoomAt(e.clientX, e.clientY, cam.zoom * factor);
  }, { passive: false });

  // Safari のページピンチを無効化
  document.addEventListener('gesturestart', e => e.preventDefault());
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}
