// src/composables/useGizmo.js
import { ViewportGizmo } from "three-viewport-gizmo";

/**
 * Viewport gizmo wrapper.
 *
 * Parent responsibilities:
 *  - pass camera, renderer, controls, container
 *  - call renderGizmo() in the render loop
 *  - call updateGizmo() on resize
 *  - call disposeGizmo() on unmount
 */
export function useGizmo() {
  let gizmo = null;

  function initGizmo({ camera, renderer, controls, container }) {
    if (!camera || !renderer || !controls || !container) {
      throw new Error(
        "useGizmo.initGizmo: camera, renderer, controls, container are required"
      );
    }

    if (gizmo) return gizmo; // idempotent

    gizmo = new ViewportGizmo(camera, renderer, {
      container,
      type: "sphere",
      size: 140,
      placement: "top-right",
      offset: {
        left: 25,
        top: 25,
      },
      x: { label: "E", color: 0xff5555, labelColor: "#ffffff", scale: 0.8 },
      y: { label: "UP", color: 0x55ff55, labelColor: "#ffffff", scale: 0.8 },
      z: {
        enabled: true,
        line: false,
        label: "",
        color: 0x5555ff,
        labelColor: "transparent",
        scale: 0.5,
      },
      nz: {
        enabled: true,
        label: "N",
        line: true,
        color: 0x5555ff,
        labelColor: "#ffffff",
        scale: 0.8,
      },
    });

    gizmo.attachControls(controls);
    return gizmo;
  }

  function renderGizmo() {
    gizmo?.render();
  }

  function updateGizmo() {
    gizmo?.update();
  }

  function disposeGizmo() {
    if (!gizmo) return;
    gizmo.dispose();
    gizmo = null;
  }

  return {
    initGizmo,
    renderGizmo,
    updateGizmo,
    disposeGizmo,
  };
}
