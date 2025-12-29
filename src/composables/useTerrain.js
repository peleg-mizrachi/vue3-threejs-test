// src/composables/useTerrain.js
import * as THREE from "three";

/**
 * Terrain mesh driven by a heightfield (Float32Array of meters).
 *
 * Height layout:
 *   heights[z * samples + x]  (row-major)
 *
 * Coordinates:
 *   X = east, Z = north (or "your north"), Y = up
 *   Mesh is centered at (0,0,0) by default.
 */
export function useTerrain({
  scene,
  sizeMeters = 300_000,
  samples = 257, // N (vertices per side) => segments are N-1
  altScale = 1, // your ALT_SCALE (vertical exaggeration)
  yOffset = 0, // in "world Y" units (after scaling)
  material = null,
  wireframe = false,
} = {}) {
  let mesh = null;
  let geometry = null;
  let mat = null;

  function initTerrain() {
    if (!scene) throw new Error("useTerrain: scene is required");
    if (samples < 2) throw new Error("useTerrain: samples must be >= 2");

    // PlaneGeometry is XY by default, rotate to XZ so Y is up.
    geometry = new THREE.PlaneGeometry(
      sizeMeters,
      sizeMeters,
      samples - 1,
      samples - 1
    );
    geometry.rotateX(-Math.PI / 2);

    mat =
      material ||
      new THREE.MeshStandardMaterial({
        color: 0x1d2b3a,
        roughness: 0.95,
        metalness: 0.0,
        wireframe,
      });

    mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(0, yOffset, 0);
    mesh.receiveShadow = true;

    scene.add(mesh);
  }

  /**
   * Apply heightfield (meters) into geometry Y (world units = meters * altScale).
   * heights must have length samples*samples.
   */
  function setHeights(heightsMeters) {
    if (!geometry) throw new Error("useTerrain: call initTerrain() first");
    if (!heightsMeters || heightsMeters.length !== samples * samples) {
      throw new Error(
        `useTerrain: heights length must be ${samples * samples} (got ${
          heightsMeters?.length
        })`
      );
    }

    const posAttr = geometry.attributes.position;
    const arr = posAttr.array; // Float32Array

    // After rotateX(-PI/2), Y is the up axis. Perfect: write elevations into arr[idx+1].
    for (let z = 0; z < samples; z++) {
      for (let x = 0; x < samples; x++) {
        const hMeters = heightsMeters[z * samples + x];
        const v = (z * samples + x) * 3;
        arr[v + 1] = hMeters * altScale;
      }
    }

    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }

  function setVisible(v) {
    if (mesh) mesh.visible = !!v;
  }

  function disposeTerrain() {
    if (mesh && scene) scene.remove(mesh);

    if (geometry) geometry.dispose();
    if (mat) mat.dispose();

    mesh = null;
    geometry = null;
    mat = null;
  }

  return {
    initTerrain,
    setHeights,
    setVisible,
    disposeTerrain,
    get mesh() {
      return mesh;
    },
  };
}
