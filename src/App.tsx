import { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import IsometricRoom from './components/3d/IsometricRoom';
import { ModalLayer } from './components/ui/Modals';
import { usePassThrough } from './hooks/usePassThrough';
import { installCursorStyles } from './lib/cursors';
import { useAppStore } from './store/useAppStore';

export default function App() {
  usePassThrough();

  useEffect(() => {
    installCursorStyles();
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
          <IsometricRoom />
        </Canvas>
      </div>
      <ModalLayer />
    </div>
  );
}
