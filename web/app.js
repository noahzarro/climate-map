// Weekly temperature climatology viewer.
//
// Loads data/meta.json for bounds + per-week metadata, displays each week's
// pre-colored PNG as an image overlay, lets the user scrub through weeks
// with a slider, and shows the exact raw temperature value on hover by
// reading from that week's raw Int16 grid (data/week_XX.bin).

const DATA_URL = "data/meta.json";
const IMAGE_SOURCE_ID = "temperature-image";
const IMAGE_LAYER_ID = "temperature-layer";

let meta = null;
let currentWeekIndex = 0;
let currentGrid = null; // Int16Array for the currently loaded week
let gridCache = new Map(); // weekIndex -> Int16Array

const weekLabelEl = document.getElementById("week-label");
const sliderEl = document.getElementById("week-slider");
const tooltipEl = document.getElementById("tooltip");
const loadingEl = document.getElementById("loading");
const legendMinEl = document.getElementById("legend-min");
const legendMaxEl = document.getElementById("legend-max");

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [10, 48],
  zoom: 3.2,
});

map.addControl(new maplibregl.NavigationControl(), "top-left");

map.on("load", async () => {
  meta = await fetch(DATA_URL).then((r) => r.json());

  const { lonMin, lonMax, latMin, latMax } = meta.bounds;
  const coordinates = [
    [lonMin, latMax], // top left
    [lonMax, latMax], // top right
    [lonMax, latMin], // bottom right
    [lonMin, latMin], // bottom left
  ];

  map.addSource(IMAGE_SOURCE_ID, {
    type: "image",
    url: weekPngUrl(0),
    coordinates,
  });

  map.addLayer({
    id: IMAGE_LAYER_ID,
    type: "raster",
    source: IMAGE_SOURCE_ID,
    paint: {
      "raster-opacity": 0.75,
    },
  });

  map.fitBounds(
    [
      [lonMin, latMin],
      [lonMax, latMax],
    ],
    { padding: 20, duration: 0 }
  );

  // Restrict panning/zooming so the world outside the data region isn't
  // visible: lock the map's bounds to the data area (with a little
  // padding) and don't allow zooming out further than the initial
  // fitted view.
  const boundsPadding = 4; // degrees
  map.setMaxBounds([
    [lonMin - boundsPadding, latMin - boundsPadding],
    [lonMax + boundsPadding, latMax + boundsPadding],
  ]);
  map.setMinZoom(map.getZoom());

  sliderEl.max = String(meta.weeks.length - 1);
  legendMinEl.textContent = `${meta.colorScale.min}\u00B0C`;
  legendMaxEl.textContent = `${meta.colorScale.max}\u00B0C`;

  await setWeek(0);

  sliderEl.addEventListener("input", (e) => {
    setWeek(parseInt(e.target.value, 10));
  });

  map.on("mousemove", onMouseMove);
  map.on("mouseout", () => {
    tooltipEl.style.display = "none";
  });
});

function weekPngUrl(index) {
  return `data/${meta.weeks[index].png}`;
}

function weekBinUrl(index) {
  return `data/${meta.weeks[index].bin}`;
}

function formatWeekLabel(week) {
  const monday = new Date(week.monday + "T00:00:00");
  const sunday = new Date(week.sunday + "T00:00:00");
  const fmt = (d) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `Week ${week.week}: ${fmt(monday)} \u2013 ${fmt(sunday)}`;
}

async function setWeek(index) {
  currentWeekIndex = index;
  const week = meta.weeks[index];
  weekLabelEl.textContent = formatWeekLabel(week);

  const source = map.getSource(IMAGE_SOURCE_ID);
  if (source) {
    source.updateImage({ url: weekPngUrl(index) });
  }

  currentGrid = await loadGrid(index);
}

async function loadGrid(index) {
  if (gridCache.has(index)) {
    return gridCache.get(index);
  }
  loadingEl.style.display = "block";
  try {
    const buf = await fetch(weekBinUrl(index)).then((r) => r.arrayBuffer());
    const grid = new Int16Array(buf);
    gridCache.set(index, grid);
    return grid;
  } finally {
    loadingEl.style.display = "none";
  }
}

function onMouseMove(e) {
  if (!meta || !currentGrid) return;

  const { lng, lat } = e.lngLat;
  const { lonMin, lonMax, latMin, latMax } = meta.bounds;

  if (lng < lonMin || lng > lonMax || lat < latMin || lat > latMax) {
    tooltipEl.style.display = "none";
    return;
  }

  const { rows, cols, latStep, lonStep } = meta.grid;

  // row 0 = north (latMax), col 0 = west (lonMin)
  const col = Math.round((lng - lonMin) / lonStep);
  const row = Math.round((latMax - lat) / latStep);

  if (col < 0 || col >= cols || row < 0 || row >= rows) {
    tooltipEl.style.display = "none";
    return;
  }

  const raw = currentGrid[row * cols + col];
  tooltipEl.style.left = `${e.point.x + 14}px`;
  tooltipEl.style.top = `${e.point.y + 14}px`;
  tooltipEl.style.display = "block";

  if (raw === meta.rawEncoding.nanSentinel) {
    tooltipEl.textContent = "No data (ocean)";
  } else {
    const value = raw / meta.rawEncoding.scale;
    tooltipEl.textContent = `${value.toFixed(1)}\u00B0C`;
  }
}
