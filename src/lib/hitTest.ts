import * as THREE from 'three';

/**
 * Module-level raycast registry. The R3F scene registers its camera and
 * root group here; the pass-through poller (which runs outside the React
 * tree) asks "is there any 3D geometry under this screen point?".
 */

let camera: THREE.Camera | null = null;
let root: THREE.Object3D | null = null;
let forceInteractive = false;

/**
 * While set, the pass-through poller keeps the window interactive no
 * matter what is under the cursor — used while dragging the character
 * so the OS never swallows pointer events mid-drag.
 */
export function setForceInteractive(value: boolean): void {
  forceInteractive = value;
}

export function isForceInteractive(): boolean {
  return forceInteractive;
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

export function registerHitTest(cam: THREE.Camera | null, object: THREE.Object3D | null): void {
  camera = cam;
  root = object;
}

export function hitTestAt(clientX: number, clientY: number): boolean {
  if (!camera || !root) return false;
  ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObject(root, true).length > 0;
}
