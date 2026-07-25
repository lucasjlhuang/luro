import { Suspense, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import IsometricRoom from './components/3d/IsometricRoom';
import { ModalLayer } from './components/ui/Modals';
import { usePassThrough } from './hooks/usePassThrough';
import { installCursorStyles } from './lib/cursors';
import { expandWindowToScreen } from './lib/tauri';
import { getPan } from './lib/pan';
import { useAppStore } from './store/useAppStore';

/**
 * Applies the rug-drag pan: shifts the camera along its screen axes so
 * the room sits wherever the user dragged it inside the screen-sized
 * window. Orientation never changes, only position.
 */
function CameraRig() {
  const camera = useThree((s) => s.camera);
  const basis = useMemo(() => {
    const pos = new THREE.Vector3(10, 10, 10);
    const dir = new THREE.Vector3(0, 0.9, 0).sub(pos).normalize();
    const right = dir.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
    const up = right.clone().cross(dir).normalize();
    return { pos, right, up };
  }, []);

  useFrame(() => {
    const pan = getPan();
    const zoom = (camera as THREE.OrthographicCamera).zoom;
    camera.position
      .copy(basis.pos)
      .addScaledVector(basis.right, -pan.x / zoom)
      .addScaledVector(basis.up, pan.y / zoom);
    camera.updateMatrixWorld();
  });
  return null;
}

export default function App() {
  usePassThrough();

  useEffect(() => {
    installCursorStyles();
    // Cover the whole monitor so panels can go anywhere; the extra
    // area is transparent and click-through.
    void expandWindowToScreen();
  }, []);

  const initPeer = useAppStore((s) => s.initPeer);
  useEffect(() => {
    initPeer();
  }, [initPeer]);

  // A desktop overlay has no use for the browser context menu.
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', prevent);
    return () => document.removeEventListener('contextmenu', prevent);
  }, []);

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden">
      <div className="absolute inset-0">
        <Canvas
          shadows
          orthographic
          dpr={[1, 2]}
          camera={{ position: [10, 10, 10], zoom: 45, near: 0.1, far: 100 }}
          gl={{ alpha: true, antialias: true }}
          style={{ background: 'transparent' }}
          onCreated={({ camera }) => camera.lookAt(0, 0.9, 0)}
        >
          <CameraRig />
          {/* decor models load async; the room pops in when ready */}
          <Suspense fallback={null}>
            <IsometricRoom />
          </Suspense>
        </Canvas>
      </div>
      <ModalLayer />
    </div>
  );
}
