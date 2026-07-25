import type { Stroke } from '../store/useAppStore';

/** Reference width strokes were authored against; sizes scale from this. */
export const STROKE_BASE_WIDTH = 440;

let offscreen: HTMLCanvasElement | null = null;

/**
 * Deterministically renders the full stroke list onto a canvas.
 * Eraser strokes use destination-out on an offscreen layer so they only
 * remove ink — the opaque background is composited underneath afterwards.
 * Shared by the whiteboard modal and the 3D whiteboard texture.
 */
export function renderStrokes(
  target: HTMLCanvasElement,
  strokes: Stroke[],
  background: string | null
): void {
  const w = target.width;
  const h = target.height;
  if (!offscreen) offscreen = document.createElement('canvas');
  if (offscreen.width !== w || offscreen.height !== h) {
    offscreen.width = w;
    offscreen.height = h;
  }
  const octx = offscreen.getContext('2d');
  const ctx = target.getContext('2d');
  if (!octx || !ctx) return;

  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, w, h);
  octx.lineJoin = 'round';
  octx.lineCap = 'round';

  for (const s of strokes) {
    octx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    // Eraser marks are blocky like the physical eraser; pen stays round.
    octx.lineCap = s.erase ? 'square' : 'round';
    octx.strokeStyle = s.color;
    octx.lineWidth = Math.max(1, s.size * (w / STROKE_BASE_WIDTH));
    octx.beginPath();
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      const x = s.points[i] * w;
      const y = s.points[i + 1] * h;
      if (i === 0) octx.moveTo(x, y);
      else octx.lineTo(x, y);
    }
    octx.stroke();
  }
  octx.globalCompositeOperation = 'source-over';

  ctx.clearRect(0, 0, w, h);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(offscreen, 0, 0);
}
