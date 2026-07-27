# luro (formerly "Desk Overlay") — Session Handoff

Read this first in a fresh session. Working dir: `/Users/yer/desk-overlay` — the DIRECTORY keeps
the old name; the app is called "luro" (git repo,
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
  scatter; `FrenchFlag` hung off the board's bottom-right edge — the frame spans
  +/-0.95 x +/-0.65, and the flag's top 27% overlaps it with the rest hanging
  free below). Bed (brown blanket/pillows, beige mattress, star pillow, striped
  navy/purple shirt), Djungelskog Prop on bed, chairs at [0.62,0,-1.2] &
  [-0.42,0,-1.2] scale 1.12, laundry basket, monstera, toy car.
  Desk notebook scribbles MIRROR the real notes: left page `myNotes`, right page
  `partnerNotes` (same spread as the panel), one row per written line, blank
  lines left blank, lines wrapped at 34 chars, 7 rows max. No text = no marks.
- **Habit tracker** — `Dumbbell` on the floor at [-1.8, 0.07, 2.62] beside the
  toy car opens the `HABITS` panel. Unlike notes and tasks (which are
  mine/theirs), the board is a SINGLE SHARED grid: `habits: { habits, updatedAt }`
  in the store, every edit republishing the whole board and resolved
  last-write-wins on `updatedAt`, same as the timer. Simultaneous edits from
  both ends can drop one — fine for two people and one small grid.
  - `Habit` = { id, name, author, days[7] }, days Monday-first (`WEEKDAYS`).
    `sanitizeHabits` pads short rows, clamps names to `HABIT_NAME_MAX` (15) and
    defaults a missing author, so older peers and older persisted boards load.
  - Rows are colour-coded by author via `ROLE_COLOR` in Modals.tsx — Lulu
    #4489a3 (sampled from his shirt texture), Roro #00a86b (her dress).
  - The dumbbell is in Character.tsx's `OBSTACLES`; verified the front-of-bed
    lane and waypoint 5 are still clear and all 13 waypoints still reachable.
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
- `CUSTOMIZE.hide` is permanent: `outfit_hat` for both (the hood covers the real
  hair mesh; the user does NOT want hats at work either) plus `outfit_cloak`
  for Lulu.
- **Work gear** (`CUSTOMIZE.gear`): `weapon` only, for both. Visible ONLY while
  WORKING (not dragged, not mid-teleport); hidden when idling, roaming, carried
  or in bed. Lulu's cape is on `hide`, so it never appears at all. Both hide and
  gear are excluded from the height fit, so gear can never change the size.
- **Size is fixed and identical for both**: `CHAR_HEIGHT` 1.27 = the chairs'
  height (back top 1.133 x scale 1.12). `HEAD_TOP` is tied to it.
- The old resize/drift-on-character-swap bug: `computeSceneBox` was measuring
  the ANIMATED CLONE, and a SkinnedMesh's bounds follow its current pose, so
  a re-fit mid-animation produced a different scale and a different recentring
  offset. It now measures `srcScene` (never animated, so always the bind pose)
  with gear skipped. Do not point it back at `scene`.
- **Roaming is a nav graph**, not a per-user list of spots. `OBSTACLES` holds
  furniture footprints in world x/z (the desk sits in a `scale={0.8}
  position={[0.02,0,-0.43]}` group, so its numbers are the SCALED ones, and it
  uses the TOP footprint because the top is at world y 1.14 — below head height,
  so the overhang is not walkable). `BODY_R` 0.16 is the character's half-width
  and is the dial if they graze furniture.
  - The room is tight: the bed reaches the left wall and the desk + its two
    chairs span the middle, so the ONLY route from the open right side to the
    monstera corner is the lane at z ~ -0.68, threading the 0.46-wide gap
    between the back of the bed (z -0.45) and the front of the chairs (z
    -0.909). That leaves a ~0.14 lane after clearance. Waypoints 6-7-8 sit on
    it in a straight line on purpose.
  - `NEIGHBOURS` joins waypoints only where the straight segment between them is
    clear, so characters can never cut through furniture; wandering picks a
    random neighbour. Verified: all 13 waypoints are in free space and all are
    reachable from each other.
  - Dropping a character anywhere else runs `nudgeFree` (push out of furniture)
    then `nearestWaypoint` (nearest node with a clear path).
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
- **Standing heights** (all absolute world y): `FLOOR_Y` 0.07 is the top of the
  floor PLANKS (0.1-tall boxes centred at y 0.02) — not the slab at y 0, which
  is why feet used to sink into the boards. `CHAIR_SEAT_Y` 0.63 (seat top 0.565
  x chair scale 1.12) — working stands ON the seat at [chairX, CHAIR_Z], since
  neither pack has a sit clip and standing behind it clipped through the chair.
  `BED_Y` 0.88 is the mattress. `s.stand` damps between them.
- **Sleeping spots are keyed by ROLE** (`SLEEP_Z`: Lulu/USER_A 1.55, Roro/USER_B
  0.75), not by who is looking — they used to sit on `SPOTS[me|partner]`, so the
  two peers saw the sides swapped. Screen-right is world (0.707, 0, -0.707), so
  a LARGER z sits further screen-LEFT: Lulu lies left of Roro. (`chairX` is
  still per-variant; only the bed was asked about.)
- **The two packs' sleep clips fall in OPPOSITE directions.** Measured at the
  final frame: Roro's head ends at model z +0.53, Lulu's at -0.555. With one
  shared yaw, Lulu ended up head-down at the FOOT of the bed. `ModelSpec.
  sleepYaw` fixes it — pi/2 for Roro, 3pi/2 for Lulu — putting both heads near
  the pillows (world x -1.10 and -1.14).
- **The Zzz and the speech bubble follow the HEAD BONE** (`Head.head.001_*`,
  same name in both packs), read live via `getWorldPosition` after
  `root.updateMatrixWorld(true)`. Do not go back to a constant offset: each
  pack's sleep pose ends somewhere different, so any constant is wrong for one
  of them.
- **Grabbing a sleeping character** used to miss. A SkinnedMesh raycast starts
  with a bounding-sphere test, and that sphere is computed ONCE, lazily, in
  whatever pose the mesh was in — a body lying down falls largely outside a
  sphere measured standing. `s.poseSettle` re-measures the skinned bounds for
  2.5s after every status change.

### Wardrobe (appearance is STATE, not constants)

`CUSTOMIZE` is gone. `buildLook(role, appearance)` derives the whole look from
`appearance.looks[role]` in the store — shared between both desks, last-write-
wins on `updatedAt`, same shape as the habit board. The laundry basket opens
the `WARDROBE` panel; either desk can dress either character.

What stays in code is per-MODEL knowledge a user can't pick: which materials
exist, which hue bands mean what (`isTunic`/`isLeather`/`isBuckle`/`isLining`,
`isTrim`), and where marks belong on the body. What moved into state: hair
roots + tips, eyes, outfit, trim, freckles/blush/stubble, pattern, accessories.

- `buildTexelMap()` replaced the old sash-only mask. Every texel now knows its
  normalised 3D position on the mesh, which is what makes three things
  possible: height bands (belt, sash), the root-to-tip hair gradient
  (`Band.toBottom`), and `Stamp`s placed by rules like "front of the face,
  cheek height, off the nose bridge". Cached per (geometry, size).
- `Stamp` draws dots or five-petal flowers through the 2D context after the
  bands, using rejection sampling over that map. Placement is seeded so marks
  never move between launches.
- **Glasses** are procedural geometry parented to the HEAD BONE, so animation
  carries them with no frame loop. Placement converts a model-space target into
  bone-local space via the BIND-POSE matrices — it must run before the mixer
  touches the clone. Add accessories the same way; list them in `ACCESSORIES`
  in the store and the panel picks them up automatically.
- **The fitted memo re-runs on the SAME clone** every wardrobe change — three
  bugs shipped in 0.1.4 because the traverse assumed a fresh scene:
  1. visibility must be set BOTH ways (`obj.visible = true` for non-hidden) or
     a mesh hidden by the previous look stays hidden until restart;
  2. painting must start from `userData.origMaterial` (stashed on first touch),
     never from `obj.material` — that repaints the previous repaint, the hue
     matchers find nothing in the recoloured texture, and colours no-op;
  3. the height fit must exclude a FIXED list (`NEVER_MEASURED`: hat, cloak,
     weapon), not the current hide list, or toggling an accessory on grows the
     measured box and shrinks the whole character.
- The panel's custom colour input commits on BLUR (picker closed), not per
  change — the picker fires dozens of events per second and each would be a
  full 512x512 repaint plus a ~1MB cached CanvasTexture. Swatches are instant.
- Preview renderer gotcha: an early version sampled ONE texel per triangle and
  flat-filled, which smears anything smaller than a face — flowers came out as
  giant coloured triangles. `scratchpad/texrender.js` interpolates UVs per
  pixel. Never judge stamps with a flat-shaded preview.

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

**Day/night:** these models are fullbright, so dimming the room's lamps does
nothing to them — they stayed at full glow against a dark room. `emissive` is
the only channel that reaches them, so the frame loop lerps `emissiveIntensity`
from `DAY_EMISSIVE` (0.84) to `NIGHT_EMISSIVE` (0.38) and the tint toward
`NIGHT_TINT` (#8c9ad0), damped at the same rate as SceneLights. Bare skin reads
hotter than cloth at the same value, so skin_body/face/nose/brow take an extra
`SKIN_DIM` (0.8) — not skin_hair or skin_eyes. Those four consts are the dials. The base
emissive is stashed ON the material (`mat.baseEmissive`), not in the fit result:
unpainted materials are shared with the source scene and outlive a re-fit, so
re-reading a live, already-tinted emissive would compound it on every role swap.

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

## Packaging (verified 2026-07-26)

- `npm run tauri build` succeeds; outputs `luro.app` + `luro_0.1.0_aarch64.dmg`
  under `src-tauri/target/release/bundle/`. Verified the three GLBs and the JS/
  CSS/font assets are embedded IN THE BINARY (Tauri v2 compiles `dist` in, so
  there are no loose files in `Contents/Resources` — do not "fix" that).
- **A Windows .exe cannot be built on the Mac** (needs MSVC + WebView2; only
  `aarch64-apple-darwin` is installed here). `.github/workflows/release.yml`
  builds macOS-universal + Windows via `tauri-action` on a tag push. Needs a
  GitHub remote — the repo has none yet.
- Icons come from `src-tauri/app-icon.png` (the user's pink hearts, 300x300)
  via `npx tauri icon`; the android/ios sets it emits are deleted each time.
  A 1024x1024 source would be sharper at the largest macOS sizes.
- `identifier` is `com.luro.app` (changed from com.deskoverlay.app WITH the
  user's approval — it keys the webview data dir, so that reset every local
  store: notes, tasks, habits, strokes. Do not change it again casually).
- Peer ids are no longer constants: `peerIdFor(code, role)` ->
  `luro-<paircode>-a|b`. Both desks must share a pair code (pencil cup UI);
  fresh installs generate a random one. This is what stops a third device
  taking a slot and locking the real partner out — the old fixed ids meant
  every install worldwide fought over the same two.
- Roles auto-claim when `rolePinned` is false: ask for USER_A, fall back to
  USER_B on `unavailable-id`. Choosing by hand sets `rolePinned` and the desk
  then waits for its own id instead of swapping. Known gap: auto-claim is
  first-come, so if the partner's desk boots first it takes Lulu.
- CSP is set (was null), and it bit once already. **`connect-src` MUST include
  `blob:`.** GLTFLoader turns every texture embedded in a GLB into a `blob:`
  URL, and on WKWebView (Safari >= 17) three loads it with `ImageBitmapLoader`,
  which uses `fetch()` — so it is policed by `connect-src`, NOT `img-src`.
  Without it the meshes load but every texture is blocked, and because this
  pack is fullbright (emissive white, no map) the characters and the bear
  render PURE WHITE. The giveaway is that repainted parts (hair, dress) still
  look right: `paintMaterial` falls back to a flat emissive tint when it cannot
  read the source image.
- CSP failures only appear in a packaged build, never in `tauri dev`. If the
  app boots blank, loses textures or cannot connect, set `"csp": null` to rule
  CSP out before looking anywhere else.
- Not code-signed: macOS needs right-click -> Open, Windows "Run anyway".

## Assets & licenses (README has full credits)

- `roro.glb` / `lulu.glb` — characters by sema.game.studio on Sketchfab
  (https://sketchfab.com/sema.game.studio), credited in the README. Sources
  kept at `~/Desktop/models/characters/`. NOTE: the exact licence was never
  confirmed against the store page; the user chose to publish on that basis.
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
