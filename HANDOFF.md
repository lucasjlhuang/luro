# Desk Overlay — Session Handoff

Read this first in a fresh session. Working dir: `/Users/yer/desk-overlay` (git repo,
commit after every accepted change; history is the undo mechanism — the user says
"revert" often).

## What this is

A collaborative, transparent, always-on-top desktop overlay (Tauri v2 + React 18 +
TS + three.js/R3F + drei + Zustand + Tailwind + PeerJS). Two users — **Lulu =
USER_A (boy)** and **Roro = USER_B (girl)** — each run it; it auto-connects P2P
(static peer IDs `desk-overlay-user-a/b`, public PeerJS broker) and syncs a shared
isometric room: notebook, corkboard, whiteboard, pomodoro clock, day/night lamp,
speech bubbles, character status + live position. The user runs `npm run tauri dev`
themselves. **Never launch preview servers or browser-test — verify with
`npm run build` (tsc + vite) only, then commit.** User tests visually and reports
back; expect blind-tuning loops ("move it 25px left").

## Working conventions

- Every accepted change: `npm run build` → `git add -A && git commit` (end commit
  message with a `Co-Authored-By:` trailer naming the model actually doing the
  work, e.g. `Claude Opus 5 <noreply@anthropic.com>` — early commits say Fable 5).
- Screen-px ↔ world: ortho zoom = 45 px/unit. screen-right = world (0.707, 0,
  −0.707); screen-down = (0.707, 0, 0.707); right+down equally = pure +x.
- The user gives exact-pixel/degree tweaks; implement literally, offer the dial.

## Architecture map

- `src/App.tsx` — Canvas (ortho cam [10,10,10] zoom 45, lookAt(0,0.9,0)),
  `CameraRig` (applies rug-drag pan from `lib/pan.ts`, persisted to localStorage),
  Suspense (GLB loading), window expands to cover the whole monitor at startup
  (`expandWindowToScreen`) — panels roam the entire screen; the rug PANS the room
  (window itself never moves).
- `src/hooks/usePassThrough.ts` — THE core trick: polls global `cursorPosition()`
  (works while cursor events ignored), maps to window coords, elementFromPoint +
  `hitTestAt` raycast → `setIgnoreCursorEvents`. `setForceInteractive(true)`
  (lib/hitTest.ts) MUST be set during any drag or the OS swallows the pointer.
- `src/lib/cursors.ts` — Wii hand cursors (33px via image-set 1x/2x PNGs in
  `src/assets/cursors/`), `lockCursor/unlockCursor` pins during drags; stylesheet
  rules for `[data-drag-handle]`, `[data-draw]`, buttons/inputs.
- `src/store/useAppStore.ts` — Zustand + persist. Sync messages: NOTE_UPDATE,
  TASK_UPDATE, STROKE_ADD, WHITEBOARD_CLEAR, LIGHTING, TIMER, STATUS, BUBBLE,
  CHAR_POS (12Hz position stream while IDLE/carried), FULL_SYNC on connect.
  Peer/conn are module singletons, never in state. Statuses: IDLE/WORKING/SLEEPING
  (RELAXING was removed; `sanitizeStatus` guards stale values).
- `src/components/3d/IsometricRoom.tsx` — everything procedural: palette `P`,
  `Interactive` wrapper (hover glow + spring + cursor), floor (drag = pan; planks
  and rug have `raycast={() => null}` so only the slab raycasts — prevents hover
  flicker), walls + open window (real hole + glass pane), desk GROUP SCALED 0.8
  about pivot (`<group scale={0.8} position={[0.02,0,-0.43]}>`) containing Desk,
  AlarmClock (white face/black digits/pink→black bar canvas texture, opens TIMER),
  Notebook3D, DeskLamp (shade glows at night; no bulb), PencilCup (click = settings
  popover: circular Lulu/Roro buttons via Html; blue ring Lulu, pink ring Roro).
  Boards at y 2.1 (whiteboard shows live strokes via `renderStrokes`; corkboard
  stickies = tasks: yellow todo / light-blue in-progress / pink partner, seeded
  scatter). Bed (brown blanket/pillows, beige mattress, star pillow, striped
  navy/purple shirt), Djungelskog Prop on bed, chairs at [0.62,0,-1.2] &
  [-0.42,0,-1.2] scale 1.12, laundry basket, monstera, toy car.
- `src/components/3d/Prop.tsx` — GLB decor loader: instance-aware bounds
  (InstancedMesh.computeBoundingBox), `frustumCulled=false`, fit axis+size,
  ground, `matte`, `envIntensity`, `brightness` (idempotent via stashed baseColor).
- `src/components/3d/Character.tsx` — CURRENT FOCUS, see below.
- `src/components/ui/Modals.tsx` — skeuomorphic draggable panels (DragShell/
  useDragPanel: drag by chrome, controls excluded via closest(), positions
  remembered per session, first open lands at room pan). Whiteboard = wood frame +
  marker-tray toolbar (eraser = dark grey block cursor, square caps); Notebook =
  orange cover, ruled pages (24px rhythm = leading-6), "Lulu's world"/"Roro's
  world" by role, Instrument Sans (@fontsource), blinking caret only on own empty
  page; Corkboard = cork + square sticky notes (75% width, centred, random tilt,
  input is a sticky too); Timer = alarm-clock chrome (bells/feet), time+Start+Reset
  only; Settings = REMOVED (pencil cup popover instead); Speech = REMOVED (in-scene
  bubble editor).

## Characters (current state + in-flight work)

Just replaced procedural villagers with **`src/assets/models/roro.glb`** (10MB,
user-supplied, 47-joint rig, 19 clips, low-poly "necromancer" pack). Both roles
share it via `SkeletonUtils.clone` (three-stdlib) until the user provides
`lulu.glb` — swap in `MODELS` table.

- Clip mapping (`CLIPS` const): walk→`Armaturerun_necromancer`, work→
  `Armaturecast_end_necromancer` (NO sit clip in pack — works STANDING at desk,
  anchor [chairX, −1.5]), sleep→`Armaturedeath_necromancer` once + clampWhenFinished
  (ends lying = bed pose; root raised to LIE_RAISE 0.88, yaw π/2 nets correct with
  model yaw π), carry→`Armaturefall_necromancer` once + clamp (limp dangle while
  picked up), idle→`Armatureidle_necromancer`.
- Random flourishes are DERIVED, not listed: `flourishesFrom(animations)` = every
  clip in the GLB minus `NEVER_RANDOM` (user's exclusion list: blocking_loop,
  blocking, cast_loop, combat_idle, idle, run_back, run_L, run_R — plus
  `Armature_static_pose`, the bind pose, which would freeze the rig) minus the
  four state clips above. Currently leaves attack, buff, gathering, get_hit,
  jump, run_attack. EXTRA_CHANCE 0.45 at wander pauses; mixer 'finished' → idle.
- Staff (`weapon_*` meshes, collected into `fitted.weapons`) is hidden while
  SLEEPING and restored on pick-up.
- Model yaw = π (source faces −z).
- Kept intact: smoke-puff teleports between statuses, drag (head-under-cursor via
  grab plane at CARRY_LIFT+HEAD_TOP), drop-zone emojis (bed 😴 rect BED_RECT,
  chairs 💻 CHAIR_XS/CHAIR_Z; drop elsewhere = roam; drag cancels speech editor +
  forces IDLE), speech bubbles (editor: white pill, hint "Say something…" measured
  width, shrinks to centred caret on focus, grows per char to 25ch/160px, Enter
  sends, 13px ✕ with SVG cross; view: 5s hold + 0.5s fade; anchors follow head,
  incl. lying offset −0.5x/+0.3y), Zzz, CHAR_POS sync, Wii cursors.
- `CUSTOMIZE` table: hood hidden (`outfit_hat`; real hair mesh underneath), then
  per-material `paint` BANDS, matched by loose material/mesh name; material
  CLONED per instance. Roro: hair #893718, eyes `skin_eyes` #50C878, and ALL
  clothing (`outfit_body` + `outfit_boots`) one pink `CLOTH_PINK` #FF46A2.
  Lulu stand-in: hair #3b2a1d.
- The sash could not be deleted — it is not separate geometry, just a region of
  the `outfit_body` mesh and atlas. It is "removed" by painting its band the
  same pink as the dress. Keep it as its OWN band even though the colour
  matches: per-band mean normalisation is what collapses its contrast. Merging
  into one catch-all band blows 10k texels out to white (measured); two bands
  clip 15.
### Recolouring: how it actually works

The pack is **FULLBRIGHT**. Every material has `baseColorFactor` pure black,
`specularFactor` 0, and all colour in an **emissive map** with `emissiveFactor`
white — what you see is `emissive * emissiveMap`, so tinting `.color` is a no-op
(black × black). That, not a material subclass, is why two rounds of `.color`
fixes did nothing about the white hair.

Tinting `.emissive` works but can only recolour a whole map at once, and the
dress + sash + hem trim all share ONE material and ONE atlas. So recolouring is
done at the **pixel** level by `repaintTexture()`:

- Each texel is classified into a `Band` by hue/saturation (`isTrimGold`,
  `isTrimBlue`; a band with no `match` is the catch-all). Transparent and
  near-black texels (the unused UV gutter) are skipped.
- The band is re-hued to the target, carrying lightness across as an OFFSET from
  the band's own mean (`newL = targetL + (pixelL − meanL)`), not a multiply.
  That preserves the baked shading at original contrast and can't blow out — the
  robe's mean sits at L 0.20 against a target of 0.72, where a multiply clips
  every highlight to white.
- Result is a `CanvasTexture` with `flipY`/wrap/`colorSpace`/`channel` copied
  from the source (GLTF textures are NOT flipped), cached per (texture, bands).
- `paintMaterial()` falls back to a flat `emissive`/`color` tint if the map can't
  be read, so a future `lulu.glb` with ordinary PBR materials needs no changes.

To retune, move the two predicates — they are the pink/green boundary. Note the
dress band is the catch-all, so anything not caught as trim goes green.

**Verify recolours headlessly before shipping** — a hue-wrap bug rendered the
pink sash BLUE and the build could not have caught it. Extract the atlas, port
the band maths to a throwaway node script, write a BMP and LOOK at it. (`sips`
drops the alpha channel on webp→png, so read alpha from the original webp.)
- Known cosmetic gap: working = standing (no sit clip); user accepted for now.
  Chair choice on drop isn't synced (partner sees your status at their default
  chair anchor) — cosmetic.

## Hard-won GLB/3D gotchas (do not relearn these)

1. NEVER `gltf-transform optimize` a SKINNED glb — silently corrupts skins
   (renders fine at rest, explodes when bones move). Use `copy`, or texture-only
   commands (`resize`, `webp`).
2. Auto-fit must measure skinned bounds (`SkinnedMesh.computeBoundingBox`), not
   `Box3.setFromObject` — game rigs can render ~100× smaller than base geometry
   (the "microscopic monkey").
3. GPU-instanced GLBs (optimizer output) get frustum-culled to invisible by base
   geometry bounds → `frustumCulled=false` + instance-aware boxes (Prop does this).
4. Photogrammetry scans: decimation shreds UV seams → white speckles. `simplify
   --lock-border` preserves seams but barely decimates scans (seams everywhere);
   bear shipped at 905k tris / plain GLB (no meshopt/quantization) — fine on Apple
   Silicon. Scans want `matte` (roughness 1, metalness 0).
5. Environment/IBL (RoomEnvironment) brightens night mode too — removed; per-prop
   `envIntensity`/`brightness` instead.
6. macOS screen-recording filenames contain U+202F narrow no-break space — glob,
   don't type paths.
7. drei `Html` overlays need `data-interactive` to be clickable through the
   pass-through poller; `pointerEvents: 'none'` + no data-attr for pure visuals.
8. Binary asset swaps don't HMR — full app reload needed to see new GLB bytes.
9. Before debugging a recolor, DUMP THE GLB JSON (`node` + read the 20-byte header,
   `readUInt32LE(12)` = JSON chunk length) and look at `baseColorFactor` /
   `emissiveTexture`. Fullbright exports (black base + emissive map) ignore
   `.color` entirely. Textures here are `EXT_texture_webp`; extract a bufferView
   and `sips -s format png` to eyeball one.

## Assets & licenses (README has full credits)

- `roro.glb` — user-supplied character (license unknown; personal use).
- `djungelskog.glb` — bear on bed, CC-BY-NC (Arkify 3D), matte, brightness 2,
  rotY = 0.85 + 165°·π/180, pos [-0.45, 0.84, -0.46] inside Bed group.
- Wii cursors (user-supplied PNGs), Instrument Sans via @fontsource.
- Old zips on user Desktop; scratch conversions under /private/tmp (gone after
  reboot — re-request source files if needed).

## Likely next asks

- Confirm/fix hair color (texture-repaint fallback above).
- `lulu.glb` arrival → MODELS + CUSTOMIZE entries.
- Sit animation someday (needs a pack with a sit clip, or manual hip/knee posing
  layered over idle).
- Foot-slide tuning: match WALK_SPEED (1.05) to run-clip stride via timeScale.
- Pink accents ON the robe itself = texture edit, not material tint.
