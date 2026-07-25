/**
 * Thin, failure-tolerant wrappers around the Tauri v2 window API.
 * Everything degrades to a no-op in a plain browser so `vite dev`
 * without the Rust shell still renders.
 */

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let lastIgnore: boolean | null = null;

/** Toggle OS-level click-through. Deduped so we only IPC on change. */
export async function setClickThrough(ignore: boolean): Promise<void> {
  if (!isTauri || lastIgnore === ignore) return;
  lastIgnore = ignore;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setIgnoreCursorEvents(ignore);
  } catch {
    lastIgnore = null; // retry on next poll
  }
}

/**
 * Grow the window to cover the current monitor. The window is
 * transparent and click-through on empty pixels, so this is invisible —
 * it just gives panels the whole screen to roam. Programmatic setSize
 * works even with resizable: false.
 */
export async function expandWindowToScreen(): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window');
    const { PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/dpi');
    const win = getCurrentWindow();
    const monitor = await currentMonitor();
    if (!monitor) return;
    await win.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
    await win.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
  } catch {
    /* stay at the configured size */
  }
}

/**
 * Global cursor position translated into window-local *logical* pixels.
 * Works even while the window ignores cursor events (which is exactly
 * when we need it — the DOM receives no mouse events in that state).
 */
export async function getCursorInWindow(): Promise<{ x: number; y: number } | null> {
  if (!isTauri) return null;
  try {
    const { getCurrentWindow, cursorPosition } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const [cursor, origin, scale] = await Promise.all([
      cursorPosition(),
      win.outerPosition(),
      win.scaleFactor(),
    ]);
    return { x: (cursor.x - origin.x) / scale, y: (cursor.y - origin.y) / scale };
  } catch {
    return null;
  }
}
