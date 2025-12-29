// src/utils/mockHeightField.js

// Small deterministic hash -> [0,1)
function hash2i(ix, iz, seed) {
  // integer hash
  let h = ix * 374761393 + iz * 668265263 + seed * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  // force unsigned
  return (h >>> 0) / 4294967295;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// smoothstep for nicer interpolation
function smooth(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Value noise (continuous-ish) using a grid of hashed values.
 * x,z are in "noise space" (not meters), typically small numbers.
 */
function valueNoise2D(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const tx = smooth(x - x0);
  const tz = smooth(z - z0);

  const v00 = hash2i(x0, z0, seed);
  const v10 = hash2i(x1, z0, seed);
  const v01 = hash2i(x0, z1, seed);
  const v11 = hash2i(x1, z1, seed);

  const a = lerp(v00, v10, tx);
  const b = lerp(v01, v11, tx);
  return lerp(a, b, tz); // [0,1]
}

function fbm2D(x, z, seed, octaves = 5) {
  let amp = 1.0;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;

  for (let i = 0; i < octaves; i++) {
    sum += amp * (valueNoise2D(x * freq, z * freq, seed + i * 101) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm; // roughly [-1,1]
}

/**
 * Build an N×N heightfield in METERS for a sizeMeters×sizeMeters square.
 *
 * Output layout: heights[z*samples + x]
 */
export function makeMockHeightField({
  sizeMeters = 300_000,
  samples = 257,
  seed = 1337,
  baseMeters = 50,
  hillsMeters = 900,
  ridgeMeters = 700,
  seaLevelMeters = 0, // clamp below this
} = {}) {
  const heights = new Float32Array(samples * samples);

  // Controls “feature size” in meters:
  // lower freq => larger hills. We want ~tens of km features.
  const hillFeatureMeters = 60_000;
  const ridgeFeatureMeters = 25_000;

  for (let z = 0; z < samples; z++) {
    const v = z / (samples - 1);
    const zMeters = (v - 0.5) * sizeMeters;

    for (let x = 0; x < samples; x++) {
      const u = x / (samples - 1);
      const xMeters = (u - 0.5) * sizeMeters;

      // Convert meters -> noise space
      const nxH = xMeters / hillFeatureMeters;
      const nzH = zMeters / hillFeatureMeters;

      const nxR = xMeters / ridgeFeatureMeters;
      const nzR = zMeters / ridgeFeatureMeters;

      // Big smooth hills
      const hills = fbm2D(nxH, nzH, seed, 5); // [-1,1]
      let h = baseMeters + hills * hillsMeters;

      // Add ridges (abs makes sharp-ish creases)
      const ridges = Math.abs(fbm2D(nxR + 100, nzR - 50, seed + 999, 4));
      h += (ridges - 0.35) * ridgeMeters;

      // Optional "mountain" near one corner (useful for testing)
      const dx = xMeters - 80_000;
      const dz = zMeters + 60_000;
      const r = Math.sqrt(dx * dx + dz * dz);
      const peak = Math.max(0, 1 - r / 90_000);
      h += peak * peak * 1400;

      // clamp below "sea level"
      if (h < seaLevelMeters) h = seaLevelMeters;

      heights[z * samples + x] = h;
    }
  }

  return heights;
}
