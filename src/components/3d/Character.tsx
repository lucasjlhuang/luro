import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { Html, RoundedBox } from '@react-three/drei';
import { CharacterStatus, CharPos, partnerOf, useAppStore } from '../../store/useAppStore';
import { setForceInteractive } from '../../lib/hitTest';
import { CURSOR, lockCursor, setCursor, unlockCursor } from '../../lib/cursors';

/* ------------------------------------------------------------------ */
/* Animal-Crossing-style villager, fully procedural.                  */
/*                                                                    */
/* Statuses no longer walk the character onto furniture (that caused  */
/* clipping): a posed status teleports via two puffs of smoke — one   */
/* where the villager vanishes, one where they reappear already in    */
/* the pose. Only IDLE walks: a gentle wander between open-floor      */
/* waypoints.                                                         */
/*                                                                    */
/* Interactions (own villager only):                                  */
/*   click          -> opens the speech-bubble input                  */
/*   click + drag   -> pick the villager up and carry them around     */
/* ------------------------------------------------------------------ */

const WALK_SPEED = 1.05;
const SKIN = '#f6e0c0';
const MAT = { roughness: 0.85, metalness: 0.05 };

/** Status choices shown as bubbles above the villager's head. */
const STATUS_OPTIONS: Array<{ value: CharacterStatus; icon: string; label: string }> = [
  { value: 'IDLE', icon: '🚶', label: 'Idle — wander around' },
  { value: 'WORKING', icon: '💻', label: 'Working — sit at the desk' },
  { value: 'SLEEPING', icon: '😴', label: 'Sleeping — lie on the bed' },
];

/** Two villagers: USER_A is the boy, USER_B the girl. */
const LOOKS = {
  USER_A: {
    girl: false,
    shirt: '#a9d6ea', // light blue tee
    sleeve: '#a9d6ea',
    legs: '#2e2c2a', // black cargo pants
    shoes: '#4a3a2a',
    hair: '#3b2a1d', // dark brown, worn as a mullet
    accent: '#f2b134',
  },
  USER_B: {
    girl: true,
    shirt: '#cfe8b5', // light green (dress body is the floral texture)
    sleeve: '#cfe8b5',
    legs: SKIN,
    shoes: '#f7f0e2',
    hair: '#a8815a', // light brown
    accent: '#f28bb4', // pink hair flower
  },
} as const;

const GLASSES = '#2f2a26';
const FRECKLE = '#c98d5f';
const FRECKLES: Array<[number, number]> = [
  [-0.16, -0.075],
  [-0.11, -0.09],
  [-0.06, -0.075],
  [0.06, -0.075],
  [0.11, -0.09],
  [0.16, -0.075],
];

/** Light-green floral print for the girl's dress. */
let floralTex: THREE.CanvasTexture | null = null;
function getFloral(): THREE.CanvasTexture {
  if (floralTex) return floralTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#cfe8b5';
    ctx.fillRect(0, 0, 128, 128);
    const flowers: Array<[number, number, number]> = [
      [22, 24, 7],
      [86, 18, 6],
      [58, 56, 8],
      [18, 88, 6],
      [96, 78, 7],
      [58, 108, 6],
      [112, 44, 5],
    ];
    for (const [fx, fy, r] of flowers) {
      ctx.fillStyle = '#f5a8c0';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(fx + Math.cos(a) * r, fy + Math.sin(a) * r, r * 0.72, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(fx, fy, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    for (const [dx, dy] of [
      [40, 20],
      [10, 55],
      [76, 40],
      [40, 86],
      [104, 104],
      [118, 12],
    ]) {
      ctx.beginPath();
      ctx.arc(dx, dy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  floralTex = new THREE.CanvasTexture(c);
  floralTex.wrapS = THREE.RepeatWrapping;
  floralTex.wrapT = THREE.RepeatWrapping;
  floralTex.repeat.set(2, 1.5);
  floralTex.anisotropy = 4;
  return floralTex;
}

const SIT_RAISE = 0.35; // hips onto the chair seat (~0.63 after 1.12x scale)
const LIE_RAISE = 1.0; // body onto the mattress top (~0.86) plus half-thickness
const TELE_OUT = 0.25;
const TELE_IN = 0.3;
const BUBBLE_TTL = 30_000;
const ROOM_CLAMP = 2.9;
const CARRY_LIFT = 0.4; // how high a picked-up villager floats
const HEAD_TOP = 1.36; // head centre (1.0) + radius (0.34) + hair, above the root

interface Spots {
  chairX: number;
  lieZ: number;
  idle: Array<[number, number]>;
}

/** Per-user destinations so two villagers never fight over one spot. */
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

/** Orientation for lying on the back: head toward -x, face up. */
const LIE_Q = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0)
  )
);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/**
 * Horizontal plane at the height a carried villager's head-top sits.
 * Intersecting the cursor ray with *this* (rather than the floor) puts
 * the top of the head under the pointer instead of the feet.
 */
const GRAB_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(CARRY_LIFT + HEAD_TOP));
const TMP_VEC = new THREE.Vector3();

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

/** Rounded speech balloon with up-to-3-line word wrap and a tail. */
function drawBubble(canvas: HTMLCanvasElement, text: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  ctx.clearRect(0, 0, W, canvas.height);
  if (!text) return;

  ctx.font = '600 26px -apple-system, "Segoe UI", sans-serif';
  const maxW = 260;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  let truncated = false;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      if (lines.length === 2) {
        truncated = true;
        break;
      }
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line && lines.length < 3) lines.push(line);
  if (truncated) lines[lines.length - 1] += '…';

  const lineH = 34;
  const boxH = lines.length * lineH + 26;
  const boxBottom = 134;
  const boxTop = boxBottom - boxH;

  ctx.fillStyle = '#fdfcf6';
  ctx.strokeStyle = '#d8d2c2';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(12, boxTop, W - 24, boxH, 18);
  ctx.fill();
  ctx.stroke();
  // tail
  ctx.beginPath();
  ctx.moveTo(W / 2 - 16, boxBottom - 2);
  ctx.lineTo(W / 2 - 2, boxBottom + 28);
  ctx.lineTo(W / 2 + 16, boxBottom - 2);
  ctx.closePath();
  ctx.fillStyle = '#fdfcf6';
  ctx.fill();

  ctx.fillStyle = '#33302a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    ctx.fillText(l, W / 2, boxTop + 20 + i * lineH + lineH / 2 - 8);
  });
}

type Phase = 'walk' | 'settle';
type Tele = 'none' | 'out' | 'in';

interface SimState {
  x: number;
  z: number;
  yaw: number;
  walkT: number;
  wp: number;
  dwell: number;
  sit: number;
  lie: number;
  scale: number;
  status: CharacterStatus;
  phase: Phase;
  tele: Tele;
  teleT: number;
  dragging: boolean;
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
  // The model follows the *role*, not who is looking: A is always the boy.
  const role = useAppStore((s) => (variant === 'me' ? s.role : partnerOf(s.role)));
  const look = LOOKS[role];

  // Status bubbles hover over the head while the speech input is open.
  const pickerOpen = useAppStore((s) => variant === 'me' && s.activeModal === 'SPEECH');
  const myStatus = useAppStore((s) => s.myStatus);
  const setMyStatus = useAppStore((s) => s.setMyStatus);

  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const pickerAnchor = useRef<THREE.Group>(null!);
  const torso = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const armL = useRef<THREE.Group>(null!);
  const armR = useRef<THREE.Group>(null!);
  const legL = useRef<THREE.Group>(null!);
  const legR = useRef<THREE.Group>(null!);
  const eyes = useRef<THREE.Group>(null!);
  const zzz = useRef<THREE.Mesh>(null!);
  const zzzMat = useRef<THREE.MeshBasicMaterial>(null!);
  const bubbleMesh = useRef<THREE.Mesh>(null!);
  const bubbleMat = useRef<THREE.MeshBasicMaterial>(null!);
  const puffGroups = [useRef<THREE.Group>(null!), useRef<THREE.Group>(null!)];
  // One shared material per puff so all particles fade together.
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

  const zzzTexture = useMemo(makeZzzTexture, []);
  const bubbleCanvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 176;
    return c;
  }, []);
  const bubbleTexture = useMemo(() => new THREE.CanvasTexture(bubbleCanvas), [bubbleCanvas]);
  useEffect(() => {
    drawBubble(bubbleCanvas, bubble.text);
    bubbleTexture.needsUpdate = true;
  }, [bubble.text, bubbleCanvas, bubbleTexture]);

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

  const qStand = useMemo(() => new THREE.Quaternion(), []);
  const sim = useRef<SimState>({
    x: spots.idle[0][0],
    z: spots.idle[0][1],
    yaw: 0,
    walkT: 0,
    wp: 0,
    dwell: 0,
    sit: 0,
    lie: 0,
    scale: 1,
    status,
    phase: 'walk',
    tele: 'none',
    teleT: 0,
    dragging: false,
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
    if (st === 'WORKING') return { x: spots.chairX, z: -1.18, yaw: Math.PI };
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
        setForceInteractive(true);
        lockCursor(CURSOR.grab);
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
        sim.current.phase = 'settle'; // stand at the drop point for a beat
        sim.current.dwell = 0;
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
    // Read imperatively: at ~12 msgs/s a subscription would re-render.
    const remote = variant === 'partner' ? useAppStore.getState().partnerCharPos : null;

    /* ---------- status change: teleport with smoke ---------- */
    if (s.status !== status) {
      s.status = status;
      s.dwell = 0;
      if (s.dragging) {
        // Carried: just adopt the status, no smoke.
      } else {
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
        s.sit = status === 'WORKING' ? 1 : 0;
        s.lie = status === 'SLEEPING' ? 1 : 0;
        s.phase = 'settle';
        s.tele = 'in';
        s.teleT = 0;
        firePuff(s.x, 0.55 + s.lie * 0.45, s.z);
      }
    } else if (s.tele === 'in') {
      s.teleT += dt;
      const p = Math.min(1, s.teleT / TELE_IN);
      // little overshoot pop on arrival
      s.scale = p < 1 ? p * (1 + 0.15 * Math.sin(p * Math.PI)) : 1;
      if (p >= 1) s.tele = 'none';
    }

    /* ---------- movement ---------- */
    let walking = false;
    if (s.dragging) {
      // Carried: hang the villager so their head-top tracks the cursor.
      frame.raycaster.setFromCamera(frame.pointer, frame.camera);
      const hit = frame.raycaster.ray.intersectPlane(GRAB_PLANE, TMP_VEC);
      if (hit) {
        s.x = damp(s.x, THREE.MathUtils.clamp(hit.x, -ROOM_CLAMP, ROOM_CLAMP), 20);
        s.z = damp(s.z, THREE.MathUtils.clamp(hit.z, -ROOM_CLAMP, ROOM_CLAMP), 20);
      }
      // Turn to face the viewer while held.
      s.yaw = dampAngle(
        s.yaw,
        Math.atan2(frame.camera.position.x - s.x, frame.camera.position.z - s.z),
        12,
        dt
      );
      s.sit = damp(s.sit, 0, 10);
      s.lie = damp(s.lie, 0, 10);
      s.scale = damp(s.scale, 1, 12);
    } else if (s.tele === 'none' && status === 'IDLE') {
      if (remote) {
        // Partner's villager mirrors the live stream from their client.
        const dist = Math.hypot(remote.x - s.x, remote.z - s.z);
        walking = !remote.carried && dist > 0.06;
        s.x = damp(s.x, remote.x, 12);
        s.z = damp(s.z, remote.z, 12);
        s.yaw = dampAngle(s.yaw, remote.yaw, 10, dt);
        if (walking) s.walkT += dt * 9;
        else s.walkT = damp(s.walkT % (Math.PI * 2), 0, 8);
      } else if (s.phase === 'walk') {
        // Wander: the only state that actually walks.
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
          s.walkT += dt * 9;
        } else {
          s.phase = 'settle';
        }
      } else {
        s.dwell += dt;
        if (s.dwell > 2.6) {
          s.dwell = 0;
          s.wp++;
          s.phase = 'walk';
        }
        s.walkT = damp(s.walkT % (Math.PI * 2), 0, 8);
      }
      s.sit = damp(s.sit, 0, 8);
      s.lie = damp(s.lie, 0, 8);
    } else if (s.tele === 'none') {
      // Posed status: hold the pose at the anchor; never walk.
      const dest = destinationFor(status, s, remote);
      s.x = damp(s.x, dest.x, 8);
      s.z = damp(s.z, dest.z, 8);
      if (dest.yaw !== null && s.lie < 0.5) s.yaw = dampAngle(s.yaw, dest.yaw, 8, dt);
      s.sit = damp(s.sit, status === 'WORKING' ? 1 : 0, 10);
      s.lie = damp(s.lie, status === 'SLEEPING' ? 1 : 0, 10);
      s.walkT = damp(s.walkT % (Math.PI * 2), 0, 8);
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
    const carried = s.dragging || (remote !== null && remote.carried && status === 'IDLE' && s.tele === 'none');
    const lieE = THREE.MathUtils.smoothstep(s.lie, 0, 1);
    const carryY = carried ? CARRY_LIFT + Math.sin(t * 3) * 0.03 : 0;
    root.current.position.set(s.x, carryY + lieE * LIE_RAISE + s.sit * SIT_RAISE, s.z);
    qStand.setFromAxisAngle(Y_AXIS, s.yaw);
    root.current.quaternion.copy(qStand).slerp(LIE_Q, lieE);
    root.current.scale.setScalar(Math.max(0.001, s.scale));

    /* ---------- limbs & secondary motion ---------- */
    const bob = walking ? Math.abs(Math.cos(s.walkT)) * 0.05 : Math.sin(t * 2.2) * 0.012;
    body.current.position.y = bob * (1 - lieE);

    const swing = walking ? Math.sin(s.walkT) * 0.5 : 0;
    // Carried: a proper protest — arms and legs flail until let go.
    const dangle = carried ? Math.sin(t * 8) * 0.45 : 0;
    const legPose = s.sit * -1.5;
    legL.current.rotation.x = damp(legL.current.rotation.x, swing + legPose + dangle, 12);
    legR.current.rotation.x = damp(legR.current.rotation.x, -swing + legPose - dangle, 12);

    const working = status === 'WORKING' && s.sit > 0.7 && !s.dragging;
    const armPoseL = working ? -1.05 + Math.sin(t * 10) * 0.08 : 0;
    const armPoseR = working ? -1.05 + Math.cos(t * 10 + 1) * 0.08 : 0;
    const armTarget = carried ? 0.4 + Math.sin(t * 9 + 0.6) * 0.5 : walking ? -swing * 0.7 : armPoseL;
    const armTargetR = carried ? 0.4 - Math.sin(t * 9) * 0.5 : walking ? swing * 0.7 : armPoseR;
    armL.current.rotation.x = damp(armL.current.rotation.x, armTarget, 12);
    armR.current.rotation.x = damp(armR.current.rotation.x, armTargetR, 12);
    // Negative Z splays the left arm outward (positive would fold it
    // across the chest); mirrored for the right.
    armL.current.rotation.z = damp(armL.current.rotation.z, carried ? -(0.55 + Math.cos(t * 7) * 0.2) : 0, 10);
    armR.current.rotation.z = damp(armR.current.rotation.z, carried ? 0.55 + Math.cos(t * 7 + 0.8) * 0.2 : 0, 10);

    torso.current.rotation.x = damp(
      torso.current.rotation.x,
      (walking ? 0.07 : 0) + s.sit * 0.06,
      10
    );
    const breathe = 1 + (s.lie > 0.8 ? Math.sin(t * 2) * 0.03 : 0.008 * Math.sin(t * 2.2));
    torso.current.scale.set(1, breathe, 1);

    head.current.rotation.y = damp(
      head.current.rotation.y,
      !walking && status === 'IDLE' && !s.dragging ? Math.sin(t * 0.6) * 0.5 : 0,
      6
    );
    eyes.current.scale.y = s.lie > 0.5 ? 0.1 : t % 3.4 < 0.12 ? 0.15 : 1;

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

    /* ---------- status picker anchor ---------- */
    if (pickerAnchor.current) {
      pickerAnchor.current.position.set(s.x, root.current.position.y + HEAD_TOP + 0.35, s.z);
    }

    /* ---------- speech bubble ---------- */
    const age = Date.now() - bubble.updatedAt;
    const bubbleVisible = bubble.text.length > 0 && age < BUBBLE_TTL;
    const fade = bubbleVisible ? Math.min(1, (BUBBLE_TTL - age) / 3000) : 0;
    bubbleMat.current.opacity = damp(bubbleMat.current.opacity, fade * s.scale, 8);
    const headY = root.current.position.y + (lieE > 0.5 ? 0.6 : 1.3);
    bubbleMesh.current.position.set(s.x, headY + 0.45, s.z);
    bubbleMesh.current.quaternion.copy(frame.camera.quaternion);
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
          {/* stubby legs (pivot at hips) */}
          {[
            { side: -1, ref: legL },
            { side: 1, ref: legR },
          ].map(({ side, ref }) => (
            <group key={side} ref={ref} position={[side * 0.11, 0.28, 0]}>
              <mesh position={[0, -0.11, 0]} castShadow>
                <cylinderGeometry args={[0.078, 0.072, 0.22, 12]} />
                <meshStandardMaterial color={look.legs} {...MAT} />
              </mesh>
              {/* cargo pocket on the outer thigh */}
              {!look.girl && (
                <RoundedBox
                  args={[0.045, 0.075, 0.09]}
                  radius={0.015}
                  position={[side * 0.085, -0.1, 0.015]}
                >
                  <meshStandardMaterial color="#3c3936" {...MAT} />
                </RoundedBox>
              )}
              <mesh position={[0, -0.23, 0.04]} scale={[1, 0.9, 1.15]} castShadow>
                <sphereGeometry args={[0.088, 14, 14]} />
                <meshStandardMaterial color={look.shoes} {...MAT} />
              </mesh>
            </group>
          ))}

          {/* round body: plain tee for the boy, floral dress for the girl */}
          <group ref={torso} position={[0, 0.5, 0]}>
            <RoundedBox args={[0.44, 0.42, 0.34]} radius={0.17} castShadow>
              {look.girl ? (
                <meshStandardMaterial map={getFloral()} {...MAT} />
              ) : (
                <meshStandardMaterial color={look.shirt} {...MAT} />
              )}
            </RoundedBox>
          </group>

          {/* skirt — kept outside the torso so breathing doesn't stretch it */}
          {look.girl && (
            <mesh position={[0, 0.36, 0]} castShadow>
              <cylinderGeometry args={[0.21, 0.36, 0.3, 24, 1, true]} />
              <meshStandardMaterial map={getFloral()} side={THREE.DoubleSide} {...MAT} />
            </mesh>
          )}

          {/* short arms with mitten hands (pivot at shoulders) */}
          {[
            { side: -1, ref: armL },
            { side: 1, ref: armR },
          ].map(({ side, ref }) => (
            <group key={side} ref={ref} position={[side * 0.25, 0.66, 0]}>
              <mesh position={[0, -0.1, 0]} castShadow>
                <cylinderGeometry args={[0.058, 0.052, 0.2, 10]} />
                <meshStandardMaterial color={look.sleeve} {...MAT} />
              </mesh>
              <mesh position={[0, -0.22, 0]} scale={[0.95, 1, 0.85]} castShadow>
                <sphereGeometry args={[0.07, 14, 14]} />
                <meshStandardMaterial color={SKIN} {...MAT} />
              </mesh>
            </group>
          ))}

          {/* oversized head — the Animal-Crossing signature */}
          <group ref={head} position={[0, 1.0, 0]}>
            <mesh castShadow>
              <sphereGeometry args={[0.34, 24, 24]} />
              <meshStandardMaterial color={SKIN} {...MAT} />
            </mesh>

            {look.girl ? (
              <>
                {/* bob: crown, side locks framing the face, back volume */}
                <mesh position={[0, 0.04, -0.01]} scale={[1.05, 1.02, 1.06]} castShadow>
                  <sphereGeometry args={[0.34, 24, 24, 0, Math.PI * 2, 0, Math.PI / 1.85]} />
                  <meshStandardMaterial color={look.hair} {...MAT} />
                </mesh>
                {[-1, 1].map((side) => (
                  <mesh
                    key={side}
                    position={[side * 0.28, -0.04, 0.0]}
                    scale={[0.6, 1.45, 0.95]}
                    castShadow
                  >
                    <sphereGeometry args={[0.17, 14, 14]} />
                    <meshStandardMaterial color={look.hair} {...MAT} />
                  </mesh>
                ))}
                <mesh position={[0, -0.05, -0.13]} scale={[1, 1.12, 0.85]} castShadow>
                  <sphereGeometry args={[0.3, 18, 18]} />
                  <meshStandardMaterial color={look.hair} {...MAT} />
                </mesh>
                <mesh position={[0, 0.15, 0.21]} scale={[1.5, 0.55, 0.75]}>
                  <sphereGeometry args={[0.2, 16, 16]} />
                  <meshStandardMaterial color={look.hair} {...MAT} />
                </mesh>
                {/* flower clip */}
                <group position={[0.26, 0.2, 0.16]}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <mesh
                      key={i}
                      position={[
                        Math.cos((i / 5) * Math.PI * 2) * 0.052,
                        Math.sin((i / 5) * Math.PI * 2) * 0.052,
                        0,
                      ]}
                    >
                      <sphereGeometry args={[0.034, 8, 8]} />
                      <meshStandardMaterial color={look.accent} {...MAT} />
                    </mesh>
                  ))}
                  <mesh position={[0, 0, 0.02]}>
                    <sphereGeometry args={[0.028, 8, 8]} />
                    <meshStandardMaterial color="#ffd166" {...MAT} />
                  </mesh>
                </group>
              </>
            ) : (
              <>
                {/* mullet: short crown + swept fringe, long in the back */}
                <mesh position={[0, 0.05, -0.02]} scale={[1.04, 1, 1.05]} castShadow>
                  <sphereGeometry args={[0.34, 24, 24, 0, Math.PI * 2, 0, Math.PI / 2.15]} />
                  <meshStandardMaterial color={look.hair} {...MAT} />
                </mesh>
                <mesh
                  position={[-0.04, 0.18, 0.19]}
                  rotation={[0, 0, 0.35]}
                  scale={[1.5, 0.5, 0.7]}
                  castShadow
                >
                  <sphereGeometry args={[0.2, 16, 16]} />
                  <meshStandardMaterial color={look.hair} {...MAT} />
                </mesh>
                <mesh position={[0, -0.16, -0.21]} scale={[0.85, 1.35, 0.45]} castShadow>
                  <sphereGeometry args={[0.22, 14, 14]} />
                  <meshStandardMaterial color={look.hair} {...MAT} />
                </mesh>
                {/* rectangular glasses: framed lenses, bridge, temple arms */}
                <group position={[0, 0.02, 0.325]}>
                  {[-1, 1].map((side) => (
                    <group key={side} position={[side * 0.12, 0, 0]}>
                      {[0.06, -0.06].map((y) => (
                        <mesh key={y} position={[0, y, 0]}>
                          <boxGeometry args={[0.14, 0.014, 0.014]} />
                          <meshStandardMaterial color={GLASSES} roughness={0.4} />
                        </mesh>
                      ))}
                      {[-0.063, 0.063].map((x) => (
                        <mesh key={x} position={[x, 0, 0]}>
                          <boxGeometry args={[0.014, 0.134, 0.014]} />
                          <meshStandardMaterial color={GLASSES} roughness={0.4} />
                        </mesh>
                      ))}
                    </group>
                  ))}
                  <mesh position={[0, 0.035, 0]}>
                    <boxGeometry args={[0.1, 0.012, 0.013]} />
                    <meshStandardMaterial color={GLASSES} roughness={0.4} />
                  </mesh>
                  {[-1, 1].map((side) => (
                    <mesh
                      key={`arm${side}`}
                      position={[side * 0.24, 0.01, -0.16]}
                      rotation={[Math.PI / 2, 0, side * 0.25]}
                    >
                      <cylinderGeometry args={[0.009, 0.009, 0.3, 8]} />
                      <meshStandardMaterial color={GLASSES} roughness={0.4} />
                    </mesh>
                  ))}
                </group>
                {/* freckles across the cheeks and nose */}
                {FRECKLES.map(([fx, fy], i) => (
                  <mesh key={i} position={[fx, fy, 0.3]}>
                    <sphereGeometry args={[0.011, 6, 6]} />
                    <meshStandardMaterial color={FRECKLE} roughness={0.8} />
                  </mesh>
                ))}
              </>
            )}

            {/* big eyes with a highlight */}
            <group ref={eyes} position={[0, 0.0, 0.29]}>
              {[-0.12, 0.12].map((x) => (
                <group key={x} position={[x, 0.02, 0]}>
                  {/* boy's eyes sit a touch smaller so the frames enclose them */}
                  <mesh scale={look.girl ? [0.8, 1.3, 0.5] : [0.75, 1.05, 0.5]}>
                    <sphereGeometry args={[0.062, 16, 16]} />
                    <meshStandardMaterial color="#2c2320" roughness={0.3} />
                  </mesh>
                  <mesh position={[0.02, 0.035, 0.028]}>
                    <sphereGeometry args={[0.019, 8, 8]} />
                    <meshBasicMaterial color="#ffffff" />
                  </mesh>
                </group>
              ))}
            </group>

            {/* blush, nose, mouth */}
            {[-0.21, 0.21].map((x) => (
              <mesh key={x} position={[x, -0.09, 0.23]} scale={[1.3, 0.85, 1]}>
                <sphereGeometry args={[0.05, 10, 10]} />
                <meshStandardMaterial color="#f0a07f" transparent opacity={0.7} />
              </mesh>
            ))}
            <mesh position={[0, -0.04, 0.33]}>
              <sphereGeometry args={[0.023, 8, 8]} />
              <meshStandardMaterial color="#e6b28c" {...MAT} />
            </mesh>
            <mesh position={[0, -0.14, 0.31]} scale={[1.7, 0.75, 0.4]}>
              <sphereGeometry args={[0.03, 10, 10]} />
              <meshStandardMaterial color="#8a5040" roughness={0.5} />
            </mesh>
          </group>
        </group>
      </group>

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

      {/* status bubbles above the head while the speech input is open */}
      {variant === 'me' && (
        <group ref={pickerAnchor}>
          {pickerOpen && (
            <Html center zIndexRange={[15, 0]}>
              <div
                data-interactive
                className="flex items-center gap-1.5 rounded-full border border-white/60 bg-white/70 px-2 py-1.5 shadow-lg backdrop-blur-xl"
              >
                {STATUS_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => setMyStatus(o.value)}
                    title={o.label}
                    aria-label={o.label}
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-[15px] leading-none transition ${
                      myStatus === o.value
                        ? 'bg-sky-500/20 ring-2 ring-sky-400'
                        : 'opacity-60 hover:bg-slate-900/10 hover:opacity-100'
                    }`}
                  >
                    {o.icon}
                  </button>
                ))}
              </div>
            </Html>
          )}
        </group>
      )}

      {/* floating Zzz while asleep */}
      <mesh ref={zzz} raycast={() => undefined}>
        <planeGeometry args={[0.5, 0.25]} />
        <meshBasicMaterial ref={zzzMat} map={zzzTexture} transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* speech bubble */}
      <mesh ref={bubbleMesh} raycast={() => undefined}>
        <planeGeometry args={[1.05, 0.58]} />
        <meshBasicMaterial
          ref={bubbleMat}
          map={bubbleTexture}
          transparent
          opacity={0}
          depthWrite={false}
        />
      </mesh>
    </>
  );
}
