// Weekly climate climatology viewer.
//
// Loads data/meta.json for bounds + per-variable/per-week metadata, displays
// the selected variable/week's pre-colored PNG as an image overlay, lets the
// user pick the variable and the week (via a pseudo-calendar) from a right
// sidebar, and shows the exact raw value on hover by reading from that
// week's raw Int16 grid (data/<var>/week_XX.bin).

const DATA_URL = "data/meta.json";
const IMAGE_SOURCE_ID = "climate-image";
const IMAGE_LAYER_ID = "climate-layer";

let meta = null;
let currentVariable = null;
let currentWeekIndex = 0;
let currentGrid = null; // Int16Array for the currently loaded variable/week
const gridCache = new Map(); // "var:weekIndex" -> Int16Array

const variableButtonsEl = document.getElementById("variable-buttons");
const legendImgEl = document.getElementById("legend-gradient");
const legendMinEl = document.getElementById("legend-min");
const legendMaxEl = document.getElementById("legend-max");
const selectedWeekLabelEl = document.getElementById("selected-week-label");
const calendarEl = document.getElementById("calendar");
const tooltipEl = document.getElementById("tooltip");
const loadingEl = document.getElementById("loading");

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [10, 48],
  zoom: 3.2,
});

map.addControl(new maplibregl.NavigationControl(), "top-left");

map.on("load", async () => {
  meta = await fetch(DATA_URL).then((r) => r.json());
  currentVariable = meta.defaultVariable;

  const { lonMin, lonMax, latMin, latMax } = meta.bounds;
  const coordinates = [
    [lonMin, latMax], // top left
    [lonMax, latMax], // top right
    [lonMax, latMin], // bottom right
    [lonMin, latMin], // bottom left
  ];

  map.addSource(IMAGE_SOURCE_ID, {
    type: "image",
    url: weekPngUrl(currentVariable, 0),
    coordinates,
  });

  // Insert the overlay below the first symbol (label/text) layer in the
  // basemap style, so place/country/road labels stay on top and remain
  // readable instead of being covered by the overlay.
  const firstSymbolLayer = map
    .getStyle()
    .layers.find((layer) => layer.type === "symbol");

  map.addLayer(
    {
      id: IMAGE_LAYER_ID,
      type: "raster",
      source: IMAGE_SOURCE_ID,
      paint: {
        "raster-opacity": 0.75,
      },
    },
    firstSymbolLayer ? firstSymbolLayer.id : undefined
  );

  map.fitBounds(
    [
      [lonMin, latMin],
      [lonMax, latMax],
    ],
    { padding: 20, duration: 0 }
  );

  // Restrict panning/zooming so the world outside the data region isn't
  // visible.
  const boundsPadding = 4; // degrees
  map.setMaxBounds([
    [lonMin - boundsPadding, latMin - boundsPadding],
    [lonMax + boundsPadding, latMax + boundsPadding],
  ]);
  map.setMinZoom(map.getZoom());

  buildVariableButtons();
  buildCalendar();
  updateLegend();

  await setWeek(0);

  map.on("mousemove", onMouseMove);
  map.on("mouseout", () => {
    tooltipEl.style.display = "none";
  });
});

function weekPngUrl(variable, index) {
  const week = meta.weeks[index];
  return `data/${meta.variables[variable].dir}/week_${String(week.index).padStart(2, "0")}.png`;
}

function weekBinUrl(variable, index) {
  const week = meta.weeks[index];
  return `data/${meta.variables[variable].dir}/week_${String(week.index).padStart(2, "0")}.bin`;
}

function formatWeekLabel(week) {
  const monday = new Date(week.monday + "T00:00:00");
  const sunday = new Date(week.sunday + "T00:00:00");
  const fmt = (d) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `Week ${week.week}: ${fmt(monday)} \u2013 ${fmt(sunday)}`;
}

function buildVariableButtons() {
  variableButtonsEl.innerHTML = "";
  for (const [key, config] of Object.entries(meta.variables)) {
    const btn = document.createElement("button");
    btn.className = "variable-button" + (key === currentVariable ? " active" : "");
    btn.textContent = config.label;
    btn.dataset.variable = key;
    btn.addEventListener("click", () => setVariable(key));
    variableButtonsEl.appendChild(btn);
  }
}

function updateLegend() {
  const config = meta.variables[currentVariable];
  legendImgEl.src = `data/${config.dir}/${config.legend}`;
  legendMinEl.textContent = `${config.colorScale.min}${config.units}`;
  legendMaxEl.textContent = `${config.colorScale.max}${config.units}`;
}

function buildCalendar() {
  calendarEl.innerHTML = "";

  // Group weeks by the calendar month of their Monday date.
  const months = Array.from({ length: 12 }, () => []);
  for (const week of meta.weeks) {
    const monday = new Date(week.monday + "T00:00:00");
    months[monday.getMonth()].push(week);
  }

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  months.forEach((weeks, monthIndex) => {
    if (weeks.length === 0) return;

    const block = document.createElement("div");
    block.className = "month-block";

    const label = document.createElement("div");
    label.className = "month-label";
    label.textContent = monthNames[monthIndex];
    block.appendChild(label);

    const row = document.createElement("div");
    row.className = "month-weeks";

    for (const week of weeks) {
      const cell = document.createElement("div");
      cell.className = "week-cell";
      cell.textContent = String(week.week);
      cell.title = formatWeekLabel(week);
      cell.dataset.index = String(week.index);
      cell.addEventListener("click", () => setWeek(week.index));
      row.appendChild(cell);
    }

    block.appendChild(row);
    calendarEl.appendChild(block);
  });
}

function highlightSelectedWeek() {
  const cells = calendarEl.querySelectorAll(".week-cell");
  cells.forEach((cell) => {
    cell.classList.toggle(
      "selected",
      parseInt(cell.dataset.index, 10) === currentWeekIndex
    );
  });
}

async function setVariable(variable) {
  if (variable === currentVariable) return;
  currentVariable = variable;

  variableButtonsEl.querySelectorAll(".variable-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.variable === variable);
  });

  updateLegend();

  const source = map.getSource(IMAGE_SOURCE_ID);
  if (source) {
    source.updateImage({ url: weekPngUrl(currentVariable, currentWeekIndex) });
  }

  currentGrid = await loadGrid(currentVariable, currentWeekIndex);
}

async function setWeek(index) {
  currentWeekIndex = index;
  const week = meta.weeks[index];
  selectedWeekLabelEl.textContent = formatWeekLabel(week);
  highlightSelectedWeek();

  const source = map.getSource(IMAGE_SOURCE_ID);
  if (source) {
    source.updateImage({ url: weekPngUrl(currentVariable, index) });
  }

  currentGrid = await loadGrid(currentVariable, index);
}

async function loadGrid(variable, index) {
  const cacheKey = `${variable}:${index}`;
  if (gridCache.has(cacheKey)) {
    return gridCache.get(cacheKey);
  }
  loadingEl.style.display = "block";
  try {
    const buf = await fetch(weekBinUrl(variable, index)).then((r) => r.arrayBuffer());
    const grid = new Int16Array(buf);
    gridCache.set(cacheKey, grid);
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
  const config = meta.variables[currentVariable];

  tooltipEl.style.left = `${e.point.x + 14}px`;
  tooltipEl.style.top = `${e.point.y + 14}px`;
  tooltipEl.style.display = "block";

  if (raw === config.rawEncoding.nanSentinel) {
    tooltipEl.textContent = "No data (ocean)";
  } else {
    const value = raw / config.rawEncoding.scale;
    tooltipEl.textContent = `${config.label}: ${value.toFixed(1)}${config.units}`;
  }
}
