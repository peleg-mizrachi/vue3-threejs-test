// useRangeRings.js
import { Vector3, BufferGeometry, LineBasicMaterial, LineLoop } from "three";
/**
 * Manages:
 *  - range ring LineLoops (with clipping to ground)
 *  - range ring labels (front for all, and a single back label for 50 km)
 *
 * The parent is still responsible for:
 *  - createTextSprite (shared for other labels)
 *  - registerLabelSprite (shared label scaling)
 *  - providing coverageDir when it changes.
 */
export function useRangeRings({
  scene,
  ringRadii, // e.g. [50_000, 100_000, ...]
  ringClipPlanes, // from useGround().ringClipPlanes
  createTextSprite, // function (text, options) -> Sprite
  registerLabelSprite, // function (sprite, { sizeMultiplier })
}) {
  if (!scene) {
    throw new Error("useRangeRings: scene is required");
  }
  if (!Array.isArray(ringRadii) || ringRadii.length === 0) {
    throw new Error("useRangeRings: ringRadii must be a non-empty array");
  }

  const rings = []; // THREE.LineLoop[]
  const rangeRingLabels = []; // { sprite, radiusMeters, side, labelHeight, labelOffset }

  function createRangeRingMesh(
    radius,
    segments = 128,
    color = 0x339966,
    opacity = 0.55
  ) {
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(
        new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
      ); // XZ plane
    }

    const geometry = new BufferGeometry().setFromPoints(points);
    const material = new LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      clippingPlanes: ringClipPlanes || [], // only draw inside ground square
    });

    return new LineLoop(geometry, material);
  }

  function addRingWithLabels(radiusMeters) {
    const ring = createRangeRingMesh(radiusMeters);
    ring.position.y = 2; // slightly above ground to avoid z-fighting
    scene.add(ring);
    rings.push(ring);

    const km = Math.round(radiusMeters / 1000);
    const labelText = `${km} km`;

    const LABEL_HEIGHT = 4000;
    const LABEL_OFFSET = 5000;

    // --- FRONT label: always created ---
    const frontSprite = createTextSprite(labelText, {
      fontSize: 150,
      padding: 0,
    });
    scene.add(frontSprite);
    registerLabelSprite(frontSprite, { sizeMultiplier: 1 });

    rangeRingLabels.push({
      sprite: frontSprite,
      radiusMeters,
      side: "front",
      labelHeight: LABEL_HEIGHT,
      labelOffset: LABEL_OFFSET,
    });

    // --- BACK label: only for 50 km ring ---
    if (radiusMeters === 50_000) {
      const backSprite = createTextSprite(labelText, {
        fontSize: 150,
        padding: 0,
      });
      scene.add(backSprite);
      registerLabelSprite(backSprite, { sizeMultiplier: 1 });

      rangeRingLabels.push({
        sprite: backSprite,
        radiusMeters,
        side: "back",
        labelHeight: LABEL_HEIGHT,
        labelOffset: LABEL_OFFSET,
      });
    }
  }

  function initRings() {
    for (const radius of ringRadii) {
      addRingWithLabels(radius);
    }
  }

  /**
   * Repositions all ring labels based on coverageDir (cone axis).
   * coverageDir: THREE.Vector3 (world)
   */
  function updateLabelPositions(coverageDir) {
    if (!coverageDir) return;

    // horizontal projection of coverageDir
    const dirProj = new Vector3(coverageDir.x, 0, coverageDir.z);
    if (dirProj.lengthSq() < 1e-6) {
      dirProj.set(1, 0, 0); // fallback
    } else {
      dirProj.normalize();
    }

    const frontDir = dirProj;
    const backDir = dirProj.clone().multiplyScalar(-1);

    for (const entry of rangeRingLabels) {
      const { sprite, radiusMeters, side, labelHeight, labelOffset } = entry;

      const r = radiusMeters + (labelOffset ?? 0);
      const dir = side === "front" ? frontDir : backDir;
      const pos2D = dir.clone().multiplyScalar(r);

      sprite.position.set(pos2D.x, labelHeight, pos2D.z);

      // visibility rules:
      // - all FRONT labels visible
      // - BACK: only for 50km
      if (side === "back" && radiusMeters !== 50_000) {
        sprite.visible = false;
      } else {
        sprite.visible = true;
      }
    }
  }

  function disposeRings() {
    // remove ring meshes
    for (const ring of rings) {
      scene.remove(ring);
      if (ring.geometry) ring.geometry.dispose();
      if (ring.material) ring.material.dispose();
    }
    rings.length = 0;

    // remove label sprites (the parent still holds them in labelSprites
    // for scaling, but removing from scene is our responsibility)
    for (const { sprite } of rangeRingLabels) {
      scene.remove(sprite);
      if (sprite.material) sprite.material.dispose();
      if (sprite.texture && sprite.texture.dispose) {
        sprite.texture.dispose?.();
      }
    }
    rangeRingLabels.length = 0;
  }

  return {
    initRings,
    updateLabelPositions,
    disposeRings,
    ringRadii, // could be handy for compass, etc.
  };
}
