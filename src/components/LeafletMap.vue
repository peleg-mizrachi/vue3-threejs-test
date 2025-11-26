<template>
  <div class="map-container">
    <div ref="mapEl" class="map"></div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const props = defineProps({
  planes: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(["right-click-origin"]);

const mapEl = ref(null);
let mapInstance = null;
let markersById = new Map();

onMounted(() => {
  if (!mapEl.value) return;

  mapInstance = L.map(mapEl.value, {
    center: [32.0853, 34.7818],
    zoom: 10,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(mapInstance);

  // Right-click handler
  mapInstance.on("contextmenu", (e) => {
    emit("right-click-origin", {
      lat: e.latlng.lat,
      lng: e.latlng.lng,
    });
  });

  // Initial markers
  syncPlaneMarkers(props.planes);
});

// Handle planes changes (if later you make them dynamic)
watch(
  () => props.planes,
  (newPlanes) => {
    syncPlaneMarkers(newPlanes);
  },
  { deep: true }
);

function syncPlaneMarkers(planes) {
  if (!mapInstance) return;

  const seenIds = new Set();

  for (const plane of planes) {
    seenIds.add(plane.id);

    let marker = markersById.get(plane.id);
    const latlng = [plane.lat, plane.lng];

    if (!marker) {
      marker = L.circleMarker(latlng, {
        radius: 6,
        color: "#ffcc00",
        fillColor: "#ffcc00",
        fillOpacity: 0.9,
      }).addTo(mapInstance);

      marker.bindPopup(`<b>${plane.id}</b><br>Alt: ${plane.alt} m`);

      markersById.set(plane.id, marker);
    } else {
      marker.setLatLng(latlng);
    }
  }

  // Remove markers for planes that no longer exist
  for (const [id, marker] of markersById.entries()) {
    if (!seenIds.has(id)) {
      mapInstance.removeLayer(marker);
      markersById.delete(id);
    }
  }
}

onBeforeUnmount(() => {
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  markersById.clear();
});
</script>

<style scoped>
.map-container {
  width: 100%;
  height: 100%;
}

.map {
  width: 100%;
  height: 100%;
}
</style>
