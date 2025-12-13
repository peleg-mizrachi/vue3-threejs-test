// src/composables/useAltitudeAxis.js
import { Group, LineBasicMaterial, Vector3, BufferGeometry, Line } from "three";
/**
 * Altitude axis (vertical line, ticks, text labels).
 *
 * Parent responsibilities:
 *  - provide scene
 *  - provide createTextSprite + registerLabelSprite (shared with other labels)
 *  - call initAltitudeAxis() once
 *  - call disposeAltitudeAxis() on unmount
 */
export function useAltitudeAxis({
  scene,
  altScale = 1,
  maxAlt = 12_000,
  step = 2_000,
  createTextSprite,
  registerLabelSprite,
}) {
  if (!scene) {
    throw new Error("useAltitudeAxis: scene is required");
  }
  if (!createTextSprite || !registerLabelSprite) {
    throw new Error(
      "useAltitudeAxis: createTextSprite and registerLabelSprite are required"
    );
  }

  let axisGroup = null;

  function initAltitudeAxis() {
    if (axisGroup) return axisGroup; // idempotent

    const group = new Group();

    const mainMat = new LineBasicMaterial({ color: 0x66aaff });
    const mainPoints = [
      new Vector3(0, 0, 0),
      new Vector3(0, maxAlt * altScale, 0),
    ]; // Y is up
    const mainGeom = new BufferGeometry().setFromPoints(mainPoints);
    const mainLine = new Line(mainGeom, mainMat);
    group.add(mainLine);

    const tickMat = new LineBasicMaterial({ color: 0x66aaff });
    const tickHalfLength = 2000;

    for (let alt = step; alt <= maxAlt; alt += step) {
      const y = alt * altScale;
      const tickPoints = [
        new Vector3(-tickHalfLength, y, 0),
        new Vector3(+tickHalfLength, y, 0),
      ];
      const tickGeom = new BufferGeometry().setFromPoints(tickPoints);
      const tickLine = new Line(tickGeom, tickMat);
      group.add(tickLine);

      const labelText = `${alt.toLocaleString()} m`;
      const sprite = createTextSprite(labelText, {
        fontSize: 100,
        padding: 6,
      });
      sprite.position.set(tickHalfLength + 2500, y, 0);

      // always visible over lines
      sprite.material.depthTest = false;
      sprite.material.depthWrite = false;

      group.add(sprite);
      registerLabelSprite(sprite, { sizeMultiplier: 0.8 });
    }

    scene.add(group);
    axisGroup = group;
    return axisGroup;
  }

  function disposeAltitudeAxis() {
    if (!axisGroup) return;

    // dispose children
    for (const child of axisGroup.children) {
      // Lines
      if (child.isLine) {
        child.geometry?.dispose();
        child.material?.dispose();
      }
      // Sprites
      if (child.isSprite) {
        // texture is on material.map
        if (child.material?.map) {
          child.material.map.dispose?.();
        }
        child.material?.dispose();
      }
    }

    scene.remove(axisGroup);
    axisGroup = null;
  }

  return {
    initAltitudeAxis,
    disposeAltitudeAxis,
  };
}
