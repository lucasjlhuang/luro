import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { Html, useAnimations, useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import { CharacterStatus, CharPos, Role, partnerOf, useAppStore } from '../../store/useAppStore';
import { setForceInteractive } from '../../lib/hitTest';
import { CURSOR, lockCursor, setCursor, unlockCursor } from '../../lib/cursors';
import roroUrl from '../../assets/models/roro.glb?url';

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

const MODELS: Record<Role, { url: string; height: number; yaw: number }> = {
  // TODO: swap to lulu.glb when provided — Roro is standing in for both.
  USER_A: { url: roroUrl, height: 1.1, yaw: 0 },
  USER_B: { url: roroUrl, height: 1.1, yaw: 0 },
};

useGLTF.preload(roroUrl);

/** Clip names inside roro.glb, mapped to app states. */
const CLIPS = {
  idle: 'Armatureidle_necromancer',
  walk: 'Armaturerun_necromancer',
  work: 'Armaturecast_loop_necromancer',
  sleep: 'Armaturedeath_necromancer',
  extras: [
    'Armatureattack_necromancer',
    'Armaturebuff_necromancer',
    'Armaturejump_necromancer',
    'Armaturegathering_necromancer',
    'Armaturecast_end_necromancer',
  ],
};
/** Chance of performing a flourish at each wander pause. */
const EXTRA_CHANCE = 0.45;

const WALK_SPEED = 1.05;
const LIE_RAISE = 0.88; // onto the mattress top
const TELE_OUT = 0.25;
const TELE_IN = 0.3;
const BUBBLE_HOLD = 5_000; // fully visible
const BUBBLE_FADE = 500; // then one gentle fade
const BUBBLE_TTL = BUBBLE_HOLD + BUBBLE_FADE;
const ROOM_CLAMP = 2.9;
const CARRY_LIFT = 0.4;
const HEAD_TOP = 1.1;

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
  lieZ: number;
  idle: Array<[number, number]>;
}

/** Per-user destinations so two characters never fight over one spot. */
const SPOTS: Record<'me' | 'partner', Spots> = {
  me: {
    chairX: 0.62,
    lieZ: 0.75,
    idle: [
      [2.2, 0.4],
      [1.1, 1.9],
      [1.7, -0.7],
      [0.95, 0.9],
    ],
  },
  partner: {
    chairX: -0.42,
    lieZ: 1.55,
    idle: [
      [1.4, 2.0],
      [2.5, -0.5],
      [1.15, 0.5],
      [2.3, 1.2],
    ],
  },
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TMP_VEC = new THREE.Vector3();
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
function computeSceneBox(scene: THREE.Object3D): THREE.Box3 {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  box.makeEmpty();
  scene.traverse((obj) => {
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
    const box = computeSceneBox(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = model.height / Math.max(size.y, 1e-6);
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.frustumCulled = false; // skinned bounds are wrong mid-clip
      }
    });
    return { scale, offset: [-center.x, -box.min.y, -center.z] as const };
  }, [scene, model.height]);

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
    x: spots.idle[0][0],
    z: spots.idle[0][1],
    yaw: 0,
    wp: 0,
    dwell: 0,
    lie: 0,
    scale: 1,
    status,
    phase: 'walk',
    tele: 'none',
    teleT: 0,
    dragging: false,
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
    // No sit clip in this pack: "working" stands at the desk casting.
    if (st === 'WORKING') return { x: s.chairX, z: -1.5, yaw: Math.PI };
    if (st === 'SLEEPING') return { x: -0.55, z: spots.lieZ, yaw: -Math.PI / 2 };
    if (remote) return { x: remote.x, z: remote.z, yaw: remote.yaw as number | null };
    const wp = spots.idle[s.wp % spots.idle.length];
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
        const wp = spots.idle[s.wp % spots.idle.length];
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
          if (variant === 'me' && Math.random() < EXTRA_CHANCE) {
            extraPlaying.current =
              CLIPS.extras[Math.floor(Math.random() * CLIPS.extras.length)];
          }
        }
      } else {
        s.dwell += dt;
        if (s.dwell > 3.2 && !extraPlaying.current) {
          s.dwell = 0;
          s.wp++;
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
    if (walking) {
      playClip(CLIPS.walk);
      extraPlaying.current = null;
    } else if (status === 'WORKING' && s.tele === 'none' && !s.dragging) {
      playClip(CLIPS.work);
    } else if (status === 'SLEEPING' && s.tele === 'none' && !s.dragging) {
      playClip(CLIPS.sleep, { once: true, fade: 0.2 });
    } else if (extraPlaying.current) {
      playClip(extraPlaying.current, { once: true, fade: 0.15 });
    } else {
      playClip(CLIPS.idle);
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
    const carried =
      s.dragging || (remote !== null && remote.carried && status === 'IDLE' && s.tele === 'none');
    const lieE = THREE.MathUtils.smoothstep(s.lie, 0, 1);
    const carryY = carried ? CARRY_LIFT + Math.sin(t * 3) * 0.03 : 0;
    root.current.position.set(s.x, carryY + lieE * LIE_RAISE, s.z);
    qStand.setFromAxisAngle(Y_AXIS, s.yaw + model.yaw);
    root.current.quaternion.copy(qStand);
    root.current.scale.setScalar(Math.max(0.001, s.scale));

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

    /* ---------- floating Zzz ---------- */
    const asleep = status === 'SLEEPING' && s.lie > 0.85 && !s.dragging;
    zzzMat.current.opacity = damp(
      zzzMat.current.opacity,
      asleep ? 0.55 + Math.sin(t * 1.8) * 0.25 : 0,
      6
    );
    zzz.current.position.set(s.x - 0.55, 1.5 + Math.sin(t * 1.2) * 0.06, s.z);
    zzz.current.quaternion.copy(frame.camera.quaternion);

    /* ---------- overhead anchor (speech bubbles) ---------- */
    if (overheadAnchor.current) {
      overheadAnchor.current.position.set(
        s.x - lieE * 0.5,
        root.current.position.y + (1 - lieE) * HEAD_TOP + lieE * 0.3,
        s.z
      );
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
