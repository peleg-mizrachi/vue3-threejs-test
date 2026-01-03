// src/composables/useTerrain.js
import * as THREE from "three";

export function useTerrain({
  scene,
  sizeMeters = 300_000,
  samples = 257,
  altScale = 1,
  yOffsetMeters = 0, // <-- meters, not "world units"
  material = null,
  wireframe = false,
  nodata = -32768,
  nodataFillMeters = 0,
} = {}) {
  if (!scene) throw new Error("useTerrain: scene is required");
  if (samples < 2) throw new Error("useTerrain: samples must be >= 2");

  let mesh = null;
  let geometry = null;
  let mat = null;

  function initTerrain() {
    // Dispose previous if re-init
    disposeTerrain();

    // PlaneGeometry is XY by default; rotate to XZ so Y is up.
    geometry = new THREE.PlaneGeometry(
      sizeMeters,
      sizeMeters,
      samples - 1,
      samples - 1
    );
    geometry.rotateX(-Math.PI / 2);

    // mat =
    //   material ||
    //   new THREE.MeshStandardMaterial({
    //     color: 0x1d2b3a,
    //     roughness: 0.95,
    //     metalness: 0.0,
    //     wireframe,
    //     vertexColors: true,
    //   });

    mat =
      material ||
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        wireframe,
      });

    mesh = new THREE.Mesh(geometry, mat);
    mesh.receiveShadow = true;

    // yOffsetMeters is in meters, apply scaling here
    mesh.position.set(0, yOffsetMeters * altScale, 0);

    scene.add(mesh);
  }

  async function loadHeightsFromUrl(url) {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok)
      throw new Error(`useTerrain: failed to fetch ${url} (${resp.status})`);
    const buf = await resp.arrayBuffer();

    // IMPORTANT: assumes little-endian int16 like we planned
    const heights = new Int16Array(buf);

    const expected = samples * samples;
    if (heights.length !== expected) {
      throw new Error(
        `useTerrain: heightmap has ${heights.length} samples, expected ${expected}. ` +
          `Check that server/generator used samples=${samples}.`
      );
    }

    return heights;
  }

  function setHeights(heightsInput, opts = {}) {
    if (!geometry)
      throw new Error("useTerrain: call initTerrain() before setHeights()");
    const {
      flipX = false,
      flipZ = false,
      computeNormals = true,
      nodataOverride = nodata,
      nodataFillOverride = nodataFillMeters,
    } = opts;

    // Normalize input
    let heights = heightsInput;
    if (heightsInput instanceof ArrayBuffer)
      heights = new Int16Array(heightsInput);

    const expected = samples * samples;
    if (!heights || heights.length !== expected) {
      throw new Error(
        `useTerrain: heights length must be ${expected} (got ${heights?.length})`
      );
    }

    const posAttr = geometry.attributes.position;
    if (posAttr.count !== expected) {
      throw new Error(
        `useTerrain: geometry has ${posAttr.count} vertices but expected ${expected}. ` +
          `Did you create PlaneGeometry(size,size, samples-1, samples-1) with the same samples?`
      );
    }

    const arr = posAttr.array; // Float32Array [x,y,z,...]

    // Mapping assumption:
    // - heights are row-major (row 0 = north edge, col 0 = west edge)
    // - PlaneGeometry is row-major too (after rotate doesn't change vertex ordering)
    for (let row = 0; row < samples; row++) {
      const srcRow = flipZ ? samples - 1 - row : row;
      const rowBase = row * samples;

      for (let col = 0; col < samples; col++) {
        const srcCol = flipX ? samples - 1 - col : col;

        const srcIdx = srcRow * samples + srcCol;
        let h = heights[srcIdx];

        if (h === nodataOverride) h = nodataFillOverride;

        const vIdx = (rowBase + col) * 3;
        arr[vIdx + 1] = h * altScale;
      }
    }

    posAttr.needsUpdate = true;

    if (computeNormals) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }

  function setPlacement({ x = 0, z = 0 } = {}) {
    if (!mesh) return;
    mesh.position.x = x;
    mesh.position.z = z;
  }

  function setVisible(v) {
    if (mesh) mesh.visible = !!v;
  }

  function disposeTerrain() {
    if (mesh) {
      scene.remove(mesh);
      mesh = null;
    }
    if (geometry) {
      geometry.dispose();
      geometry = null;
    }
    if (mat) {
      mat.dispose();
      mat = null;
    }
  }

  function setDebugNodataColors(heights, NODATA = -32768) {
    if (!geometry) throw new Error("useTerrain: initTerrain() first");

    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < heights.length; i++) {
      const isNo = heights[i] === NODATA;
      const j = i * 3;
      // nodata = red, valid = green
      colors[j + 0] = isNo ? 1 : 0;
      colors[j + 1] = isNo ? 0 : 1;
      colors[j + 2] = 0;
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.attributes.color.needsUpdate = true;
  }

  function setColorsFromHeights(
    heightsInput,
    {
      nodataValue = nodata,
      seaLevel = 0,
      // height stops in meters (tweak later)
      h0 = 0, // sea level
      h1 = 200, // lowlands
      h2 = 800, // hills
      h3 = 1800, // mountains
      h4 = 3000, // high peaks
    } = {}
  ) {
    if (!geometry) throw new Error("useTerrain: initTerrain() first");

    let heights = heightsInput;
    if (heightsInput instanceof ArrayBuffer)
      heights = new Int16Array(heightsInput);

    const expected = samples * samples;
    if (!heights || heights.length !== expected) {
      throw new Error(
        `useTerrain: heights length must be ${expected} (got ${heights?.length})`
      );
    }

    const colors = new Float32Array(expected * 3);

    // helper: linear interpolation
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp01 = (t) => Math.max(0, Math.min(1, t));

    // helper: blend two RGB colors (0..1)
    function mix(c1, c2, t) {
      t = clamp01(t);
      return [
        lerp(c1[0], c2[0], t),
        lerp(c1[1], c2[1], t),
        lerp(c1[2], c2[2], t),
      ];
    }

    // palette (feel free to tweak)
    const WATER_DEEP = [0.03, 0.08, 0.18];
    const WATER_SHALLOW = [0.05, 0.18, 0.35];

    const LOWLAND = [0.12, 0.3, 0.12]; // green
    const HILLS = [0.4, 0.42, 0.18]; // olive / dry grass
    const ROCK = [0.45, 0.42, 0.4]; // gray-brown rock
    const SNOW = [0.92, 0.92, 0.92]; // snow

    for (let i = 0; i < expected; i++) {
      const h = heights[i];

      let rgb;

      if (h === nodataValue) {
        // No bathymetry available: paint as ocean
        rgb = WATER_DEEP;
      } else if (h < seaLevel) {
        // If you ever have negative elevations and want them water-ish
        // blend deep->shallow by depth (cap at -200m for appearance)
        const t = clamp01((h - -200) / (seaLevel - -200));
        rgb = mix(WATER_DEEP, WATER_SHALLOW, t);
      } else if (h < h1) {
        // lowlands: green ramp
        const t = clamp01((h - h0) / (h1 - h0));
        rgb = mix([0.08, 0.22, 0.08], LOWLAND, t);
      } else if (h < h2) {
        // hills: green -> olive
        const t = clamp01((h - h1) / (h2 - h1));
        rgb = mix(LOWLAND, HILLS, t);
      } else if (h < h3) {
        // mountains: olive -> rock
        const t = clamp01((h - h2) / (h3 - h2));
        rgb = mix(HILLS, ROCK, t);
      } else {
        // high mountains: rock -> snow
        const t = clamp01((h - h3) / (h4 - h3));
        rgb = mix(ROCK, SNOW, t);
      }

      const j = i * 3;
      colors[j + 0] = rgb[0];
      colors[j + 1] = rgb[1];
      colors[j + 2] = rgb[2];
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.attributes.color.needsUpdate = true;
  }

  return {
    initTerrain,
    loadHeightsFromUrl,
    setHeights,
    setPlacement,
    setVisible,
    disposeTerrain,
    get mesh() {
      return mesh;
    },
    setDebugNodataColors,
    setColorsFromHeights,
  };
}
