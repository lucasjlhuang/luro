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

## Characters (current state)

Two REAL models now, both from the same low-poly pack family (same material
names, same fullbright setup): `src/assets/models/lulu.glb` (mage, 7MB) for
USER_A and `roro.glb` (necromancer, 10MB) for USER_B. Clip names differ per
pack, so `MODELS[role]` carries its own `clips` + `neverRandom` table — there is
no longer a global CLIPS const.

- State clips per model:
  - Lulu: idle `idle_mage`, walk `run_mage`, work `skill_attack_mage`, sleep
    `death_mage`, carry `falling_mage`.
  - Roro: idle `idle_necromancer`, walk `run_necromancer`, work
    `cast_end_necromancer`, sleep `death_necromancer`, carry
    `fall_necromancer`.
  - All names carry the `Armature` prefix. sleep + carry play once with
    clampWhenFinished; sleep ends lying = bed pose (root raised to LIE_RAISE
    0.88, yaw pi/2 nets correct with model yaw pi).
  - NOTE: the user's Lulu exclusion list named `walk.mage`, so walk is driven by
    `run_mage` (matching Roro). Swap if they meant the reverse.
- `flourishesFrom(animations, model)` = every clip in that GLB minus its
  `neverRandom` minus the five state clips. Static/bind poses are excluded by
  name and differ per pack: `Armature_static_pose` (roro) vs
  `Armature__static_pose` (lulu, TWO underscores). EXTRA_CHANCE 0.45 at wander
  pauses; mixer 'finished' returns to idle.
  - Roro pool: attack, buff, gathering, get_hit, jump, run_attack.
  - Lulu pool: attack, blocking_loop, buff, gathering, get_hit, jump,
    run_attack, run_back. (blocking_loop was excluded for Roro but NOT listed
    for Lulu — user's list, left as given.)
- Hidden per role via `CUSTOMIZE.hide` (loose substring match on mesh AND
  material names): both hide `outfit_hat` and `weapon`; Lulu also hides
  `outfit_cloak` (the cape).
- The staff-stow-while-sleeping logic (`fitted.weapons`, hidden when SLEEPING
  and not being dragged) still exists but is INERT while 'weapon' is in `hide`.
  Drop 'weapon' from `hide` to bring the staff back and it applies again.
- Kept intact: smoke-puff teleports between statuses, drag (head-under-cursor
  via grab plane at CARRY_LIFT+HEAD_TOP), drop-zone emojis (bed emoji rect
  BED_RECT, chairs CHAIR_XS/CHAIR_Z; drop elsewhere = roam; drag cancels speech
  editor + forces IDLE), speech bubbles (editor: white pill, hint "Say
  something..." measured width, shrinks to centred caret on focus, grows per
  char to 25ch/160px, Enter sends, 13px close with SVG cross; view: 5s hold +
  0.5s fade; anchors follow head, incl. lying offset -0.5x/+0.3y), Zzz,
  CHAR_POS sync, Wii cursors.
- Known cosmetic gaps: working = standing (no sit clip in either pack); chair
  choice on drop isn't synced (partner sees your status at their default chair
  anchor).
- Model yaw = pi for both (sources face -z). If Lulu ends up facing backwards,
  that is the dial.

### Recolouring: how it actually works

Both packs are **FULLBRIGHT**. Every material has `baseColorFactor` pure black,
`specularFactor` 0, and all colour in an **emissive map** with `emissiveFactor`
white — what you see is `emissive * emissiveMap`, so tinting `.color` is a no-op
(black x black). That, not a material subclass, is why two rounds of `.color`
fixes did nothing about the white hair.

Tinting `.emissive` works but recolours a whole map at once, and the dress, sash
and trims all share ONE material and ONE atlas. So recolouring happens at the
**pixel** level in `repaintTexture()`:

- Each texel is classified into a `Band` by hue/saturation (`isTrimGold`,
  `isTrimBlue`; a band with no `match` is the catch-all). Transparent and
  near-black texels (the unused UV gutter) are skipped.
- The band is re-hued to the target, carrying lightness across as an OFFSET from
  the band's own mean (`newL = targetL + (pixelL - meanL)`), not a multiply — a
  multiply clips every highlight when a dark region takes a light target.
- Where the offset would still run past black or white it is SQUEEZED to fit
  (`fit[b].up/.down`, from the band's min/max L) rather than clamped. Clamping
  flattens the overshoot to one value: pale trims became a white blob and black
  shoes lost their form entirely. Current table clamps zero texels on every map.
- Result is a `CanvasTexture` with `flipY`/wrap/`colorSpace`/`channel` copied
  from the source (GLTF textures are NOT flipped), cached per (texture, bands).
- `paintMaterial()` falls back to a flat `emissive`/`color` tint if the map
  can't be read, which also covers any future model with ordinary PBR materials.

Two extra mechanisms exist for parts that share a material AND a colour:

- `bodyBand: [lo, hi]` restricts a band to texels used by triangles sitting in
  that slice of the mesh's own height. `buildBodyBandMask()` rasterises those
  triangles into UV space at load (grown a texel for seams). Needed because the
  sash and hem are the same colour and their UV islands are scattered across the
  atlas — no UV rectangle separates them.
- `mergeInto: <band index>` makes a band adopt another band's colour, mean
  lightness AND contrast. Colour alone is not enough: the sash carries far more
  internal contrast (std 0.095) than the dress cloth (0.060) and still read as a
  band when only its mean was matched.

**Verify recolours headlessly before shipping** — a hue-wrap bug rendered the
pink sash BLUE and the build could not have caught it. Extract the atlas, port
the band maths to a throwaway node script, write a BMP and LOOK at it. Going
further and software-rasterising the mesh (project positions, sample the painted
atlas per triangle) is what identified the sash vs the hem in the first place.
(`sips` drops alpha on webp->png, so read alpha from the original webp.)

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

- `roro.glb` / `lulu.glb` — user-supplied characters (license unknown; personal
  use). Sources kept at `~/Desktop/models/characters/`.
- `djungelskog.glb` — bear on bed, CC-BY-NC (Arkify 3D), matte, brightness 2,
  rotY = 0.85 + 165°·π/180, pos [-0.45, 0.84, -0.46] inside Bed group.
- Wii cursors (user-supplied PNGs), Instrument Sans via @fontsource.
- Old zips on user Desktop; scratch conversions under /private/tmp (gone after
  reboot — re-request source files if needed).

## Likely next asks

- Colour/removal tweaks on either character — the dials are the `CUSTOMIZE`
  table, the `isTrim*` predicates (dress/trim boundary) and `SASH_BAND`.
- Confirm Lulu's facing and walk clip (see the two NOTEs above).
- Sit animation someday (neither pack has a sit clip, so working = standing).
- Foot-slide tuning: match WALK_SPEED (1.05) to each run clip's stride via
  timeScale.
