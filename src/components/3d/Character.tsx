import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { CharacterStatus, CharPos, Role, partnerOf, useAppStore } from '../../store/useAppStore';
import { setForceInteractive } from '../../lib/hitTest';
import { CURSOR, lockCursor, setCursor, unlockCursor } from '../../lib/cursors';
import racoonUrl from '../../assets/models/racoon.glb?url';
import monkeyUrl from '../../assets/models/monkey.glb?url';

/* ------------------------------------------------------------------ */
/* Model-based characters (racoon = USER_A, monkey = USER_B), driven  */
/* by rigid-body procedural animation: the whole model hops when      */
/* walking, perches to sit, lies down, and rocks when carried. The    */
/* models ship without animation clips, so nothing is skeletal.       */
/*                                                                    */
/* Statuses teleport via two puffs of smoke rather than walking onto  */
/* furniture; only IDLE walks (wander between open-floor waypoints).  */
/*                                                                    */
/* Interactions (own character only):                                 */
/*   click          -> opens the speech-bubble input                  */
/*   click + drag   -> pick the character up and carry them around    */
/* ------------------------------------------------------------------ */

const WALK_SPEED = 1.05;

interface ModelSpec {
  url: string;
  /** Normalised world height of the character. */
  height: number;
  /** Extra yaw if the source model doesn't face +z. */
  yaw: number;
}

const MODELS: Record<Role, ModelSpec> = {
  USER_A: { url: racoonUrl, height: 1.15, yaw: 0 },
  USER_B: { url: monkeyUrl, height: 1.05, yaw: 0 },
};

useGLTF.preload(racoonUrl);
useGLTF.preload(monkeyUrl);

/**
 * The monkey ships rigged (48 joints, no clips), so its limbs are driven
 * procedurally: rest pose captured at load, swing applied per-frame about
 * this bone-local axis. If a limb hinges the wrong way on a rig, flip the
 * axis or sign here — one line, no re-export.
 */
const BONE_AXIS = new THREE.Vector3(1, 0, 0);
const MONKEY_BONES = {
  armL: 'arm_L_a_06',
  armR: 'arm_R_a_017',
  legL: 'leg_L_a_033',
  legR: 'leg_R_a_037',
  head: 'head_028',
  tail: ['tail_a_041', 'tail_b_042', 'tail_c_043', 'tail_d_044', 'tail_e_045', 'tail_f_046'],
};

interface BoneRig {
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
  head?: THREE.Object3D;
  tail: THREE.Object3D[];
}

/** Reset to rest pose, then swing about the configured bone-local axis. */
function swingBone(bone: THREE.Object3D | undefined, angle: number): void {
  if (!bone) return;
  const rest = bone.userData.restQ as THREE.Quaternion | undefined;
  if (!rest) return;
  bone.quaternion.copy(rest);
  if (angle !== 0) bone.rotateOnAxis(BONE_AXIS, angle);
}

const SIT_RAISE = 0.5; // perch the model onto the chair seat
const LIE_RAISE = 1.0; // onto the mattress top
const TELE_OUT = 0.25;
const TELE_IN = 0.3;
const BUBBLE_TTL = 30_000;
const ROOM_CLAMP = 2.9;
const CARRY_LIFT = 0.4;

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

/** Orientation for lying on the back: head toward -x, face up. */
const LIE_Q = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0)
  )
);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
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
  // The model follows the *role*, not who is looking: A is always the racoon.
  const role = useAppStore((s) => (variant === 'me' ? s.role : partnerOf(s.role)));
  const model = MODELS[role];

  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const zzz = useRef<THREE.Mesh>(null!);
  const zzzMat = useRef<THREE.MeshBasicMaterial>(null!);
  const bubbleMesh = useRef<THREE.Mesh>(null!);
  const bubbleMat = useRef<THREE.MeshBasicMaterial>(null!);
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

  /* ---------------- model loading & normalisation ---------------- */
  const { scene } = useGLTF(model.url);
  const fitted = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = model.height / Math.max(size.y, 0.001);
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.frustumCulled = false; // skinned bounds can be wrong mid-animation
      }
    });
    return { scale, offset: [-center.x, -box.min.y, -center.z] as const };
  }, [scene, model.height]);

  /** Bone handles for the rigged monkey; null for the unrigged racoon. */
  const rig = useMemo<BoneRig | null>(() => {
    const capture = (name: string) => {
      const bone = scene.getObjectByName(name);
      if (bone) bone.userData.restQ = bone.quaternion.clone();
      return bone ?? undefined;
    };
    const armL = capture(MONKEY_BONES.armL);
    if (!armL) return null; // not the rigged model
    const tail: THREE.Object3D[] = [];
    for (const n of MONKEY_BONES.tail) {
      const b = capture(n);
      if (b) tail.push(b);
    }
    return {
      armL,
      armR: capture(MONKEY_BONES.armR),
      legL: capture(MONKEY_BONES.legL),
      legR: capture(MONKEY_BONES.legR),
      head: capture(MONKEY_BONES.head),
      tail,
    };
  }, [scene]);
  /** Smoothed limb angles so pose changes never snap. */
  const limbs = useRef({ armL: 0, armR: 0, legL: 0, legR: 0, head: 0 });

  /**
   * The grab plane sits at the model's head-top height so the crown of
   * the head tracks the cursor while carried.
   */
  const grabPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, 1, 0), -(CARRY_LIFT + model.height)),
    [model.height]
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
        // A carried character stops holding furniture poses.
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
      // Carried: hang the character so their head-top tracks the cursor.
      frame.raycaster.setFromCamera(frame.pointer, frame.camera);
      const hit = frame.raycaster.ray.intersectPlane(grabPlane, TMP_VEC);
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
        // Partner's character mirrors the live stream from their client.
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
    const carried =
      s.dragging || (remote !== null && remote.carried && status === 'IDLE' && s.tele === 'none');
    const lieE = THREE.MathUtils.smoothstep(s.lie, 0, 1);
    const carryY = carried ? CARRY_LIFT + Math.sin(t * 3) * 0.03 : 0;
    root.current.position.set(s.x, carryY + lieE * LIE_RAISE + s.sit * SIT_RAISE, s.z);
    qStand.setFromAxisAngle(Y_AXIS, s.yaw);
    root.current.quaternion.copy(qStand).slerp(LIE_Q, lieE);
    root.current.scale.setScalar(Math.max(0.001, s.scale));

    /* ---------- body motion ---------- */
    const working = status === 'WORKING' && s.sit > 0.7;
    const hop = walking ? Math.abs(Math.sin(s.walkT)) * (rig ? 0.045 : 0.08) : 0;
    const typing = working ? Math.abs(Math.sin(t * 9)) * 0.015 : 0;
    body.current.position.y = (hop + typing + Math.sin(t * 2.2) * 0.008) * (1 - lieE);
    // walk waddle / carried rocking protest
    const waddle = walking ? Math.sin(s.walkT) * (rig ? 0.05 : 0.08) : 0;
    const rock = carried ? Math.sin(t * 8) * 0.14 : 0;
    body.current.rotation.z = damp(body.current.rotation.z, waddle + rock, 12);
    body.current.rotation.x = damp(
      body.current.rotation.x,
      (walking ? 0.06 : 0) + (carried ? 0.12 : 0) + s.sit * -0.08,
      10
    );
    // breathing (gentle upright, deep while asleep) + squash-and-stretch
    // landing compression for the unrigged racoon so its gait reads alive
    const breathe = 1 + (s.lie > 0.8 ? Math.sin(t * 2) * 0.03 : 0.006 * Math.sin(t * 2.2));
    const squash = !rig && walking ? 1 - 0.11 * (1 - Math.abs(Math.sin(s.walkT))) : 1;
    const jiggle = !rig && carried ? 1 + Math.sin(t * 8) * 0.04 : 1;
    const sy = breathe * squash * jiggle;
    const sxz = 1 + (1 - sy) * 0.55;
    body.current.scale.set(sxz, sy, sxz);

    /* ---------- skeletal limbs (rigged monkey only) ---------- */
    if (rig) {
      const L = limbs.current;
      const swing = walking ? Math.sin(s.walkT) * 0.65 : 0;
      // carried: flail; working: arms reach forward with a typing wiggle
      const armPose = carried
        ? 0.5 + Math.sin(t * 9) * 0.55
        : working
          ? -0.9 + Math.sin(t * 10) * 0.1
          : 0;
      const armPoseR = carried
        ? 0.5 - Math.sin(t * 9 + 0.7) * 0.55
        : working
          ? -0.9 + Math.cos(t * 10 + 1) * 0.1
          : 0;
      const legPose = carried ? Math.sin(t * 8) * 0.5 : s.sit > 0.05 ? -1.1 * s.sit : 0;
      const legPoseR = carried ? -Math.sin(t * 8) * 0.5 : s.sit > 0.05 ? -1.1 * s.sit : 0;
      L.armL = damp(L.armL, walking ? -swing * 0.8 : armPose, 12);
      L.armR = damp(L.armR, walking ? swing * 0.8 : armPoseR, 12);
      L.legL = damp(L.legL, walking ? swing : legPose, 12);
      L.legR = damp(L.legR, walking ? -swing : legPoseR, 12);
      L.head = damp(
        L.head,
        walking ? Math.sin(s.walkT * 2) * 0.05 : status === 'IDLE' && !carried ? Math.sin(t * 0.6) * 0.25 : 0,
        8
      );
      swingBone(rig.armL, L.armL);
      swingBone(rig.armR, L.armR);
      swingBone(rig.legL, L.legL);
      swingBone(rig.legR, L.legR);
      swingBone(rig.head, L.head);
      // tail: a travelling wave, calmer when asleep
      const tailAmp = s.lie > 0.8 ? 0.05 : carried ? 0.22 : 0.12;
      rig.tail.forEach((bone, i) => {
        swingBone(bone, Math.sin(t * 2.6 + i * 0.55) * tailAmp);
      });
    }

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

    /* ---------- speech bubble ---------- */
    const age = Date.now() - bubble.updatedAt;
    const bubbleVisible = bubble.text.length > 0 && age < BUBBLE_TTL;
    const fade = bubbleVisible ? Math.min(1, (BUBBLE_TTL - age) / 3000) : 0;
    bubbleMat.current.opacity = damp(bubbleMat.current.opacity, fade * s.scale, 8);
    const headY = root.current.position.y + (lieE > 0.5 ? 0.5 : model.height);
    bubbleMesh.current.position.set(s.x, headY + 0.5, s.z);
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
          <group scale={fitted.scale} rotation={[0, model.yaw, 0]}>
            <primitive
              object={scene}
              position={[fitted.offset[0], fitted.offset[1], fitted.offset[2]]}
            />
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
