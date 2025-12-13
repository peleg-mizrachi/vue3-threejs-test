// src/composable/useCoverage.js
import {
  Vector3,
  ConeGeometry,
  DoubleSide,
  MeshBasicMaterial,
  Mesh,
  WireframeGeometry,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Quaternion,
} from "three";
/**
 * Handles coverage cone + wire + orientation.
 *
 * The component owns:
 *  - scene
 *  - coverageHeight, halfAngleRad
 *  - clipping plane(s)
 *
 * The composable owns:
 *  - coverageDir (unit vector)
 *  - coverage cone & wire meshes
 *  - orientation math
 */
export function useCoverage(options) {
  const {
    scene,
    coverageHeight = 300_000,
    halfAngleRad = Math.PI / 4, // 45°
    clippingPlane = null, // e.g. groundClipPlane
  } = options;

  if (!scene) {
    throw new Error("useCoverage: scene is required");
  }

  const coverageDir = new Vector3(1, 0, 0); // default +X
  const baseDir = new Vector3(1, 0, 0);

  let coverageCone = null;
  let coverageWire = null;

  function createCoverageMeshes() {
    const coverageRadius = coverageHeight * Math.tan(halfAngleRad);

    const coverageBaseGeom = new ConeGeometry(
      coverageRadius,
      coverageHeight,
      48,
      1,
      true
    );

    // Move apex from +H/2 down to 0
    coverageBaseGeom.translate(0, -coverageHeight / 2, 0);
    // Rotate axis from +Y to +X (our baseDir)
    coverageBaseGeom.rotateZ(Math.PI / 2);

    const matOpts = {
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
    };
    if (clippingPlane) {
      matOpts.clippingPlanes = [clippingPlane];
    }

    const coverageMat = new MeshBasicMaterial(matOpts);
    coverageCone = new Mesh(coverageBaseGeom, coverageMat);
    scene.add(coverageCone);

    const wireGeom = new WireframeGeometry(coverageBaseGeom);
    const wireMatOpts = {
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
    };
    if (clippingPlane) {
      wireMatOpts.clippingPlanes = [clippingPlane];
    }

    const wireMat = new LineBasicMaterial(wireMatOpts);
    coverageWire = new LineSegments(wireGeom, wireMat);
    scene.add(coverageWire);
  }

  function setCoverageOrientation(azDeg, elDeg) {
    if (!coverageCone) return;

    const az = MathUtils.degToRad(azDeg);
    const el = MathUtils.degToRad(elDeg);

    const cosEl = Math.cos(el);
    coverageDir
      .set(
        cosEl * Math.sin(az), // X (east)
        Math.sin(el), // Y (up)
        cosEl * Math.cos(az) // Z (north); 0°=north, 90°=east
      )
      .normalize();

    const quat = new Quaternion().setFromUnitVectors(baseDir, coverageDir);
    coverageCone.quaternion.copy(quat);
    if (coverageWire) coverageWire.quaternion.copy(quat);
  }

  function initCoverage(initialAzDeg = 0, initialElDeg = 0) {
    createCoverageMeshes();
    setCoverageOrientation(initialAzDeg, initialElDeg);
  }

  function disposeCoverage() {
    if (!scene) return;

    if (coverageCone) {
      scene.remove(coverageCone);
      coverageCone.geometry.dispose();
      coverageCone.material.dispose();
      coverageCone = null;
    }
    if (coverageWire) {
      scene.remove(coverageWire);
      coverageWire.geometry.dispose();
      coverageWire.material.dispose();
      coverageWire = null;
    }
  }

  return {
    coverageDir,
    initCoverage,
    setCoverageOrientation,
    disposeCoverage,
    getCoverageCone: () => coverageCone,
    getCoverageWire: () => coverageWire,
  };
}
