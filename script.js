const map = L.map("map", { zoomControl: false }).setView([60.69, 26.8], 11);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: "© Esri",
  },
).addTo(map);

let layerGroup = L.layerGroup().addTo(map);
let loadedTracksData = [];
let hikerMarkers = [];
let isPlaying = false;
let playbackSpeed = 1;
let animationFrameId = null;
let lastFrameTime = null;

const parseCoords = (inputStr) => {
  const parts = inputStr.split(",");
  return [parseFloat(parts[1].trim()), parseFloat(parts[0].trim())];
};

// Main func to calculate zones, parse GPX
async function runMission() {
  layerGroup.clearLayers();
  loadedTracksData = [];

  const ptA = parseCoords(document.getElementById("pointA").value);
  const ptB = parseCoords(document.getElementById("pointB").value);
  const missionLine = turf.lineString([ptA, ptB]);

  const radii = {
    platinum: Number(document.getElementById("buff1-radius").value),
    gold: Number(document.getElementById("buff2-radius").value),
    silver: Number(document.getElementById("buff3-radius").value),
    bronze: Number(document.getElementById("buff4-radius").value),
  };

  const zones = [
    { radius: radii.platinum, color: "rgba(255, 255, 255, 0.8)" },
    { radius: radii.gold, color: "rgba(255, 255, 255, 0.4)" },
    { radius: radii.silver, color: "rgba(255, 255, 255, 0.4)" },
    { radius: radii.bronze, color: "rgba(255, 21, 21, 0.8)" },
  ];

  zones.forEach((zone) => {
    const buffer = turf.buffer(missionLine, zone.radius, { units: "meters" });
    L.geoJSON(buffer, {
      style: { color: zone.color, weight: 1, opacity: 1, fillOpacity: 0 },
    }).addTo(layerGroup);
  });

  L.geoJSON(missionLine, {
    style: { color: "white", weight: 1, dashArray: "5, 10" },
  }).addTo(layerGroup);

  const gpsFiles = [
    document.getElementById("gpxFile1"),
    document.getElementById("gpxFile2"),
    document.getElementById("gpxFile3"),
    document.getElementById("gpxFile4"),
  ];

  if (gpsFiles.every((input) => input.files.length === 0)) {
    alert("No GPX file(s) selected!");
    return;
  }

  let globalMinTime = Infinity;
  let globalMaxTime = -Infinity;
  const trackColors = ["#ff3358", "#2a8aff", "#80d832", "#d61ce0"];

  // Track points, time bounds, boundary crossings
  for (let i = 0; i < gpsFiles.length; i++) {
    if (gpsFiles[i].files.length === 0) continue;

    const file = gpsFiles[i].files[0];
    const xmlDoc = new DOMParser().parseFromString(
      await file.text(),
      "text/xml",
    );
    const trkpts = xmlDoc.getElementsByTagName("trkpt");

    let trackPoints = [];
    let crosses = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
    let state = {};
    let maxDist = 0;

    for (let j = 0; j < trkpts.length; j++) {
      const lat = parseFloat(trkpts[j].getAttribute("lat"));
      const lon = parseFloat(trkpts[j].getAttribute("lon"));
      const timeTag = trkpts[j].getElementsByTagName("time")[0];
      const timestamp =
        timeTag && timeTag.textContent
          ? new Date(timeTag.textContent).getTime()
          : j;

      const pt = turf.point([lon, lat]);
      const dist = turf.pointToLineDistance(pt, missionLine, {
        units: "meters",
      });
      maxDist = Math.max(maxDist, dist);

      const current = {
        platinum: dist <= radii.platinum,
        gold: dist <= radii.gold,
        silver: dist <= radii.silver,
        bronze: dist <= radii.bronze,
      };

      if (j === 0) {
        state = current;
      } else {
        Object.keys(current).forEach((tier) => {
          if (current[tier] !== state[tier]) {
            crosses[tier]++;
            state[tier] = current[tier];
          }
        });
      }

      trackPoints.push({ lat, lon, time: timestamp, dist });
      globalMinTime = Math.min(globalMinTime, timestamp);
      globalMaxTime = Math.max(globalMaxTime, timestamp);
    }

    loadedTracksData.push({
      id: i + 1,
      fileName: file.name,
      color: trackColors[i],
      points: trackPoints,
      crosses,
      maxDist,
    });
  }

  const timeSpanHours = (globalMaxTime - globalMinTime) / (1000 * 60 * 60);
  if (timeSpanHours > 48 && globalMinTime !== Infinity) {
    alert(
      `Warning: The loaded tracks span ${Math.round(timeSpanHours)} hours. They might not be from the same timeframe!`,
    );
  }

  document.getElementById("bottom-panel").style.display = "flex";

  loadedTracksData.forEach((track) => {
    const coords = track.points.map((p) => [p.lon, p.lat]);
    L.geoJSON(turf.lineString(coords), {
      style: { color: track.color, weight: 3 },
    }).addTo(layerGroup);
  });

  const bbox = turf.bbox(turf.buffer(missionLine, 100, { units: "meters" }));
  map.fitBounds([
    [bbox[1], bbox[0]],
    [bbox[3], bbox[2]],
  ]);

  setupAnimator(globalMinTime, globalMaxTime);
  updateTable();
}

// Setup playback and initial markers
function setupAnimator(minTime, maxTime) {
  pausePlayback();
  document.getElementById("animator").style.display = "block";

  const slider = document.getElementById("timeSlider");
  slider.min = minTime;
  slider.max = maxTime;
  slider.value = minTime;

  hikerMarkers.forEach((marker) => map.removeLayer(marker));
  hikerMarkers = [];

  loadedTracksData.forEach((track) => {
    if (track.points.length > 0) {
      const marker = L.circleMarker(
        [track.points[0].lat, track.points[0].lon],
        {
          color: "white",
          weight: 1,
          fillColor: track.color,
          fillOpacity: 1,
          radius: 6,
        },
      ).addTo(map);
      hikerMarkers.push(marker);
    }
  });
}

// Marker positions
function updateMarkers(timeValue) {
  loadedTracksData.forEach((track, idx) => {
    if (track.points.length === 0 || !hikerMarkers[idx]) return;

    let left = 0,
      right = track.points.length - 1,
      bestIndex = 0;
    while (left <= right) {
      let mid = Math.floor((left + right) / 2);
      if (track.points[mid].time <= timeValue) {
        bestIndex = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    hikerMarkers[idx].setLatLng([
      track.points[bestIndex].lat,
      track.points[bestIndex].lon,
    ]);
  });
}

function startPlayback() {
  if (loadedTracksData.length === 0) return;
  const slider = document.getElementById("timeSlider");
  if (Number(slider.value) >= Number(slider.max)) slider.value = slider.min;

  if (map.getZoom() < 16) map.setZoom(16);

  isPlaying = true;
  document.getElementById("play-btn").classList.add("paused");
  document.getElementById("pause-btn").classList.remove("paused");

  lastFrameTime = performance.now();
  animationFrameId = requestAnimationFrame(playLoop);
}

function pausePlayback() {
  isPlaying = false;
  document.getElementById("play-btn").classList.remove("paused");
  document.getElementById("pause-btn").classList.add("paused");
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

// Playback and camera follow
function playLoop(timestamp) {
  if (!isPlaying) return;

  const slider = document.getElementById("timeSlider");
  let newValue =
    Number(slider.value) + (timestamp - lastFrameTime) * playbackSpeed;
  lastFrameTime = timestamp;

  if (newValue >= Number(slider.max)) {
    slider.value = slider.max;
    updateMarkers(slider.max);
    pausePlayback();
    return;
  }

  slider.value = newValue;
  updateMarkers(newValue);

  if (hikerMarkers.length > 0) {
    let sumLat = 0,
      sumLon = 0;
    hikerMarkers.forEach((marker) => {
      const coords = marker.getLatLng();
      sumLat += coords.lat;
      sumLon += coords.lng;
    });
    map.setView(
      [sumLat / hikerMarkers.length, sumLon / hikerMarkers.length],
      map.getZoom(),
      { animate: false },
    );
  }

  animationFrameId = requestAnimationFrame(playLoop);
}

// Update results table
function updateTable() {
  const tbody = document.getElementById("results-tbody");
  tbody.innerHTML = "";

  if (loadedTracksData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--medium-gray);">Run a mission to see results.</td></tr>`;
    return;
  }

  const radii = {
    platinum: Number(document.getElementById("buff1-radius").value),
    gold: Number(document.getElementById("buff2-radius").value),
    silver: Number(document.getElementById("buff3-radius").value),
    bronze: Number(document.getElementById("buff4-radius").value),
  };

  loadedTracksData.forEach((track) => {
    let finalScore = "Platinum",
      scoreColor = "white";
    if (track.maxDist > radii.bronze) {
      finalScore = "Failed";
      scoreColor = "darkred";
    } else if (track.maxDist > radii.silver) {
      finalScore = "Bronze";
    } else if (track.maxDist > radii.gold) {
      finalScore = "Silver";
    } else if (track.maxDist > radii.platinum) {
      finalScore = "Gold";
    }

    tbody.innerHTML += `
      <tr>
        <td>${track.fileName}</td>
        <td><span class="color-swatch" style="background-color: ${track.color};"></span></td>
        <td>${track.crosses.platinum}</td>
        <td>${track.crosses.gold}</td>
        <td>${track.crosses.silver}</td>
        <td>${track.crosses.bronze}</td>
        <td style="font-weight: bold; color: ${scoreColor};">${finalScore}</td>
      </tr>
    `;
  });
}

// Example missions if ?eg=X in the URL
async function loadExampleMission(egNum) {
  try {
    const basePath = `./example_missions/slm${egNum}/`;
    const lineRes = await fetch(`${basePath}line.txt`);
    if (!lineRes.ok) return;

    const textLines = (await lineRes.text())
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "");

    if (textLines.length > 0) {
      const parts = textLines[0].split(",");
      if (parts.length >= 4) {
        document.getElementById("pointA").value =
          `${parts[0].trim()}, ${parts[1].trim()}`;
        document.getElementById("pointB").value =
          `${parts[2].trim()}, ${parts[3].trim()}`;
      }
    }

    if (textLines.length > 1) {
      const fileNames = textLines[1]
        .split(",")
        .map((n) => n.trim())
        .slice(0, 4);
      const inputs = ["gpxFile1", "gpxFile2", "gpxFile3", "gpxFile4"].map(
        (id) => document.getElementById(id),
      );

      for (let i = 0; i < fileNames.length; i++) {
        const gpxRes = await fetch(`${basePath}${fileNames[i]}`);
        if (gpxRes.ok) {
          const file = new File([await gpxRes.text()], fileNames[i], {
            type: "application/gpx+xml",
          });
          const dt = new DataTransfer();
          dt.items.add(file);
          inputs[i].files = dt.files;
        }
      }
    }
  } catch (err) {
    console.error("Error loading example mission:", err);
  }
}

// Event Listeners
document.getElementById("startBtn").addEventListener("click", runMission);
document
  .getElementById("timeSlider")
  .addEventListener("input", (e) => updateMarkers(Number(e.target.value)));
document.getElementById("play-btn").addEventListener("click", startPlayback);
document.getElementById("pause-btn").addEventListener("click", pausePlayback);

document.getElementById("expandBtn").addEventListener("click", () => {
  const panel = document.getElementById("bottom-panel");
  panel.classList.toggle("expanded");
  if (panel.classList.contains("expanded")) updateTable();
});

document.querySelectorAll(".speed-option").forEach((option) => {
  option.addEventListener("click", (e) => {
    playbackSpeed = Number(e.target.getAttribute("data-speed"));
    document
      .querySelectorAll(".speed-option")
      .forEach((opt) => opt.classList.remove("active"));
    e.target.classList.add("active");
  });
});

window.addEventListener("DOMContentLoaded", () => {
  const egNum = new URLSearchParams(window.location.search).get("eg");
  if (egNum) loadExampleMission(egNum);
});
