<template>
  <div class="three-container">
    <canvas ref="canvasEl"></canvas>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ViewportGizmo } from "three-viewport-gizmo";

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

const labelSprites = []; // all world-space text labels (range rings, altitude, etc.)
const rangeRingLabels = []; // { sprite, radiusMeters, side: "front" | "back", labelHeight: number }

function registerLabelSprite(sprite, { sizeMultiplier = 1 } = {}) {
  sprite.userData.labelSizeMultiplier = sizeMultiplier; // e.g. 1 for range, 0.8 for altitude
  labelSprites.push(sprite);
}
const planeGroups = new Map(); // id -> THREE.Group

let originSphere = null;

// "sensor view" state
let isFixedPointView = false;

const savedView = {
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
  controls: {
    enableRotate: true,
    enablePan: true,
    enableZoom: true,
    minDistance: 8000,
    maxDistance: 500000,
  },
};

const GROUND_SIZE = 400000; // 400 km square
const GROUND_HALF = GROUND_SIZE / 2;
const BACK_MARGIN = 50_000; // 50 km "behind" the origin

let ground = null;
let grid = null;

// These 4 planes define the "inside" of the ground square
const ringClipPlanes = [
  new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), // x >= minX
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0), // x <= maxX
  new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), // z >= minZ
  new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), // z <= maxZ
];

// direction of coverage cone axis in world space
const coverageDir = new THREE.Vector3(1, 0, 0);

// shared raycasting helpers
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

// reuse same height used for coverage
const COVERAGE_HEIGHT = 300000;

// We'll keep a reference to the cone & wire so we can reorient later
let coverageCone = null;
let coverageWire = null;

let gizmo = null;

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

// // Plane mesh + label group
// function createPlaneGroup(planeId) {
//   const group = new THREE.Group();

//   const bodyGeom = new THREE.BoxGeometry(5000, 5000, 5000);
//   const bodyMat = new THREE.MeshStandardMaterial({
//     color: 0xffaa00,
//     metalness: 0.2,
//     roughness: 0.5,
//   });
//   const mesh = new THREE.Mesh(bodyGeom, bodyMat);

//   // Shift so rotation feels like nose-first
//   mesh.geometry.translate(0, 0, -400);

//   group.add(mesh);

//   // Label above plane
//   const label = createTextSprite(String(planeId), {
//     fontSize: 48,
//     padding: 8,
//   });
//   label.position.set(0, 800, 0);
//   group.add(label);

//   scene.add(group);
//   return group;
// }

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
  const label = createTextSprite(String(planeId), {
    fontSize: 48,
    padding: 8,
  });
  label.position.set(0, 800, 0);
  bodyGroup.add(label);

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
    console.log("planes ENU", plane.id, pos);
  }

  // Remove planes that disappeared
  for (const [id, group] of planeGroups.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(group);
      planeGroups.delete(id);
    }
  }

  console.log("origin", origin);
}

// ---------------------------------------------------------------------
// Environment helpers (rings, axis, compass, labels)
// ---------------------------------------------------------------------

function updateGroundAndGridPlacement() {
  if (!ground || !grid) return;

  // Project coverageDir onto horizontal plane (XZ)
  const dirProj = new THREE.Vector3(coverageDir.x, 0, coverageDir.z);
  if (dirProj.lengthSq() < 1e-6) {
    // coverage pointing straight up/down -> fall back to +X
    dirProj.set(1, 0, 0);
  } else {
    dirProj.normalize();
  }

  // We want ~50 km behind the origin, rest in front.
  // With a 400 km square: half = 200 km
  // center offset = half - BACK_MARGIN = 200 - 50 = 150 km
  const offsetDist = GROUND_HALF - BACK_MARGIN; // 150 km
  const offset = dirProj.multiplyScalar(offsetDist);

  ground.position.set(offset.x, 0, offset.z);
  grid.position.set(offset.x, 1, offset.z);

  // 🔹 Update clipping planes so rings are only visible inside [minX,maxX] × [minZ,maxZ]
  const minX = ground.position.x - GROUND_HALF;
  const maxX = ground.position.x + GROUND_HALF;
  const minZ = ground.position.z - GROUND_HALF;
  const maxZ = ground.position.z + GROUND_HALF;

  // plane 0: x >= minX
  ringClipPlanes[0].constant = -minX; // distance = x - minX

  // plane 1: x <= maxX
  ringClipPlanes[1].constant = maxX; // distance = -x + maxX

  // plane 2: z >= minZ
  ringClipPlanes[2].constant = -minZ; // distance = z - minZ

  // plane 3: z <= maxZ
  ringClipPlanes[3].constant = maxZ; // distance = -z + maxZ
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
    ); // XZ plane
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    clippingPlanes: ringClipPlanes, // only draw inside ground square
  });

  return new THREE.LineLoop(geometry, material);
}

// function addRangeRingWithLabel(
//   scene,
//   radiusMeters,
//   { segments = 128, color = 0x339966, opacity = 0.55 } = {}
// ) {
//   const ring = createRangeRing(radiusMeters, segments, color, opacity);
//   ring.position.y = 2;
//   scene.add(ring);

//   const km = Math.round(radiusMeters / 1000);
//   const labelText = `${km} km`;

//   const LABEL_HEIGHT = 4000;
//   const LABEL_OFFSET = 5000;

//   const makeLabelSprite = (xSign) => {
//     const sprite = createTextSprite(labelText, {
//       fontSize: 150,
//       padding: 0,
//     });

//     const x = xSign * (radiusMeters + LABEL_OFFSET);
//     sprite.position.set(x, LABEL_HEIGHT, 0);

//     scene.add(sprite);
//     registerLabelSprite(sprite, { sizeMultiplier: 1 });
//   };

//   makeLabelSprite(+1);
//   makeLabelSprite(-1);
// }

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

  const LABEL_HEIGHT = 4000; // keep as before
  const LABEL_OFFSET = 5000; // reuse later in positioning

  // --- FRONT label: always created ---
  const frontSprite = createTextSprite(labelText, {
    fontSize: 150,
    padding: 0,
  });
  scene.add(frontSprite);
  registerLabelSprite(frontSprite, { sizeMultiplier: 1 });

  rangeRingLabels.push({
    sprite: frontSprite,
    radiusMeters,
    side: "front",
    labelHeight: LABEL_HEIGHT,
    labelOffset: LABEL_OFFSET,
  });

  // --- BACK label: only for 50 km ring ---
  if (radiusMeters === 50_000) {
    const backSprite = createTextSprite(labelText, {
      fontSize: 150,
      padding: 0,
    });
    scene.add(backSprite);
    registerLabelSprite(backSprite, { sizeMultiplier: 1 });

    rangeRingLabels.push({
      sprite: backSprite,
      radiusMeters,
      side: "back",
      labelHeight: LABEL_HEIGHT,
      labelOffset: LABEL_OFFSET,
    });
  }
}

function updateRangeRingLabelPositions() {
  if (!coverageDir) return;

  // horizontal projection of coverageDir
  const dirProj = new THREE.Vector3(coverageDir.x, 0, coverageDir.z);
  if (dirProj.lengthSq() < 1e-6) {
    dirProj.set(1, 0, 0); // fallback
  } else {
    dirProj.normalize();
  }

  const frontDir = dirProj;
  const backDir = dirProj.clone().multiplyScalar(-1);

  for (const entry of rangeRingLabels) {
    const { sprite, radiusMeters, side, labelHeight, labelOffset } = entry;

    const r = radiusMeters + (labelOffset ?? 0);
    const dir = side === "front" ? frontDir : backDir;
    const pos2D = dir.clone().multiplyScalar(r);

    sprite.position.set(pos2D.x, labelHeight, pos2D.z);

    // visibility rules:
    // - all FRONT labels visible
    // - BACK: only for 50km (we already only create that one, but keep the rule explicit)
    if (side === "back" && radiusMeters !== 50_000) {
      sprite.visible = false;
    } else {
      sprite.visible = true;
    }
  }
}

function createAltitudeAxis(maxAlt = 12000, step = 2000, altScale = 1) {
  const group = new THREE.Group();

  const mainMat = new THREE.LineBasicMaterial({ color: 0x66aaff });
  const mainPoints = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, maxAlt * altScale, 0),
  ]; // Y is up
  const mainGeom = new THREE.BufferGeometry().setFromPoints(mainPoints);
  const mainLine = new THREE.Line(mainGeom, mainMat);
  group.add(mainLine);

  const tickMat = new THREE.LineBasicMaterial({ color: 0x66aaff });
  const tickHalfLength = 2000;

  for (let alt = step; alt <= maxAlt; alt += step) {
    const y = alt * altScale;
    const tickPoints = [
      new THREE.Vector3(-tickHalfLength, y, 0),
      new THREE.Vector3(+tickHalfLength, y, 0),
    ];
    const tickGeom = new THREE.BufferGeometry().setFromPoints(tickPoints);
    const tickLine = new THREE.Line(tickGeom, tickMat);
    group.add(tickLine);

    const labelText = `${alt.toLocaleString()} m`;
    const sprite = createTextSprite(labelText, {
      fontSize: 100,
      padding: 6,
    });
    sprite.position.set(tickHalfLength + 2500, y, 0);

    // // 🔹 give it a visible world size
    // const aspect = sprite.userData.aspect || 2;
    // const worldHeight = 6000; // 6 km tall, tweak to taste
    // const worldWidth = worldHeight * aspect;
    // sprite.scale.set(worldWidth, worldHeight, 1);

    // optional: always visible over lines
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;

    group.add(sprite);
    registerLabelSprite(sprite, { sizeMultiplier: 0.8 });
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

// function updateRangeLabelScales() {
//   if (!camera) return;

//   const baseScreenFactor = 0.05;
//   const minScale = 4000;
//   const maxScale = 40000;

//   for (const sprite of rangeLabelSprites) {
//     if (!sprite) continue;

//     const dist = camera.position.distanceTo(sprite.position);

//     let worldHeight = dist * baseScreenFactor;
//     if (worldHeight < minScale) worldHeight = minScale;
//     if (worldHeight > maxScale) worldHeight = maxScale;

//     const aspect = sprite.userData.aspect || 2;
//     const worldWidth = worldHeight * aspect;

//     sprite.scale.set(worldWidth, worldHeight, 1);
//   }
// }

// ---------------------------------------------------------------------
// Coverage cone orientation (azimuth + elevation)
// ---------------------------------------------------------------------

function updateLabelSpriteScales() {
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

const groundClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y >= 0
const baseDir = new THREE.Vector3(1, 0, 0); // +X is "default" cone axis

// function setCoverageOrientation(coneMesh, wireMesh, azDeg, elDeg) {
//   const az = THREE.MathUtils.degToRad(azDeg);
//   const el = THREE.MathUtils.degToRad(elDeg);

//   const cosEl = Math.cos(el);
//   const dir = new THREE.Vector3(
//     cosEl * Math.sin(az), // X (east)
//     Math.sin(el), // Y (up)
//     cosEl * Math.cos(az) // Z (north); 0°=north, 90°=east
//   ).normalize();

//   coverageDir.copy(dir);

//   const quat = new THREE.Quaternion().setFromUnitVectors(baseDir, dir);
//   coneMesh.quaternion.copy(quat);
//   if (wireMesh) wireMesh.quaternion.copy(quat);
// }

function setCoverageOrientation(coneMesh, wireMesh, azDeg, elDeg) {
  const az = THREE.MathUtils.degToRad(azDeg);
  const el = THREE.MathUtils.degToRad(elDeg);

  const cosEl = Math.cos(el);
  const dir = new THREE.Vector3(
    cosEl * Math.sin(az), // X (east)
    Math.sin(el), // Y (up)
    cosEl * Math.cos(az) // Z (north); 0°=north, 90°=east
  ).normalize();

  coverageDir.copy(dir);

  const quat = new THREE.Quaternion().setFromUnitVectors(baseDir, dir);
  coneMesh.quaternion.copy(quat);
  if (wireMesh) wireMesh.quaternion.copy(quat);

  // 🔹 keep ground/grid aligned with the coverage direction
  updateGroundAndGridPlacement();

  // 🔹 labels follow coverage direction as well
  updateRangeRingLabelPositions();
}

function enterFixedPointView() {
  if (!camera || !controls) return;

  // save current camera + controls
  savedView.position.copy(camera.position);
  savedView.target.copy(controls.target);
  savedView.controls.enableRotate = controls.enableRotate;
  savedView.controls.enablePan = controls.enablePan;
  savedView.controls.enableZoom = controls.enableZoom;
  savedView.controls.minDistance = controls.minDistance;
  savedView.controls.maxDistance = controls.maxDistance;

  // --- choose distances relative to origin ---

  const eyeHeight = 1500; // meters above ground
  const frontDistance = 80_000; // point inside the cone (80 km "forward")
  const backDistance = 5_000; // camera 5 km "behind" the origin

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

  // ---- IMPORTANT: don't let OrbitControls clamp our distance away ----

  const distance = camera.position.distanceTo(controls.target);

  // allow at least this distance
  controls.minDistance = Math.min(1000, distance * 0.5);
  controls.maxDistance = distance * 2; // > current distance, so no clamping

  // you can decide how "locked" this view is:
  controls.enableRotate = true; // enable to look around a bit
  controls.enablePan = false;
  controls.enableZoom = true;

  controls.update();

  isFixedPointView = true;
}

function exitFixedPointView() {
  if (!camera || !controls) return;

  // restore previous camera + controls
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

function onCanvasPointerDown(event) {
  if (!renderer || !camera || !originSphere) return;

  const rect = renderer.domElement.getBoundingClientRect();

  // convert to NDC
  pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNDC, camera);

  const intersects = raycaster.intersectObject(originSphere, true);

  if (intersects.length > 0) {
    toggleFixedPointView();
  }
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

  renderer.domElement.addEventListener("pointerdown", onCanvasPointerDown);

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

  // === Viewport gizmo (top-left) ===
  const containerEl = canvas.parentElement;
  gizmo = new ViewportGizmo(camera, renderer, {
    container: containerEl,
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

  // Lights
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(30000, 60000, -40000);
  scene.add(dirLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // // Ground
  // const groundGeom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  // const groundMat = new THREE.MeshPhongMaterial({
  //   color: 0x050814,
  //   side: THREE.FrontSide,
  // });
  // const ground = new THREE.Mesh(groundGeom, groundMat);
  // ground.rotation.x = -Math.PI / 2;
  // ground.position.set(150000, 0, 0); // 50km behind, rest in front
  // scene.add(ground);

  // // Grid
  // const gridSize = GROUND_SIZE;
  // const gridDivisions = 60;
  // const grid = new THREE.GridHelper(
  //   gridSize,
  //   gridDivisions,
  //   0x00ffff, // center liens
  //   0xc4c4c5 // regular lines
  // );
  // grid.position.set(150000, 1, 0);
  // grid.material.opacity = 0.35;
  // grid.material.transparent = true;
  // scene.add(grid);

  // Ground
  const groundGeom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  const groundMat = new THREE.MeshPhongMaterial({
    color: 0x050814,
    side: THREE.FrontSide,
  });
  ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Grid
  const gridDivisions = 60;
  grid = new THREE.GridHelper(
    GROUND_SIZE,
    gridDivisions,
    0x00ffff, // center lines
    0xc4c4c5 // regular lines
  );
  grid.position.y = 1;
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

  const altitudeAxis = createAltitudeAxis(12000, 2000, ALT_SCALE);
  scene.add(altitudeAxis);

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

  // Coverage cone geometry (apex at origin, axis along +X by default)
  const halfAngleRad = Math.PI / 4;
  const coverageRadius = COVERAGE_HEIGHT * Math.tan(halfAngleRad);

  const coverageBaseGeom = new THREE.ConeGeometry(
    coverageRadius,
    COVERAGE_HEIGHT,
    48,
    1,
    true
  );
  // Move apex from +H/2 down to 0
  coverageBaseGeom.translate(0, -COVERAGE_HEIGHT / 2, 0);
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

  window.addEventListener("resize", onWindowResize);

  const tick = () => {
    if (!renderer || !scene || !camera) return;

    controls && controls.update();
    updateLabelSpriteScales();

    renderer.setScissorTest(false);
    // main scene render
    renderer.render(scene, camera);

    // gizmo overlay
    if (gizmo) {
      gizmo.render();
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

  if (gizmo) {
    gizmo.update(); // makes it recompute its position/size
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

  if (gizmo) {
    gizmo.dispose();
    gizmo = null;
  }

  if (renderer) {
    renderer.domElement.removeEventListener("pointerdown", onCanvasPointerDown);
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
