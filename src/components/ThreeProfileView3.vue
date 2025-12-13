<template>
  <div class="three-container">
    <canvas ref="canvasEl"></canvas>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { useCoverage } from "@/composables/useCoverage.js";
import { useGround } from "@/composables/useGround.js";
import { useRangeRings } from "@/composables/useRangeRings.js";
import { useAltitudeAxis } from "@/composables/useAltitudeAxis.js";
import { useGizmo } from "@/composables/useGizmo.js";
import { useLabels } from "@/composables/useLabels.js";
import { useFixedView } from "@/composables/useFixedView.js";
import { usePlanes } from "@/composables/useAirplanes.js";

// ---------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------
const props = defineProps({
  origin: {
    type: Object, // { lat, lng, alt? } or null
    default: null,
  },
  planes: {
    type: Array, // [{ id, lat, lng, alt, heading? }]
    default: () => [],
  },
  // optional future props for cone orientation (deg)
  coverageAzimuthDeg: {
    type: Number,
    default: 0, // 90° = East (in our system)
  },
  coverageElevationDeg: {
    type: Number,
    default: 0, // 0° = horizontal
  },
});

const canvasEl = ref(null);

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let animationId = null;

// const planeGroups = new Map(); // id -> THREE.Group

let originSphere = null;

const COVERAGE_HEIGHT = 300000;
const groundClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let coverageDir = null;
let coverageApi = null;
let groundApi = null;
let rangeRingsApi = null;
let altitudeAxisApi = null;
let gizmoApi = null;
let labelsApi = null;
let fixedViewApi = null;
let planesApi = null;

// ---------------------------------------------------------------------
// Coordinate + plane helpers
// ---------------------------------------------------------------------

const ALT_SCALE = 10;

function initScene() {
  const canvas = canvasEl.value;
  if (!canvas) return;

  const parent = canvas.parentElement;
  const width = parent?.clientWidth || 300;
  const height = parent?.clientHeight || 300;

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x02030a, 1);
  renderer.localClippingEnabled = true;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02030a);

  // Camera
  camera = new THREE.PerspectiveCamera(60, width / height, 50, 1_000_000);
  camera.position.set(120000, 80000, -200000);
  camera.lookAt(0, 4000 * ALT_SCALE, 0);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 4000 * ALT_SCALE, 0);
  controls.enablePan = true;
  controls.minDistance = 8000;
  controls.maxDistance = 500000;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.enableDamping = true;
  controls.dampingFactor = 0.5;

  labelsApi = useLabels();
  // === Viewport gizmo (top-left) ===
  const containerEl = canvas.parentElement;
  gizmoApi = useGizmo();
  gizmoApi.initGizmo({
    camera,
    renderer,
    controls,
    container: containerEl,
  });

  // Lights
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(30000, 60000, -40000);
  scene.add(dirLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // --- Ground + grid via composable ---
  groundApi = useGround({
    scene,
    size: 400_000,
    backMargin: 50_000,
  });
  groundApi.initGround();

  // Range rings
  const ringRadii = [50_000, 100_000, 150_000, 200_000, 250_000, 300_000];

  rangeRingsApi = useRangeRings({
    scene,
    ringRadii,
    ringClipPlanes: groundApi.ringClipPlanes,
    createTextSprite: labelsApi.createTextSprite,
    registerLabelSprite: labelsApi.registerLabelSprite,
  });
  rangeRingsApi.initRings();

  // // Compass + altitude axis + origin
  // const compass = createCompassLabels(
  //   ringRadii[ringRadii.length - 1] + 8000,
  //   labelsApi.createTextSprite
  // );
  // scene.add(compass);

  altitudeAxisApi = useAltitudeAxis({
    scene,
    altScale: ALT_SCALE,
    maxAlt: 12_000,
    step: 2_000,
    createTextSprite: labelsApi.createTextSprite,
    registerLabelSprite: labelsApi.registerLabelSprite,
  });
  altitudeAxisApi.initAltitudeAxis();

  const originSphereGeom = new THREE.SphereGeometry(1500, 24, 24);
  const originSphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  originSphere = new THREE.Mesh(originSphereGeom, originSphereMat);
  originSphere.position.set(0, 0, 0);
  scene.add(originSphere);

  // === DEBUG BOX: 80 km east, 2000 m up ===
  const debugBoxGeom = new THREE.BoxGeometry(5000, 5000, 5000);
  const debugBoxMat = new THREE.MeshStandardMaterial({
    color: 0x00ff00,
    metalness: 0.1,
    roughness: 0.6,
  });
  const debugBox = new THREE.Mesh(debugBoxGeom, debugBoxMat);
  debugBox.position.set(80_000, 2_000 * ALT_SCALE, 10_000);
  scene.add(debugBox);

  coverageApi = useCoverage({
    scene,
    coverageHeight: COVERAGE_HEIGHT,
    halfAngleRad: Math.PI / 4,
    clippingPlane: groundClipPlane,
  });
  coverageDir = coverageApi.coverageDir;
  coverageApi.initCoverage(
    props.coverageAzimuthDeg,
    props.coverageElevationDeg
  );

  // Ground + labels need to be in sync with initial coverageDir
  groundApi.updatePlacement(coverageDir);
  rangeRingsApi.updateLabelPositions(coverageDir);

  // Fixed view composable
  fixedViewApi = useFixedView();
  fixedViewApi.initFixedView({
    camera,
    controls,
    coverageDir,
    originObject: originSphere,
    domElement: renderer.domElement,
    // optional overrides:
    // eyeHeight: 1500,
    // frontDistance: 80_000,
    // backDistance: 5_000,
  });

  const fixedPointPosition = new THREE.Vector3(
    0,
    4000 * ALT_SCALE, // or whatever your fixed-point altitude is
    0
  );

  planesApi = usePlanes({
    scene,
    camera,
    domElement: renderer.domElement,
    labelsApi,
    fixedPointPosition,
    altScale: ALT_SCALE,
    maxRadius: 300_000,
  });

  window.addEventListener("resize", onWindowResize);

  const tick = () => {
    if (!renderer || !scene || !camera) return;

    controls && controls.update();

    if (labelsApi) {
      labelsApi.updateLabelSpriteScales(camera);
    }
    renderer.setScissorTest(false);
    // main scene render
    renderer.render(scene, camera);

    // gizmo overlay
    if (gizmoApi) {
      gizmoApi.renderGizmo();
    }

    animationId = requestAnimationFrame(tick);
  };

  tick();
}

function onWindowResize() {
  const canvas = canvasEl.value;
  if (!canvas || !renderer || !camera) return;

  const parent = canvas.parentElement;
  const width = parent?.clientWidth || window.innerWidth;
  const height = parent?.clientHeight || window.innerHeight;

  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  if (gizmoApi) {
    gizmoApi.updateGizmo();
  }
}

onMounted(() => {
  initScene();
  if (planesApi) {
    planesApi.syncPlanes({
      origin: props.origin,
      planes: props.planes,
    });
  }
});

watch(
  () => [props.origin, props.planes],
  () => {
    if (!planesApi) return;
    planesApi.syncPlanes({
      origin: props.origin,
      planes: props.planes,
    });
  },
  { deep: true }
);

watch(
  () => [props.coverageAzimuthDeg, props.coverageElevationDeg],
  ([az, el]) => {
    if (!coverageApi) return;

    coverageApi.setCoverageOrientation(az, el);

    // keep ground and labels aligned with the new coverageDir
    groundApi.updatePlacement(coverageDir);
    rangeRingsApi.updateLabelPositions(coverageDir);
  }
);

onBeforeUnmount(() => {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
  }
  window.removeEventListener("resize", onWindowResize);

  if (planesApi) {
    planesApi.disposePlanes();
    planesApi = null;
  }

  if (groundApi) {
    groundApi.disposeGround();
    groundApi = null;
  }

  if (altitudeAxisApi) {
    altitudeAxisApi.disposeAltitudeAxis();
    altitudeAxisApi = null;
  }

  if (gizmoApi) {
    gizmoApi.disposeGizmo();
    gizmoApi = null;
  }

  if (coverageApi) {
    coverageApi.disposeCoverage();
    coverageApi = null;
    coverageDir = null;
  }

  if (rangeRingsApi) {
    rangeRingsApi.disposeRings();
    rangeRingsApi = null;
  }

  if (labelsApi) {
    labelsApi.disposeLabels();
    labelsApi = null;
  }

  if (fixedViewApi) {
    fixedViewApi.disposeFixedView();
    fixedViewApi = null;
  }

  if (renderer) {
    renderer.dispose();
    renderer = null;
  }

  scene = null;
  camera = null;
  controls = null;
});
</script>

<style scoped>
.three-container {
  width: 100%;
  height: 100%;
  background: #02030a;
  color: #c4c4c5;
  display: flex;
  position: relative;
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
