import { useEffect } from 'react';
import { getCursorInWindow, isTauri, setClickThrough } from '../lib/tauri';
import { hitTestAt, isForceInteractive } from '../lib/hitTest';

const POLL_MS = 60;

/**
 * Dynamic hit-testing for the transparent overlay.
 *
 * Tauri (unlike Electron) has no `setIgnoreMouseEvents(..., { forward })`;
 * once a window ignores cursor events the DOM receives nothing, so hover
 * state can never be derived from DOM events. Instead we poll the *global*
 * cursor position (which keeps working in the ignored state), map it into
 * window coordinates, and decide:
 *
 *   - over a `[data-interactive]` UI panel  -> capture clicks
 *   - over the WebGL canvas                 -> raycast; capture iff a mesh is hit
 *   - over empty space / outside the window -> OS click-through
 *
 * On any uncertainty (API failure) we keep the window interactive rather
 * than risk an unclickable app.
 */
export function usePassThrough(): void {
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;

    (async () => {
      while (!cancelled) {
        const p = await getCursorInWindow();
        let interactive = true; // safe default
        if (isForceInteractive()) {
          // mid-drag: never let the OS swallow pointer events
        } else if (p) {
          if (p.x < 0 || p.y < 0 || p.x > window.innerWidth || p.y > window.innerHeight) {
            interactive = false;
          } else {
            const el = document.elementFromPoint(p.x, p.y);
            if (!el) interactive = false;
            else if (el.closest('[data-interactive]')) interactive = true;
            else if (el.tagName === 'CANVAS') interactive = hitTestAt(p.x, p.y);
            else interactive = false;
          }
        }
        await setClickThrough(!interactive);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
