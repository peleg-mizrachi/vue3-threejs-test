<template>
  <div class="three-container">
    <canvas ref="canvasEl"></canvas>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import L from "leaflet";

const props = defineProps({
  origin: {
    type: Object, // { lat, lng } or null
    default: null,
  },
  planes: {
    type: Array, // [{ id, lat, lng, alt, heading? }]
    default: () => [],
  },
});

const canvasEl = ref(null);

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let animationId = null;

// Plane instances: id -> THREE.Group (mesh + label)
const planeGroups = new Map();

// --- Helpers -------------------------------------------------------------

// Convert (lat,lng,alt) to local coords (X=east, Y=up, Z=north)
function latLngAltToLocal(lat, lng, alt, origin) {
  if (!origin) return new THREE.Vector3(0, 0, 0);

  const crs = L.CRS.EPSG3857;

  const originPoint = crs.project(L.latLng(origin.lat, origin.lng));
  const planePoint = crs.project(L.latLng(lat, lng));

  const dx = planePoint.x - originPoint.x; // east-west
  const dz = planePoint.y - originPoint.y; // north-south

  // X = east, Y = up, Z = north
  return new THREE.Vector3(dx, alt, dz);
}

// Create a text label as a sprite
function createTextSprite(text) {
  const fontSize = 48;
  const border = 8;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  canvas.width = 512;
  canvas.height = 256;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.font = `bold ${fontSize}px system-ui`;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;

  const boxWidth = textWidth + border * 2;
  const boxHeight = fontSize + border * 2;

  const x = (canvas.width - boxWidth) / 2;
  const y = (canvas.height - boxHeight) / 2;

  // Background
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(x, y, boxWidth, boxHeight, 16);
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(material);

  // Scale sprite to readable size in world units
  const scale = 1200;
  sprite.scale.set(
    scale * (boxWidth / canvas.width),
    scale * (boxHeight / canvas.height),
    1
  );

  return sprite;
}

// Create a group containing plane mesh + label
function createPlaneGroup(planeId) {
  const group = new THREE.Group();

  const bodyGeom = new THREE.BoxGeometry(600, 200, 1000);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffaa00,
    metalness: 0.2,
    roughness: 0.5,
  });
  const mesh = new THREE.Mesh(bodyGeom, bodyMat);

  // Shift geometry so rotation feels like nose-first
  mesh.geometry.translate(0, 0, -400);

  group.add(mesh);

  // Label above plane
  const label = createTextSprite(planeId);
  label.position.set(0, 800, 0); // 800m above plane body
  group.add(label);

  scene.add(group);
  return group;
}

// Sync plane groups with props.planes + props.origin
function syncPlanes() {
  if (!scene) return;

  const origin = props.origin;
  const planes = props.planes || [];

  // If no origin – clear everything
  if (!origin) {
    for (const [id, group] of planeGroups.entries()) {
      scene.remove(group);
    }
    planeGroups.clear();
    return;
  }

  const seenIds = new Set();
  const MAX_RADIUS = 150_000; // 150 km radius

  for (const plane of planes) {
    if (plane.lat == null || plane.lng == null) continue;

    const altMeters = plane.alt ?? 0;
    const pos = latLngAltToLocal(plane.lat, plane.lng, altMeters, origin);
    const radius2D = Math.hypot(pos.x, pos.z);
    if (radius2D > MAX_RADIUS) continue;

    let group = planeGroups.get(plane.id);
    if (!group) {
      group = createPlaneGroup(plane.id);
      planeGroups.set(plane.id, group);
    }

    // Position & heading
    group.position.copy(pos);

    if (plane.heading != null) {
      // heading deg: 0 = north, clockwise. Our Z=north, X=east.
      const yawRad = THREE.MathUtils.degToRad(-plane.heading);
      group.rotation.set(0, yawRad, 0);
    }

    seenIds.add(plane.id);
  }

  // Remove groups for planes that are gone
  for (const [id, group] of planeGroups.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(group);
      planeGroups.delete(id);
    }
  }
}

// --- Init + lifecycle ----------------------------------------------------

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

  // enable local clipping (so materials can clip with a plane)
  renderer.localClippingEnabled = true;

  // Plane y = 0, with normal pointing up – we keep the y > 0 side
  const floorClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02030a);

  // Camera: start a bit “south” and above, looking at origin
  camera = new THREE.PerspectiveCamera(60, width / height, 50, 800000);
  camera.position.set(0, 8000, -30000); // 30km south, 8km up
  camera.lookAt(0, 5000, 0);

  // OrbitControls, locked on center
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 5000, 0); // focus a bit above ground
  controls.enablePan = false; // no panning, always orbit around origin
  controls.minDistance = 5000;
  controls.maxDistance = 150_000;
  controls.maxPolarAngle = Math.PI * 0.95;

  // Lights
  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(3000, 8000, -5000);
  scene.add(dirLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  // Ground grid
  const grid = new THREE.GridHelper(50_000, 25, 0x444444, 0x222222);
  scene.add(grid);

  // Altitude axis at origin
  const altitudeMaterial = new THREE.LineBasicMaterial({ color: 0x5555ff });
  const altitudePoints = [];
  altitudePoints.push(new THREE.Vector3(0, 0, 0));
  altitudePoints.push(new THREE.Vector3(0, 12_000, 0));
  const altitudeGeometry = new THREE.BufferGeometry().setFromPoints(
    altitudePoints
  );
  const altitudeLine = new THREE.Line(altitudeGeometry, altitudeMaterial);
  scene.add(altitudeLine);

  // Origin “observer” sphere
  const originSphereGeom = new THREE.SphereGeometry(200, 16, 16);
  const originSphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const originSphere = new THREE.Mesh(originSphereGeom, originSphereMat);
  originSphere.position.set(0, 0, 0);
  scene.add(originSphere);

  // Coverage cone: 200 km range, ~45° opening, pointing WEST (−X)
  const coverageHeight = 200_000; // 200 km “length” from origin
  const halfAngleRad = Math.PI / 4; // 45° half-angle
  const coverageRadius = coverageHeight * Math.tan(halfAngleRad); // also ≈ 200 km

  const coverageGeom = new THREE.ConeGeometry(
    coverageRadius, // radius at far end
    coverageHeight, // axis length
    32,
    1,
    true // open-ended (no cap)
  );

  // Default cone: apex at (0, +H/2, 0), base at (0, −H/2, 0).
  // We want:
  //   - apex exactly at origin
  //   - base “forward” along −X
  //
  // 1) Move apex down from +H/2 to 0, so base ends at y = −H:
  coverageGeom.translate(0, -coverageHeight / 2, 0);

  const coverageMat = new THREE.MeshBasicMaterial({
    color: 0x00ffcc,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
    clippingPlanes: [floorClipPlane], // hide anything below y = 0
  });

  const coverageCone = new THREE.Mesh(coverageGeom, coverageMat);

  // 2) Rotate so axis (apex → base) points along −X instead of −Y.
  // After the translate, axis is (0, −1, 0) = −Y.
  // Rotating around Z by −90° (−π/2) sends −Y to −X.
  coverageCone.rotation.z = -Math.PI / 2;

  scene.add(coverageCone);

  // Resize handler
  window.addEventListener("resize", onWindowResize);

  // Animation loop
  const tick = () => {
    if (!renderer || !scene || !camera) return;

    controls && controls.update();
    renderer.render(scene, camera);

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

onBeforeUnmount(() => {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
  }
  window.removeEventListener("resize", onWindowResize);

  // Clean plane groups
  for (const [, group] of planeGroups.entries()) {
    scene && scene.remove(group);
  }
  planeGroups.clear();

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
  display: flex;
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
