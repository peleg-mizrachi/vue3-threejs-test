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

const planeGroups = new Map(); // id -> THREE.Group

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

// ---------------------------------------------------------------------
// Coordinate + plane helpers
// ---------------------------------------------------------------------

const R = 6371000; // Earth radius (approx)
const deg2rad = Math.PI / 180;
const ALT_SCALE = 10;

function latLonAltToLocalENU(lat, lon, alt, origin) {
  const phi0 = origin.lat * deg2rad;
  const lam0 = origin.lng * deg2rad;

  const phi = lat * deg2rad;
  const lam = lon * deg2rad;

  const dPhi = phi - phi0;
  const dLam = lam - lam0;

  const xEast = R * dLam * Math.cos(phi0); // meters east
  const zNorth = R * dPhi; // meters north
  const yUp = (alt ?? 0) * ALT_SCALE;

  // Map to Three.js: X=east, Y=up, Z=north
  return new THREE.Vector3(xEast, yUp, zNorth);
}

function createPlaneGroup(planeId) {
  const group = new THREE.Group();

  // ---------------------------
  // BODY (plane mesh + label)
  // ---------------------------
  const bodyGroup = new THREE.Group();

  const bodyGeom = new THREE.BoxGeometry(5000, 5000, 5000);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffaa00,
    metalness: 0.2,
    roughness: 0.5,
  });
  const mesh = new THREE.Mesh(bodyGeom, bodyMat);

  // Shift so rotation feels like nose-first (as before)
  mesh.geometry.translate(0, 0, -400);

  bodyGroup.add(mesh);

  // Label above plane
  const label = labelsApi.createTextSprite(String(planeId), {
    fontSize: 48,
    padding: 8,
  });
  label.position.set(0, 800, 0);
  bodyGroup.add(label);

  labelsApi.registerLabelSprite(label, { sizeMultiplier: 0.8 });
  group.add(bodyGroup);

  // ---------------------------
  // ALTITUDE COLUMN
  // ---------------------------

  // Thin vertical stem from plane to ground (unit height, we scale later)
  const stemRadius = 300;
  const stemGeom = new THREE.CylinderGeometry(stemRadius, stemRadius, 1, 12);
  const stemMat = new THREE.MeshBasicMaterial({
    color: 0x66aaff,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });

  const columnGroup = new THREE.Group();
  const stem = new THREE.Mesh(stemGeom, stemMat);
  columnGroup.add(stem);
  group.add(columnGroup);

  // Ground ring (on y=0 world, we position it in syncPlanes)
  const groundRingInner = 1200;
  const groundRingOuter = 2200;
  const groundRingGeom = new THREE.RingGeometry(
    groundRingInner,
    groundRingOuter,
    32
  );
  const groundRingMat = new THREE.MeshBasicMaterial({
    color: 0x66aaff,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const groundRing = new THREE.Mesh(groundRingGeom, groundRingMat);
  groundRing.rotation.x = -Math.PI / 2; // face up
  group.add(groundRing);

  // Bowl-like base just under the plane (optional but nice)
  const bowlInner = 800;
  const bowlOuter = 1800;
  const bowlGeom = new THREE.RingGeometry(bowlInner, bowlOuter, 32);
  const bowlMat = new THREE.MeshBasicMaterial({
    color: 0x66aaff,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const bowl = new THREE.Mesh(bowlGeom, bowlMat);
  bowl.rotation.x = -Math.PI / 2;

  // Put it just under the plane body (box is 5000 high → half is 2500)
  bowl.position.y = -2600;
  group.add(bowl);

  // Store references for updates in syncPlanes
  group.userData.bodyGroup = bodyGroup;
  group.userData.altitudeColumnGroup = columnGroup;
  group.userData.altitudeStem = stem;
  group.userData.groundRing = groundRing;
  group.userData.bowl = bowl;

  scene.add(group);
  return group;
}

// Sync planes with props.origin + props.planes
function syncPlanes() {
  if (!scene) return;

  const origin = props.origin;
  const planes = props.planes || [];

  // No origin -> clear planes
  if (!origin) {
    for (const [, group] of planeGroups.entries()) {
      scene.remove(group);
    }
    planeGroups.clear();
    return;
  }

  const seenIds = new Set();
  const MAX_RADIUS = 300_000; // 300 km horizontal radius

  for (const plane of planes) {
    if (plane.lat == null || plane.lng == null) continue;

    const altMeters = plane.alt ?? 0;
    const pos = latLonAltToLocalENU(plane.lat, plane.lng, altMeters, origin);

    // Limit to a certain radius in the horizontal plane
    const radius2D = Math.hypot(pos.x, pos.z); // X=east, Z=north
    if (radius2D > MAX_RADIUS) continue;

    let group = planeGroups.get(plane.id);
    if (!group) {
      group = createPlaneGroup(plane.id);
      planeGroups.set(plane.id, group);
    }

    // Position in ENU
    group.position.copy(pos);

    // Heading: 0° = north, clockwise; our Z=north, X=east
    if (plane.heading != null) {
      const yawRad = THREE.MathUtils.degToRad(-plane.heading);
      group.rotation.set(0, yawRad, 0);
    }

    // ---- ALTITUDE COLUMN UPDATE ----
    const stem = group.userData.altitudeStem;
    const columnGroup = group.userData.altitudeColumnGroup;
    const groundRing = group.userData.groundRing;

    if (stem && columnGroup && groundRing) {
      const altitudeY = pos.y; // already alt * ALT_SCALE

      // if altitude is <= 0, hide the column
      if (altitudeY <= 0) {
        stem.visible = false;
        groundRing.visible = false;
      } else {
        stem.visible = true;
        groundRing.visible = true;

        // Column:
        // - we want top at plane altitude
        // - bottom at ground (y=0)
        //
        // columnGroup is anchored at plane group origin (the plane),
        // so:
        //   - move the group halfway down,
        //   - scale the unit-height stem to full altitude.
        columnGroup.position.set(0, -altitudeY / 2, 0);
        stem.scale.set(1, altitudeY, 1); // geom height=1 → total height=altitudeY

        // Ground ring: same x/z as plane, y=0 in world
        groundRing.position.set(0, -altitudeY, 0);
      }
    }

    seenIds.add(plane.id);
    // console.log("planes ENU", plane.id, pos);
  }

  // Remove planes that disappeared
  for (const [id, group] of planeGroups.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(group);
      planeGroups.delete(id);
    }
  }

  // console.log("origin", origin);
}

// ---------------------------------------------------------------------
// Environment helpers (rings, axis, compass, labels)
// ---------------------------------------------------------------------

// function createCompassLabels(radius, createTextSprite) {
//   const group = new THREE.Group();
//   const offsetY = 200;

//   const directions = [
//     { label: "N", pos: new THREE.Vector3(0, offsetY, radius) },
//     { label: "E", pos: new THREE.Vector3(radius, offsetY, 0) },
//     { label: "S", pos: new THREE.Vector3(0, offsetY, -radius) },
//     { label: "W", pos: new THREE.Vector3(-radius, offsetY, 0) },
//   ];

//   for (const dir of directions) {
//     const sprite = createTextSprite(dir.label, {
//       fontSize: 64,
//       padding: 10,
//     });
//     sprite.position.copy(dir.pos);
//     group.add(sprite);

//     labelsApi.registerLabelSprite(sprite, { sizeMultiplier: 1.0 });
//   }

//   return group;
// }

// ---------------------------------------------------------------------
// Init + lifecycle
// ---------------------------------------------------------------------

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
  syncPlanes();
});

watch(
  () => [props.origin, props.planes],
  () => {
    syncPlanes();
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

  for (const [, group] of planeGroups.entries()) {
    scene && scene.remove(group);
  }
  planeGroups.clear();

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
