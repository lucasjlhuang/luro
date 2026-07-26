# luro

A collaborative, transparent, always-on-top 3D isometric desk that floats over your desktop.
Two people (Lulu / Roro) each run the app; it pairs over WebRTC (PeerJS) using a shared room
code and keeps a shared notebook, corkboard, whiteboard, pomodoro timer, habit tracker,
and day/night lighting in sync.

Stack: **Tauri v2 · React 18 · TypeScript · Three.js · @react-three/fiber · drei · Zustand · Tailwind · PeerJS**

## Run

```bash
npm install
npm run tauri dev
```

## Packaging

```bash
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/` — `.app` and `.dmg` on macOS, `.msi` and an
NSIS `.exe` on Windows.

### Auto-update

The app checks `https://github.com/lucasjlhuang/luro/releases/latest/download/latest.json` on
launch and every 6 h, installs quietly in the background, and the new version takes effect on the
next launch. Failures are swallowed — no network, no release yet, or a dev build must never break
the app.

Releases are built and signed by CI. Two repo secrets are required, or the update will build but
ship unsigned and every client will reject it:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/luro.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty (the key was generated without one) |

`~/.tauri/luro.key` is the *only* copy of the signing key and is deliberately outside the repo.
**Lose it and no future build can ship an update to an already-installed app** — every client
would need a fresh manual install.

`npm run release` (macOS) does the same build and then replaces `/Applications/luro.app` with it,
so the installed copy is never a stale snapshot. Note that a packaged app is always a build
artifact — the frontend is compiled into the binary, so it only changes when you rebuild. For
live reload while working, use `npm run tauri dev`.

**Tauri builds only for the platform it runs on.** A Windows `.exe` cannot be produced from a
Mac (it needs the MSVC toolchain and WebView2), so `.github/workflows/release.yml` builds both:
push a tag (`git tag v0.1.0 && git push origin v0.1.0`) or run the workflow by hand from the
Actions tab, and it attaches a universal macOS `.dmg` and the Windows installers to a draft
release. This requires the repo to have a GitHub remote.

### Sending a build to someone else

Neither build is signed with a real developer certificate, so the first launch is blocked.

**macOS** — the app is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), which is what keeps
macOS from calling it *"damaged"*; without it the bundle has no `_CodeSignature` seal, validation
fails before Gatekeeper reaches a policy decision, and the only button offered is Move to Trash.
With the seal, the tester instead gets *"Apple cannot check it for malicious software"*, and can:

- **System Settings → Privacy & Security → Security → "Open Anyway"** (right-click → Open no
  longer works on macOS 15+, Apple removed that bypass), or
- drag the app to `/Applications`, then `xattr -dr com.apple.quarantine /Applications/luro.app`

Removing the warning entirely means an Apple Developer Program membership ($99/yr) for a
Developer ID certificate plus notarization via `notarytool`. Notarization itself is free once
enrolled.

Icons are generated from `src-tauri/app-icon.png` with `npx tauri icon src-tauri/app-icon.png`
(then delete the `android/` and `ios/` sets it emits — this is a desktop-only app). The source is
300×300; a 1024×1024 original would come out sharper at the largest macOS sizes.

## How it works

- **Transparency / click-through** — the window is frameless, transparent, non-resizable
  (500×500) and always-on-top. Tauri has no Electron-style `setIgnoreMouseEvents(..., {forward})`,
  so `src/hooks/usePassThrough.ts` polls the *global* cursor position (`cursorPosition()`, which
  keeps working while cursor events are ignored), maps it into window space, and enables
  `setIgnoreCursorEvents(true)` only when the cursor is over empty pixels — decided by
  `document.elementFromPoint` for UI panels and a Three.js raycast for the 3D scene.
- **Window dragging** — pointer-down on the rug/floor mesh calls `startDragging()`.
- **Pairing** — peer ids are `luro-<paircode>-a` / `-b`, registered on the public PeerJS cloud
  broker. Both desks enter the same code (pencil cup ⚙); a different code is a different room, so
  handing the app to someone else cannot lock your partner out or leak your data to them. A fresh
  install generates its own random code. Desks dial each other every 4 s until a reliable data
  channel opens.
- **Role auto-claim** — a desk that has never picked a character asks for Lulu and falls back to
  Roro if Lulu is taken, so the second install pairs up without touching a setting. Picking by
  hand pins the choice, and a pinned desk waits for its own id rather than swapping. On connect, each side sends a `FULL_SYNC`; afterwards granular messages sync notes,
  tasks, whiteboard strokes, lamp/lighting state, and the timer (last-write-wins via timestamps).
- **Persistence** — Zustand `persist` keeps notes, tasks, habits, strokes, lighting, timer, and
  role in `localStorage`; PeerJS handles live in module-level singletons, never in persisted
  state. Stroke history is capped at 600 and coordinates are stored to 4 decimal places, which
  keeps the whole blob under ~1.7 MB against the ~5 MB quota — unbounded, it would eventually
  throw on write and take notes, tasks and habits down with it.
- **Habit tracker** — the dumbbell opens a shared weekly grid. Unlike notes and tasks, which are
  per-user, this is one board both people edit, resolved last-write-wins on `updatedAt`.

## Compatibility

macOS 11 Big Sur and later, **but WebGL2 is required**: three.js dropped WebGL1 in r163, so the
renderer asks for a `webgl2` context and has no fallback. Big Sur ships Safari 14, where WebGL2
was still behind a flag (default from Safari 15), and WKWebView uses whatever Safari is
installed — so Big Sur works only if Safari has been updated to 15.6.1. Without it the renderer
throws on construction, the app unmounts, and you get a blank transparent window; `src/boot.ts`
detects that case up front and says so on screen instead. The universal build carries both slices (Intel min 10.13, Apple
Silicon min 11.0), and Vite targets `safari14` because Big Sur's WKWebView tracks Safari 14–15.6
— building with `esnext` can emit syntax that WebKit rejects outright, which shows up as a blank
window rather than an error. If you ever raise that target, test on the oldest macOS you support.

## Asset credits

Models from Sketchfab, bundled as compressed GLB (the bear decimated from a 1.3M-triangle scan).
This project is personal and non-commercial.

- Lulu and Roro character models by
  [sema.game.studio](https://sketchfab.com/sema.game.studio) — `src/assets/models/lulu.glb`
  and `roro.glb`
- "Chunky Djungelskog Bear" by [Arkify 3D](https://sketchfab.com/arkify) — CC-BY-NC-4.0
  — https://sketchfab.com/3d-models/chunky-djungelskog-bear-a865f0ac929c4cfc88ff270f7bf18c43

## Notes & known limits

- Auto-claim is first-come: if your partner's desk starts while yours is off, theirs takes Lulu.
  Pin each desk once (pencil cup ⚙) and it stays put.
- The pair code is a namespace, not a secret — it is not authentication. Someone who knew your
  code could still take a slot. For real privacy, self-host `peerjs-server` and pass `host`/`port`
  to the `Peer` constructor.
- A `WHITEBOARD_CLEAR` that happens while the peer is offline can be resurrected by that peer's
  next `FULL_SYNC` (stroke sets are merged by id — eventual-consistency trade-off).
- No TURN server is configured, so PeerJS falls back to Google's public STUN. Two desks behind
  strict/symmetric NAT may fail to establish a data channel even though both show CONNECTING.
- `macOSPrivateApi` is required for the transparent window and makes the app ineligible for the
  Mac App Store. Not an issue for direct distribution.
- The CSP in `tauri.conf.json` needs `'wasm-unsafe-eval'` in `script-src`: three-stdlib bundles
  the Meshopt/Draco/KTX2 decoders via drei's GLTF loader, and Meshopt calls `WebAssembly.validate`
  on startup even though none of our models use those formats. Without it the app throws a
  `CompileError` before mounting.
- The CSP allows only `self`, `blob:`/`data:` and the PeerJS broker. If a
  future change fetches from anywhere else it will be blocked — widen `connect-src`, or set
  `"csp": null` to rule CSP out while debugging. `blob:` in `connect-src` is load-bearing: three
  fetches GLB textures through blob URLs, so dropping it renders every model white. CSP problems
  never show up in `tauri dev`, only in a packaged build.
