import pointer1x from '../assets/cursors/WiiPointer-33.png';
import pointer2x from '../assets/cursors/WiiPointer.png';
import blue1x from '../assets/cursors/WiiPointerBlue-33.png';
import blue2x from '../assets/cursors/WiiPointerBlue.png';
import open1x from '../assets/cursors/WiiPointerOpenHand-33.png';
import open2x from '../assets/cursors/WiiPointerOpenHand.png';
import grab1x from '../assets/cursors/WiiPointerGrab-33.png';
import grab2x from '../assets/cursors/WiiPointerGrab.png';

/**
 * Wii-style hand cursors, drawn at 33 CSS px.
 *
 * Each one ships at two sizes: a 33px image used on its own (guaranteeing
 * the size on any engine, including ones that ignore `image-set` inside
 * `cursor`) and the original 66px as the 2x entry, so a retina display
 * gets every source pixel. Declarations are emitted coarse-to-preferred —
 * plain `url()`, `-webkit-image-set` (WKWebView on macOS), then standard
 * `image-set` — and an engine that can't parse one keeps the last form it
 * understood.
 *
 * Hotspots were measured from each PNG's alpha channel — the index
 * fingertip for the pointers, the palm centre for the hands — then halved
 * to match the rendered size.
 */

export interface CursorSpec {
  /** Plain `url()` at the rendered size; understood everywhere. */
  base: string;
  /** Preferred forms, applied after `base` so they win where supported. */
  scaled: string[];
}

function spec(
  url1x: string,
  url2x: string,
  hx: number,
  hy: number,
  fallback: string
): CursorSpec {
  // Hotspots were measured on the 66px art; the cursor renders at 33.
  const hot = `${Math.round(hx / 2)} ${Math.round(hy / 2)}`;
  const set = `url(${url1x}) 1x, url(${url2x}) 2x`;
  return {
    base: `url(${url1x}) ${hot}, ${fallback}`,
    scaled: [
      `-webkit-image-set(${set}) ${hot}, ${fallback}`,
      `image-set(${set}) ${hot}, ${fallback}`,
    ],
  };
}

export const CURSOR = {
  default: spec(pointer1x, pointer2x, 6, 1, 'auto'),
  pointer: spec(blue1x, blue2x, 6, 1, 'pointer'),
  open: spec(open1x, open2x, 24, 30, 'grab'),
  grab: spec(grab1x, grab2x, 20, 34, 'grabbing'),
} as const;

function apply(cursor: CursorSpec): void {
  const style = document.body.style;
  // Assignments the engine rejects are dropped by the CSSOM, leaving the
  // previous valid value in place — hence the cascade of writes.
  style.cursor = cursor.base;
  for (const value of cursor.scaled) style.cursor = value;
}

/** While locked, hover handlers can't change the cursor. */
let locked: CursorSpec | null = null;

/** Set the page-wide cursor (the WebGL canvas inherits from body). */
export function setCursor(cursor: CursorSpec): void {
  if (locked) return;
  apply(cursor);
}

/**
 * Pin the cursor for the duration of a drag. Objects passing under the
 * pointer mid-drag would otherwise flip it back to their hover cursor.
 */
export function lockCursor(cursor: CursorSpec): void {
  locked = null;
  apply(cursor);
  locked = cursor;
}

export function unlockCursor(): void {
  locked = null;
}

/**
 * Lock the cursor for a drag the page can't observe the end of.
 * Tauri's `startDragging()` hands the mouse to the OS, which on macOS
 * usually swallows the matching `pointerup` — so a move with no buttons
 * held is treated as the release too, otherwise the lock would never lift.
 */
export function lockCursorUntilRelease(cursor: CursorSpec, onRelease: () => void): void {
  lockCursor(cursor);
  const finish = () => {
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointermove', onMove);
    unlockCursor();
    onRelease();
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons === 0) finish();
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointermove', onMove);
}

/** Every declaration for one selector, coarse-to-preferred. */
function rule(selector: string, cursor: CursorSpec): string {
  const decls = [cursor.base, ...cursor.scaled].map((v) => `cursor: ${v};`).join(' ');
  return `${selector} { ${decls} }`;
}

/**
 * Installs the static rules once: the default hand everywhere, and the
 * blue pointing hand over clickable UI controls. Kept in JS so the
 * hotspots live in exactly one place.
 */
export function installCursorStyles(): void {
  if (document.getElementById('wii-cursors')) return;
  const style = document.createElement('style');
  style.id = 'wii-cursors';
  // Form controls carry their own UA cursors (I-beam, arrow), so they are
  // overridden explicitly — the custom set should hold inside panels too.
  //
  // Deliberately NOT matching `canvas`: the WebGL canvas must keep
  // inheriting body's inline cursor, which is what hover handlers set.
  // A declaration of its own would out-rank that and freeze it.
  style.textContent = [
    rule('html, body', CURSOR.default),
    rule('input, textarea, select', CURSOR.default),
    rule('button, [role="button"], summary, label', CURSOR.pointer),
    rule('[data-draw]', CURSOR.pointer),
  ].join('\n');
  document.head.appendChild(style);
  setCursor(CURSOR.default);
}
