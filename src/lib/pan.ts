/**
 * Screen-space offset of the room inside the (screen-sized) window.
 * Dragging the rug pans the camera instead of moving the OS window —
 * the window now covers the whole screen so panels can go anywhere.
 * Persisted on drag end so the room stays where the user left it.
 */

const KEY = 'desk-overlay-pan';

let pan = { x: 0, y: 0 };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as { x?: number; y?: number };
    pan = { x: parsed.x ?? 0, y: parsed.y ?? 0 };
  }
} catch {
  /* fresh start */
}

export function getPan(): { x: number; y: number } {
  return pan;
}

export function panBy(dx: number, dy: number): void {
  // Keep the room's centre reachable on screen.
  const limX = Math.max(0, window.innerWidth / 2 - 60);
  const limY = Math.max(0, window.innerHeight / 2 - 60);
  pan = {
    x: Math.max(-limX, Math.min(limX, pan.x + dx)),
    y: Math.max(-limY, Math.min(limY, pan.y + dy)),
  };
}

export function savePan(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pan));
  } catch {
    /* non-fatal */
  }
}
