// usePlanes.js
import * as THREE from "three";

export function usePlanes({
  scene,
  camera,
  domElement,
  labelsApi,
  fixedPointPosition = new THREE.Vector3(0, 0, 0),
  altScale = 10,
  maxRadius = 300_000, // 300 km
}) {
  const R = 6_371_000;
  const deg2rad = Math.PI / 180;

  const planeGroups = new Map(); // id -> group
  const pickMeshes = []; // meshes used for raycasting

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoveredGroup = null;

  // --- Shared line origin->plane + angle label ---
  const lineGeometry = new THREE.BufferGeometry().setFromPoints([
    fixedPointPosition.clone(),
    fixedPointPosition.clone(),
  ]);
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 0.8,
  });
  const elevLine = new THREE.Line(lineGeometry, lineMaterial);
  elevLine.visible = false;
  scene.add(elevLine);

  const elevAngleSprite = labelsApi.createTextSprite("0°", {
    fontSize: 48,
    padding: 6,
  });
  elevAngleSprite.visible = false;
  scene.add(elevAngleSprite);
  labelsApi.registerLabelSprite(elevAngleSprite, { sizeMultiplier: 0.9 });

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  function latLonAltToLocalENU(lat, lon, alt, origin) {
    const phi0 = origin.lat * deg2rad;
    const lam0 = origin.lng * deg2rad;

    const phi = lat * deg2rad;
    const lam = lon * deg2rad;

    const dPhi = phi - phi0;
    const dLam = lam - lam0;

    const xEast = R * dLam * Math.cos(phi0); // meters east
    const zNorth = R * dPhi; // meters north
    const yUp = (alt ?? 0) * altScale;

    return new THREE.Vector3(xEast, yUp, -zNorth);
  }

  function formatLat(lat) {
    const hemi = lat >= 0 ? "N" : "S";
    return `${Math.abs(lat).toFixed(3)}°${hemi}`;
  }

  function formatLon(lon) {
    const hemi = lon >= 0 ? "E" : "W";
    return `${Math.abs(lon).toFixed(3)}°${hemi}`;
  }

  function formatAlt(altMeters) {
    return `${Math.round(altMeters)} m`;
  }

  function createPlaneGroup(planeId) {
    const group = new THREE.Group();

    // ---------------------------
    // BODY
    // ---------------------------
    const bodyGroup = new THREE.Group();

    const bodyGeom = new THREE.BoxGeometry(5000, 5000, 5000);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffaa00,
      metalness: 0.2,
      roughness: 0.5,
    });
    const mesh = new THREE.Mesh(bodyGeom, bodyMat);
    mesh.geometry.translate(0, 0, -400); // nose

    bodyGroup.add(mesh);

    // ID label
    const idLabel = labelsApi.createTextSprite(String(planeId), {
      fontSize: 48,
      padding: 8,
    });
    idLabel.position.set(0, 800, 0);
    bodyGroup.add(idLabel);
    labelsApi.registerLabelSprite(idLabel, { sizeMultiplier: 0.8 });

    group.add(bodyGroup);

    // ---------------------------
    // ALTITUDE COLUMN & RINGS
    // ---------------------------
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

    const groundRingInner = 2200;
    const groundRingOuter = 4200;
    const groundRingGeom = new THREE.RingGeometry(
      groundRingInner,
      groundRingOuter,
      50
    );
    const groundRingMat = new THREE.MeshBasicMaterial({
      color: 0x66aaff,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const groundRing = new THREE.Mesh(groundRingGeom, groundRingMat);
    groundRing.rotation.x = -Math.PI / 2;
    group.add(groundRing);

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
    bowl.position.y = -2600;
    group.add(bowl);

    // Hover-only coord label sprite (created lazily)
    let coordLabelSprite = null;

    group.userData = {
      bodyGroup,
      mesh,
      stem,
      columnGroup,
      groundRing,
      bowl,
      coordLabelSprite,
      geodetic: null, // { lat, lng, altMeters }
    };

    // Raycasting: pick on the body mesh
    mesh.userData.planeGroup = group;
    pickMeshes.push(mesh);

    scene.add(group);
    return group;
  }

  function updateAltitudeColumn(group, worldPosY) {
    const { stem, columnGroup, groundRing } = group.userData;
    if (!stem || !columnGroup || !groundRing) return;

    if (worldPosY <= 0) {
      stem.visible = false;
      groundRing.visible = false;
      return;
    }

    stem.visible = true;
    groundRing.visible = true;

    columnGroup.position.set(0, -worldPosY / 2, 0);
    stem.scale.set(1, worldPosY, 1);

    groundRing.position.set(0, -worldPosY, 0);
  }

  function computeElevationAngle(planePos) {
    const dx = planePos.x - fixedPointPosition.x;
    const dz = planePos.z - fixedPointPosition.z;
    const dy = planePos.y - fixedPointPosition.y;

    const horiz = Math.hypot(dx, dz);
    const angleRad = Math.atan2(dy, horiz);
    return (angleRad * 180) / Math.PI;
  }

  function setHoveredGroup(newGroup) {
    if (newGroup === hoveredGroup) return;

    // Clear previous
    if (hoveredGroup) {
      hoveredGroup.scale.set(1, 1, 1);

      const ud = hoveredGroup.userData;
      if (ud.coordLabelSprite) {
        ud.coordLabelSprite.visible = false;
      }
    }

    hoveredGroup = newGroup;

    if (!hoveredGroup) {
      elevLine.visible = false;
      elevAngleSprite.visible = false;
      return;
    }

    // Scale up
    hoveredGroup.scale.set(1.3, 1.3, 1.3);

    const ud = hoveredGroup.userData;
    const planePos = hoveredGroup.position;

    // Coordinates label (create lazily)
    if (!ud.coordLabelSprite && ud.geodetic) {
      const { lat, lng, altMeters } = ud.geodetic;
      const text = `${formatLat(lat)}\n${formatLon(lng)}\n${formatAlt(
        altMeters
      )}`;

      ud.coordLabelSprite = labelsApi.createTextSprite(text, {
        fontSize: 44,
        padding: 8,
      });
      ud.coordLabelSprite.position.set(0, 9000, 0);
      ud.bodyGroup.add(ud.coordLabelSprite);
      labelsApi.registerLabelSprite(ud.coordLabelSprite, {
        sizeMultiplier: 0.9,
      });
    } else if (ud.coordLabelSprite && ud.geodetic) {
      // NOTE: to keep things simple I'm not updating the text here;
      // if you add a `updateTextSprite(sprite, text)` helper in `useLabels`,
      // call it here when geodetic changes.
      ud.coordLabelSprite.visible = true;
    }

    if (ud.coordLabelSprite) {
      ud.coordLabelSprite.visible = true;
    }

    // Update line
    const posAttr = elevLine.geometry.attributes.position;
    posAttr.setXYZ(
      0,
      fixedPointPosition.x,
      fixedPointPosition.y,
      fixedPointPosition.z
    );
    posAttr.setXYZ(1, planePos.x, planePos.y, planePos.z);
    posAttr.needsUpdate = true;
    elevLine.visible = true;

    // Elevation angle label
    const elevDeg = computeElevationAngle(planePos);
    // same note: ideally use labelsApi.updateTextSprite
    const mid = new THREE.Vector3()
      .addVectors(fixedPointPosition, planePos)
      .multiplyScalar(0.5);
    mid.y += 6000; // lift a bit so it doesn't sit inside the line

    elevAngleSprite.position.copy(mid);
    elevAngleSprite.visible = true;
  }

  function onPointerMove(event) {
    const rect = domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(pickMeshes, false);

    if (intersects.length > 0) {
      const mesh = intersects[0].object;
      const group = mesh.userData.planeGroup;
      setHoveredGroup(group || null);
    } else {
      setHoveredGroup(null);
    }
  }

  function onPointerLeave() {
    setHoveredGroup(null);
  }

  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerleave", onPointerLeave);

  // -------------------------------------------------------------------
  // Public: sync planes
  // -------------------------------------------------------------------
  function syncPlanes({ origin, planes }) {
    if (!origin) {
      for (const [, group] of planeGroups.entries()) {
        scene.remove(group);
      }
      planeGroups.clear();
      setHoveredGroup(null);
      return;
    }

    const seenIds = new Set();

    for (const plane of planes || []) {
      if (plane.lat == null || plane.lng == null) continue;
      const altMeters = plane.alt ?? 0;

      const pos = latLonAltToLocalENU(plane.lat, plane.lng, altMeters, origin);

      // radius cut
      const radius2D = Math.hypot(pos.x, pos.z);
      if (radius2D > maxRadius) continue;

      let group = planeGroups.get(plane.id);
      if (!group) {
        group = createPlaneGroup(plane.id);
        planeGroups.set(plane.id, group);
      }

      group.position.copy(pos);

      if (plane.heading != null) {
        const yawRad = THREE.MathUtils.degToRad(-plane.heading);
        group.rotation.set(0, yawRad, 0);
      }

      // store geodetic for hover label
      group.userData.geodetic = {
        lat: plane.lat,
        lng: plane.lng,
        altMeters,
      };

      updateAltitudeColumn(group, pos.y);

      seenIds.add(plane.id);
    }

    // Remove planes that disappeared
    for (const [id, group] of planeGroups.entries()) {
      if (!seenIds.has(id)) {
        scene.remove(group);
        planeGroups.delete(id);
      }
    }

    // If hovered plane moved, update line/angle position
    if (hoveredGroup) {
      setHoveredGroup(hoveredGroup);
    }
  }

  function disposePlanes() {
    domElement.removeEventListener("pointermove", onPointerMove);
    domElement.removeEventListener("pointerleave", onPointerLeave);

    for (const [, group] of planeGroups.entries()) {
      scene.remove(group);
    }
    planeGroups.clear();

    scene.remove(elevLine);
    scene.remove(elevAngleSprite);

    setHoveredGroup(null);
  }

  return {
    syncPlanes,
    disposePlanes,
  };
}
