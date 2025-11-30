<template>
  <div class="three-container">
    <canvas ref="canvasEl"></canvas>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const canvasEl = ref(null);

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let animationId = null;
const rangeLabelSprites = [];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

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

  const baseScale = 1; // we'll control absolute size later
  const baseWidth = baseScale * (boxWidth / canvas.width);
  const baseHeight = baseScale * (boxHeight / canvas.height);

  sprite.scale.set(baseWidth, baseHeight, 1);
  sprite.userData.aspect = baseWidth / baseHeight || 1;

  return sprite;
}

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
    );
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
  });

  return new THREE.LineLoop(geometry, material);
}

/**
 * Create a range ring + a distance label in km.
 */
function addRangeRingWithLabel(
  scene,
  radiusMeters,
  { segments = 128, color = 0x339966, opacity = 0.55 } = {}
) {
  // Ring itself
  const ring = createRangeRing(radiusMeters, segments, color, opacity);
  ring.position.y = 2;
  scene.add(ring);

  // Label: show distance in km, e.g. "50 km"
  const km = Math.round(radiusMeters / 1000);
  const labelText = `${km} km`;

  const LABEL_HEIGHT = 4000; // a bit above the floor
  const LABEL_OFFSET = 5000; // small offset outside the ring

  // Helper for creating + positioning one label sprite
  const makeLabelSprite = (xSign) => {
    const sprite = createTextSprite(labelText, {
      fontSize: 150,
      padding: 0,
    });

    const x = xSign * (radiusMeters + LABEL_OFFSET);
    sprite.position.set(x, LABEL_HEIGHT, 0);

    scene.add(sprite);

    // If you’re using the dynamic scaling we added earlier:
    if (typeof rangeLabelSprites !== "undefined") {
      rangeLabelSprites.push(sprite);
    }
  };

  // Create one label on +X side and one on -X side
  makeLabelSprite(+1);
  makeLabelSprite(-1);
}

function createAltitudeAxis(maxAlt = 12000, step = 2000) {
  const group = new THREE.Group();

  const mainMat = new THREE.LineBasicMaterial({ color: 0x66aaff });
  const mainPoints = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, maxAlt, 0),
  ];
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

  // tune these to your taste
  const baseScreenFactor = 0.05; // bigger = larger labels
  const minScale = 4000; // clamp min world height
  const maxScale = 40000; // clamp max world height

  for (const sprite of rangeLabelSprites) {
    if (!sprite) continue;

    const dist = camera.position.distanceTo(sprite.position);

    // world-space height proportional to distance
    let worldHeight = dist * baseScreenFactor;
    if (worldHeight < minScale) worldHeight = minScale;
    if (worldHeight > maxScale) worldHeight = maxScale;

    const aspect = sprite.userData.aspect || 2;
    const worldWidth = worldHeight * aspect;

    sprite.scale.set(worldWidth, worldHeight, 1);
  }
}

// ---------------------------------------------------------------------
// Init + lifecycle
// ---------------------------------------------------------------------

const groundClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

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
  // Remove fog for now so environment stays crisp when zooming out
  // scene.fog = new THREE.FogExp2(0x02030a, 0.000004);

  // Camera
  camera = new THREE.PerspectiveCamera(60, width / height, 50, 1_000_000);
  // Start in a position that sees more of the coverage side, less "behind"
  camera.position.set(120000, 80000, -200000);
  camera.lookAt(0, 4000, 0);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 4000, 0);
  controls.enablePan = true;
  controls.minDistance = 8000;
  controls.maxDistance = 400000; // can zoom out well beyond coverage
  // Prevent going under the floor: always above "horizon"
  controls.minPolarAngle = 0.2; // not perfectly top-down
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // never below horizon
  controls.enableDamping = true;
  controls.dampingFactor = 0.5;

  // Lights
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(30000, 60000, -40000);
  scene.add(dirLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // --- Solid ground so nothing is visible "below" the floor ---
  const GROUND_SIZE = 400000; // 400 km square
  const groundGeom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  const groundMat = new THREE.MeshPhongMaterial({
    color: 0x050814,
    side: THREE.FrontSide, // we never see the underside anyway
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  // ground.position.y = 0;
  ground.position.set(-150000, 0, 0);
  // X center at -100000, so X ∈ [-300000, +100000]

  scene.add(ground);

  // Grid slightly above ground to avoid z-fighting
  const gridSize = GROUND_SIZE;
  const gridDivisions = 60;
  const grid = new THREE.GridHelper(
    gridSize,
    gridDivisions,
    0x00ffff,
    0xc4c4c5
  );
  grid.position.y = 1;
  grid.position.set(-150000, 1, 0); // same X offset, y=1 to avoid z-fighting
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  scene.add(grid);

  // Range rings + distance labels (in km)
  const ringRadii = [50000, 100000, 150000, 200000, 250000, 300000];

  for (const radius of ringRadii) {
    addRangeRingWithLabel(scene, radius, {
      color: 0x339966,
      opacity: 0.55,
    });
  }

  // Compass labels at outer ring
  const compass = createCompassLabels(ringRadii[ringRadii.length - 1] + 8000);
  scene.add(compass);

  // Altitude axis
  const altitudeAxis = createAltitudeAxis(12000, 2000);
  scene.add(altitudeAxis);

  // Origin point
  const originSphereGeom = new THREE.SphereGeometry(600, 24, 24);
  const originSphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const originSphere = new THREE.Mesh(originSphereGeom, originSphereMat);
  originSphere.position.set(0, 0, 0);
  scene.add(originSphere);

  // Coverage cone: 200 km, ~45° opening, pointing WEST (−X), only above the floor
  const coverageHeight = 300000;
  const halfAngleRad = Math.PI / 4;
  const coverageRadius = coverageHeight * Math.tan(halfAngleRad);

  const coverageGeom = new THREE.ConeGeometry(
    coverageRadius,
    coverageHeight,
    48, // a bit smoother
    1,
    true // openEnded: no base cap
  );

  // Move apex to origin (0,0,0), base away along -Y first
  coverageGeom.translate(0, -coverageHeight / 2, 0);

  // Very subtle transparent material, clipped by the ground plane
  const coverageMat = new THREE.MeshBasicMaterial({
    color: 0x00ffcc,
    transparent: true,
    opacity: 0.06, // << much lower opacity
    depthWrite: false, // let other objects render correctly with transparency
    depthTest: true,
    side: THREE.DoubleSide,
    clippingPlanes: [groundClipPlane],
  });

  const coverageCone = new THREE.Mesh(coverageGeom, coverageMat);

  // Rotate so the cone axis points roughly along −X instead of −Y:
  coverageCone.rotation.z = -Math.PI / 2;

  scene.add(coverageCone);

  // Optional: wireframe outline (also clipped above the floor)
  const wireGeom = new THREE.WireframeGeometry(coverageGeom);
  const wireMat = new THREE.LineBasicMaterial({
    color: 0x00ffcc,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
    clippingPlanes: [groundClipPlane],
  });
  const coverageWire = new THREE.LineSegments(wireGeom, wireMat);
  coverageWire.rotation.z = -Math.PI / 2;
  scene.add(coverageWire);

  window.addEventListener("resize", onWindowResize);

  const tick = () => {
    if (!renderer || !scene || !camera) return;

    controls && controls.update();
    updateRangeLabelScales();
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
});

onBeforeUnmount(() => {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
  }
  window.removeEventListener("resize", onWindowResize);

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
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
