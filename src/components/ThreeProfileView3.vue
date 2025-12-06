<template>
  <div class="three-container">
    <canvas ref="canvasEl"></canvas>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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
    default: 90, // 90° = East (in our system)
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

const rangeLabelSprites = [];
const planeGroups = new Map(); // id -> THREE.Group

// We'll keep a reference to the cone & wire so we can reorient later
let coverageCone = null;
let coverageWire = null;

// === GIZMO STATE ===
let gizmoScene = null;
let gizmoCamera = null;
let gizmoAxesHelper = null;
let gizmoRoot = null;

// ---------------------------------------------------------------------
// Coordinate + plane helpers
// ---------------------------------------------------------------------

const R = 6371000; // Earth radius (approx)
const deg2rad = Math.PI / 180;

function latLonAltToLocalENU(lat, lon, alt, origin) {
  const phi0 = origin.lat * deg2rad;
  const lam0 = origin.lng * deg2rad;

  const phi = lat * deg2rad;
  const lam = lon * deg2rad;

  const dPhi = phi - phi0;
  const dLam = lam - lam0;

  const xEast = R * dLam * Math.cos(phi0); // meters east
  const zNorth = R * dPhi; // meters north
  const yUp = alt; // meters up (relative)

  // Map to Three.js: X=east, Y=up, Z=north
  return new THREE.Vector3(xEast, yUp, zNorth);
}

// Label sprite (used for rings + altitude ticks + plane labels)
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

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest: true,
    depthWrite: false,
    transparent: true,
  });

  const sprite = new THREE.Sprite(material);

  const baseScale = 1;
  const baseWidth = baseScale * (boxWidth / canvas.width);
  const baseHeight = baseScale * (boxHeight / canvas.height);

  sprite.scale.set(baseWidth, baseHeight, 1);
  sprite.userData.aspect = baseWidth / baseHeight || 1;

  return sprite;
}

// Plane mesh + label group
function createPlaneGroup(planeId) {
  const group = new THREE.Group();

  const bodyGeom = new THREE.BoxGeometry(600, 200, 1000);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffaa00,
    metalness: 0.2,
    roughness: 0.5,
  });
  const mesh = new THREE.Mesh(bodyGeom, bodyMat);

  // Shift so rotation feels like nose-first
  mesh.geometry.translate(0, 0, -400);

  group.add(mesh);

  // Label above plane
  const label = createTextSprite(String(planeId), {
    fontSize: 48,
    padding: 8,
  });
  label.position.set(0, 800, 0);
  group.add(label);

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
  const MAX_RADIUS = 150_000; // 150 km horizontal radius

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

    // Position
    group.position.copy(pos);

    // Heading: 0° = north, clockwise; our Z=north, X=east
    if (plane.heading != null) {
      const yawRad = THREE.MathUtils.degToRad(-plane.heading);
      group.rotation.set(0, yawRad, 0);
    }

    seenIds.add(plane.id);
  }

  // Remove planes that disappeared
  for (const [id, group] of planeGroups.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(group);
      planeGroups.delete(id);
    }
  }
}

// ---------------------------------------------------------------------
// Environment helpers (rings, axis, compass, labels)
// ---------------------------------------------------------------------

function createRangeRing(
  radius,
  segments = 128,
  color = 0x444444,
  opacity = 0.5
) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(
      new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
    ); // XZ plane
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
  });

  return new THREE.LineLoop(geometry, material);
}

function addRangeRingWithLabel(
  scene,
  radiusMeters,
  { segments = 128, color = 0x339966, opacity = 0.55 } = {}
) {
  const ring = createRangeRing(radiusMeters, segments, color, opacity);
  ring.position.y = 2;
  scene.add(ring);

  const km = Math.round(radiusMeters / 1000);
  const labelText = `${km} km`;

  const LABEL_HEIGHT = 4000;
  const LABEL_OFFSET = 5000;

  const makeLabelSprite = (xSign) => {
    const sprite = createTextSprite(labelText, {
      fontSize: 150,
      padding: 0,
    });

    const x = xSign * (radiusMeters + LABEL_OFFSET);
    sprite.position.set(x, LABEL_HEIGHT, 0);

    scene.add(sprite);
    rangeLabelSprites.push(sprite);
  };

  makeLabelSprite(+1);
  makeLabelSprite(-1);
}

// function createAltitudeAxis(maxAlt = 12000, step = 2000) {
//   const group = new THREE.Group();

//   const mainMat = new THREE.LineBasicMaterial({ color: 0x66aaff });
//   const mainPoints = [
//     new THREE.Vector3(0, 0, 0),
//     new THREE.Vector3(0, maxAlt, 0),
//   ]; // Y is up
//   const mainGeom = new THREE.BufferGeometry().setFromPoints(mainPoints);
//   const mainLine = new THREE.Line(mainGeom, mainMat);
//   group.add(mainLine);

//   const tickMat = new THREE.LineBasicMaterial({ color: 0x66aaff });
//   const tickHalfLength = 2000;

//   for (let alt = step; alt <= maxAlt; alt += step) {
//     const tickPoints = [
//       new THREE.Vector3(-tickHalfLength, alt, 0),
//       new THREE.Vector3(+tickHalfLength, alt, 0),
//     ];
//     const tickGeom = new THREE.BufferGeometry().setFromPoints(tickPoints);
//     const tickLine = new THREE.Line(tickGeom, tickMat);
//     group.add(tickLine);

//     const labelText = `${alt.toLocaleString()} m`;
//     const sprite = createTextSprite(labelText, {
//       fontSize: 48,
//       padding: 6,
//     });
//     sprite.position.set(tickHalfLength + 2500, alt, 0);
//     group.add(sprite);
//   }

//   return group;
// }

function createAltitudeAxis(maxAlt = 12000, step = 2000) {
  const group = new THREE.Group();

  const mainMat = new THREE.LineBasicMaterial({ color: 0x66aaff });
  const mainPoints = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, maxAlt, 0),
  ]; // Y is up
  const mainGeom = new THREE.BufferGeometry().setFromPoints(mainPoints);
  const mainLine = new THREE.Line(mainGeom, mainMat);
  group.add(mainLine);

  const tickMat = new THREE.LineBasicMaterial({ color: 0x66aaff });
  const tickHalfLength = 2000;

  for (let alt = step; alt <= maxAlt; alt += step) {
    const tickPoints = [
      new THREE.Vector3(-tickHalfLength, alt, 0),
      new THREE.Vector3(+tickHalfLength, alt, 0),
    ];
    const tickGeom = new THREE.BufferGeometry().setFromPoints(tickPoints);
    const tickLine = new THREE.Line(tickGeom, tickMat);
    group.add(tickLine);

    const labelText = `${alt.toLocaleString()} m`;
    const sprite = createTextSprite(labelText, {
      fontSize: 48,
      padding: 6,
    });
    sprite.position.set(tickHalfLength + 2500, alt, 0);

    // 🔹 give it a visible world size
    const aspect = sprite.userData.aspect || 2;
    const worldHeight = 6000; // 6 km tall, tweak to taste
    const worldWidth = worldHeight * aspect;
    sprite.scale.set(worldWidth, worldHeight, 1);

    // optional: always visible over lines
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;

    group.add(sprite);
  }

  return group;
}

function createCompassLabels(radius) {
  const group = new THREE.Group();
  const offsetY = 200;

  const directions = [
    { label: "N", pos: new THREE.Vector3(0, offsetY, radius) },
    { label: "E", pos: new THREE.Vector3(radius, offsetY, 0) },
    { label: "S", pos: new THREE.Vector3(0, offsetY, -radius) },
    { label: "W", pos: new THREE.Vector3(-radius, offsetY, 0) },
  ];

  for (const dir of directions) {
    const sprite = createTextSprite(dir.label, {
      fontSize: 64,
      padding: 10,
    });
    sprite.position.copy(dir.pos);
    group.add(sprite);
  }

  return group;
}

function updateRangeLabelScales() {
  if (!camera) return;

  const baseScreenFactor = 0.05;
  const minScale = 4000;
  const maxScale = 40000;

  for (const sprite of rangeLabelSprites) {
    if (!sprite) continue;

    const dist = camera.position.distanceTo(sprite.position);

    let worldHeight = dist * baseScreenFactor;
    if (worldHeight < minScale) worldHeight = minScale;
    if (worldHeight > maxScale) worldHeight = maxScale;

    const aspect = sprite.userData.aspect || 2;
    const worldWidth = worldHeight * aspect;

    sprite.scale.set(worldWidth, worldHeight, 1);
  }
}

function createGizmoLabel(text, x, y, z) {
  const sprite = createTextSprite(text, { fontSize: 64, padding: 8 });
  sprite.position.set(x, y, z);

  const aspect = sprite.userData.aspect || 2;

  // 🔹 BIG size in gizmo units
  const height = 1.8; // try 1.8–2.2
  const width = height * aspect;
  sprite.scale.set(width, height, 1);

  if (sprite.material) {
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;
  }

  return sprite;
}

// ---------------------------------------------------------------------
// Coverage cone orientation (azimuth + elevation)
// ---------------------------------------------------------------------

const groundClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y >= 0
const baseDir = new THREE.Vector3(1, 0, 0); // +X is "default" cone axis

function setCoverageOrientation(coneMesh, wireMesh, azDeg, elDeg) {
  const az = THREE.MathUtils.degToRad(azDeg);
  const el = THREE.MathUtils.degToRad(elDeg);

  const cosEl = Math.cos(el);
  const dir = new THREE.Vector3(
    cosEl * Math.sin(az), // X (east)
    Math.sin(el), // Y (up)
    cosEl * Math.cos(az) // Z (north); 0°=north, 90°=east
  ).normalize();

  const quat = new THREE.Quaternion().setFromUnitVectors(baseDir, dir);
  coneMesh.quaternion.copy(quat);
  if (wireMesh) wireMesh.quaternion.copy(quat);
}

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
  camera.lookAt(0, 4000, 0);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 4000, 0);
  controls.enablePan = true;
  controls.minDistance = 8000;
  controls.maxDistance = 500000;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.enableDamping = true;
  controls.dampingFactor = 0.5;

  // Lights
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(30000, 60000, -40000);
  scene.add(dirLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // Ground
  const GROUND_SIZE = 400000; // 400 km
  const groundGeom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  const groundMat = new THREE.MeshPhongMaterial({
    color: 0x050814,
    side: THREE.FrontSide,
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(150000, 0, 0); // 50km behind, rest in front
  scene.add(ground);

  // Grid
  const gridSize = GROUND_SIZE;
  const gridDivisions = 60;
  const grid = new THREE.GridHelper(
    gridSize,
    gridDivisions,
    0x00ffff, // center liens
    0xc4c4c5 // regular lines
  );
  grid.position.set(150000, 1, 0);
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  scene.add(grid);

  // Range rings
  const ringRadii = [50000, 100000, 150000, 200000, 250000, 300000];
  for (const radius of ringRadii) {
    addRangeRingWithLabel(scene, radius, {
      color: 0x339966,
      opacity: 0.55,
    });
  }

  // Compass + altitude axis + origin
  const compass = createCompassLabels(ringRadii[ringRadii.length - 1] + 8000);
  scene.add(compass);

  const altitudeAxis = createAltitudeAxis(12000, 2000);
  scene.add(altitudeAxis);

  const originSphereGeom = new THREE.SphereGeometry(600, 24, 24);
  const originSphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const originSphere = new THREE.Mesh(originSphereGeom, originSphereMat);
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
  debugBox.position.set(80_000, 2_000, 0); // X=80km, Y=2000m, Z=0
  scene.add(debugBox);

  // Coverage cone geometry (apex at origin, axis along +X by default)
  const coverageHeight = 300000;
  const halfAngleRad = Math.PI / 4;
  const coverageRadius = coverageHeight * Math.tan(halfAngleRad);

  const coverageBaseGeom = new THREE.ConeGeometry(
    coverageRadius,
    coverageHeight,
    48,
    1,
    true
  );
  // Move apex from +H/2 down to 0
  coverageBaseGeom.translate(0, -coverageHeight / 2, 0);
  // Rotate axis from +Y to +X (our baseDir)
  coverageBaseGeom.rotateZ(Math.PI / 2);

  const coverageMat = new THREE.MeshBasicMaterial({
    color: 0x00ffcc,
    transparent: true,
    opacity: 0.06,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    clippingPlanes: [groundClipPlane], // y >= 0
  });

  coverageCone = new THREE.Mesh(coverageBaseGeom, coverageMat);
  scene.add(coverageCone);

  const wireGeom = new THREE.WireframeGeometry(coverageBaseGeom);
  const wireMat = new THREE.LineBasicMaterial({
    color: 0x00ffcc,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
    clippingPlanes: [groundClipPlane],
  });
  coverageWire = new THREE.LineSegments(wireGeom, wireMat);
  scene.add(coverageWire);

  // Initial orientation from props (azimuth/elevation)
  setCoverageOrientation(
    coverageCone,
    coverageWire,
    props.coverageAzimuthDeg,
    props.coverageElevationDeg
  );

  // === GIZMO INIT (mini axes top-left) ===
  gizmoScene = new THREE.Scene();
  // wider far plane + camera a bit further back
  gizmoCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  gizmoCamera.position.set(0, 0, 8);
  gizmoCamera.lookAt(0, 0, 0);

  // Root that we will rotate
  gizmoRoot = new THREE.Group();
  // 🔹 no extra scale here – keep units small & controlled
  // gizmoRoot.scale.set(2.0, 2.0, 2.0);
  gizmoScene.add(gizmoRoot);

  // smaller axes helper, fits comfortably in view
  gizmoAxesHelper = new THREE.AxesHelper(2.5); // X red, Y green, Z blue
  gizmoRoot.add(gizmoAxesHelper);

  // optional text labels: E (X+), N (Z+), UP (Y+)
  const gizmoLabels = new THREE.Group();

  gizmoLabels.add(createGizmoLabel("E", 2.8, 0, 0)); // +X (east)
  gizmoLabels.add(createGizmoLabel("N", 0, 0, 2.8)); // +Z (north)
  gizmoLabels.add(createGizmoLabel("UP", 0, 2.8, 0)); // +Y (up)

  gizmoRoot.add(gizmoLabels);

  window.addEventListener("resize", onWindowResize);

  //   const tick = () => {
  //     if (!renderer || !scene || !camera) return;

  //     controls && controls.update();
  //     updateRangeLabelScales();
  //     renderer.render(scene, camera);

  //     animationId = requestAnimationFrame(tick);
  //   };
  const tick = () => {
    if (!renderer || !scene || !camera) return;

    controls && controls.update();
    updateRangeLabelScales();

    // main scene render
    const size = new THREE.Vector2();
    renderer.getSize(size);
    const width = size.x;
    const height = size.y;

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.render(scene, camera);

    // gizmo render in top-left corner
    if (gizmoScene && gizmoCamera) {
      const insetSize = Math.min(width, height) * 0.24;
      const margin = 16;
      const insetX = margin;
      const insetY = height - insetSize - margin;

      renderer.clearDepth(); // draw on top of main scene
      renderer.setScissorTest(true);
      renderer.setScissor(insetX, insetY, insetSize, insetSize);
      renderer.setViewport(insetX, insetY, insetSize, insetSize);

      // keep camera fixed looking at origin
      gizmoCamera.position.set(0, 0, 8);
      gizmoCamera.lookAt(0, 0, 0);

      // rotate axes to match main camera orientation
      if (gizmoRoot) {
        gizmoRoot.quaternion.copy(camera.quaternion);
      }

      renderer.render(gizmoScene, gizmoCamera);
      renderer.setScissorTest(false);
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
    if (coverageCone && coverageWire) {
      setCoverageOrientation(coverageCone, coverageWire, az, el);
    }
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

  if (renderer) {
    renderer.dispose();
    renderer = null;
  }

  scene = null;
  camera = null;
  controls = null;
  gizmoScene = null;
  gizmoCamera = null;
  gizmoAxesHelper = null;
});
</script>

<style scoped>
.three-container {
  width: 100%;
  height: 100%;
  background: #02030a;
  color: #c4c4c5;
  display: flex;
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
