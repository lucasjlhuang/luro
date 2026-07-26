import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { Html, useAnimations, useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import { CharacterStatus, CharPos, Role, partnerOf, useAppStore } from '../../store/useAppStore';
import { setForceInteractive } from '../../lib/hitTest';
import { CURSOR, lockCursor, setCursor, unlockCursor } from '../../lib/cursors';
import roroUrl from '../../assets/models/roro.glb?url';
import luluUrl from '../../assets/models/lulu.glb?url';

/* ------------------------------------------------------------------ */
/* GLB characters driven by their own animation clips.                */
/*                                                                    */
/* State -> clip: walking plays the run cycle, working plays the      */
/* casting loop at the desk, sleeping plays the fall-down clip once   */
/* and clamps its final lying frame. While idling at a waypoint the   */
/* villager sometimes performs a random flourish from the pack.       */
/*                                                                    */
/* Statuses teleport via two puffs of smoke; only IDLE walks.         */
/* Interactions (own character only):                                 */
/*   click        -> speech-bubble editor                             */
/*   click + drag -> pick up and carry (drop on bed/chairs to pose)   */
/* ------------------------------------------------------------------ */

/**
 * Clip names differ per model — Lulu is the "mage" pack, Roro the
 * "necromancer" one — so each model carries its own table.
 *
 * `neverRandom` is the user's exclusion list for the idle flourishes. The four
 * state clips below are barred automatically, so they need not be repeated.
 */
interface ModelSpec {
  url: string;
  yaw: number;
  /**
   * Yaw used while lying in bed. The two packs' death clips fall in OPPOSITE
   * directions — measured at the final frame, Roro's head ends at model z
   * +0.53 and Lulu's at -0.555 — so a single value lands one of them head-down
   * at the foot of the bed. These two put both heads on the pillows.
   */
  sleepYaw: number;
  clips: { idle: string; walk: string; work: string; sleep: string; carry: string };
  neverRandom: string[];
}

/**
 * Both characters are fitted to exactly this height — matching the chairs
 * (back top 1.133 * scale 1.12). Fitting is measured in the BIND POSE with the
 * gear excluded, so the size is identical for both roles and never shifts.
 */
const CHAR_HEIGHT = 1.27;

const MODELS: Record<Role, ModelSpec> = {
  // Lulu — mage pack. Walk uses run_mage (walk.mage is on the exclusion list).
  USER_A: {
    url: luluUrl,
    yaw: Math.PI, // the source model faces -z, so add a half turn
    sleepYaw: (3 * Math.PI) / 2, // he falls the other way; head to x -1.14
    clips: {
      idle: 'Armatureidle_mage',
      walk: 'Armaturerun_mage',
      work: 'Armatureskill_attack_mage',
      sleep: 'Armaturedeath_mage',
      carry: 'Armaturefalling_mage',
    },
    neverRandom: [
      'Armaturecasting_loop_mage',
      'Armaturecombat_idle_mage',
      'Armatureidle_mage',
      'Armaturerun_L_mage',
      'Armaturerun_R_mage',
      'Armaturewalk.mage',
      'Armature__static_pose', // bind pose, not an animation (note: two underscores)
    ],
  },
  // Roro — necromancer pack.
  USER_B: {
    url: roroUrl,
    yaw: Math.PI,
    sleepYaw: Math.PI / 2, // head to x -1.10
    clips: {
      idle: 'Armatureidle_necromancer',
      walk: 'Armaturerun_necromancer',
      work: 'Armaturecast_end_necromancer',
      sleep: 'Armaturedeath_necromancer',
      carry: 'Armaturefall_necromancer',
    },
    neverRandom: [
      'Armatureblocking_loop_necromancer',
      'Armatureblocking_necromancer',
      'Armaturecast_loop_necromancer',
      'Armaturecombat_idle_necromancer',
      'Armatureidle_necromancer',
      'Armaturerun_back_necromancer',
      'Armaturerun_L_necromancer',
      'Armaturerun_R_necromancer',
      'Armature_static_pose',
    ],
  },
};

useGLTF.preload(roroUrl);
useGLTF.preload(luluUrl);

/**
 * A band of a texture to repaint, selected by the source pixel's hue and
 * saturation. Bands are tried in order; one with no `match` is the catch-all
 * for everything the earlier bands left over.
 */
type Band = {
  match?: (hue: number, sat: number) => boolean;
  /**
   * Restrict the band to texels used by triangles sitting within this slice of
   * the mesh's own height (0 = its lowest vertex, 1 = its highest). Needed when
   * two parts share both a material AND a colour and can only be told apart by
   * where they sit on the body — see SASH_BAND.
   */
  bodyBand?: [number, number];
  /**
   * Index of another band to disappear into. The band takes that band's colour,
   * mean lightness AND contrast, so it stops reading as a separate part.
   * Matching only the colour is not enough — a bright trim keeps far more
   * internal contrast than the cloth around it and still shows as a band.
   * When set, `to` is ignored.
   */
  mergeInto?: number;
  to: string;
};

/* The dress, skirt and trims all share ONE material and ONE atlas, so they can
 * only be told apart by colour: the cloth is desaturated purple, the trims are
 * the saturated blue and gold runs. These two predicates ARE the dress/trim
 * boundary — widen or narrow them to move it. */
const isTrimGold = (h: number, s: number) => h >= 20 && h <= 70 && s >= 0.2;
const isTrimBlue = (h: number, s: number) => h >= 185 && h <= 248 && s >= 0.35;
const isTrim = (h: number, s: number) => isTrimGold(h, s) || isTrimBlue(h, s);

/* The sash is the trim-coloured belt at the waist; the rest of the trim is the
 * hem around the bottom of the skirt. They are the same colour in the atlas and
 * their UV islands are scattered, so height is the only thing that separates
 * them. Measured from the bind pose: the belt sits at 50-72% of the mesh's
 * height, the hem below 40%. The sash cannot be DELETED — it is not separate
 * geometry, just a band of the dress surface, and dropping those triangles
 * would punch a hole through the dress — so it is "removed" by painting it the
 * dress colour. */
const SASH_BAND: [number, number] = [0.5, 0.72];

/**
 * Day/night response. These models are FULLBRIGHT — they render straight out of
 * their emissive map and take no light from the scene — so dimming the room's
 * lamps left them glowing at full strength against a dark room. `emissive` is
 * the only channel that reaches them, so night scales its intensity and cools
 * its tint by hand. Roughly tracks the room: ambient falls to 0.32 of day,
 * directional to 0.11. Turn these two down for a darker character at night.
 */
const DAY_EMISSIVE = 0.84; // full emissive read too hot against the clay room
const NIGHT_EMISSIVE = 0.38; // intensity multiplier at full night
const NIGHT_TINT = new THREE.Color('#8c9ad0'); // moonlight cast
/** Bare skin reads brighter than cloth at the same emissive, so knock it back
 *  a little further. Matches skin_body/face/nose/brow — NOT skin_hair (hair) or
 *  skin_eyes (the recoloured iris, which is meant to catch the light). */
const SKIN_DIM = 0.8;
const isSkinMaterial = (name: string) => /skin_(body|face|nose|brow)/i.test(name);

/**
 * Per-role model surgery, keyed by material name: which meshes are work gear
 * and how to repaint the rest. Materials are cloned per instance so the two
 * roles can differ despite sharing one GLB.
 */
const CUSTOMIZE: Record<Role, { hide: string[]; gear: string[]; paint: Record<string, Band[]> }> = {
  // `hide` is permanent (the hood covers the real hair mesh underneath).
  // `gear` = worn only on the job: hidden while idling, roaming, carried or in
  // bed, shown while WORKING. Both are excluded from the height fit, so gear
  // can never change how big the character is.
  USER_A: {
    hide: ['outfit_hat', 'outfit_cloak'], // no hat, no cape — not even at work
    gear: ['weapon'], // staff only
    paint: {
      skin_hair: [{ to: '#1A120B' }], // dark brown, near black
      skin_eyes: [{ match: (_h, s) => s >= 0.25, to: '#A8763E' }], // hazel brown
    },
  },
  USER_B: {
    hide: ['outfit_hat'],
    gear: ['weapon'], // no cape mesh in this pack
    paint: {
      skin_hair: [{ to: '#893718' }], // light brown
      outfit_body: [
        // the sash: dissolved into the dress (band 2) so it vanishes
        { match: isTrim, bodyBand: SASH_BAND, mergeInto: 2, to: '#00A86B' },
        { match: isTrim, to: '#98FB98' }, // remaining trims (the hem)
        { to: '#00A86B' }, // dress + skirt
      ],
      outfit_boots: [{ to: '#000000' }], // shoes
      // leave the white catchlights alone, recolour only the glowing iris
      skin_eyes: [{ match: (_h, s) => s >= 0.25, to: '#50C878' }], // emerald
    },
  },
};

/* ------------------------- texture repainting ------------------------- */

/**
 * Everything in this pack is FULLBRIGHT — baseColorFactor is black and all the
 * colour lives in an emissive map — so `material.color` is a no-op and even
 * `material.emissive` can only tint a whole map at once. The dress and its
 * trim share one atlas, so recolouring means rewriting pixels: classify each
 * texel into a band by hue/saturation, then re-hue it.
 *
 * Lightness is carried across as an OFFSET from the band's own mean
 * (`newL = targetL + (pixelL - meanL)`) rather than a multiply. That keeps the
 * baked shading gradient at its original contrast and can't blow out — the
 * robe's mean sits at L 0.20 and the target at 0.72, where a multiply would
 * clip every highlight to white.
 */
const repaintCache = new WeakMap<THREE.Texture, Map<string, THREE.Texture>>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360; // must land in [0,1) — comp() only unwraps once
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const comp = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [comp(h + 1 / 3) * 255, comp(h) * 255, comp(h - 1 / 3) * 255];
}

/**
 * Texels covered by triangles whose centre sits within [lo,hi] of the mesh's
 * own height, in bind pose. Rasterised straight into UV space at the texture's
 * resolution; edges are grown by a texel so seams don't leak the old colour.
 */
function buildBodyBandMask(
  geom: THREE.BufferGeometry,
  w: number,
  h: number,
  lo: number,
  hi: number
): Uint8Array | null {
  const pos = geom.getAttribute('position');
  const uv = geom.getAttribute('uv');
  if (!pos || !uv) return null;
  const index = geom.getIndex();
  const triCount = (index ? index.count : pos.count) / 3;

  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const span = yMax - yMin;
  if (!(span > 0)) return null;

  const mask = new Uint8Array(w * h);
  const ux = [0, 0, 0];
  const uy = [0, 0, 0];
  for (let t = 0; t < triCount; t += 1) {
    let cy = 0;
    for (let c = 0; c < 3; c += 1) {
      const vi = index ? index.getX(t * 3 + c) : t * 3 + c;
      cy += pos.getY(vi);
      ux[c] = uv.getX(vi) * (w - 1);
      uy[c] = uv.getY(vi) * (h - 1);
    }
    const frac = (cy / 3 - yMin) / span;
    if (frac < lo || frac > hi) continue;

    // grow the triangle's box by one texel to cover the UV seam
    const x0 = Math.max(0, Math.floor(Math.min(ux[0], ux[1], ux[2])) - 1);
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ux[0], ux[1], ux[2])) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(uy[0], uy[1], uy[2])) - 1);
    const y1 = Math.min(h - 1, Math.ceil(Math.max(uy[0], uy[1], uy[2])) + 1);
    const area = (ux[1] - ux[0]) * (uy[2] - uy[0]) - (ux[2] - ux[0]) * (uy[1] - uy[0]);
    if (!area) continue;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const w0 = ((ux[1] - x) * (uy[2] - y) - (ux[2] - x) * (uy[1] - y)) / area;
        const w1 = ((ux[2] - x) * (uy[0] - y) - (ux[0] - x) * (uy[2] - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

/** Source texture -> a recoloured copy. Cached per (texture, band set). */
function repaintTexture(
  tex: THREE.Texture,
  bands: Band[],
  geom?: THREE.BufferGeometry
): THREE.Texture | null {
  // Bands can share a colour, so the key notes matchers and height slices too.
  const key = bands
    .map((b) => (b.match ? 'm' : '*') + (b.bodyBand?.join(':') ?? '') + b.to)
    .join('|');
  let perTex = repaintCache.get(tex);
  if (perTex?.has(key)) return perTex.get(key) ?? null;

  let result: THREE.Texture | null = null;
  try {
    const img = tex.image as CanvasImageSource & { width?: number; height?: number };
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    if (w && h) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const image = ctx.getImageData(0, 0, w, h);
        const { data } = image;

        const masks = bands.map((b) =>
          b.bodyBand && geom ? buildBodyBandMask(geom, w, h, b.bodyBand[0], b.bodyBand[1]) : null
        );
        const bandAt = (p: number, hue: number, sat: number) =>
          bands.findIndex(
            (band, bi) =>
              (!band.match || band.match(hue, sat)) && (!masks[bi] || masks[bi]![p] === 1)
          );

        // pass 1: which band each texel belongs to, and each band's L stats
        const bandOf = new Int8Array(w * h).fill(-1);
        const sumL = new Float64Array(bands.length);
        const sumSq = new Float64Array(bands.length);
        const count = new Float64Array(bands.length);
        const minL = new Float64Array(bands.length).fill(1);
        const maxL = new Float64Array(bands.length).fill(0);
        for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
          // skip the unused UV gutter: transparent or near-black
          if (data[i + 3] < 8 || data[i] + data[i + 1] + data[i + 2] < 12) continue;
          const [hue, sat, lum] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          const b = bandAt(p, hue, sat);
          if (b < 0) continue;
          bandOf[p] = b;
          sumL[b] += lum;
          sumSq[b] += lum * lum;
          count[b] += 1;
          minL[b] = Math.min(minL[b], lum);
          maxL[b] = Math.max(maxL[b], lum);
        }

        // Parse the hex straight to sRGB bytes — the texels are in that same
        // space, and going via THREE.Color would depend on whether colour
        // management happens to be enabled.
        const target = bands.map((b) => {
          const n = parseInt(b.to.slice(1), 16);
          return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
        });

        /* Shading is carried across as an offset from the band's mean. Where
         * that offset would run past black or white, squeeze it to fit instead
         * of clamping: clamping flattens the whole overshoot to one value, so a
         * bright trim region turns into a white blob and near-black shoes lose
         * their form entirely. Squeezing keeps the gradient, just shallower. */
        const fit = bands.map((_, b) => {
          if (!count[b]) return { up: 1, down: 1 };
          const mean = sumL[b] / count[b];
          const tL = target[b][2];
          return {
            up: maxL[b] > mean ? Math.min(1, (1 - tL) / (maxL[b] - mean)) : 1,
            down: mean > minL[b] ? Math.min(1, tL / (mean - minL[b])) : 1,
          };
        });

        const stdev = bands.map((_, b) =>
          count[b] ? Math.sqrt(Math.max(0, sumSq[b] / count[b] - (sumL[b] / count[b]) ** 2)) : 0
        );

        // pass 2: re-hue at the fitted lightness
        for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
          const b = bandOf[p];
          if (b < 0) continue;
          const [, , lum] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          const mean = count[b] ? sumL[b] / count[b] : lum;
          const d = lum - mean;

          const into = bands[b].mergeInto;
          let tH: number;
          let tS: number;
          let newL: number;
          if (into !== undefined && count[into] && stdev[b] > 1e-4) {
            // adopt the host band's colour, level and contrast
            [tH, tS] = target[into];
            const hostFit = (fit[into].up + fit[into].down) / 2;
            newL = target[into][2] + d * (stdev[into] / stdev[b]) * hostFit;
          } else {
            [tH, tS] = target[b];
            newL = target[b][2] + d * (d > 0 ? fit[b].up : fit[b].down);
          }
          const [nr, ng, nb] = hslToRgb(tH, tS, THREE.MathUtils.clamp(newL, 0, 1));
          data[i] = nr;
          data[i + 1] = ng;
          data[i + 2] = nb;
        }
        ctx.putImageData(image, 0, 0);

        const out = new THREE.CanvasTexture(canvas);
        // GLTF textures are not flipped and carry their own wrapping/space
        out.flipY = tex.flipY;
        out.wrapS = tex.wrapS;
        out.wrapT = tex.wrapT;
        out.colorSpace = tex.colorSpace;
        out.channel = tex.channel;
        out.needsUpdate = true;
        result = out;
      }
    }
  } catch {
    result = null; // tainted canvas / undecoded image — caller falls back to a flat tint
  }

  if (!perTex) {
    perTex = new Map();
    repaintCache.set(tex, perTex);
  }
  perTex.set(key, result as THREE.Texture);
  return result;
}

/** Repaint a material's emissive map, or flat-tint it if the map is unreadable. */
function paintMaterial(mat: THREE.Material, bands: Band[], geom?: THREE.BufferGeometry): void {
  const m = mat as THREE.Material & {
    color?: THREE.Color;
    emissive?: THREE.Color;
    emissiveMap?: THREE.Texture | null;
  };
  const repainted = m.emissiveMap ? repaintTexture(m.emissiveMap, bands, geom) : null;
  if (repainted) {
    m.emissiveMap = repainted;
    return;
  }
  // Fallback: no readable map. Fullbright materials show `emissive`, ordinary
  // PBR ones (a future lulu.glb) show `color`.
  const hex = bands[bands.length - 1].to;
  if (m.emissive && (!m.color || m.color.getHex() === 0x000000)) m.emissive.set(hex);
  else m.color?.set(hex);
}

/**
 * Everything in the model's pack is fair game for the idle flourishes except
 * its own `neverRandom` exclusions and the clips already bound to a state.
 */
function flourishesFrom(clips: THREE.AnimationClip[], model: ModelSpec): string[] {
  const reserved = new Set<string>([...Object.values(model.clips), ...model.neverRandom]);
  return clips.map((c) => c.name).filter((name) => !reserved.has(name));
}

/** Chance of performing a flourish at each wander pause. */
const EXTRA_CHANCE = 0.45;

const WALK_SPEED = 1.05;
/* Standing heights, in world units. The floor planks sit ON the slab, so their
 * top face — not y=0 — is where feet belong. */
const FLOOR_Y = 0.07; // plank top: boxes 0.1 tall centred at y 0.02
const CHAIR_SEAT_Y = 0.63; // seat top 0.565 * chair scale 1.12
const BED_Y = 0.88; // mattress top (absolute, not an offset from the floor)
const TELE_OUT = 0.25;
const TELE_IN = 0.3;
const BUBBLE_HOLD = 5_000; // fully visible
const BUBBLE_FADE = 500; // then one gentle fade
const BUBBLE_TTL = BUBBLE_HOLD + BUBBLE_FADE;
const ROOM_CLAMP = 2.9;
const CARRY_LIFT = 0.4;
const HEAD_TOP = CHAR_HEIGHT; // bubble anchor + grab plane sit at the head

/* Drop zones shown while carrying: bed and both chairs. */
const CHAIR_XS = [0.62, -0.42];
const CHAIR_Z = -1.2;
const CHAIR_RADIUS = 0.55;
const BED_RECT = { minX: -3.15, maxX: 0.85, minZ: -0.45, maxZ: 2.15 };

const HINT = 'Say something…';

/** Shared 2D context for synchronous text measurement. */
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/**
 * Speech-bubble chrome per spec: solid white, 10px radius, soft drop
 * shadow, 12px #222 text, sitting above its anchor with a CSS
 * border-triangle tail centred on the bottom edge.
 */
const BUBBLE_STYLE: React.CSSProperties = {
  position: 'relative',
  background: '#ffffff',
  borderRadius: 10,
  boxShadow: '0 4px 20px rgba(0,0,0,0.18)',
  padding: '4.5px 9px',
  fontSize: 12,
  color: '#222',
  // The bubble's bottom sits 22px above the anchor; the 14px tail hangs
  // below it, leaving its tip ~8px over the head.
  transform: 'translateY(calc(-50% - 22px))',
};

const BUBBLE_TAIL: React.CSSProperties = {
  position: 'absolute',
  bottom: -14,
  left: '50%',
  transform: 'translateX(-50%)',
  width: 0,
  height: 0,
  border: '7px solid transparent',
  borderTopColor: '#ffffff',
};

/**
 * Read-only bubble shown while a message is live: fully visible for
 * BUBBLE_HOLD, then one gentle BUBBLE_FADE-long fade.
 */
function BubbleView({ text }: { text: string }) {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setFaded(true)));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div
      style={{
        ...BUBBLE_STYLE,
        width: 'max-content',
        maxWidth: '25ch',
        opacity: faded ? 0 : 1,
        transition: `opacity ${BUBBLE_FADE}ms ease-out ${BUBBLE_HOLD}ms`,
      }}
    >
      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>{text}</span>
      <span style={BUBBLE_TAIL} />
    </div>
  );
}

/** Editable speech bubble that floats over the villager's head. */
function BubbleEditor({ onClose }: { onClose: () => void }) {
  const setMyBubble = useAppStore((s) => s.setMyBubble);
  // Always opens empty — it composes a new message, not an edit.
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const fontRef = useRef('12px sans-serif');
  const [hintW, setHintW] = useState(90);
  const [textW, setTextW] = useState(24);
  useEffect(() => {
    if (!inputRef.current) return;
    const cs = getComputedStyle(inputRef.current);
    fontRef.current =
      cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    setHintW(widthFor(HINT));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const widthFor = (text: string): number => {
    const ctx = getMeasureCtx();
    if (!ctx) return 90;
    ctx.font = fontRef.current;
    return Math.min(160, Math.max(14, ctx.measureText(text).width + 6));
  };

  // Resting: hugging the hint. Focused & empty: the tightest bubble
  // that fits a centred caret. Typing: track the text.
  const inputW = focused || draft ? (draft ? textW : 10) : hintW;

  return (
    <div data-interactive style={BUBBLE_STYLE}>
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute -right-1 -top-1 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-[#e8e4dc] p-0 shadow"
      >
        <svg
          width="5"
          height="5"
          viewBox="0 0 6 6"
          aria-hidden
          style={{ position: 'absolute', inset: 0, margin: 'auto', display: 'block' }}
        >
          <path d="M1 1l4 4M5 1L1 5" stroke="#6b5b4a" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <input
        ref={inputRef}
        value={draft}
        maxLength={80}
        onChange={(e) => {
          const value = e.target.value;
          setDraft(value);
          setTextW(widthFor(value));
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setMyBubble(draft);
            onClose();
          }
        }}
        placeholder={focused ? '' : HINT}
        className="placeholder:text-[#b0ada6]"
        style={{
          width: inputW,
          textAlign: draft ? 'left' : 'center',
          transition: 'width 0.18s cubic-bezier(0.2, 0, 0, 1)',
          background: 'transparent',
          outline: 'none',
          fontSize: 12,
          color: '#222',
          caretColor: '#b0ada6',
        }}
      />
      <span style={BUBBLE_TAIL} />
    </div>
  );
}

interface Spots {
  chairX: number;
  /** Which waypoint this character starts from, so the two don't stack up. */
  start: number;
}

/** Per-user destinations so two characters never fight over one spot. */
const SPOTS: Record<'me' | 'partner', Spots> = {
  me: { chairX: 0.62, start: 0 },
  partner: { chairX: -0.42, start: 5 },
};

/**
 * Which side of the bed each character sleeps on — keyed by ROLE so both peers
 * see the same arrangement (it used to key off who was looking, so the sides
 * swapped between the two machines). Screen-right is world (0.707, 0, -0.707),
 * so a LARGER z sits further to the screen-left: Lulu lies left of Roro.
 */
const SLEEP_Z: Record<Role, number> = { USER_A: 1.55, USER_B: 0.75 };

/* ------------------------------ roaming ------------------------------ */

/**
 * Furniture footprints in world x/z, measured from IsometricRoom (the desk sits
 * inside a `scale={0.8} position={[0.02,0,-0.43]}` group, so its numbers are
 * the scaled ones). Characters never enter these.
 *
 * The desk uses its TOP footprint, not the narrower body: the top sits at world
 * y 1.14, below head height, so walking under the overhang would clip.
 */
const BODY_R = 0.16; // character half-width used for clearance
const OBSTACLES = [
  { minX: -3.15, maxX: 0.85, minZ: -0.45, maxZ: 2.15 }, // bed
  { minX: -1.38, maxX: 1.58, minZ: -2.75, maxZ: -1.55 }, // desk (top)
  { minX: 0.329, maxX: 0.911, minZ: -1.491, maxZ: -0.909 }, // chair, right
  { minX: -0.711, maxX: -0.129, minZ: -1.491, maxZ: -0.909 }, // chair, left
  { minX: -3.05, maxX: -2.15, minZ: -2.95, maxZ: -2.05 }, // monstera
  { minX: 2.2, maxX: 3.1, minZ: -3.0, maxZ: -2.1 }, // laundry basket
  { minX: -2.93, maxX: -2.17, minZ: 2.17, maxZ: 2.93 }, // toy car
  { minX: -2.11, maxX: -1.49, minZ: 2.47, maxZ: 2.77 }, // dumbbell
];

function blocked(x: number, z: number): boolean {
  if (Math.abs(x) > ROOM_CLAMP || Math.abs(z) > ROOM_CLAMP) return true;
  return OBSTACLES.some(
    (o) =>
      x > o.minX - BODY_R && x < o.maxX + BODY_R && z > o.minZ - BODY_R && z < o.maxZ + BODY_R
  );
}

/** Walk the segment in small steps — the gaps here are only ~0.14 wide. */
function pathClear(ax: number, az: number, bx: number, bz: number): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.06));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (blocked(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}

/**
 * Roaming graph. The room is tight — the bed reaches the left wall and the desk
 * plus its two chairs span the middle — so the ONLY route between the open right
 * side and the monstera corner is the lane at z ~ -0.68, threading between the
 * back of the bed (z -0.45) and the front of the chairs (z -0.909). Waypoints
 * are joined only where the straight line between them is clear, so characters
 * follow that lane instead of cutting through furniture.
 */
const WAYPOINTS: Array<[number, number]> = [
  [2.35, 0.3], // 0  open floor, right of the bed
  [1.45, 1.6], // 1
  [2.45, 2.1], // 2
  [1.3, -0.1], // 3
  [0.45, 2.6], // 4  the strip in front of the bed
  [-1.15, 2.6], // 5
  [1.9, -0.68], // 6  the lane behind the bed / in front of the chairs
  [0.1, -0.68], // 7
  [-1.6, -0.68], // 8
  [-2.6, -1.5], // 9  monstera corner
  [-1.85, -2.55], // 10 behind the desk, left
  [2.3, -1.6], // 11 beside the laundry basket
  [2.6, -1.75], // 12
];

/** Waypoints reachable from each one in a straight line. */
const NEIGHBOURS: number[][] = WAYPOINTS.map(([ax, az], i) =>
  WAYPOINTS.reduce<number[]>((acc, [bx, bz], jj) => {
    if (jj !== i && pathClear(ax, az, bx, bz)) acc.push(jj);
    return acc;
  }, [])
);

/** Nearest waypoint this position can actually walk to. */
function nearestWaypoint(x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  let bestClear = false;
  WAYPOINTS.forEach(([wx, wz], i) => {
    const d = Math.hypot(wx - x, wz - z);
    const clear = pathClear(x, z, wx, wz);
    // prefer a reachable one; fall back to the closest if none is reachable
    if ((clear && !bestClear) || (clear === bestClear && d < bestD)) {
      best = i;
      bestD = d;
      bestClear = clear;
    }
  });
  return best;
}

/** Push a dropped character out of any furniture it landed in. */
function nudgeFree(x: number, z: number): [number, number] {
  if (!blocked(x, z)) return [x, z];
  let best: [number, number] = [x, z];
  let bestD = Infinity;
  for (let r = 0.15; r <= 2.4; r += 0.15) {
    for (let a = 0; a < 24; a += 1) {
      const ang = (a / 24) * Math.PI * 2;
      const nx = x + Math.cos(ang) * r;
      const nz = z + Math.sin(ang) * r;
      if (blocked(nx, nz)) continue;
      const d = Math.hypot(nx - x, nz - z);
      if (d < bestD) {
        bestD = d;
        best = [nx, nz];
      }
    }
    if (bestD < Infinity) break;
  }
  return best;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TMP_VEC = new THREE.Vector3();
const TMP_COLOR = new THREE.Color();
const TMP_BOX = new THREE.Box3();

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}

function makeZzzTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#f5f9ff';
    ctx.font = 'bold 32px Menlo, monospace';
    ctx.fillText('Z', 84, 30);
    ctx.font = 'bold 23px Menlo, monospace';
    ctx.fillText('z', 54, 44);
    ctx.font = 'bold 16px Menlo, monospace';
    ctx.fillText('z', 30, 56);
  }
  return new THREE.CanvasTexture(c);
}

/**
 * World bounds with skinning applied — Box3.setFromObject measures a
 * SkinnedMesh's unskinned base geometry, which can be wildly off.
 */
function computeSceneBox(
  scene: THREE.Object3D,
  skip?: (mesh: THREE.Mesh) => boolean
): THREE.Box3 {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  box.makeEmpty();
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && skip?.(obj)) return;
    if (obj instanceof THREE.SkinnedMesh) {
      obj.computeBoundingBox();
      if (obj.boundingBox) box.union(TMP_BOX.copy(obj.boundingBox).applyMatrix4(obj.matrixWorld));
    } else if (obj instanceof THREE.Mesh) {
      obj.geometry.computeBoundingBox();
      const gb = obj.geometry.boundingBox;
      if (gb) box.union(TMP_BOX.copy(gb).applyMatrix4(obj.matrixWorld));
    }
  });
  return box;
}

type Phase = 'walk' | 'settle';
type Tele = 'none' | 'out' | 'in';

interface SimState {
  x: number;
  z: number;
  yaw: number;
  wp: number;
  dwell: number;
  lie: number;
  scale: number;
  status: CharacterStatus;
  phase: Phase;
  tele: Tele;
  teleT: number;
  dragging: boolean;
  /** Damped standing height: floor planks, chair seat or mattress. */
  stand: number;
  /** Seconds left of re-measuring skinned bounds after a pose change. */
  poseSettle: number;
  /** Damped 0..1 day->night blend for the emissive tint. */
  night: number;
  /** Which chair to work at — set by dropping the villager on one. */
  chairX: number;
}

interface PuffState {
  active: boolean;
  t: number;
  origin: THREE.Vector3;
}

const PUFF_COUNT = 7;
const PUFF_DURATION = 0.65;

export default function Character({ variant }: { variant: 'me' | 'partner' }) {
  const status = useAppStore((s) => (variant === 'me' ? s.myStatus : s.partnerStatus));
  const bubble = useAppStore((s) => (variant === 'me' ? s.myBubble : s.partnerBubble));
  const spots = SPOTS[variant];
  // The model follows the *role*, not who is looking.
  const role = useAppStore((s) => (variant === 'me' ? s.role : partnerOf(s.role)));
  const model = MODELS[role];

  const isNight = useAppStore((st) => st.isNightMode);
  // The editable speech bubble replaces the old speech menu.
  const editing = useAppStore((s) => variant === 'me' && s.activeModal === 'SPEECH');
  // Reactive mirror of sim.dragging so drop markers can mount/unmount.
  const [dragActive, setDragActive] = useState(false);

  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const overheadAnchor = useRef<THREE.Group>(null!);
  const zzz = useRef<THREE.Mesh>(null!);
  const zzzMat = useRef<THREE.MeshBasicMaterial>(null!);

  // Bubble lifetime tick.
  const [, setBubbleTick] = useState(0);
  useEffect(() => {
    if (!bubble.text) return;
    const id = setInterval(() => setBubbleTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [bubble.text, bubble.updatedAt]);
  const bubbleShown = bubble.text.length > 0 && Date.now() - bubble.updatedAt < BUBBLE_TTL;

  /* ---------------- model, clone & animation wiring ---------------- */
  const { scene: srcScene, animations } = useGLTF(model.url);
  // Clone per instance: two characters can share one GLB.
  const scene = useMemo(() => SkeletonUtils.clone(srcScene), [srcScene]);
  const { actions, mixer } = useAnimations(animations, scene);

  const fitted = useMemo(() => {
    const custom = CUSTOMIZE[role];
    const matches = (name: string, key: string) =>
      name.toLowerCase().includes(key.toLowerCase());
    const namesOf = (obj: THREE.Mesh) => {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      return [obj.name, ...mats.map((m) => m.name)];
    };
    const isGear = (obj: THREE.Mesh) =>
      custom.gear.some((g) => namesOf(obj).some((n) => matches(n, g)));
    const isHidden = (obj: THREE.Mesh) =>
      custom.hide.some((h) => namesOf(obj).some((n) => matches(n, h)));

    // Measure the SOURCE scene, not the animated clone: a SkinnedMesh's bounds
    // follow its current pose, so measuring the clone made the character
    // resize (and slide off-axis) whenever it was re-fitted mid-animation —
    // which is exactly what swapping characters in the settings menu did. The
    // source is never animated, so it always reads the bind pose. Gear is
    // excluded so putting the hat on can't change the size either.
    const box = computeSceneBox(srcScene, (m) => isGear(m) || isHidden(m));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = CHAR_HEIGHT / Math.max(size.y, 1e-6);

    const gear: THREE.Object3D[] = [];
    // Every material, with its original emissive stashed, so the night tint can
    // be re-applied from the base each frame instead of compounding.
    const lit: Array<{
      mat: THREE.Material & { emissive: THREE.Color; emissiveIntensity: number };
      base: THREE.Color;
      dim: number;
    }> = [];
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.frustumCulled = false; // skinned bounds are wrong mid-clip
      if (isHidden(obj)) {
        obj.visible = false;
        return;
      }
      if (isGear(obj)) {
        gear.push(obj);
        obj.visible = false; // shown again only while WORKING
      }
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      // Loose name match, then repaint the emissive atlas (see paintMaterial —
      // this pack is emissive-only, and one atlas covers dress + sash + trim).
      const paintOne = (mat: THREE.Material): THREE.Material => {
        for (const [key, bands] of Object.entries(custom.paint)) {
          if (matches(mat.name, key) || matches(obj.name, key)) {
            const clone = mat.clone();
            paintMaterial(clone, bands, obj.geometry);
            return clone;
          }
        }
        return mat;
      };
      obj.material = Array.isArray(obj.material) ? mats.map(paintOne) : paintOne(mats[0]);
      const applied = Array.isArray(obj.material) ? obj.material : [obj.material];
      applied.forEach((m) => {
        const em = m as THREE.Material & {
          emissive?: THREE.Color;
          emissiveIntensity?: number;
          baseEmissive?: THREE.Color;
        };
        if (!em.emissive || lit.some((e) => e.mat === em)) return;
        // Stash on the material, not in this array: a material can outlive the
        // fit (unpainted ones are shared with the source scene), and re-reading
        // a live emissive that night had already tinted would compound it.
        if (!em.baseEmissive) em.baseEmissive = em.emissive.clone();
        lit.push({
          mat: em as THREE.Material & { emissive: THREE.Color; emissiveIntensity: number },
          base: em.baseEmissive,
          dim: isSkinMaterial(m.name) || isSkinMaterial(obj.name) ? SKIN_DIM : 1,
        });
      });
    });
    // The head bone drives the Zzz and the speech bubble. Reading it live
    // beats a per-model offset: each pack's sleep clip ends in a different
    // pose, so a constant that suits one model puts the other's Zzz in midair.
    let head: THREE.Object3D | null = null;
    scene.traverse((obj) => {
      if (head) return;
      if (/head\.head/i.test(obj.name)) head = obj;
    });
    if (!head) scene.traverse((obj) => { if (!head && /head/i.test(obj.name)) head = obj; });

    const skinned: THREE.SkinnedMesh[] = [];
    scene.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) skinned.push(obj);
    });

    return {
      scale,
      offset: [-center.x, -box.min.y, -center.z] as const,
      gear,
      head: head as THREE.Object3D | null,
      skinned,
      lit,
    };
  }, [scene, srcScene, role]);

  /** Flourish pool, derived from whatever clips this model actually ships. */
  const flourishes = useMemo(() => flourishesFrom(animations, model), [animations, model]);

  /** Currently playing clip + one-shot flourish bookkeeping. */
  const currentClip = useRef<string | null>(null);
  const extraPlaying = useRef<string | null>(null);

  const playClip = (name: string, opts?: { once?: boolean; fade?: number; timeScale?: number }) => {
    const action = actions[name];
    if (!action || currentClip.current === name) return;
    const prev = currentClip.current ? actions[currentClip.current] : null;
    action.reset();
    action.setLoop(opts?.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = opts?.once ?? false;
    action.timeScale = opts?.timeScale ?? 1;
    if (prev) action.crossFadeFrom(prev, opts?.fade ?? 0.25, false);
    action.play();
    currentClip.current = name;
  };

  // Flourishes return to idle when their one-shot finishes.
  useEffect(() => {
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      if (extraPlaying.current && e.action.getClip().name === extraPlaying.current) {
        extraPlaying.current = null;
      }
    };
    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
  }, [mixer]);

  /**
   * The grab plane sits at head-top height so the crown of the head
   * tracks the cursor while carried.
   */
  const grabPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 1, 0), -(CARRY_LIFT + HEAD_TOP)),
    []
  );

  const zzzTexture = useMemo(makeZzzTexture, []);

  const puffDirs = useMemo(() => {
    const dirs: THREE.Vector3[] = [];
    for (let i = 0; i < PUFF_COUNT; i++) {
      const a = (i / PUFF_COUNT) * Math.PI * 2;
      dirs.push(new THREE.Vector3(Math.cos(a), 0.35 + (i % 3) * 0.25, Math.sin(a)).normalize());
    }
    return dirs;
  }, []);
  const puffs = useRef<[PuffState, PuffState]>([
    { active: false, t: 0, origin: new THREE.Vector3() },
    { active: false, t: 0, origin: new THREE.Vector3() },
  ]);
  const puffIdx = useRef(0);
  const puffGroups = [useRef<THREE.Group>(null!), useRef<THREE.Group>(null!)];
  const puffMaterials = useMemo(
    () =>
      [0, 1].map(
        () =>
          new THREE.MeshBasicMaterial({
            color: '#eae6dc',
            transparent: true,
            opacity: 0,
            depthWrite: false,
          })
      ),
    []
  );

  const qStand = useMemo(() => new THREE.Quaternion(), []);
  const sim = useRef<SimState>({
    x: WAYPOINTS[spots.start][0],
    z: WAYPOINTS[spots.start][1],
    yaw: 0,
    wp: spots.start,
    dwell: 0,
    lie: 0,
    scale: 1,
    status,
    phase: 'walk',
    tele: 'none',
    teleT: 0,
    dragging: false,
    stand: FLOOR_Y,
    poseSettle: 2.5,
    night: 0,
    chairX: spots.chairX,
  });

  const firePuff = (x: number, y: number, z: number) => {
    const i = (puffIdx.current = puffIdx.current ^ 1);
    const p = puffs.current[i];
    p.active = true;
    p.t = 0;
    p.origin.set(x, y, z);
  };

  /** Anchor position + pose for a posed status; waypoint (or the live
   *  streamed position for the partner) for IDLE. */
  const destinationFor = (st: CharacterStatus, s: SimState, remote: CharPos | null) => {
    // No sit clip in either pack, so "working" stands ON the chair seat
    // (CHAIR_SEAT_Y) rather than clipping through it from behind.
    if (st === 'WORKING') return { x: s.chairX, z: CHAIR_Z, yaw: Math.PI };
    if (st === 'SLEEPING') return { x: -0.55, z: SLEEP_Z[role], yaw: model.sleepYaw };
    if (remote) return { x: remote.x, z: remote.z, yaw: remote.yaw as number | null };
    const wp = WAYPOINTS[s.wp % WAYPOINTS.length];
    return { x: wp[0], z: wp[1], yaw: null as number | null };
  };

  /* ------------------------ drag / click ------------------------ */
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (variant !== 'me' || e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) {
        dragging = true;
        sim.current.dragging = true;
        setDragActive(true);
        setForceInteractive(true);
        lockCursor(CURSOR.grab);
        // Picking the villager up cancels an open speech editor.
        if (useAppStore.getState().activeModal === 'SPEECH') {
          useAppStore.getState().setActiveModal('NONE');
        }
        // A carried villager stops holding furniture poses.
        if (useAppStore.getState().myStatus !== 'IDLE') {
          useAppStore.getState().setMyStatus('IDLE');
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setForceInteractive(false);
      unlockCursor();
      setCursor(CURSOR.open);
      if (dragging) {
        sim.current.dragging = false;
        setDragActive(false);
        // Dropped on a marked zone? Bed puts them to sleep, either
        // chair puts them to work there; anywhere else they roam.
        const sx = sim.current.x;
        const sz = sim.current.z;
        const chair = CHAIR_XS.find((cx) => Math.hypot(sx - cx, sz - CHAIR_Z) < CHAIR_RADIUS);
        if (sx > BED_RECT.minX && sx < BED_RECT.maxX && sz > BED_RECT.minZ && sz < BED_RECT.maxZ) {
          useAppStore.getState().setMyStatus('SLEEPING');
        } else if (chair !== undefined) {
          sim.current.chairX = chair;
          useAppStore.getState().setMyStatus('WORKING');
        } else {
          // Roam from wherever they landed — but not from inside the desk or
          // a plant pot, and heading for a waypoint they can actually reach.
          const [fx, fz] = nudgeFree(sx, sz);
          sim.current.x = fx;
          sim.current.z = fz;
          sim.current.wp = nearestWaypoint(fx, fz);
          sim.current.phase = 'settle'; // stand at the drop point for a beat
          sim.current.dwell = 0;
        }
      } else {
        useAppStore.getState().setActiveModal('SPEECH');
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const sendState = useRef({ lastT: 0, lastX: 0, lastZ: 0, lastCarried: false });

  useFrame((frame, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = frame.clock.elapsedTime + (variant === 'partner' ? 1.7 : 0);
    const s = sim.current;
    const damp = (cur: number, target: number, lambda: number) =>
      THREE.MathUtils.damp(cur, target, lambda, dt);
    const remote = variant === 'partner' ? useAppStore.getState().partnerCharPos : null;

    /* ---------- status change: teleport with smoke ---------- */
    if (s.status !== status) {
      s.status = status;
      s.dwell = 0;
      s.poseSettle = 2.5; // re-measure skinned bounds while the new pose lands
      extraPlaying.current = null;
      if (!s.dragging) {
        s.tele = 'out';
        s.teleT = 0;
        firePuff(s.x, 0.55 + s.lie * 0.45, s.z);
      }
    }

    /* ---------- teleport phases ---------- */
    if (s.tele === 'out') {
      s.teleT += dt;
      const p = Math.min(1, s.teleT / TELE_OUT);
      s.scale = 1 - p;
      if (p >= 1) {
        const dest = destinationFor(status, s, remote);
        s.x = dest.x;
        s.z = dest.z;
        if (dest.yaw !== null) s.yaw = dest.yaw;
        s.lie = status === 'SLEEPING' ? 1 : 0;
        s.phase = 'settle';
        s.tele = 'in';
        s.teleT = 0;
        firePuff(s.x, 0.55 + s.lie * 0.45, s.z);
      }
    } else if (s.tele === 'in') {
      s.teleT += dt;
      const p = Math.min(1, s.teleT / TELE_IN);
      s.scale = p < 1 ? p * (1 + 0.15 * Math.sin(p * Math.PI)) : 1;
      if (p >= 1) s.tele = 'none';
    }

    /* ---------- movement ---------- */
    let walking = false;
    if (s.dragging) {
      frame.raycaster.setFromCamera(frame.pointer, frame.camera);
      const hit = frame.raycaster.ray.intersectPlane(grabPlane, TMP_VEC);
      if (hit) {
        s.x = damp(s.x, THREE.MathUtils.clamp(hit.x, -ROOM_CLAMP, ROOM_CLAMP), 20);
        s.z = damp(s.z, THREE.MathUtils.clamp(hit.z, -ROOM_CLAMP, ROOM_CLAMP), 20);
      }
      s.yaw = dampAngle(
        s.yaw,
        Math.atan2(frame.camera.position.x - s.x, frame.camera.position.z - s.z),
        12,
        dt
      );
      s.lie = damp(s.lie, 0, 10);
      s.scale = damp(s.scale, 1, 12);
    } else if (s.tele === 'none' && status === 'IDLE') {
      if (remote) {
        const dist = Math.hypot(remote.x - s.x, remote.z - s.z);
        walking = !remote.carried && dist > 0.06;
        s.x = damp(s.x, remote.x, 12);
        s.z = damp(s.z, remote.z, 12);
        s.yaw = dampAngle(s.yaw, remote.yaw, 10, dt);
      } else if (s.phase === 'walk') {
        const wp = WAYPOINTS[s.wp % WAYPOINTS.length];
        const dx = wp[0] - s.x;
        const dz = wp[1] - s.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.05) {
          walking = true;
          const step = Math.min(dist, WALK_SPEED * dt);
          s.x += (dx / dist) * step;
          s.z += (dz / dist) * step;
          s.yaw = dampAngle(s.yaw, Math.atan2(dx, dz), 10, dt);
        } else {
          s.phase = 'settle';
          s.dwell = 0;
          // Sometimes celebrate arriving with a random flourish.
          if (variant === 'me' && flourishes.length && Math.random() < EXTRA_CHANCE) {
            extraPlaying.current = flourishes[Math.floor(Math.random() * flourishes.length)];
          }
        }
      } else {
        s.dwell += dt;
        if (s.dwell > 3.2 && !extraPlaying.current) {
          s.dwell = 0;
          // Step to a neighbour, so the straight line there stays clear of
          // furniture. Falls back to re-picking the nearest reachable node.
          const options = NEIGHBOURS[s.wp % WAYPOINTS.length];
          s.wp = options.length
            ? options[Math.floor(Math.random() * options.length)]
            : nearestWaypoint(s.x, s.z);
          s.phase = 'walk';
        }
      }
      s.lie = damp(s.lie, 0, 8);
    } else if (s.tele === 'none') {
      const dest = destinationFor(status, s, remote);
      s.x = damp(s.x, dest.x, 8);
      s.z = damp(s.z, dest.z, 8);
      if (dest.yaw !== null) s.yaw = dampAngle(s.yaw, dest.yaw, 8, dt);
      s.lie = damp(s.lie, status === 'SLEEPING' ? 1 : 0, 10);
    }

    /* ---------- clip selection ---------- */
    const carried =
      s.dragging || (remote !== null && remote.carried && status === 'IDLE' && s.tele === 'none');
    // Hat, staff and cape are work gear: worn at the desk, off everywhere else.
    const atWork = status === 'WORKING' && !s.dragging && s.tele === 'none';
    fitted.gear.forEach((g) => {
      g.visible = atWork;
    });

    if (carried) {
      // Picked up: go limp and hold the last frame while dangling.
      playClip(model.clips.carry, { once: true, fade: 0.15 });
      extraPlaying.current = null;
    } else if (walking) {
      playClip(model.clips.walk);
      extraPlaying.current = null;
    } else if (status === 'WORKING' && s.tele === 'none' && !s.dragging) {
      playClip(model.clips.work);
    } else if (status === 'SLEEPING' && s.tele === 'none' && !s.dragging) {
      playClip(model.clips.sleep, { once: true, fade: 0.2 });
    } else if (extraPlaying.current) {
      playClip(extraPlaying.current, { once: true, fade: 0.15 });
    } else {
      playClip(model.clips.idle);
    }

    /* ---------- broadcast my position while wandering / carried ---------- */
    if (variant === 'me' && status === 'IDLE' && s.tele === 'none') {
      const now = performance.now();
      const snd = sendState.current;
      const moved = Math.hypot(s.x - snd.lastX, s.z - snd.lastZ) > 0.02;
      if ((moved || snd.lastCarried !== s.dragging) && now - snd.lastT > 80) {
        snd.lastT = now;
        snd.lastX = s.x;
        snd.lastZ = s.z;
        snd.lastCarried = s.dragging;
        useAppStore.getState().sendCharPos({ x: s.x, z: s.z, yaw: s.yaw, carried: s.dragging });
      }
    }

    /* ---------- root transform ---------- */
    const lieE = THREE.MathUtils.smoothstep(s.lie, 0, 1);
    const carryY = carried ? CARRY_LIFT + Math.sin(t * 3) * 0.03 : 0;
    // Feet land on the planks, on the chair seat while working, on the
    // mattress once lying. Damped so the change can't pop.
    const standTarget = status === 'WORKING' && !s.dragging ? CHAIR_SEAT_Y : FLOOR_Y;
    s.stand = damp(s.stand, standTarget, 10);
    root.current.position.set(s.x, carryY + THREE.MathUtils.lerp(s.stand, BED_Y, lieE), s.z);
    qStand.setFromAxisAngle(Y_AXIS, s.yaw + model.yaw);
    root.current.quaternion.copy(qStand);
    root.current.scale.setScalar(Math.max(0.001, s.scale));
    // Push the new transform down the skeleton before anything reads a bone.
    root.current.updateMatrixWorld(true);

    /* ---------- keep hit-testing honest across poses ----------
     * A SkinnedMesh raycast starts with a bounding-sphere test, and that sphere
     * is computed once, lazily, in whatever pose the character happened to be
     * in. Lying down puts most of the body outside a sphere measured standing,
     * which is why a sleeping character could not be grabbed. Recompute while
     * the pose is still settling after any status change (armed above, where
     * the status actually changes — s.status is already synced by this point). */
    if (s.poseSettle > 0) {
      s.poseSettle -= dt;
      fitted.skinned.forEach((m) => {
        m.computeBoundingSphere();
        m.computeBoundingBox();
      });
    }

    // carried protest: rock the whole body
    const rock = carried ? Math.sin(t * 8) * 0.14 : 0;
    body.current.rotation.z = damp(body.current.rotation.z, rock, 12);
    body.current.rotation.x = damp(body.current.rotation.x, carried ? 0.12 : 0, 10);

    /* ---------- puffs of smoke ---------- */
    puffs.current.forEach((p, i) => {
      const group = puffGroups[i].current;
      const mat = puffMaterials[i];
      if (!group) return;
      if (!p.active) {
        mat.opacity = 0;
        return;
      }
      p.t += dt;
      const prog = Math.min(1, p.t / PUFF_DURATION);
      group.position.copy(p.origin);
      group.children.forEach((child, j) => {
        const dir = puffDirs[j % PUFF_COUNT];
        child.position.copy(dir).multiplyScalar(0.12 + prog * 0.42);
        child.position.y += prog * 0.18;
        child.scale.setScalar((0.12 + prog * 0.1) * (1 - prog * 0.35));
      });
      mat.opacity = 0.85 * (1 - prog);
      if (prog >= 1) p.active = false;
    });

    /* ---------- day / night ----------
     * Fullbright models take no light from the scene, so the room's lamps
     * dimming does nothing to them on its own — fade the emissive by hand. */
    s.night = damp(s.night, isNight ? 1 : 0, 5);
    const strength = DAY_EMISSIVE + (NIGHT_EMISSIVE - DAY_EMISSIVE) * s.night;
    fitted.lit.forEach(({ mat, base, dim }) => {
      mat.emissiveIntensity = strength * dim;
      mat.emissive.copy(base).lerp(TMP_COLOR.copy(base).multiply(NIGHT_TINT), s.night);
    });

    /* ---------- floating Zzz ---------- */
    const asleep = status === 'SLEEPING' && s.lie > 0.85 && !s.dragging;
    zzzMat.current.opacity = damp(
      zzzMat.current.opacity,
      asleep ? 0.55 + Math.sin(t * 1.8) * 0.25 : 0,
      6
    );
    // Anchor to the actual head bone so the Zzz follows whatever pose the
    // pack's sleep clip ends in, rather than a hardcoded standing offset.
    if (fitted.head) fitted.head.getWorldPosition(TMP_VEC);
    else TMP_VEC.set(s.x, root.current.position.y + HEAD_TOP, s.z);
    zzz.current.position.set(
      TMP_VEC.x - 0.3,
      TMP_VEC.y + 0.34 + Math.sin(t * 1.2) * 0.06,
      TMP_VEC.z
    );
    zzz.current.quaternion.copy(frame.camera.quaternion);

    /* ---------- overhead anchor (speech bubbles) ---------- */
    if (overheadAnchor.current) {
      // Same head bone as the Zzz — correct for both packs in every pose.
      if (fitted.head) fitted.head.getWorldPosition(TMP_VEC);
      else TMP_VEC.set(s.x, root.current.position.y + HEAD_TOP, s.z);
      overheadAnchor.current.position.set(TMP_VEC.x, TMP_VEC.y + 0.26, TMP_VEC.z);
    }
  });

  return (
    <>
      <group
        ref={root}
        onPointerDown={onPointerDown}
        onPointerOver={(e) => {
          if (variant !== 'me') return;
          e.stopPropagation();
          setCursor(sim.current.dragging ? CURSOR.grab : CURSOR.open);
        }}
        onPointerOut={(e) => {
          if (variant !== 'me') return;
          e.stopPropagation();
          if (!sim.current.dragging) setCursor(CURSOR.default);
        }}
      >
        <group ref={body}>
          <group scale={fitted.scale}>
            <primitive
              object={scene}
              position={[fitted.offset[0], fitted.offset[1], fitted.offset[2]]}
            />
          </group>
        </group>
      </group>

      {/* speech bubble over the head: editor for me, live text for both */}
      <group ref={overheadAnchor}>
        {variant === 'me' && editing ? (
          <Html center zIndexRange={[15, 0]}>
            <BubbleEditor onClose={() => useAppStore.getState().setActiveModal('NONE')} />
          </Html>
        ) : bubbleShown ? (
          <Html center zIndexRange={[13, 0]} style={{ pointerEvents: 'none' }}>
            <BubbleView key={bubble.updatedAt} text={bubble.text} />
          </Html>
        ) : null}
      </group>

      {/* drop-zone markers while carrying: bed to sleep, chairs to work */}
      {variant === 'me' && dragActive && (
        <>
          <group position={[-1.15, 1.7, 0.85]}>
            <Html center zIndexRange={[14, 0]} style={{ pointerEvents: 'none' }}>
              <div className="flex h-9 w-9 animate-bounce items-center justify-center rounded-full border border-white/70 bg-white/85 text-[17px] shadow-lg backdrop-blur">
                😴
              </div>
            </Html>
          </group>
          {CHAIR_XS.map((cx) => (
            <group key={cx} position={[cx, 1.5, CHAIR_Z]}>
              <Html center zIndexRange={[14, 0]} style={{ pointerEvents: 'none' }}>
                <div className="flex h-9 w-9 animate-bounce items-center justify-center rounded-full border border-white/70 bg-white/85 text-[17px] shadow-lg backdrop-blur">
                  💻
                </div>
              </Html>
            </group>
          ))}
        </>
      )}

      {/* puffs of smoke (two so vanish + appear can overlap) */}
      {[0, 1].map((i) => (
        <group key={i} ref={puffGroups[i]}>
          {Array.from({ length: PUFF_COUNT }).map((_, j) => (
            <mesh key={j} material={puffMaterials[i]} scale={0.001} raycast={() => undefined}>
              <sphereGeometry args={[1, 10, 10]} />
            </mesh>
          ))}
        </group>
      ))}

      {/* floating Zzz while asleep */}
      <mesh ref={zzz} raycast={() => undefined}>
        <planeGeometry args={[0.5, 0.25]} />
        <meshBasicMaterial ref={zzzMat} map={zzzTexture} transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
}
