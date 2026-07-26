import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { Html, RoundedBox } from '@react-three/drei';
import { PAIR_CODE_MAX, useAppStore } from '../../store/useAppStore';
import { registerHitTest, setForceInteractive } from '../../lib/hitTest';
import { renderStrokes } from '../../lib/strokes';
import { panBy, savePan } from '../../lib/pan';
import { CURSOR, CursorSpec, lockCursor, setCursor, unlockCursor } from '../../lib/cursors';
import Character from './Character';
import Prop from './Prop';
import djungelskogUrl from '../../assets/models/djungelskog.glb?url';

/* ------------------------------------------------------------------ */
/* Palette — tuned to the cozy teal/wood/orange reference render      */
/* ------------------------------------------------------------------ */

const P = {
  wallTeal: '#2a9184',
  wallTealSide: '#238073',
  pink: '#f2a8bd',
  brown: '#9c6b4a',
  brownLight: '#b07f5c',
  beige: '#e8d5b0',
  woodTrim: '#d9a563',
  woodMid: '#c99a5f',
  floorBase: '#d3a05e',
  plankTones: ['#ecc98f', '#e3bd80', '#f0d09a'],
  cream: '#f6ecca',
  creamSoft: '#efe2ba',
  white: '#f9f4e8',
  orange: '#ee7d3c',
  orangeSoft: '#f4a259',
  yellow: '#ffd166',
  sage: '#a9c4a0',
  teal: '#7fb8a8',
  leaf: '#4f9068',
  leafDark: '#3e7d5a',
  metal: '#8a7a66',
};

const CLAY = { roughness: 0.85, metalness: 0.05 };

/* ------------------------------------------------------------------ */
/* Interactive wrapper: hover glow + springy scale bounce             */
/* ------------------------------------------------------------------ */

interface InteractiveProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scaleAmount?: number;
  cursor?: CursorSpec;
  onSelect?: () => void;
  onDragStart?: (e: ThreeEvent<PointerEvent>) => void;
  children: (hovered: boolean) => ReactNode;
}

function Interactive({
  position,
  rotation,
  scaleAmount = 1.07,
  cursor = CURSOR.pointer,
  onSelect,
  onDragStart,
  children,
}: InteractiveProps) {
  const group = useRef<THREE.Group>(null!);
  const [hovered, setHovered] = useState(false);
  const spring = useRef({ value: 1, velocity: 0 });

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const target = hovered ? scaleAmount : 1;
    const sp = spring.current;
    sp.velocity += (target - sp.value) * 180 * dt;
    sp.velocity *= Math.exp(-14 * dt);
    sp.value += sp.velocity * dt;
    group.current?.scale.setScalar(sp.value);
  });

  return (
    <group
      ref={group}
      position={position}
      rotation={rotation}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        setCursor(cursor);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHovered(false);
        setCursor(CURSOR.default);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
      onPointerDown={(e) => {
        if (onDragStart && e.button === 0) {
          e.stopPropagation();
          onDragStart(e);
        }
      }}
    >
      {children(hovered)}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Lighting: bright soft "clay render" day, cozy lamp-lit night       */
/* ------------------------------------------------------------------ */

function SceneLights() {
  const isNight = useAppStore((s) => s.isNightMode);
  const amb = useRef<THREE.AmbientLight>(null!);
  const hemi = useRef<THREE.HemisphereLight>(null!);
  const dir = useRef<THREE.DirectionalLight>(null!);
  const colors = useMemo(
    () => ({
      dayAmbient: new THREE.Color('#fff4e4'),
      nightAmbient: new THREE.Color('#31406e'),
      dayDir: new THREE.Color('#ffe8c8'),
      nightDir: new THREE.Color('#5c6da8'),
    }),
    []
  );

  useFrame((_, delta) => {
    const t = 1 - Math.exp(-Math.min(delta, 0.05) * 5);
    amb.current.intensity += ((isNight ? 0.2 : 0.62) - amb.current.intensity) * t;
    hemi.current.intensity += ((isNight ? 0.1 : 0.45) - hemi.current.intensity) * t;
    dir.current.intensity += ((isNight ? 0.12 : 1.05) - dir.current.intensity) * t;
    amb.current.color.lerp(isNight ? colors.nightAmbient : colors.dayAmbient, t);
    dir.current.color.lerp(isNight ? colors.nightDir : colors.dayDir, t);
  });

  return (
    <>
      <ambientLight ref={amb} intensity={0.62} />
      <hemisphereLight ref={hemi} args={['#fffdf5', '#e0b878', 0.45]} />
      <directionalLight
        ref={dir}
        castShadow
        position={[6, 10, 4]}
        intensity={1.05}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-near={1}
        shadow-camera-far={30}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Floor: wood plank platform (window drag handle)                    */
/* ------------------------------------------------------------------ */

interface Plank {
  key: string;
  x: number;
  z: number;
  w: number;
  tone: string;
}

function buildPlanks(): Plank[] {
  const planks: Plank[] = [];
  const rows = 8;
  const depth = 0.775;
  for (let i = 0; i < rows; i++) {
    const z = -2.71 + i * depth;
    // Alternating seam position gives the staggered-plank look.
    const seam = i % 2 === 0 ? 0.9 : -1.1;
    const segments: Array<[number, number]> = [
      [-3.1, seam - 0.04],
      [seam + 0.04, 3.1],
    ];
    segments.forEach(([x0, x1], j) => {
      planks.push({
        key: `${i}-${j}`,
        x: (x0 + x1) / 2,
        z,
        w: x1 - x0,
        tone: P.plankTones[(i * 2 + j) % 3],
      });
    });
  }
  return planks;
}

function FloorPlatform() {
  const planks = useMemo(buildPlanks, []);
  return (
    <Interactive
      scaleAmount={1.008}
      cursor={CURSOR.open}
      onDragStart={(e) => {
        // Pan the room within the screen-sized window (the window
        // itself no longer moves).
        setForceInteractive(true);
        lockCursor(CURSOR.grab);
        let lastX = e.clientX;
        let lastY = e.clientY;
        const onMove = (ev: PointerEvent) => {
          panBy(ev.clientX - lastX, ev.clientY - lastY);
          lastX = ev.clientX;
          lastY = ev.clientY;
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          setForceInteractive(false);
          unlockCursor();
          setCursor(CURSOR.open);
          savePan();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }}
    >
      {(hovered) => (
        <>
          {/* The slab is the only pointer target down here: the planks and
              rug opt out of raycasting so the gaps between boards can't
              drop the ray through and flicker hover on and off. */}
          <RoundedBox args={[6.4, 0.3, 6.4]} radius={0.08} position={[0, -0.15, 0]} receiveShadow>
            <meshStandardMaterial color={P.floorBase} {...CLAY} />
          </RoundedBox>
          {planks.map((p) => (
            <RoundedBox
              key={p.key}
              args={[p.w, 0.1, 0.7]}
              radius={0.03}
              position={[p.x, 0.02, p.z]}
              receiveShadow
              raycast={() => null}
            >
              <meshStandardMaterial
                color={p.tone}
                {...CLAY}
                emissive={hovered ? '#ffcf8a' : '#000000'}
                emissiveIntensity={0.08}
              />
            </RoundedBox>
          ))}
          <CircularRug />
        </>
      )}
    </Interactive>
  );
}

/* ------------------------------------------------------------------ */
/* Circular layered rug at the room's open center                     */
/* ------------------------------------------------------------------ */

function CircularRug() {
  return (
    <group position={[0.3, 0, 0.3]}>
      <mesh position={[0, 0.1, 0]} receiveShadow raycast={() => null}>
        <cylinderGeometry args={[1.7, 1.7, 0.05, 56]} />
        <meshStandardMaterial color={P.teal} {...CLAY} />
      </mesh>
      <mesh position={[0, 0.13, 0]} receiveShadow raycast={() => null}>
        <cylinderGeometry args={[1.26, 1.26, 0.045, 56]} />
        <meshStandardMaterial color={P.cream} {...CLAY} />
      </mesh>
      <mesh position={[0, 0.155, 0]} receiveShadow raycast={() => null}>
        <cylinderGeometry args={[0.63, 0.63, 0.04, 40]} />
        <meshStandardMaterial color={P.orangeSoft} {...CLAY} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Walls: teal with wood trim; the left wall has a real opening —     */
/* the window's faint glass pane tints the actual desktop showing     */
/* through the transparent canvas.                                    */
/* ------------------------------------------------------------------ */

const WIN = { yBottom: 1.75, yTop: 2.85, zHalf: 0.75 };

function Walls() {
  const sideH = WIN.yTop - WIN.yBottom;
  const sideLen = 3.2 - WIN.zHalf;
  return (
    <group>
      {/* back wall */}
      <mesh position={[0, 1.55, -3.32]} receiveShadow>
        <boxGeometry args={[6.4, 3.4, 0.25]} />
        <meshStandardMaterial color={P.wallTeal} {...CLAY} />
      </mesh>
      {/* left wall, built around the window opening */}
      <mesh position={[-3.32, (WIN.yBottom - 0.15) / 2, 0]} receiveShadow>
        <boxGeometry args={[0.25, WIN.yBottom + 0.15, 6.4]} />
        <meshStandardMaterial color={P.wallTealSide} {...CLAY} />
      </mesh>
      <mesh position={[-3.32, (WIN.yTop + 3.25) / 2, 0]} receiveShadow>
        <boxGeometry args={[0.25, 3.25 - WIN.yTop, 6.4]} />
        <meshStandardMaterial color={P.wallTealSide} {...CLAY} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[-3.32, (WIN.yBottom + WIN.yTop) / 2, side * (WIN.zHalf + sideLen / 2)]}
          receiveShadow
        >
          <boxGeometry args={[0.25, sideH, sideLen]} />
          <meshStandardMaterial color={P.wallTealSide} {...CLAY} />
        </mesh>
      ))}
      {/* top trim: two beams butted flush against a shared corner block,
          all one colour so the run reads as a single piece */}
      <RoundedBox args={[0.5, 0.3, 0.5]} radius={0.05} position={[-3.32, 3.35, -3.32]} castShadow>
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[6.495, 0.3, 0.5]} radius={0.05} position={[0.1775, 3.35, -3.32]} castShadow>
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[0.5, 0.3, 6.495]} radius={0.05} position={[-3.32, 3.35, 0.1775]} castShadow>
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </RoundedBox>
    </group>
  );
}

function OpenWindow() {
  const midY = (WIN.yBottom + WIN.yTop) / 2;
  return (
    <group position={[-3.24, midY, 0]} rotation={[0, Math.PI / 2, 0]}>
      {/* frame border */}
      <RoundedBox args={[1.74, 0.14, 0.14]} radius={0.04} position={[0, 0.62, 0]} castShadow>
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[1.9, 0.16, 0.26]} radius={0.05} position={[0, -0.62, 0.02]} castShadow>
        <meshStandardMaterial color={P.woodMid} {...CLAY} />
      </RoundedBox>
      {[-0.8, 0.8].map((x) => (
        <RoundedBox key={x} args={[0.14, 1.36, 0.14]} radius={0.04} position={[x, 0, 0]} castShadow>
          <meshStandardMaterial color={P.woodTrim} {...CLAY} />
        </RoundedBox>
      ))}
      {/* thin cross bars */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.05, 1.24, 0.06]} />
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[1.5, 0.05, 0.06]} />
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </mesh>
      {/* glassmorphism pane: a faint tint over the real desktop behind
          the window, with two soft diagonal glints */}
      <mesh position={[0, 0, -0.01]}>
        <planeGeometry args={[1.56, 1.22]} />
        <meshStandardMaterial
          color="#dff3ef"
          transparent
          opacity={0.16}
          roughness={0.15}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[-0.28, 0.18, 0.005]} rotation={[0, 0, 0.6]}>
        <planeGeometry args={[0.85, 0.1]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.18} depthWrite={false} />
      </mesh>
      <mesh position={[0.22, -0.14, 0.005]} rotation={[0, 0, 0.6]}>
        <planeGeometry args={[0.5, 0.06]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.14} depthWrite={false} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Desk restyled as the sage sideboard with cream drawers             */
/* ------------------------------------------------------------------ */

function Desk() {
  const legs: Array<[number, number]> = [
    [-1.45, -0.5],
    [1.45, -0.5],
    [-1.45, 0.5],
    [1.45, 0.5],
  ];
  return (
    <group position={[0.1, 0, -2.15]}>
      <RoundedBox args={[3.7, 0.18, 1.5]} radius={0.06} position={[0, 1.42, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[3.3, 0.88, 1.25]} radius={0.09} position={[0, 0.88, 0]} castShadow>
        <meshStandardMaterial color={P.sage} {...CLAY} />
      </RoundedBox>
      {/* drawer fronts + knobs */}
      {[-0.78, 0.78].map((x) => (
        <group key={x} position={[x, 0.88, 0.62]}>
          <RoundedBox args={[1.35, 0.6, 0.07]} radius={0.05}>
            <meshStandardMaterial color={P.cream} {...CLAY} />
          </RoundedBox>
          <mesh position={[0, 0, 0.06]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.06, 16]} />
            <meshStandardMaterial color={P.woodMid} {...CLAY} />
          </mesh>
        </group>
      ))}
      {legs.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.22, z]} castShadow>
          <cylinderGeometry args={[0.08, 0.1, 0.44, 16]} />
          <meshStandardMaterial color={P.woodMid} {...CLAY} />
        </mesh>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Twin-bell alarm clock on the desk (face is a live CanvasTexture)   */
/* ------------------------------------------------------------------ */

function ClockScreen({
  position,
  size,
}: {
  position: [number, number, number];
  size: [number, number];
}) {
  // Aspect matches the screen plane so digits render undistorted.
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 138;
    return c;
  }, []);
  const texture = useMemo(() => new THREE.CanvasTexture(canvas), [canvas]);
  const lastDraw = useRef(0);

  useFrame(({ clock }) => {
    if (clock.elapsedTime - lastDraw.current < 0.25) return;
    lastDraw.current = clock.elapsedTime;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // White face, black digits, pink progress bar — matches the timer menu.
    const { timer } = useAppStore.getState();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 138);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const remaining =
      timer.isRunning && timer.endsAt !== null
        ? Math.max(0, timer.endsAt - Date.now())
        : timer.remainingMs;
    const fullMs = (timer.mode === 'WORK' ? timer.workMin : timer.breakMin) * 60_000;
    const timerVisible = timer.isRunning || remaining < fullMs;

    ctx.fillStyle = '#1a1a1a';
    if (timerVisible) {
      const mm = String(Math.floor(remaining / 60_000)).padStart(2, '0');
      const ss = String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0');
      ctx.font = 'bold 74px Menlo, monospace';
      ctx.fillText(`${mm}:${ss}`, 128, 56);
      ctx.fillStyle = '#f2eaec';
      ctx.fillRect(24, 104, 208, 14);
      ctx.fillStyle = '#f9c1d0';
      ctx.fillRect(24, 104, 208 * (fullMs > 0 ? remaining / fullMs : 0), 14);
    } else {
      const now = new Date();
      const colon = now.getSeconds() % 2 === 0 ? ':' : ' ';
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      ctx.font = 'bold 80px Menlo, monospace';
      ctx.fillText(`${hh}${colon}${min}`, 128, 69);
    }
    texture.needsUpdate = true;
  });

  return (
    <mesh position={position}>
      <planeGeometry args={size} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

function AlarmClock() {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  return (
    <Interactive position={[-0.95, 1.51, -2.25]} rotation={[0, 0.35, 0]} onSelect={() => setActiveModal('TIMER')}>
      {(hovered) => (
        <>
          {/* feet */}
          {[-0.24, 0.24].map((x) => (
            <mesh key={x} position={[x, 0.04, 0.05]} castShadow>
              <cylinderGeometry args={[0.045, 0.055, 0.08, 12]} />
              <meshStandardMaterial color={P.woodMid} {...CLAY} />
            </mesh>
          ))}
          {/* body */}
          <RoundedBox args={[0.78, 0.5, 0.36]} radius={0.1} position={[0, 0.32, 0]} castShadow>
            <meshStandardMaterial
              color={P.orange}
              {...CLAY}
              emissive={hovered ? '#ff9d5c' : '#000000'}
              emissiveIntensity={0.35}
            />
          </RoundedBox>
          {/* bezel + digital face */}
          <RoundedBox args={[0.62, 0.36, 0.05]} radius={0.05} position={[0, 0.32, 0.17]}>
            <meshStandardMaterial color={P.cream} {...CLAY} />
          </RoundedBox>
          <ClockScreen position={[0, 0.32, 0.2]} size={[0.52, 0.28]} />
          {/* twin bells + striker */}
          {[-0.17, 0.17].map((x) => (
            <group key={x} position={[x, 0.61, 0]} rotation={[0, 0, -x * 0.9]}>
              <mesh castShadow>
                <sphereGeometry args={[0.1, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
                <meshStandardMaterial color="#e0b25c" metalness={0.4} roughness={0.35} />
              </mesh>
              <mesh position={[0, 0.02, 0]}>
                <sphereGeometry args={[0.025, 8, 8]} />
                <meshStandardMaterial color={P.woodMid} {...CLAY} />
              </mesh>
            </group>
          ))}
          <mesh position={[0, 0.62, 0]} castShadow>
            <sphereGeometry args={[0.035, 10, 10]} />
            <meshStandardMaterial color={P.metal} metalness={0.5} roughness={0.4} />
          </mesh>
        </>
      )}
    </Interactive>
  );
}

/* ------------------------------------------------------------------ */
/* Open notebook (orange cover, cream pages)                          */
/* ------------------------------------------------------------------ */

function Notebook3D() {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const myNotes = useAppStore((s) => s.myNotes);
  const partnerNotes = useAppStore((s) => s.partnerNotes);

  /* The scribbles MIRROR what is actually written: left page is your notes,
     right page your partner's, matching the notebook panel's two-page spread.
     A blank line leaves its row empty and each line's length sets how far its
     scribble runs, so the desk reads like the page you typed. */
  const scribbles = useMemo(() => {
    const ROWS = 7; // rows that fit a page
    const PER_ROW = 34; // characters before writing wraps to the next row
    const RUN = 0.38; // width of a full row of writing

    const rowsOf = (text: string): string[] => {
      const rows: string[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) {
          rows.push(''); // blank line stays blank
          continue;
        }
        for (let i = 0; i < line.length; i += PER_ROW) rows.push(line.slice(i, i + PER_ROW));
      }
      return rows.slice(0, ROWS);
    };

    const build = (text: string, pageX: number, tag: string) =>
      rowsOf(text).flatMap((row, i) => {
        const len = row.trim().length;
        if (!len) return [];
        const key = `${tag}-${i}`;
        const w = Math.max(0.05, RUN * Math.min(1, len / PER_ROW));
        return [
          {
            key,
            x: pageX - RUN / 2 + w / 2 + (seeded(key, 4) - 0.5) * 0.012,
            z: -0.27 + i * 0.09 + (seeded(key, 5) - 0.5) * 0.01,
            w,
            rot: (seeded(key, 6) - 0.5) * 0.05,
          },
        ];
      });

    return [...build(myNotes, -0.27, 'me'), ...build(partnerNotes, 0.27, 'partner')];
  }, [myNotes, partnerNotes]);

  return (
    <Interactive
      position={[0.35, 1.51, -1.95]}
      rotation={[0, -0.35, 0]}
      onSelect={() => setActiveModal('NOTEBOOK')}
    >
      {(hovered) => (
        <>
          <RoundedBox args={[1.15, 0.06, 0.82]} radius={0.03} position={[0, 0.03, 0]} castShadow>
            <meshStandardMaterial
              color={P.orange}
              {...CLAY}
              emissive={hovered ? '#ff9d5c' : '#000000'}
              emissiveIntensity={0.3}
            />
          </RoundedBox>
          <mesh position={[-0.27, 0.07, 0]} rotation={[0, 0, 0.05]}>
            <boxGeometry args={[0.52, 0.03, 0.74]} />
            <meshStandardMaterial color={P.cream} {...CLAY} />
          </mesh>
          <mesh position={[0.27, 0.07, 0]} rotation={[0, 0, -0.05]}>
            <boxGeometry args={[0.52, 0.03, 0.74]} />
            <meshStandardMaterial color={P.white} {...CLAY} />
          </mesh>
          {/* scribbled lines so the open pages read as written on */}
          {scribbles.map((l) => (
            <mesh
              key={l.key}
              position={[l.x, 0.086, l.z]}
              rotation={[-Math.PI / 2, 0, l.rot]}
            >
              <planeGeometry args={[l.w, 0.012]} />
              <meshStandardMaterial color="#7d6a52" transparent opacity={0.55} />
            </mesh>
          ))}
        </>
      )}
    </Interactive>
  );
}

/* ------------------------------------------------------------------ */
/* Corkboard + whiteboard, side by side above the desk (back wall)    */
/* ------------------------------------------------------------------ */

/** Stable pseudo-random in [0, 1) derived from a string id (FNV-1a). */
function seeded(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ */
/* Flags pinned to the corkboard                                      */
/* ------------------------------------------------------------------ */

/** Brass push pin, sized to whatever flag it holds up. */
function FlagPin({ width, height }: { width: number; height: number }) {
  return (
    <mesh position={[0, height / 2 - height * 0.1, width * 0.04]} castShadow>
      <sphereGeometry args={[width * 0.089, 12, 12]} />
      <meshStandardMaterial color="#d8c058" {...CLAY} />
    </mesh>
  );
}

/**
 * Tricolour: three equal vertical bands (the flag has been equal thirds since
 * 1853) at the 3:2 ratio. Hung so its top overlaps the board's bottom edge and
 * the rest falls free, with a slight tilt so it reads as pinned on by hand.
 */
function FrenchFlag({
  position,
  rotation = 0,
  width = 0.36,
}: {
  position: [number, number, number];
  rotation?: number;
  width?: number;
}) {
  const height = width / 1.5;
  const band = width / 3;
  const bands: Array<[string, number]> = [
    ['#0055a4', -band],
    ['#ffffff', 0],
    ['#ef4135', band],
  ];
  return (
    <group position={position} rotation={[0, 0, rotation]}>
      {bands.map(([color, x]) => (
        <mesh key={color} position={[x, 0, 0]}>
          <planeGeometry args={[band, height]} />
          <meshStandardMaterial color={color} {...CLAY} />
        </mesh>
      ))}
      <FlagPin width={width} height={height} />
    </group>
  );
}

/**
 * Right half of the 11-point maple leaf, top tip down to the stem, in a unit
 * box; the left half is this mirrored. Alternating outward points and inward
 * notches — five points a side plus the central tip make the canonical eleven.
 */
const MAPLE_HALF: Array<[number, number]> = [
  [0.0, 0.5],
  [0.07, 0.3],
  [0.18, 0.335],
  [0.145, 0.19],
  [0.4, 0.23],
  [0.345, 0.115],
  [0.47, -0.01],
  [0.3, -0.075],
  [0.33, -0.19],
  [0.13, -0.15],
  [0.15, -0.33],
  [0.045, -0.3],
  [0.045, -0.5],
];

/**
 * Maple leaf flag. Bands run 1:2:1 rather than the tricolour's thirds, and the
 * leaf sits in the white square. Sized to match the French flag rather than its
 * official 2:1 ratio, so the pair hangs as a set.
 */
function CanadaFlag({
  position,
  rotation = 0,
  width = 0.36,
}: {
  position: [number, number, number];
  rotation?: number;
  width?: number;
}) {
  const height = width / 1.5;
  const red = '#d52b1e';

  const leaf = useMemo(() => {
    const shape = new THREE.Shape();
    const s = height * 0.62; // leaf height, as a share of the flag's
    const pts = [
      ...MAPLE_HALF,
      // mirror back up the left side, skipping the shared stem-bottom point
      ...MAPLE_HALF.slice(0, -1)
        .reverse()
        .map(([x, y]) => [-x, y] as [number, number]),
    ];
    pts.forEach(([x, y], i) => {
      if (i === 0) shape.moveTo(x * s, y * s);
      else shape.lineTo(x * s, y * s);
    });
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }, [height]);

  return (
    <group position={position} rotation={[0, 0, rotation]}>
      {/* 1:2:1 — red quarter, white half, red quarter */}
      <mesh position={[-width * 0.375, 0, 0]}>
        <planeGeometry args={[width / 4, height]} />
        <meshStandardMaterial color={red} {...CLAY} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[width / 2, height]} />
        <meshStandardMaterial color="#ffffff" {...CLAY} />
      </mesh>
      <mesh position={[width * 0.375, 0, 0]}>
        <planeGeometry args={[width / 4, height]} />
        <meshStandardMaterial color={red} {...CLAY} />
      </mesh>
      <mesh geometry={leaf} position={[0, 0, 0.001]}>
        <meshStandardMaterial color={red} {...CLAY} />
      </mesh>
      <FlagPin width={width} height={height} />
    </group>
  );
}

/**
 * Dumbbell on the floor — the habit tracker's handle. Lies on its side, so the
 * plates carry it: the group rides at plate-radius above the plank tops (0.07)
 * to sit ON the boards rather than sunk into them.
 */
function Dumbbell({
  position,
  rotationY = 0,
}: {
  position: [number, number, number];
  rotationY?: number;
}) {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const R = 0.13; // outer plate radius
  return (
    <Interactive
      position={position}
      rotation={[0, rotationY, 0]}
      onSelect={() => setActiveModal('HABITS')}
    >
      {(hovered) => (
        <group position={[0, R, 0]}>
          {/* knurled bar, laid along x */}
          <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.032, 0.032, 0.42, 12]} />
            <meshStandardMaterial
              color={P.metal}
              roughness={0.5}
              metalness={0.45}
              emissive={hovered ? '#ffb060' : '#000000'}
              emissiveIntensity={0.3}
            />
          </mesh>
          {[-1, 1].map((side) => (
            <group key={side}>
              <mesh position={[side * 0.175, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
                <cylinderGeometry args={[R, R, 0.055, 20]} />
                <meshStandardMaterial
                  color="#4a4a52"
                  roughness={0.7}
                  metalness={0.3}
                  emissive={hovered ? '#ffb060' : '#000000'}
                  emissiveIntensity={0.25}
                />
              </mesh>
              <mesh position={[side * 0.113, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
                <cylinderGeometry args={[0.104, 0.104, 0.05, 20]} />
                <meshStandardMaterial
                  color="#5b5b66"
                  roughness={0.7}
                  metalness={0.3}
                  emissive={hovered ? '#ffb060' : '#000000'}
                  emissiveIntensity={0.25}
                />
              </mesh>
            </group>
          ))}
        </group>
      )}
    </Interactive>
  );
}

/* Strat-style body outline, as cubic beziers in a unit-ish space centred on the
 * body. Long bass horn, shorter treble horn, deep cutaway between them, pinched
 * waist and a wide lower bout. Scaled by BODY_SCALE into world units. */
const GUITAR_OUTLINE: Array<[[number, number], [number, number], [number, number], [number, number]]> = [
  [[-0.34, 0.74], [-0.52, 0.68], [-0.6, 0.46], [-0.56, 0.22]],
  [[-0.56, 0.22], [-0.53, 0.06], [-0.4, 0.02], [-0.4, -0.1]],
  [[-0.4, -0.1], [-0.4, -0.3], [-0.6, -0.36], [-0.58, -0.58]],
  [[-0.58, -0.58], [-0.55, -0.8], [-0.28, -0.88], [0.0, -0.88]],
  [[0.0, -0.88], [0.28, -0.88], [0.55, -0.8], [0.58, -0.58]],
  [[0.58, -0.58], [0.6, -0.36], [0.41, -0.3], [0.41, -0.1]],
  [[0.41, -0.1], [0.41, 0.06], [0.54, 0.2], [0.46, 0.44]],
  [[0.46, 0.44], [0.4, 0.58], [0.26, 0.5], [0.16, 0.3]],
  [[0.16, 0.3], [0.08, 0.14], [-0.04, 0.16], [-0.1, 0.3]],
  [[-0.1, 0.3], [-0.18, 0.52], [-0.24, 0.68], [-0.34, 0.74]],
];

function guitarShape(scale: number, shrink = 1, dy = 0): THREE.Shape {
  const sh = new THREE.Shape();
  const P = (x: number, y: number): [number, number] => [x * scale * shrink, (y * shrink + dy) * scale];
  sh.moveTo(...P(-0.34, 0.74));
  for (const [, c1, c2, p] of GUITAR_OUTLINE) {
    sh.bezierCurveTo(...P(c1[0], c1[1]), ...P(c2[0], c2[1]), ...P(p[0], p[1]));
  }
  sh.closePath();
  return sh;
}

/**
 * Electric guitar propped against the left wall beside the head of the bed.
 * Two nested groups: the inner one turns it so the face looks into the room
 * (+x), the outer one tilts it back so the headstock rests on the wall. At LEAN
 * 0.14 rad over ~1.2 of height the top drifts ~0.17 toward the wall, landing on
 * the inner face at x -3.195 without clipping through it.
 */
function Guitar({
  position,
  lean = 0.14,
}: {
  position: [number, number, number];
  lean?: number;
}) {
  const RED = '#c42b2b';
  const CREAM = '#f4f1e8';
  const MAPLE = '#d9b98a';
  const ROSEWOOD = '#4a2f22';
  const CHROME = '#c8ccd2';
  const BODY_SCALE = 0.28;

  const geo = useMemo(() => {
    const body = new THREE.ExtrudeGeometry(guitarShape(BODY_SCALE), {
      depth: 0.042,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.012,
      bevelSegments: 2,
      curveSegments: 24,
    });
    // the pickguard is close enough to a shrunken body outline to read right
    const guard = new THREE.ExtrudeGeometry(guitarShape(BODY_SCALE, 0.72, 0.06), {
      depth: 0.008,
      bevelEnabled: false,
      curveSegments: 20,
    });
    return { body, guard };
  }, []);

  return (
    <group position={position} rotation={[0, 0, lean]}>
      <group rotation={[0, Math.PI / 2, 0]}>
        {/* body + pickguard, both centred on the body's own origin */}
        <group position={[0, 0.26, -0.021]}>
          <mesh geometry={geo.body} castShadow>
            <meshStandardMaterial color={RED} roughness={0.28} metalness={0.12} />
          </mesh>
          <mesh geometry={geo.guard} position={[0, 0, 0.043]}>
            <meshStandardMaterial color={CREAM} roughness={0.35} />
          </mesh>

          {/* HSS: humbucker at the bridge, two single coils above it */}
          <mesh position={[0.01, -0.1, 0.056]} castShadow>
            <boxGeometry args={[0.115, 0.042, 0.014]} />
            <meshStandardMaterial color={CREAM} roughness={0.4} />
          </mesh>
          {[0.0, 0.07].map((y) => (
            <mesh key={y} position={[0.01, y, 0.056]} castShadow>
              <boxGeometry args={[0.1, 0.022, 0.012]} />
              <meshStandardMaterial color={CREAM} roughness={0.4} />
            </mesh>
          ))}
          {/* chrome tremolo + saddles */}
          <mesh position={[0.01, -0.175, 0.056]} castShadow>
            <boxGeometry args={[0.105, 0.03, 0.016]} />
            <meshStandardMaterial color={CHROME} roughness={0.25} metalness={0.85} />
          </mesh>
          {/* control knobs */}
          {[[-0.055, -0.2], [0.075, -0.14], [0.085, -0.2]].map(([x, y]) => (
            <mesh key={`${x}-${y}`} position={[x, y, 0.058]} castShadow>
              <cylinderGeometry args={[0.011, 0.011, 0.014, 10]} />
              <meshStandardMaterial color={CREAM} roughness={0.35} />
            </mesh>
          ))}
        </group>

        {/* neck: maple with a rosewood board and a few frets */}
        <mesh position={[0, 0.72, 0]} castShadow>
          <boxGeometry args={[0.052, 0.6, 0.04]} />
          <meshStandardMaterial color={MAPLE} {...CLAY} />
        </mesh>
        <mesh position={[0, 0.72, 0.023]}>
          <boxGeometry args={[0.05, 0.6, 0.012]} />
          <meshStandardMaterial color={ROSEWOOD} {...CLAY} />
        </mesh>
        {[0.5, 0.6, 0.7, 0.8, 0.9, 0.98].map((y) => (
          <mesh key={y} position={[0, y, 0.0295]} raycast={() => null}>
            <boxGeometry args={[0.05, 0.004, 0.002]} />
            <meshStandardMaterial color={CHROME} roughness={0.3} metalness={0.8} />
          </mesh>
        ))}

        {/* headstock, angled slightly, with six tuners down one side */}
        <group position={[0, 1.08, 0]} rotation={[0, 0, 0.07]}>
          <mesh castShadow>
            <boxGeometry args={[0.072, 0.17, 0.026]} />
            <meshStandardMaterial color={MAPLE} {...CLAY} />
          </mesh>
          {[0.055, 0.02, -0.015, -0.05].map((y) => (
            <mesh key={y} position={[-0.045, y, 0.004]} castShadow>
              <boxGeometry args={[0.026, 0.009, 0.016]} />
              <meshStandardMaterial color={CHROME} roughness={0.25} metalness={0.85} />
            </mesh>
          ))}
        </group>

        {/* strings, running the neck into the bridge */}
        {[-0.014, 0, 0.014].map((x) => (
          <mesh key={x} position={[x, 0.63, 0.031]} raycast={() => null}>
            <boxGeometry args={[0.0025, 1.0, 0.0025]} />
            <meshStandardMaterial color="#e6e0d2" roughness={0.35} metalness={0.6} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Corkboard3D() {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const myTasks = useAppStore((s) => s.myTasks);
  const partnerTasks = useAppStore((s) => s.partnerTasks);

  const stickies = useMemo(() => {
    // Same palette as the corkboard menu: yellow to-do, blue in-progress,
    // pink partner.
    const mine = myTasks.map((t) => ({
      key: t.id,
      color: t.status === 'IN_PROGRESS' ? '#a8d8ea' : '#ffe66b',
    }));
    const theirs = partnerTasks.map((t) => ({ key: `p-${t.id}`, color: '#f9c1d0' }));
    // One sticky per task (max 10). Each note hashes to a preferred slot
    // in a 5x2 grid, probing forward when taken, then gets a seeded
    // jitter and tilt — thrown-on look without notes burying each other.
    const taken = new Array<boolean>(10).fill(false);
    return [...mine, ...theirs].slice(0, 10).map((s, i) => {
      let slot = Math.floor(seeded(s.key, 4) * 10);
      let probes = 0;
      while (taken[slot] && probes < 10) {
        slot = (slot + 1) % 10;
        probes++;
      }
      taken[slot] = true;
      const col = slot % 5;
      const row = Math.floor(slot / 5);
      return {
        ...s,
        x: -0.58 + col * 0.29 + (seeded(s.key, 1) - 0.5) * 0.07,
        y: (row === 0 ? 0.2 : -0.2) + (seeded(s.key, 2) - 0.5) * 0.1,
        rot: (seeded(s.key, 3) - 0.5) * 0.5,
        z: 0.062 + i * 0.0025,
        lines: [0, 1, 2].map((j) => 0.1 + seeded(s.key, 5 + j) * 0.1),
      };
    });
  }, [myTasks, partnerTasks]);

  return (
    <Interactive position={[1.35, 2.1, -3.15]} onSelect={() => setActiveModal('CORKBOARD')}>
      {(hovered) => (
        <>
          <RoundedBox args={[1.9, 1.3, 0.1]} radius={0.05} castShadow>
            <meshStandardMaterial
              color={P.woodTrim}
              {...CLAY}
              emissive={hovered ? '#ffb060' : '#000000'}
              emissiveIntensity={0.3}
            />
          </RoundedBox>
          <mesh position={[0, 0, 0.055]}>
            <planeGeometry args={[1.68, 1.08]} />
            <meshStandardMaterial color={P.creamSoft} {...CLAY} />
          </mesh>
          {/* Hung off the board's bottom edge (the frame spans +/-0.65 in y):
              the top ~27% overlaps the frame, the rest hangs free below it. */}
          <FrenchFlag position={[0.66, -0.71, 0.062]} rotation={-0.05} width={0.36} />
          <CanadaFlag position={[0.22, -0.71, 0.062]} rotation={0.04} width={0.36} />
          {stickies.map((s) => (
            <group key={s.key} position={[s.x, s.y, s.z]} rotation={[0, 0, s.rot]}>
              <mesh>
                <planeGeometry args={[0.27, 0.27]} />
                <meshStandardMaterial color={s.color} {...CLAY} />
              </mesh>
              {/* scribbled "writing" */}
              {s.lines.map((w, j) => (
                <mesh key={j} position={[-0.105 + w / 2, 0.06 - j * 0.055, 0.002]}>
                  <planeGeometry args={[w, 0.018]} />
                  <meshStandardMaterial color="#6b5b4a" transparent opacity={0.6} />
                </mesh>
              ))}
            </group>
          ))}
        </>
      )}
    </Interactive>
  );
}

function WhiteboardSurface() {
  const strokes = useAppStore((s) => s.strokes);
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 320;
    return c;
  }, []);
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.anisotropy = 4;
    return t;
  }, [canvas]);

  useEffect(() => {
    renderStrokes(canvas, strokes, '#faf7ef');
    texture.needsUpdate = true;
  }, [strokes, canvas, texture]);

  return (
    <mesh position={[0, 0, 0.05]}>
      <planeGeometry args={[2.02, 1.26]} />
      <meshStandardMaterial map={texture} roughness={0.4} />
    </mesh>
  );
}

function Whiteboard3D() {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const penColor = useAppStore((s) => s.penColor);
  return (
    <Interactive position={[-1.0, 2.1, -3.15]} onSelect={() => setActiveModal('WHITEBOARD')}>
      {(hovered) => (
        <>
          <RoundedBox args={[2.3, 1.5, 0.09]} radius={0.05} castShadow>
            <meshStandardMaterial
              color={P.woodTrim}
              {...CLAY}
              emissive={hovered ? '#ffb060' : '#000000'}
              emissiveIntensity={0.3}
            />
          </RoundedBox>
          <WhiteboardSurface />
          <RoundedBox args={[0.9, 0.07, 0.14]} radius={0.03} position={[0, -0.82, 0.08]}>
            <meshStandardMaterial color={P.woodMid} {...CLAY} />
          </RoundedBox>
          {/* marker on the ledge, tinted with the user's last pen colour */}
          <group position={[0.1, -0.75, 0.08]} rotation={[0, 0.15, Math.PI / 2]}>
            <mesh castShadow>
              <cylinderGeometry args={[0.035, 0.035, 0.3, 12]} />
              <meshStandardMaterial color={penColor} roughness={0.5} />
            </mesh>
            <mesh position={[0, 0.17, 0]}>
              <cylinderGeometry args={[0.03, 0.03, 0.05, 12]} />
              <meshStandardMaterial color="#3a3f4a" roughness={0.5} />
            </mesh>
          </group>
        </>
      )}
    </Interactive>
  );
}

/* ------------------------------------------------------------------ */
/* Desk lamp: sage base, orange shade — toggles synced night mode     */
/* ------------------------------------------------------------------ */

function DeskLamp() {
  const toggleNightMode = useAppStore((s) => s.toggleNightMode);
  const isNight = useAppStore((s) => s.isNightMode);
  const shadeMat = useRef<THREE.MeshStandardMaterial>(null!);
  const lamp = useRef<THREE.PointLight>(null!);

  useFrame((_, delta) => {
    const t = 1 - Math.exp(-Math.min(delta, 0.05) * 6);
    lamp.current.intensity += ((isNight ? 2.4 : 0) - lamp.current.intensity) * t;
    // The shade itself glows from within at night — no visible bulb.
    shadeMat.current.emissiveIntensity +=
      ((isNight ? 0.85 : 0) - shadeMat.current.emissiveIntensity) * t;
  });

  return (
    <Interactive position={[1.4, 1.51, -2.35]} onSelect={toggleNightMode}>
      {(hovered) => (
        <>
          <mesh position={[0, 0.04, 0]} castShadow>
            <cylinderGeometry args={[0.17, 0.2, 0.09, 24]} />
            <meshStandardMaterial
              color={P.sage}
              {...CLAY}
              emissive={hovered ? '#ffcf8a' : '#000000'}
              emissiveIntensity={0.35}
            />
          </mesh>
          {/* one gently tilted stem flowing into a downward-opening
              shade — no elbow joint, no visible bulb */}
          <mesh position={[0.04, 0.32, 0.02]} rotation={[0.12, 0, -0.18]} castShadow>
            <cylinderGeometry args={[0.026, 0.034, 0.56, 12]} />
            <meshStandardMaterial color={P.woodMid} {...CLAY} />
          </mesh>
          <mesh position={[0.12, 0.62, 0.07]} rotation={[0.25, 0, -0.35]} castShadow>
            <coneGeometry args={[0.17, 0.24, 24, 1, true]} />
            <meshStandardMaterial
              ref={shadeMat}
              color={P.orange}
              {...CLAY}
              side={THREE.DoubleSide}
              emissive="#ffb86b"
              emissiveIntensity={0}
            />
          </mesh>
          <pointLight
            ref={lamp}
            position={[0.15, 0.5, 0.1]}
            color="#ffb86b"
            intensity={0}
            distance={7}
            decay={1.6}
          />
        </>
      )}
    </Interactive>
  );
}

/* ------------------------------------------------------------------ */
/* Bed: headboard against the window wall, proportional to the room   */
/* ------------------------------------------------------------------ */

function StarPillow({ position, rotation }: { position: [number, number, number]; rotation: [number, number, number] }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    const outer = 0.34;
    const inner = 0.16;
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.09,
      bevelEnabled: true,
      bevelSize: 0.055,
      bevelThickness: 0.055,
      bevelSegments: 4,
    });
    geo.center();
    return geo;
  }, []);
  return (
    <mesh geometry={geometry} position={position} rotation={rotation} castShadow>
      <meshStandardMaterial color={P.yellow} {...CLAY} />
    </mesh>
  );
}

/** A tee lying flat, slightly askew — like it was just thrown there. */
function Shirt({
  position,
  rotation,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
}) {
  // Dark navy / dark purple stripes running across the shirt.
  const stripes = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      for (let y = 0; y < 64; y += 4) {
        ctx.fillStyle = (y / 4) % 2 === 0 ? '#232f4e' : '#5a4074';
        ctx.fillRect(0, y, 64, 4);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }, []);

  return (
    <group position={position} rotation={rotation}>
      {/* torso, shoulders toward -z */}
      <RoundedBox args={[0.58, 0.06, 0.68]} radius={0.03} castShadow>
        <meshStandardMaterial map={stripes} {...CLAY} />
      </RoundedBox>
      {/* sleeves */}
      <RoundedBox args={[0.24, 0.05, 0.22]} radius={0.025} position={[-0.35, 0, -0.2]} rotation={[0, 0.5, 0]}>
        <meshStandardMaterial map={stripes} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[0.24, 0.05, 0.22]} radius={0.025} position={[0.35, 0, -0.24]} rotation={[0, -0.4, 0]}>
        <meshStandardMaterial map={stripes} {...CLAY} />
      </RoundedBox>
      {/* collar */}
      <mesh position={[0, 0.035, -0.26]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.09, 0.024, 8, 20]} />
        <meshStandardMaterial color="#232f4e" {...CLAY} />
      </mesh>
    </group>
  );
}

function Bed() {
  const legs: Array<[number, number]> = [
    [-1.82, -1.18],
    [-1.82, 1.18],
    [1.82, -1.18],
    [1.82, 1.18],
  ];
  // Slightly longer than the desk top and generously wide, shifted
  // toward the monstera corner.
  return (
    <group position={[-1.15, 0, 0.85]}>
      {/* frame + headboard */}
      <RoundedBox args={[4.0, 0.45, 2.6]} radius={0.1} position={[0, 0.29, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={P.woodMid} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[0.22, 1.35, 2.6]} radius={0.08} position={[-1.93, 0.76, 0]} castShadow>
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </RoundedBox>
      {legs.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.09, z]} castShadow>
          <cylinderGeometry args={[0.07, 0.09, 0.18, 12]} />
          <meshStandardMaterial color={P.woodMid} {...CLAY} />
        </mesh>
      ))}
      {/* mattress */}
      <RoundedBox args={[3.72, 0.38, 2.36]} radius={0.12} position={[0.03, 0.67, 0]} castShadow>
        <meshStandardMaterial color={P.beige} {...CLAY} />
      </RoundedBox>
      {/* blanket reaching up to just under the pillows + folded edge */}
      <RoundedBox args={[2.9, 0.44, 2.44]} radius={0.13} position={[0.52, 0.66, 0]} castShadow>
        <meshStandardMaterial color={P.brown} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[0.24, 0.46, 2.44]} radius={0.09} position={[-0.9, 0.67, 0]} castShadow>
        <meshStandardMaterial color={P.brownLight} {...CLAY} />
      </RoundedBox>
      {/* sleeping pillows — each spans half the bed width */}
      {[-0.6, 0.6].map((z) => (
        <RoundedBox
          key={z}
          args={[0.78, 0.2, 1.15]}
          radius={0.09}
          position={[-1.4, 0.95, z]}
          rotation={[0, 0, 0.12]}
          castShadow
        >
          <meshStandardMaterial color={P.brown} {...CLAY} />
        </RoundedBox>
      ))}
      {/* star accent pillow stacked on the right sleeping pillow */}
      <StarPillow position={[-1.38, 1.16, -0.6]} rotation={[-1.4, 0, 0.25]} />
      {/* shirt tossed on the bed's near-left corner */}
      <Shirt position={[1.2, 0.91, 0.85]} rotation={[0.02, 0.7, -0.03]} />
      {/* the real Djungelskog, propped on the bed
          (+200° to face the room, then 75° back the other way; nudged
          25px right + 25px down in screen space = +0.79 world x) */}
      <Prop
        url={djungelskogUrl}
        position={[-0.45, 0.84, -0.46]}
        rotationY={0.85 + (165 * Math.PI) / 180}
        fitSize={0.72}
        matte
        envIntensity={0.7}
        brightness={2}
      />
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Plants                                                             */
/* ------------------------------------------------------------------ */

/** Simple desk chair the characters can sit on. */
function DeskChair({
  position,
  scale = 1,
}: {
  position: [number, number, number];
  scale?: number;
}) {
  const legs: Array<[number, number]> = [
    [-0.2, -0.18],
    [0.2, -0.18],
    [-0.2, 0.18],
    [0.2, 0.18],
  ];
  return (
    <group position={position} scale={scale}>
      <RoundedBox args={[0.52, 0.09, 0.48]} radius={0.04} position={[0, 0.52, 0]} castShadow>
        <meshStandardMaterial color={P.cream} {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[0.52, 0.55, 0.08]} radius={0.04} position={[0, 0.86, 0.22]} rotation={[0.12, 0, 0]} castShadow>
        <meshStandardMaterial color={P.sage} {...CLAY} />
      </RoundedBox>
      {legs.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.24, z]} castShadow>
          <cylinderGeometry args={[0.035, 0.045, 0.48, 10]} />
          <meshStandardMaterial color={P.woodMid} {...CLAY} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Pencil cup with pens leaning at odd angles. Clicking it pops the two
 * circular identity buttons (Lulu / Roro) right above the cup — the
 * whole settings surface, no menu.
 */
function PencilCup({ position }: { position: [number, number, number] }) {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const open = useAppStore((s) => s.activeModal === 'SETTINGS');
  const role = useAppStore((s) => s.role);
  const setRole = useAppStore((s) => s.setRole);
  const pairCode = useAppStore((s) => s.pairCode);
  const setPairCode = useAppStore((s) => s.setPairCode);
  const connection = useAppStore((s) => s.connectionStatus);
  const [codeDraft, setCodeDraft] = useState(pairCode);
  useEffect(() => setCodeDraft(pairCode), [pairCode]);
  const pens: Array<{ x: number; z: number; tiltX: number; tiltZ: number; h: number; color: string }> = [
    { x: 0.03, z: 0.02, tiltX: 0.1, tiltZ: 0.08, h: 0.34, color: '#e8b25c' },
    { x: -0.04, z: 0.03, tiltX: -0.06, tiltZ: -0.14, h: 0.3, color: P.orange },
    { x: 0.0, z: -0.05, tiltX: -0.12, tiltZ: 0.05, h: 0.32, color: P.teal },
    { x: 0.05, z: -0.02, tiltX: 0.05, tiltZ: 0.16, h: 0.27, color: P.white },
    { x: -0.02, z: -0.01, tiltX: 0.14, tiltZ: -0.04, h: 0.36, color: P.leafDark },
  ];
  return (
    <Interactive position={position} onSelect={() => setActiveModal(open ? 'NONE' : 'SETTINGS')}>
      {(hovered) => (
        <>
          {open && (
            <group position={[0, 0.95, 0]}>
              <Html center zIndexRange={[15, 0]}>
                <div data-interactive className="flex flex-col items-center gap-1.5">
                  <div className="flex gap-1.5">
                  {(['USER_A', 'USER_B'] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => {
                        setRole(r);
                        setActiveModal('NONE');
                      }}
                      className={`flex h-9 w-9 items-center justify-center rounded-full border text-[10px] font-bold shadow-lg backdrop-blur transition ${
                        role === r
                          ? r === 'USER_A'
                            ? 'border-sky-400 bg-sky-100/90 text-sky-700 ring-2 ring-sky-400'
                            : 'border-pink-400 bg-pink-100/90 text-pink-600 ring-2 ring-pink-400'
                          : 'border-white/70 bg-white/85 text-slate-600 hover:bg-white'
                      }`}
                    >
                      {r === 'USER_A' ? 'Lulu' : 'Roro'}
                    </button>
                  ))}
                  </div>
                  {/* Both desks must type the same code; anyone on a different
                      code is in a different room and cannot collide with you. */}
                  <div className="flex flex-col items-center gap-0.5 rounded-lg bg-white/85 px-2 py-1.5 shadow-lg backdrop-blur">
                    <span className="text-[8px] font-semibold uppercase tracking-wide text-slate-500">
                      Pair code
                    </span>
                    <input
                      value={codeDraft}
                      maxLength={PAIR_CODE_MAX}
                      onChange={(e) => setCodeDraft(e.target.value)}
                      onBlur={() => setPairCode(codeDraft)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setPairCode(codeDraft);
                      }}
                      spellCheck={false}
                      className="w-[92px] rounded bg-slate-100 px-1.5 py-0.5 text-center text-[11px] font-mono tracking-wider text-slate-700 outline-none"
                    />
                    <span
                      className="text-[8px] font-medium"
                      style={{
                        color:
                          connection === 'CONNECTED'
                            ? '#3f9a72'
                            : connection === 'CONNECTING'
                              ? '#b08540'
                              : '#a05353',
                      }}
                    >
                      {connection === 'CONNECTED'
                        ? 'connected'
                        : connection === 'CONNECTING'
                          ? 'waiting for partner…'
                          : 'offline'}
                    </span>
                  </div>
                </div>
              </Html>
            </group>
          )}
          <mesh position={[0, 0.13, 0]} castShadow>
            <cylinderGeometry args={[0.11, 0.09, 0.26, 20]} />
            <meshStandardMaterial
              color={P.sage}
              {...CLAY}
              emissive={hovered ? '#ffcf8a' : '#000000'}
              emissiveIntensity={0.35}
            />
          </mesh>
          {pens.map((p, i) => (
            <group key={i} position={[p.x, 0.22, p.z]} rotation={[p.tiltX, 0, p.tiltZ]}>
              <mesh position={[0, p.h / 2, 0]} castShadow>
                <cylinderGeometry args={[0.017, 0.017, p.h, 8]} />
                <meshStandardMaterial color={p.color} roughness={0.6} />
              </mesh>
              {/* sharpened tip on the classic pencil */}
              {i === 0 && (
                <mesh position={[0, p.h + 0.025, 0]}>
                  <coneGeometry args={[0.017, 0.05, 8]} />
                  <meshStandardMaterial color="#8a6b3f" roughness={0.7} />
                </mesh>
              )}
            </group>
          ))}
        </>
      )}
    </Interactive>
  );
}

/** Small toy car: red body, cream cabin, chunky dark wheels. */
function ToyCar({
  position,
  rotationY = 0,
}: {
  position: [number, number, number];
  rotationY?: number;
}) {
  const wheels: Array<[number, number]> = [
    [-0.2, -0.17],
    [0.2, -0.17],
    [-0.2, 0.17],
    [0.2, 0.17],
  ];
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <RoundedBox args={[0.6, 0.18, 0.34]} radius={0.06} position={[0, 0.17, 0]} castShadow>
        <meshStandardMaterial color="#d9432f" {...CLAY} />
      </RoundedBox>
      <RoundedBox args={[0.32, 0.15, 0.3]} radius={0.06} position={[-0.04, 0.32, 0]} castShadow>
        <meshStandardMaterial color={P.cream} {...CLAY} />
      </RoundedBox>
      {wheels.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.09, z]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.09, 0.09, 0.07, 16]} />
          <meshStandardMaterial color="#33302a" roughness={0.7} />
        </mesh>
      ))}
      {/* headlights */}
      {[-0.1, 0.1].map((z) => (
        <mesh key={z} position={[0.3, 0.2, z]}>
          <sphereGeometry args={[0.028, 10, 10]} />
          <meshStandardMaterial color={P.yellow} emissive={P.yellow} emissiveIntensity={0.25} />
        </mesh>
      ))}
    </group>
  );
}

/** Woven laundry basket with clothes peeking out the top. */
function LaundryBasket({ position }: { position: [number, number, number] }) {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  return (
    <Interactive position={position} onSelect={() => setActiveModal('WARDROBE')}>
      {() => (
        <group>
      <mesh position={[0, 0.38, 0]} castShadow>
        <cylinderGeometry args={[0.42, 0.34, 0.76, 24]} />
        <meshStandardMaterial color={P.creamSoft} {...CLAY} />
      </mesh>
      {/* weave rings following the taper */}
      {[0.18, 0.38, 0.58].map((y, i) => (
        <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.36 + i * 0.028, 0.018, 10, 32]} />
          <meshStandardMaterial color={P.woodMid} {...CLAY} />
        </mesh>
      ))}
      <mesh position={[0, 0.76, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.42, 0.035, 10, 32]} />
        <meshStandardMaterial color={P.woodTrim} {...CLAY} />
      </mesh>
      {/* laundry poking out */}
      <mesh position={[0.12, 0.8, 0.06]} scale={[1, 0.6, 1]} castShadow>
        <sphereGeometry args={[0.17, 16, 16]} />
        <meshStandardMaterial color={P.white} {...CLAY} />
      </mesh>
          <mesh position={[-0.13, 0.78, -0.07]} scale={[1, 0.55, 1]} castShadow>
            <sphereGeometry args={[0.14, 16, 16]} />
            <meshStandardMaterial color={P.teal} {...CLAY} />
          </mesh>
        </group>
      )}
    </Interactive>
  );
}

/** Tall monstera: leaning stems topped with split leaves (real holes
 *  in the leaf shape via THREE.Shape hole paths). */
function Monstera({
  position,
  rotationY = 0,
  scale = 1,
}: {
  position: [number, number, number];
  rotationY?: number;
  scale?: number;
}) {
  const leafGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0.3, 0.02, 0.34, 0.38, 0.02, 0.56);
    shape.bezierCurveTo(-0.34, 0.38, -0.3, 0.02, 0, 0);
    for (const side of [-1, 1]) {
      for (let j = 0; j < 3; j++) {
        const hole = new THREE.Path();
        hole.absellipse(side * 0.14, 0.14 + j * 0.12, 0.08, 0.018, 0, Math.PI * 2, true, side * 0.5);
        shape.holes.push(hole);
      }
    }
    return new THREE.ShapeGeometry(shape, 12);
  }, []);

  const stems = useMemo(
    () => [
      { angle: 0.5, lean: 0.32, h: 1.35 },
      { angle: 1.7, lean: 0.2, h: 1.85 },
      { angle: 2.9, lean: 0.38, h: 1.05 },
      { angle: 4.2, lean: 0.28, h: 1.6 },
      { angle: 5.4, lean: 0.42, h: 0.85 },
    ],
    []
  );

  return (
    <group position={position} rotation={[0, rotationY, 0]} scale={scale}>
      <mesh position={[0, 0.28, 0]} castShadow>
        <cylinderGeometry args={[0.32, 0.26, 0.55, 20]} />
        <meshStandardMaterial color={P.cream} {...CLAY} />
      </mesh>
      <mesh position={[0, 0.56, 0]}>
        <cylinderGeometry args={[0.27, 0.27, 0.03, 20]} />
        <meshStandardMaterial color="#5a4632" roughness={1} />
      </mesh>
      {stems.map((s, i) => (
        <group key={i} rotation={[0, s.angle, 0]}>
          <mesh
            position={[Math.sin(s.lean) * s.h * 0.5, 0.55 + Math.cos(s.lean) * s.h * 0.5, 0]}
            rotation={[0, 0, -s.lean]}
            castShadow
          >
            <cylinderGeometry args={[0.022, 0.032, s.h, 8]} />
            <meshStandardMaterial color={P.leafDark} {...CLAY} />
          </mesh>
          <mesh
            geometry={leafGeometry}
            position={[Math.sin(s.lean) * s.h, 0.5 + Math.cos(s.lean) * s.h, 0]}
            rotation={[-0.55, Math.PI / 2, s.lean * 0.5]}
            castShadow
          >
            <meshStandardMaterial
              color={i % 2 === 0 ? P.leaf : P.leafDark}
              side={THREE.DoubleSide}
              {...CLAY}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Scene root                                                         */
/* ------------------------------------------------------------------ */

export default function IsometricRoom() {
  const rootRef = useRef<THREE.Group>(null!);
  const camera = useThree((s) => s.camera);
  const partnerPresent = useAppStore((s) => s.connectionStatus === 'CONNECTED');

  // Every mesh in this group blocks OS click-through; empty pixels don't.
  useEffect(() => {
    registerHitTest(camera, rootRef.current);
    return () => registerHitTest(null, null);
  }, [camera]);

  return (
    <>
      <SceneLights />
      <group ref={rootRef}>
        <FloorPlatform />
        <Walls />
        <OpenWindow />
        {/* Desk + everything on it, scaled to 80% about the desk's
            floor-centre pivot [0.1, 0, -2.15] (position = 0.2 * pivot),
            so it shrinks in place instead of drifting toward the origin. */}
        <group scale={0.8} position={[0.02, 0, -0.43]}>
          <Desk />
          <AlarmClock />
          <Notebook3D />
          <DeskLamp />
          <PencilCup position={[0.3, 1.51, -2.55]} />
        </group>
        <Corkboard3D />
        <Whiteboard3D />
        <Bed />
        <LaundryBasket position={[2.65, 0, -2.55]} />
        <Monstera position={[-2.6, 0, -2.5]} rotationY={2.1} scale={0.92} />
        {/* leaning on the left wall, just past the head of the bed */}
        <Guitar position={[-3.02, 0.07, -1.15]} />
        <ToyCar position={[-2.55, 0, 2.55]} rotationY={-0.6} />
        {/* habit tracker, on the boards beside the toy car and the bed's foot */}
        <Dumbbell position={[-1.8, 0.07, 2.62]} rotationY={0.35} />
        <DeskChair position={[0.62, 0, -1.2]} scale={1.12} />
        <DeskChair position={[-0.42, 0, -1.2]} scale={1.12} />
        <Character variant="me" />
        {partnerPresent && <Character variant="partner" />}
      </group>
    </>
  );
}
