// useGround.js
import {
  Plane,
  Vector3,
  PlaneGeometry,
  MeshPhongMaterial,
  FrontSide,
  Mesh,
  GridHelper,
} from "three";

/**
 * Manages the ground plane + grid and the ring clipping rectangle.
 *
 * - Owns: ground mesh, grid helper, ringClipPlanes, placement logic.
 * - Caller passes:
 *    - scene
 *    - size (square side in meters)
 *    - backMargin (how much of the square is "behind" the origin along coverageDir)
 */
export function useGround({ scene, size = 400_000, backMargin = 50_000 }) {
  if (!scene) {
    throw new Error("useGround: scene is required");
  }

  const GROUND_SIZE = size;
  const GROUND_HALF = GROUND_SIZE / 2;
  const BACK_MARGIN = backMargin;

  let ground = null;
  let grid = null;

  // These 4 planes define the "inside" of the ground square
  const ringClipPlanes = [
    new Plane(new Vector3(1, 0, 0), 0), // x >= minX
    new Plane(new Vector3(-1, 0, 0), 0), // x <= maxX
    new Plane(new Vector3(0, 0, 1), 0), // z >= minZ
    new Plane(new Vector3(0, 0, -1), 0), // z <= maxZ
  ];

  function initGround() {
    // Ground
    const groundGeom = new PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
    const groundMat = new MeshPhongMaterial({
      color: 0x050814,
      side: FrontSide,
    });
    ground = new Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Grid
    const gridDivisions = 60;
    grid = new GridHelper(
      GROUND_SIZE,
      gridDivisions,
      0x00ffff, // center lines
      0xc4c4c5 // regular lines
    );
    grid.position.y = 1;
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    grid.visible = false;
    scene.add(grid);
  }

  /**
   * Place the ground so that:
   *  - ~BACK_MARGIN is behind the origin along coverageDir
   *  - the rest is in front
   *  - ringClipPlanes always match the current ground square
   */
  function updatePlacement(coverageDir) {
    if (!ground || !grid || !coverageDir) return;

    // Project coverageDir onto horizontal plane (XZ)
    const dirProj = new Vector3(coverageDir.x, 0, coverageDir.z);
    if (dirProj.lengthSq() < 1e-6) {
      // coverage pointing straight up/down -> fall back to +X
      dirProj.set(1, 0, 0);
    } else {
      dirProj.normalize();
    }

    // With a GROUND_SIZE square: half = 200 km
    // center offset = half - BACK_MARGIN = 200 - 50 = 150 km
    const offsetDist = GROUND_HALF - BACK_MARGIN;
    const offset = dirProj.multiplyScalar(offsetDist);

    ground.position.set(offset.x, 0, offset.z);
    grid.position.set(offset.x, 1, offset.z);

    // Update clipping planes so rings are only visible inside [minX,maxX] × [minZ,maxZ]
    const minX = ground.position.x - GROUND_HALF;
    const maxX = ground.position.x + GROUND_HALF;
    const minZ = ground.position.z - GROUND_HALF;
    const maxZ = ground.position.z + GROUND_HALF;

    // plane 0: x >= minX
    ringClipPlanes[0].constant = -minX; // distance = x - minX

    // plane 1: x <= maxX
    ringClipPlanes[1].constant = maxX; // distance = -x + maxX

    // plane 2: z >= minZ
    ringClipPlanes[2].constant = -minZ; // distance = z - minZ

    // plane 3: z <= maxZ
    ringClipPlanes[3].constant = maxZ; // distance = -z + maxZ
  }

  function disposeGround() {
    if (ground) {
      scene.remove(ground);
      ground.geometry.dispose();
      ground.material.dispose();
      ground = null;
    }
    if (grid) {
      scene.remove(grid);
      // GridHelper material may be array in some three versions
      if (Array.isArray(grid.material)) {
        grid.material.forEach((m) => m.dispose());
      } else {
        grid.material.dispose();
      }
      grid = null;
    }
  }

  return {
    initGround,
    updatePlacement,
    disposeGround,
    ringClipPlanes, // used by range ring materials
    getGround: () => ground,
    getGrid: () => grid,
  };
}
