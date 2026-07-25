# Desk Overlay

A collaborative, transparent, always-on-top 3D isometric desk that floats over your desktop.
Two people (User A / User B) each run the app; it auto-connects over WebRTC (PeerJS) with no
room codes and keeps a shared notebook, corkboard, whiteboard, pomodoro timer, and day/night
lighting in sync.

Stack: **Tauri v2 · React 18 · TypeScript · Three.js · @react-three/fiber · drei · Zustand · Tailwind · PeerJS**

## Run

```bash
npm install
npm run tauri dev
```

Production bundle: `npm run tauri build` (run `npx tauri icon src-tauri/icons/icon.png` first to
generate the platform icon set — the checked-in `icon.png` is a dev placeholder).

## How it works

- **Transparency / click-through** — the window is frameless, transparent, non-resizable
  (500×500) and always-on-top. Tauri has no Electron-style `setIgnoreMouseEvents(..., {forward})`,
  so `src/hooks/usePassThrough.ts` polls the *global* cursor position (`cursorPosition()`, which
  keeps working while cursor events are ignored), maps it into window space, and enables
  `setIgnoreCursorEvents(true)` only when the cursor is over empty pixels — decided by
  `document.elementFromPoint` for UI panels and a Three.js raycast for the 3D scene.
- **Window dragging** — pointer-down on the rug/floor mesh calls `startDragging()`.
- **P2P auto-connect** — both roles register static PeerJS IDs (`desk-overlay-user-a/b`) on the
  public PeerJS cloud broker and keep dialing each other every 4 s until a reliable data channel
  opens. On connect, each side sends a `FULL_SYNC`; afterwards granular messages sync notes,
  tasks, whiteboard strokes, lamp/lighting state, and the timer (last-write-wins via timestamps).
- **Persistence** — Zustand `persist` keeps notes, tasks, strokes, lighting, timer, and role in
  `localStorage`; PeerJS handles live in module-level singletons, never in persisted state.

## Asset credits

Decor models from Sketchfab, bundled as compressed GLB (the bear decimated
from a 1.3M-triangle scan). This project is personal and non-commercial.

- "Chunky Djungelskog Bear" by [Arkify 3D](https://sketchfab.com/arkify) — CC-BY-NC-4.0
  — https://sketchfab.com/3d-models/chunky-djungelskog-bear-a865f0ac929c4cfc88ff270f7bf18c43
- "POKEMON CARDS 7/9" by [tobyporter](https://sketchfab.com/tobyporter) — CC-BY-NC-4.0
  — https://sketchfab.com/3d-models/pokemon-cards-79-cedffde11c0045aca5d267a57ca6a2a1
- "Space Marine" by [neil1neil38](https://sketchfab.com/neil1neil38) — CC-BY-4.0
  — https://sketchfab.com/3d-models/space-marine-18c4db9aeabe4d9e98ae76c80c1c2581
- "Trading Card Pack" by [goonmize1](https://sketchfab.com/goonmize1) — CC-BY-4.0
  — https://sketchfab.com/3d-models/trading-card-pack-26d1a87e47814d0ea3a710d169e3a671

## Notes & known limits

- Both desks must pick different roles (Settings ⚙ in the status bar). If both grab the same ID,
  the second instance backs off and retries every 6 s.
- The static-ID scheme means exactly one A/B pair globally per PeerJS broker. For private use,
  self-host `peerjs-server` and pass `host`/`port` to the `Peer` constructor, or namespace the IDs.
- A `WHITEBOARD_CLEAR` that happens while the peer is offline can be resurrected by that peer's
  next `FULL_SYNC` (stroke sets are merged by id — eventual-consistency trade-off).
