<template>
  <div
    style="
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 12px;
      height: 520px;
    "
  >
    <div style="padding: 12px; border: 1px solid #2a2f3a; border-radius: 8px">
      <div style="font-weight: 700; margin-bottom: 10px">Cone controls</div>

      <label style="display: block; margin: 10px 0">
        radius: {{ radius.toFixed(2) }}
        <input
          type="range"
          min="0.1"
          max="20"
          step="0.1"
          v-model.number="radius"
          style="width: 100%"
        />
      </label>

      <label style="display: block; margin: 10px 0">
        height: {{ height.toFixed(2) }}
        <input
          type="range"
          min="0.1"
          max="40"
          step="0.1"
          v-model.number="height"
          style="width: 100%"
        />
      </label>

      <label style="display: block; margin: 10px 0">
        radialSegments: {{ radialSegments }}
        <input
          type="range"
          min="3"
          max="128"
          step="1"
          v-model.number="radialSegments"
          style="width: 100%"
        />
      </label>

      <label style="display: block; margin: 10px 0">
        thetaStart: {{ thetaStart.toFixed(2) }}
        <input
          type="range"
          min="0"
          :max="(Math.PI * 2).toFixed(6)"
          step="0.01"
          v-model.number="thetaStart"
          style="width: 100%"
        />
      </label>

      <label style="display: block; margin: 10px 0">
        thetaLength: {{ thetaLength.toFixed(2) }}
        <input
          type="range"
          min="0.01"
          :max="(Math.PI * 2).toFixed(6)"
          step="0.01"
          v-model.number="thetaLength"
          style="width: 100%"
        />
      </label>

      <label style="display: block; margin: 10px 0">
        <input type="checkbox" v-model="openEnded" />
        openEnded
      </label>

      <label style="display: block; margin: 10px 0">
        <input type="checkbox" v-model="wireframe" />
        wireframe
      </label>

      <button
        @click="reset"
        style="
          margin-top: 10px;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid #2a2f3a;
          background: transparent;
          color: inherit;
          cursor: pointer;
        "
      >
        Reset
      </button>
    </div>

    <div
      style="border: 1px solid #2a2f3a; border-radius: 8px; overflow: hidden"
    >
      <canvas
        ref="canvasEl"
        style="width: 100%; height: 100%; display: block"
      ></canvas>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const canvasEl = ref(null);

let renderer = null;
let scene = null;
let camera = null;
let controls = null;

let coneMesh = null;

// --- params (docs-like defaults) ---
const radius = ref(5);
const height = ref(20);
const radialSegments = ref(32);
const openEnded = ref(false);
const thetaStart = ref(0);
const thetaLength = ref(Math.PI * 2);
const wireframe = ref(false);

function reset() {
  radius.value = 5;
  height.value = 20;
  radialSegments.value = 32;
  openEnded.value = false;
  thetaStart.value = 0;
  thetaLength.value = Math.PI * 2;
  wireframe.value = false;
}

function renderOnce() {
  if (!renderer || !scene || !camera) return;
  renderer.render(scene, camera);
}

function rebuildCone() {
  if (!scene) return;

  if (coneMesh) {
    scene.remove(coneMesh);
    coneMesh.geometry.dispose();
    coneMesh.material.dispose();
    coneMesh = null;
  }

  const geometry = new THREE.ConeGeometry(
    radius.value,
    height.value,
    radialSegments.value,
    1, // heightSegments
    openEnded.value,
    thetaStart.value,
    thetaLength.value
  );

  const material = new THREE.MeshBasicMaterial({
    color: 0xffff00,
    wireframe: wireframe.value,
  });

  coneMesh = new THREE.Mesh(geometry, material);
  scene.add(coneMesh);

  renderOnce();
}

onMounted(() => {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111318);

  // Camera
  const rect = canvasEl.value.getBoundingClientRect();
  camera = new THREE.PerspectiveCamera(60, rect.width / rect.height, 0.1, 1000);
  camera.position.set(25, 15, 35);
  camera.lookAt(0, 0, 0);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas: canvasEl.value,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height, false);

  // Controls (no animation loop; render on change)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; // important: damping would require an animation loop
  controls.addEventListener("change", renderOnce);

  // Helpers
  scene.add(new THREE.AxesHelper(12));

  // Initial cone
  rebuildCone();

  // Resize (render on resize, too)
  const onResize = () => {
    if (!renderer || !camera) return;
    const r = canvasEl.value.getBoundingClientRect();
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    renderer.setSize(r.width, r.height, false);
    renderOnce();
  };
  window.addEventListener("resize", onResize);
  scene.userData._onResize = onResize;
});

// Rebuild cone when params change
watch(
  [
    radius,
    height,
    radialSegments,
    openEnded,
    thetaStart,
    thetaLength,
    wireframe,
  ],
  rebuildCone
);

onBeforeUnmount(() => {
  if (controls) {
    controls.removeEventListener("change", renderOnce);
    controls.dispose();
    controls = null;
  }
  if (coneMesh) {
    scene.remove(coneMesh);
    coneMesh.geometry.dispose();
    coneMesh.material.dispose();
    coneMesh = null;
  }
  if (scene?.userData?._onResize) {
    window.removeEventListener("resize", scene.userData._onResize);
  }
  renderer?.dispose();
  renderer = null;
  scene = null;
  camera = null;
});
</script>
