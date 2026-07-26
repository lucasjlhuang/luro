/**
 * Loaded before the app, as its own module script, so it survives failures the
 * main bundle cannot report on — including a parse error, which stops that
 * bundle from running a single line.
 *
 * Without this, every startup failure looks identical from the outside: the
 * window opens, the Dock icon appears, and nothing renders. On a transparent
 * full-screen overlay that reads as "the app is broken" with nothing to go on,
 * and the person seeing it is usually the one person who cannot debug it.
 */

const FATAL_ID = 'luro-fatal';

function showFatal(title: string, detail: string): void {
  if (document.getElementById(FATAL_ID)) return; // first failure wins
  const mount = () => {
    const el = document.createElement('div');
    el.id = FATAL_ID;
    el.setAttribute('data-interactive', '');
    el.style.cssText = [
      'position:fixed',
      'top:50%',
      'left:50%',
      'transform:translate(-50%,-50%)',
      'z-index:2147483647',
      'max-width:min(560px,80vw)',
      'padding:20px 24px',
      'border-radius:14px',
      'background:#fdf6e6',
      'color:#4a3a28',
      'box-shadow:0 12px 40px rgba(0,0,0,.35)',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif',
      'white-space:pre-wrap',
      'user-select:text',
    ].join(';');
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:8px';
    const p = document.createElement('div');
    p.textContent = detail;
    p.style.cssText = 'font-family:ui-monospace,Menlo,monospace;font-size:11px;opacity:.85';
    // Dismissible: not every caught error is fatal. The room may be running
    // perfectly behind this panel, and an undismissable overlay would be a
    // worse bug than the one it is reporting.
    const x = document.createElement('button');
    x.textContent = '\u2715';
    x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText =
      'position:absolute;top:8px;right:10px;border:0;background:transparent;' +
      'font-size:13px;line-height:1;color:#8a7660;cursor:pointer;padding:2px';
    x.onclick = () => el.remove();
    el.append(h, p, x);
    document.body.appendChild(el);
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
}

window.addEventListener('error', (e) => {
  const err = e.error as Error | undefined;
  showFatal(
    'luro could not start',
    `${err?.name ?? 'Error'}: ${err?.message ?? e.message}\n${e.filename ?? ''}:${e.lineno ?? 0}`
  );
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as Error | string | undefined;
  showFatal(
    'luro could not start',
    typeof r === 'string' ? r : `${r?.name ?? 'Error'}: ${r?.message ?? String(r)}`
  );
});

/*
 * CSP failures are invisible in `tauri dev` — no policy is applied there — and
 * in a packaged build they surface as some unrelated-looking breakage: blocked
 * textures, or a WebAssembly CompileError from a decoder nobody knew was
 * loaded. Naming the directive that did it turns a guessing game into a fix.
 */
document.addEventListener('securitypolicyviolation', (e) => {
  showFatal(
    'Blocked by the app\u2019s security policy',
    `directive: ${e.violatedDirective}\nblocked: ${e.blockedURI || '(inline/eval)'}\n\n` +
      'Widen that directive in src-tauri/tauri.conf.json (app.security.csp).'
  );
});

/*
 * three.js dropped WebGL1 in r163, so the renderer asks for a `webgl2` context
 * and nothing else. macOS 11 Big Sur ships Safari 14, where WebGL2 was still
 * behind a flag — it only became default in Safari 15 — and WKWebView tracks
 * whatever Safari is installed. On such a machine the renderer throws during
 * construction and the whole app unmounts, so say so plainly instead.
 */
try {
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2')) {
    showFatal(
      'Graphics not supported on this Mac',
      'luro needs WebGL2, which this version of macOS does not enable.\n\n' +
        'Update macOS — or, on Big Sur, updating to Safari 15.6.1 is enough, ' +
        'since the app uses the system WebKit.'
    );
  }
} catch {
  /* probing must never itself break startup */
}

export {};
