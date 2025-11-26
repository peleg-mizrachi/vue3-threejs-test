<template>
  <div class="app-root">
    <header class="app-header">
      <h1>Mini Flight Radar – 2D + 3D Demo</h1>
    </header>

    <main class="app-main">
      <section class="map-wrapper">
        <LeafletMap :planes="planes" @right-click-origin="onRightClickOrigin" />
      </section>

      <section class="side-panel">
        <h2>3D Profile View</h2>

        <div v-if="profileOrigin">
          <p>
            Origin:
            <strong
              >{{ profileOrigin.lat.toFixed(4) }},
              {{ profileOrigin.lng.toFixed(4) }}</strong
            >
          </p>
        </div>
        <div v-else>
          <p>Right-click somewhere on the map to set the 3D origin.</p>
        </div>

        <!-- Three.js window -->
        <div class="three-wrapper">
          <ThreeProfileView :origin="profileOrigin" :planes="planes" />
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import LeafletMap from "./components/LeafletMap.vue";
import ThreeProfileView from "./components/ThreeProfileView.vue";

// Tel Aviv-ish mock planes with heading (deg) and speed (m/s)
const planes = ref([
  { id: "LY101", lat: 32.05, lng: 34.78, alt: 9000, heading: 60, speed: 230 },
  { id: "LY202", lat: 32.1, lng: 34.82, alt: 12000, heading: 210, speed: 250 },
  { id: "LY303", lat: 32.15, lng: 34.75, alt: 7000, heading: 320, speed: 210 },
]);

const profileOrigin = ref(null);
let moveTimer = null;

function onRightClickOrigin(latlng) {
  profileOrigin.value = latlng;
}

onMounted(() => {
  const dtSeconds = 0.2; // time step per tick
  const intervalMs = dtSeconds * 1000;

  moveTimer = setInterval(() => {
    planes.value = planes.value.map((p) => {
      const speed = p.speed ?? 200; // m/s
      const headingDeg = p.heading ?? 0;

      const distance = speed * dtSeconds; // meters travelled in this step
      const headingRad = (Math.PI / 180) * headingDeg;

      // Simple ENU: dx = east, dz = north
      const dx = Math.sin(headingRad) * distance;
      const dz = Math.cos(headingRad) * distance;

      // Convert meters to degrees (approx)
      const latRad = (p.lat * Math.PI) / 180;
      const metersPerDegLat = 111_111;
      const metersPerDegLng = metersPerDegLat * Math.cos(latRad) || 1e-6;

      const dLat = dz / metersPerDegLat;
      const dLng = dx / metersPerDegLng;

      let newLat = p.lat + dLat;
      let newLng = p.lng + dLng;
      let newHeading = headingDeg;

      // Keep them roughly around TLV area – if they wander too far, flip heading
      const latCenter = 32.0853;
      const lngCenter = 34.7818;
      const maxDeltaDeg = 0.5; // ~50–60km

      if (
        Math.abs(newLat - latCenter) > maxDeltaDeg ||
        Math.abs(newLng - lngCenter) > maxDeltaDeg
      ) {
        // turn around, but don't move this tick
        newLat = p.lat;
        newLng = p.lng;
        newHeading = (headingDeg + 180) % 360;
      }

      return {
        ...p,
        lat: newLat,
        lng: newLng,
        heading: newHeading,
      };
    });
  }, intervalMs);
});

onBeforeUnmount(() => {
  if (moveTimer) {
    clearInterval(moveTimer);
    moveTimer = null;
  }
});
</script>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.app-header {
  padding: 0.5rem 1rem;
  background: #222;
  color: #f5f5f5;
  font-size: 0.9rem;
}

.app-main {
  flex: 1;
  display: flex;
  min-height: 0; /* important for flex children with 100% height */
}

/* left: map */
.map-wrapper {
  flex: 2;
  min-width: 0;
}

/* right: 3D panel */
.side-panel {
  flex: 1;
  min-width: 280px;
  max-width: 420px;
  border-left: 1px solid #444;
  background: #050812;
  color: #eee;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
}

.side-panel h2 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}

.three-wrapper {
  margin-top: 0.5rem;
  flex: 1;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #333;
}
</style>
