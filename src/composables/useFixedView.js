// src/composables/useFixedView.js
import { Vector3, Raycaster, Vector2 } from "three";

export function useFixedView() {
  // internal refs
  let camera = null;
  let controls = null;
  let coverageDir = null; // THREE.Vector3 (unit-ish, will normalize)
  let originObject = null; // the sphere (or any clickable object)
  let domElement = null; // renderer.domElement

  let isFixedPointView = false;

  const savedView = {
    position: new Vector3(),
    target: new Vector3(),
    controls: {
      enableRotate: true,
      enablePan: true,
      enableZoom: true,
      minDistance: 8000,
      maxDistance: 500000,
    },
  };

  // shared raycasting helpers
  const raycaster = new Raycaster();
  const pointerNDC = new Vector2();

  // configurable distances (can be overridden from init if you want later)
  let eyeHeight = 1500; // meters above ground
  let frontDistance = 80_000; // point inside the cone
  let backDistance = 5_000; // camera behind origin

  function enterFixedPointView() {
    if (!camera || !controls || !coverageDir) return;

    // save current camera + controls
    savedView.position.copy(camera.position);
    savedView.target.copy(controls.target);
    savedView.controls.enableRotate = controls.enableRotate;
    savedView.controls.enablePan = controls.enablePan;
    savedView.controls.enableZoom = controls.enableZoom;
    savedView.controls.minDistance = controls.minDistance;
    savedView.controls.maxDistance = controls.maxDistance;

    // coverageDir is the axis of the cone (unit vector). Normalize just in case
    const dir = coverageDir.clone().normalize();

    // target is IN FRONT of origin, inside the cone
    const target = dir.clone().multiplyScalar(frontDistance);

    // eye is BEHIND origin, along -dir, plus height
    const eye = dir.clone().multiplyScalar(-backDistance);
    eye.y = eyeHeight;

    camera.position.copy(eye);
    controls.target.copy(target);
    camera.lookAt(controls.target);

    const distance = camera.position.distanceTo(controls.target);

    // allow at least this distance
    controls.minDistance = Math.min(1000, distance * 0.5);
    controls.maxDistance = distance * 2; // > current distance, so no clamping

    // you can decide how "locked" this view is:
    controls.enableRotate = true;
    controls.enablePan = false;
    controls.enableZoom = true;

    controls.update();

    isFixedPointView = true;
  }

  function exitFixedPointView() {
    if (!camera || !controls) return;

    camera.position.copy(savedView.position);
    controls.target.copy(savedView.target);
    camera.lookAt(controls.target);

    controls.enableRotate = savedView.controls.enableRotate;
    controls.enablePan = savedView.controls.enablePan;
    controls.enableZoom = savedView.controls.enableZoom;
    controls.minDistance = savedView.controls.minDistance;
    controls.maxDistance = savedView.controls.maxDistance;

    controls.update();

    isFixedPointView = false;
  }

  function toggleFixedPointView() {
    if (isFixedPointView) {
      exitFixedPointView();
    } else {
      enterFixedPointView();
    }
  }

  function handlePointerDown(event) {
    if (!domElement || !camera || !originObject) return;

    const rect = domElement.getBoundingClientRect();

    // convert to NDC
    pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointerNDC, camera);

    const intersects = raycaster.intersectObject(originObject, true);

    if (intersects.length > 0) {
      toggleFixedPointView();
    }
  }

  /**
   * Initialize the fixed view behavior.
   *
   * @param {Object} opts
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {OrbitControls} opts.controls
   * @param {THREE.Vector3} opts.coverageDir
   * @param {THREE.Object3D} opts.originObject - object to click on (sphere)
   * @param {HTMLElement} opts.domElement - renderer.domElement
   * @param {number} [opts.eyeHeight]
   * @param {number} [opts.frontDistance]
   * @param {number} [opts.backDistance]
   */
  function initFixedView(opts) {
    camera = opts.camera;
    controls = opts.controls;
    coverageDir = opts.coverageDir;
    originObject = opts.originObject;
    domElement = opts.domElement;

    if (opts.eyeHeight != null) eyeHeight = opts.eyeHeight;
    if (opts.frontDistance != null) frontDistance = opts.frontDistance;
    if (opts.backDistance != null) backDistance = opts.backDistance;

    if (domElement) {
      domElement.addEventListener("pointerdown", handlePointerDown);
    }
  }

  function disposeFixedView() {
    if (domElement) {
      domElement.removeEventListener("pointerdown", handlePointerDown);
    }

    camera = null;
    controls = null;
    coverageDir = null;
    originObject = null;
    domElement = null;
    isFixedPointView = false;
  }

  // In case later you ever replace coverageDir vector object:
  function setCoverageDirection(vec) {
    coverageDir = vec;
  }

  return {
    initFixedView,
    disposeFixedView,
    enterFixedPointView,
    exitFixedPointView,
    toggleFixedPointView,
    setCoverageDirection,
    // if you ever want to bind a button / UI to this:
    isFixedPointView: () => isFixedPointView,
  };
}
