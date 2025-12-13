// src/composables/useLabels.js
import { CanvasTexture, LinearFilter, SpriteMaterial, Sprite } from "three";
/**
 * Central labels manager:
 *  - creates text sprites
 *  - keeps a registry of sprites that should scale with camera distance
 *  - updates scales each frame
 */
export function useLabels() {
  const labelSprites = []; // all sprites that should auto-scale

  function registerLabelSprite(sprite, { sizeMultiplier = 1 } = {}) {
    sprite.userData.labelSizeMultiplier = sizeMultiplier;
    labelSprites.push(sprite);
  }

  /**
   * Create a text sprite (rounded box + text).
   * Registering (for scaling) is *not* automatic – caller decides.
   */
  function createTextSprite(text, { fontSize = 48, padding = 8 } = {}) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = 512;
    canvas.height = 256;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `bold ${fontSize}px system-ui`;

    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const boxWidth = textWidth + padding * 2;
    const boxHeight = fontSize + padding * 2;

    const x = (canvas.width - boxWidth) / 2;
    const y = (canvas.height - boxHeight) / 2;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 3;

    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, boxWidth, boxHeight, 16);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, boxWidth, boxHeight);
      ctx.strokeRect(x, y, boxWidth, boxHeight);
    }

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 3);

    const texture = new CanvasTexture(canvas);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.needsUpdate = true;

    const material = new SpriteMaterial({
      map: texture,
      depthTest: true,
      depthWrite: false,
      transparent: true,
    });

    const sprite = new Sprite(material);

    const baseScale = 1;
    const baseWidth = baseScale * (boxWidth / canvas.width);
    const baseHeight = baseScale * (boxHeight / canvas.height);

    sprite.scale.set(baseWidth, baseHeight, 1);
    sprite.userData.aspect = baseWidth / baseHeight || 1;

    return sprite;
  }

  /**
   * Call once per frame with current camera.
   */
  function updateLabelSpriteScales(camera) {
    if (!camera) return;

    const baseScreenFactor = 0.05; // how big labels look vs distance
    const minBaseHeight = 4000;
    const maxBaseHeight = 40000;

    for (const sprite of labelSprites) {
      if (!sprite) continue;

      const dist = camera.position.distanceTo(sprite.position);
      const mult = sprite.userData.labelSizeMultiplier ?? 1;

      let worldHeight = dist * baseScreenFactor * mult;

      const minHeight = minBaseHeight * mult;
      const maxHeight = maxBaseHeight * mult;

      if (worldHeight < minHeight) worldHeight = minHeight;
      if (worldHeight > maxHeight) worldHeight = maxHeight;

      const aspect = sprite.userData.aspect || 2;
      const worldWidth = worldHeight * aspect;

      sprite.scale.set(worldWidth, worldHeight, 1);
    }
  }

  function disposeLabels() {
    for (const sprite of labelSprites) {
      if (!sprite) continue;
      if (sprite.material?.map) {
        sprite.material.map.dispose?.();
      }
      sprite.material?.dispose?.();
    }
    labelSprites.length = 0;
  }

  return {
    createTextSprite,
    registerLabelSprite,
    updateLabelSpriteScales,
    disposeLabels,
  };
}
