import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';

/**
 * A static decor model: loads a GLB, auto-fits it to a target size along
 * one axis, grounds its base at the given position, and casts shadows.
 * Being part of the room group, it blocks click-through like furniture.
 */
export default function Prop({
  url,
  position,
  rotationY = 0,
  fitAxis = 'y',
  fitSize,
  ground = true,
}: {
  url: string;
  position: [number, number, number];
  rotationY?: number;
  /** Axis whose extent is scaled to `fitSize` (y = height, x/z = footprint). */
  fitAxis?: 'x' | 'y' | 'z';
  fitSize: number;
  /** Sit the model's base at position.y (true) or centre it there. */
  ground?: boolean;
}) {
  const { scene } = useGLTF(url);
  const fitted = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = fitSize / Math.max(size[fitAxis], 1e-6);
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        // Imported PBR materials lean hard on environment light — give
        // them a boost so they sit in the room's brightness range.
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.envMapIntensity = 1.4;
          }
        }
      }
    });
    return {
      scale,
      offset: [-center.x, ground ? -box.min.y : -center.y, -center.z] as const,
    };
  }, [scene, fitAxis, fitSize, ground]);

  return (
    <group position={position} rotation={[0, rotationY, 0]} scale={fitted.scale}>
      <primitive
        object={scene}
        position={[fitted.offset[0], fitted.offset[1], fitted.offset[2]]}
      />
    </group>
  );
}
