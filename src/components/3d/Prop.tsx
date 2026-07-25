import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';

const TMP_BOX = new THREE.Box3();

/**
 * Bounds that respect GPU instancing: optimized GLBs often pack repeated
 * parts as InstancedMesh, whose geometry bbox covers only ONE instance —
 * measuring (or letting the frustum culler measure) with that makes the
 * model mis-fit or vanish entirely.
 */
function computeBox(scene: THREE.Object3D): THREE.Box3 {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  box.makeEmpty();
  scene.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) {
      obj.computeBoundingBox(); // instance-aware
      if (obj.boundingBox) box.union(TMP_BOX.copy(obj.boundingBox).applyMatrix4(obj.matrixWorld));
    } else if (obj instanceof THREE.Mesh) {
      obj.geometry.computeBoundingBox();
      const gb = obj.geometry.boundingBox;
      if (gb) box.union(TMP_BOX.copy(gb).applyMatrix4(obj.matrixWorld));
    }
  });
  return box;
}

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
  envIntensity = 1.4,
  matte = false,
  brightness = 1,
}: {
  url: string;
  position: [number, number, number];
  rotationY?: number;
  /** Axis whose extent is scaled to `fitSize` (y = height, x/z = footprint). */
  fitAxis?: 'x' | 'y' | 'z';
  fitSize: number;
  /** Sit the model's base at position.y (true) or centre it there. */
  ground?: boolean;
  /** Environment-light pickup; raise for dark metallic imports. */
  envIntensity?: number;
  /** Force fully rough/non-metal — for photo scans whose light is baked in. */
  matte?: boolean;
  /**
   * Per-prop exposure lift (1 = untouched). Multiplies the base colour
   * and adds a small self-lit component from the model's own texture,
   * so only this prop brightens — scene lighting is untouched.
   */
  brightness?: number;
}) {
  const { scene } = useGLTF(url);
  const fitted = useMemo(() => {
    const box = computeBox(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = fitSize / Math.max(size[fitAxis], 1e-6);
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        // Instanced meshes would be culled by their single-instance
        // bounds; small props are cheap to just always draw.
        obj.frustumCulled = false;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.envMapIntensity = envIntensity;
            if (matte) {
              mat.roughness = 1;
              mat.metalness = 0;
            }
            // Idempotent brightness: always derive from the stashed
            // original so re-renders never compound the multiplier.
            if (!mat.userData.baseColor) mat.userData.baseColor = mat.color.clone();
            mat.color.copy(mat.userData.baseColor as THREE.Color).multiplyScalar(brightness);
            if (brightness > 1 && mat.map) {
              mat.emissiveMap = mat.map;
              mat.emissive.setScalar(Math.min(0.35, (brightness - 1) * 0.35));
            }
          }
        }
      }
    });
    return {
      scale,
      offset: [-center.x, ground ? -box.min.y : -center.y, -center.z] as const,
    };
  }, [scene, fitAxis, fitSize, ground, envIntensity, matte, brightness]);

  return (
    <group position={position} rotation={[0, rotationY, 0]} scale={fitted.scale}>
      <primitive
        object={scene}
        position={[fitted.offset[0], fitted.offset[1], fitted.offset[2]]}
      />
    </group>
  );
}
