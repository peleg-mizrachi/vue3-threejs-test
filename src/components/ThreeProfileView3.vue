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
import { useTerrain } from "@/composables/useTerrain.js";
import { makeMockHeightField } from "@/utils/mockHeightField.js";

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
let terrainApi = null;

// ---------------------------------------------------------------------
// Coordinate + plane helpers
// ---------------------------------------------------------------------

const ALT_SCALE = 10;

async function setupTerrain() {
  terrainApi = useTerrain({
    scene,
    sizeMeters: 400_000, // MUST match the generator config
    samples: 257,
    altScale: ALT_SCALE,
    yOffsetMeters: 0,
    wireframe: false,
    nodata: -32768,
    nodataFillMeters: 0,
  });

  terrainApi.initTerrain();

  const heights = await terrainApi.loadHeightsFromUrl("/terrain.bin");
  console.log(heights);

  debugHeightStats(heights, 257, -32768);
  debugWestEastNodata(heights, 257, -32768);
  debugEdgeNodata(heights, 257, -32768);

  terrainApi.setHeights(heights);
  // terrainApi.setDebugNodataColors(heights);
  // paint by height + water for nodata
  terrainApi.setColorsFromHeights(heights, {
    nodataValue: -32768,
    seaLevel: 0,
    // tweak these later if you want
    h1: 200,
    h2: 800,
    h3: 1800,
    h4: 3000,
  });
  // terrainApi.setHeights(heights, { flipX: true });

  // scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  // Optional: align terrain with your ground offset
  // If you want it to sit exactly where the ground plane is:
  const ground = groundApi.getGround();
  terrainApi.setPlacement({ x: ground.position.x, z: ground.position.z });

  return true;
}

function debugHeightStats(heights, N, NODATA) {
  let min = Infinity,
    max = -Infinity,
    nodata = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h === NODATA) {
      nodata++;
      continue;
    }
    if (h < min) min = h;
    if (h > max) max = h;
  }
  console.log("HEIGHT STATS", {
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    nodata,
    total: heights.length,
    nodataPct: ((100 * nodata) / heights.length).toFixed(1) + "%",
  });
}

function debugWestEastNodata(heights, N, NODATA) {
  let westNo = 0,
    westTotal = 0;
  let eastNo = 0,
    eastTotal = 0;

  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const h = heights[row * N + col];
      if (col < N / 2) {
        westTotal++;
        if (h === NODATA) westNo++;
      } else {
        eastTotal++;
        if (h === NODATA) eastNo++;
      }
    }
  }

  console.log("WEST/EAST NODATA", {
    westNo,
    westPct: ((100 * westNo) / westTotal).toFixed(1) + "%",
    eastNo,
    eastPct: ((100 * eastNo) / eastTotal).toFixed(1) + "%",
  });
}

function debugEdgeNodata(heights, N, NODATA) {
  let top = 0,
    bottom = 0,
    left = 0,
    right = 0;

  for (let i = 0; i < N; i++) {
    if (heights[i] === NODATA) top++;
    if (heights[(N - 1) * N + i] === NODATA) bottom++;
    if (heights[i * N] === NODATA) left++;
    if (heights[i * N + (N - 1)] === NODATA) right++;
  }

  console.log("EDGE NODATA", { top, bottom, left, right });
}

async function initScene() {
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

  // X axis (east)
  scene.add(
    new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0),
      150_000,
      0xff0000
    )
  );
  // Y axis (up)
  scene.add(
    new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 0),
      80_000,
      0x00ff00
    )
  );
  // Z axis (north = -Z)
  scene.add(
    new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 0),
      150_000,
      0x0000ff
    )
  );

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
  debugBox.position.set(80_000, 2_000 * ALT_SCALE, -80_000);
  scene.add(debugBox);

  coverageApi = useCoverage({
    scene,
    coverageHeight: COVERAGE_HEIGHT,
    halfAngleRad: THREE.MathUtils.degToRad(120 / 2),
    clippingPlane: groundClipPlane,
  });
  coverageDir = coverageApi.coverageDir;
  coverageApi.initCoverage(
    props.coverageAzimuthDeg,
    props.coverageElevationDeg
  );

  console.log("coverageDir after init:", coverageDir.toArray());

  // Ground + labels need to be in sync with initial coverageDir
  groundApi.updatePlacement(coverageDir);
  rangeRingsApi.updateLabelPositions(coverageDir);

  console.log("coverageDir after init:", coverageDir.toArray());

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

  const isInit = await setupTerrain();

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

    const g = groundApi.getGround();
    terrainApi?.setPlacement({ x: g.position.x, z: g.position.z });
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
