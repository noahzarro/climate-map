// Period climate climatology viewer.
//
// Loads data/meta.json for bounds + per-variable/per-period metadata,
// displays the selected variable/period's pre-colored PNG as an image
// overlay, lets the user pick the variable and the period (via a
// pseudo-calendar) from a right sidebar, and shows the exact raw value on
// hover by reading from that period's raw Int16 grid
// (data/<var>/period_XX.bin). Each of the 12 months is split into 4
// nearly-equal periods (see periods.py), for 48 periods total.

const DATA_URL = "data/meta.json";
const IMAGE_SOURCE_ID = "climate-image";
const IMAGE_LAYER_ID = "climate-layer";
const HIGHLIGHT_SOURCE_ID = "climate-highlight";
const HIGHLIGHT_LAYER_ID = "climate-highlight-layer";

const HIGHLIGHT_DIM_ALPHA = 170; // 0-255, alpha of the dimming overlay

let meta = null;
let currentVariable = null;
let currentPeriodIndex = 0;
let currentGrid = null; // Int16Array for the currently loaded variable/period
const gridCache = new Map(); // "var:periodIndex" -> Int16Array

let highlightEnabled = false;
let highlightDirection = "atLeast"; // "atLeast" | "atMost"
let highlightThreshold = 0;
let rowRemap = null; // Int32Array: for each Mercator-warped output row, the
// nearest source row index in the north-first equirectangular grid.

const variableButtonsEl = document.getElementById("variable-buttons");
const legendImgEl = document.getElementById("legend-gradient");
const legendMinEl = document.getElementById("legend-min");
const legendMaxEl = document.getElementById("legend-max");
const selectedPeriodLabelEl = document.getElementById("selected-period-label");
const calendarEl = document.getElementById("calendar");
const tooltipEl = document.getElementById("tooltip");
const loadingEl = document.getElementById("loading");
const highlightEnableEl = document.getElementById("highlight-enable");
const highlightControlsEl = document.getElementById("highlight-controls");
const highlightDirectionEl = document.getElementById("highlight-direction");
const highlightThresholdEl = document.getElementById("highlight-threshold");
const highlightValueLabelEl = document.getElementById("highlight-value-label");
const sidebarEl = document.getElementById("sidebar");
const sidebarToggleEl = document.getElementById("sidebar-toggle");
const sidebarBackdropEl = document.getElementById("sidebar-backdrop");

// --- Collapsible sidebar (small/mobile viewports) ---------------------
// On wider viewports the sidebar is permanently visible (see CSS); below
// the mobile breakpoint it's an off-canvas overlay toggled by the
// floating button / backdrop below.
function setSidebarOpen(open) {
  sidebarEl.classList.toggle("open", open);
  sidebarBackdropEl.classList.toggle("visible", open);
  sidebarToggleEl.setAttribute("aria-expanded", String(open));
}

sidebarToggleEl.addEventListener("click", () => {
  setSidebarOpen(!sidebarEl.classList.contains("open"));
});

sidebarBackdropEl.addEventListener("click", () => setSidebarOpen(false));

// --- Scale control (bottom-left) --------------------------------------
// MapLibre's built-in ScaleControl measures ground distance at the
// *vertical center* of the map container - correct for a control placed
// near the center, but not for one anchored at the bottom-left. In the
// Mercator projection, meters-per-pixel varies with latitude, and this
// app's data spans a huge latitude range (~25-71 degrees N), so the true
// scale at the bottom of the viewport can differ noticeably from the
// scale at the vertical center. This control instead measures distance
// directly at the bottom edge of the map container - where it's
// visually anchored - so the displayed scale always matches that corner,
// not some other (generally more northern, i.e. more compressed) part of
// the visible map.
class BottomEdgeScaleControl {
  constructor(options = {}) {
    this._maxWidth = options.maxWidth || 100;
    this._update = this._update.bind(this);
  }

  onAdd(map) {
    this._map = map;
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-scale";
    this._update();
    this._map.on("move", this._update);
    this._map.on("resize", this._update);
    return this._container;
  }

  onRemove() {
    this._container.remove();
    this._map.off("move", this._update);
    this._map.off("resize", this._update);
    this._map = undefined;
  }

  getDefaultPosition() {
    return "bottom-left";
  }

  _update() {
    const map = this._map;
    const maxWidth = this._maxWidth;

    // y = bottom edge of the container (minus a pixel to stay in bounds),
    // not clientHeight / 2, since that's where this control is anchored.
    const y = map.getContainer().clientHeight - 1;
    const left = map.unproject([0, y]);
    const right = map.unproject([maxWidth, y]);
    const maxMeters = left.distanceTo(right);

    if (maxMeters >= 1000) {
      setScale(this._container, maxWidth, maxMeters / 1000, "km");
    } else {
      setScale(this._container, maxWidth, maxMeters, "m");
    }
  }
}

function setScale(container, maxWidth, maxDistance, unit) {
  const distance = getRoundScaleNum(maxDistance);
  const ratio = distance / maxDistance;
  container.style.width = `${maxWidth * ratio}px`;
  container.innerHTML = `${distance}&nbsp;${unit}`;
}

// Round a raw distance down to a "nice" number (1/2/3/5/10 x a power of
// ten) for display, same approach MapLibre's own ScaleControl uses.
function getRoundScaleNum(num) {
  const pow10 = Math.pow(10, `${Math.floor(num)}`.length - 1);
  let d = num / pow10;
  d = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : d >= 1 ? 1 : getDecimalRoundNum(d);
  return pow10 * d;
}

function getDecimalRoundNum(d) {
  const multiplier = Math.pow(10, Math.ceil(-Math.log(d) / Math.LN10));
  return Math.round(d * multiplier) / multiplier;
}

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [10, 48],
  zoom: 3.2,
});

map.addControl(new maplibregl.NavigationControl(), "top-left");
map.addControl(new BottomEdgeScaleControl(), "bottom-left");
window.map = map; // handy for debugging in the browser console

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
    url: periodPngUrl(currentVariable, 0),
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

  // Highlight overlay: a dimming mask drawn on top of the color layer,
  // built client-side from the raw grid, so it can respond instantly to
  // threshold changes without any server round-trip.
  map.addSource(HIGHLIGHT_SOURCE_ID, {
    type: "image",
    url: transparentPixelUrl(),
    coordinates,
  });

  map.addLayer(
    {
      id: HIGHLIGHT_LAYER_ID,
      type: "raster",
      source: HIGHLIGHT_SOURCE_ID,
      paint: {
        "raster-opacity": 1,
      },
    },
    firstSymbolLayer ? firstSymbolLayer.id : undefined
  );

  map.fitBounds(
    [
      [lonMin, latMin],
      [lonMax, latMax],
    ],
    { padding: 0, duration: 0 }
  );

  // Restrict panning/zooming so the world outside the data region isn't
  // visible. maxBounds is set to the exact data bbox (no extra padding),
  // and minZoom is bumped slightly above the fitBounds zoom so a mismatch
  // between the data's aspect ratio and the viewport's aspect ratio can
  // never leave a blank (data-less) strip visible at the edges - we'd
  // rather crop a sliver of the data than show empty basemap.
  map.setMaxBounds([
    [lonMin, latMin],
    [lonMax, latMax],
  ]);
  const minZoom = map.getZoom() + 0.3;
  map.setMinZoom(minZoom);
  map.jumpTo({ zoom: minZoom });

  buildVariableButtons();
  buildCalendar();
  updateLegend();
  setupHighlightControls();

  const { rows } = meta.grid;
  rowRemap = buildMercatorRowRemap(latMin, latMax, meta.grid.latStep, rows);

  await setPeriod(0);

  map.on("mousemove", onMouseMove);
  map.on("mouseout", () => {
    tooltipEl.style.display = "none";
  });
});

function periodPngUrl(variable, index) {
  const period = meta.periods[index];
  return `data/${meta.variables[variable].dir}/period_${String(period.index).padStart(2, "0")}.png`;
}

function periodBinUrl(variable, index) {
  const period = meta.periods[index];
  return `data/${meta.variables[variable].dir}/period_${String(period.index).padStart(2, "0")}.bin`;
}

function formatPeriodLabel(period) {
  return `${period.monthName}: ${period.label}`;
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

  // Group periods by calendar month (1-12).
  const months = Array.from({ length: 12 }, () => []);
  for (const period of meta.periods) {
    months[period.month - 1].push(period);
  }

  months.forEach((periods) => {
    if (periods.length === 0) return;

    const block = document.createElement("div");
    block.className = "month-block";

    const label = document.createElement("div");
    label.className = "month-label";
    label.textContent = periods[0].monthName;
    block.appendChild(label);

    const row = document.createElement("div");
    row.className = "month-periods";

    for (const period of periods) {
      const cell = document.createElement("div");
      cell.className = "period-cell";
      cell.textContent = String(period.part);
      cell.title = formatPeriodLabel(period);
      cell.dataset.index = String(period.index);
      cell.addEventListener("click", () => setPeriod(period.index));
      row.appendChild(cell);
    }

    block.appendChild(row);
    calendarEl.appendChild(block);
  });
}

function markSelectedPeriodCell() {
  const cells = calendarEl.querySelectorAll(".period-cell");
  cells.forEach((cell) => {
    cell.classList.toggle(
      "selected",
      parseInt(cell.dataset.index, 10) === currentPeriodIndex
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
  configureThresholdRangeForVariable(meta.variables[currentVariable]);

  const source = map.getSource(IMAGE_SOURCE_ID);
  if (source) {
    source.updateImage({ url: periodPngUrl(currentVariable, currentPeriodIndex) });
  }

  currentGrid = await loadGrid(currentVariable, currentPeriodIndex);
  updateHighlightOverlay();
}

async function setPeriod(index) {
  currentPeriodIndex = index;
  const period = meta.periods[index];
  selectedPeriodLabelEl.textContent = formatPeriodLabel(period);
  markSelectedPeriodCell();

  const source = map.getSource(IMAGE_SOURCE_ID);
  if (source) {
    source.updateImage({ url: periodPngUrl(currentVariable, index) });
  }

  currentGrid = await loadGrid(currentVariable, index);
  updateHighlightOverlay();
}

async function loadGrid(variable, index) {
  const cacheKey = `${variable}:${index}`;
  if (gridCache.has(cacheKey)) {
    return gridCache.get(cacheKey);
  }
  loadingEl.style.display = "block";
  try {
    const buf = await fetch(periodBinUrl(variable, index)).then((r) => r.arrayBuffer());
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

  if (raw === config.rawEncoding.nanSentinel) {
    tooltipEl.textContent = "No data (ocean)";
  } else {
    const value = raw / config.rawEncoding.scale;
    tooltipEl.textContent = `${config.label}: ${value.toFixed(1)}${config.units}`;
  }

  positionTooltip(e.point.x, e.point.y);
}

// Position the tooltip near the cursor, offset by 14px, but clamped so it
// never extends past the viewport edges (which would otherwise grow the
// document size and show a scrollbar).
function positionTooltip(pointX, pointY) {
  // Must be visible before measuring, since a display:none element always
  // reports zero offsetWidth/offsetHeight.
  tooltipEl.style.display = "block";

  const OFFSET = 14;
  const { offsetWidth: width, offsetHeight: height } = tooltipEl;

  let left = pointX + OFFSET;
  if (left + width > window.innerWidth) {
    left = pointX - OFFSET - width;
  }
  left = Math.max(0, Math.min(left, window.innerWidth - width));

  let top = pointY + OFFSET;
  if (top + height > window.innerHeight) {
    top = pointY - OFFSET - height;
  }
  top = Math.max(0, Math.min(top, window.innerHeight - height));

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

// --- Highlight (threshold) overlay -----------------------------------

function transparentPixelUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas.toDataURL("image/png");
}

function mercatorY(latDeg) {
  const phi = (latDeg * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

function mercatorYToLat(y) {
  const phi = 2 * Math.atan(Math.exp(y)) - Math.PI / 2;
  return (phi * 180) / Math.PI;
}

/**
 * For a north-first equirectangular grid (row 0 = latMax, evenly spaced by
 * `latStep`), build a mapping from an output row index (also north-first,
 * but evenly spaced in Web Mercator Y, matching how the color PNGs were
 * pre-warped in export_web.py) to the nearest source row index.
 *
 * Nearest-neighbor (rather than interpolation) is used deliberately, so
 * NaN "no data" cells never bleed into neighboring valid cells when we
 * threshold them.
 */
function buildMercatorRowRemap(latMin, latMax, latStep, rows) {
  const yMin = mercatorY(latMin);
  const yMax = mercatorY(latMax);
  const remap = new Int32Array(rows);

  for (let r = 0; r < rows; r++) {
    const frac = r / (rows - 1);
    const yRow = yMax - frac * (yMax - yMin);
    const latRow = mercatorYToLat(yRow);
    const idxFrac = Math.min(
      Math.max((latMax - latRow) / latStep, 0),
      rows - 1
    );
    remap[r] = Math.round(idxFrac);
  }

  return remap;
}

function setupHighlightControls() {
  const config = meta.variables[currentVariable];
  highlightThreshold = (config.colorScale.min + config.colorScale.max) / 2;
  configureThresholdRangeForVariable(config);

  highlightEnableEl.addEventListener("change", () => {
    highlightEnabled = highlightEnableEl.checked;
    highlightControlsEl.classList.toggle("disabled", !highlightEnabled);
    updateHighlightOverlay();
  });

  highlightDirectionEl.querySelectorAll(".direction-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      highlightDirection = btn.dataset.direction;
      highlightDirectionEl
        .querySelectorAll(".direction-button")
        .forEach((b) => b.classList.toggle("active", b === btn));
      updateHighlightLabel();
      updateHighlightOverlay();
    });
  });

  highlightThresholdEl.addEventListener("input", () => {
    highlightThreshold = parseFloat(highlightThresholdEl.value);
    updateHighlightLabel();
    updateHighlightOverlay();
  });
}

function configureThresholdRangeForVariable(config) {
  const { min, max } = config.colorScale;
  highlightThresholdEl.min = String(min);
  highlightThresholdEl.max = String(max);
  highlightThreshold = Math.min(Math.max(highlightThreshold, min), max);
  highlightThresholdEl.value = String(highlightThreshold);
  updateHighlightLabel();
}

function updateHighlightLabel() {
  const config = meta.variables[currentVariable];
  const dirLabel = highlightDirection === "atLeast" ? "\u2265" : "\u2264";
  highlightValueLabelEl.textContent = `Threshold: ${dirLabel} ${highlightThreshold.toFixed(1)}${config.units}`;
}

function updateHighlightOverlay() {
  const source = map.getSource(HIGHLIGHT_SOURCE_ID);
  if (!source) return;

  if (!highlightEnabled || !currentGrid || !rowRemap) {
    source.updateImage({ url: transparentPixelUrl() });
    return;
  }

  const { rows, cols } = meta.grid;
  const config = meta.variables[currentVariable];
  const { scale, nanSentinel } = config.rawEncoding;
  const thresholdRaw = Math.round(highlightThreshold * scale);

  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(cols, rows);
  const data = imageData.data;

  for (let r = 0; r < rows; r++) {
    const srcRow = rowRemap[r];
    const rowOffset = srcRow * cols;
    const outOffset = r * cols;

    for (let c = 0; c < cols; c++) {
      const raw = currentGrid[rowOffset + c];
      const outIdx = (outOffset + c) * 4;

      if (raw === nanSentinel) {
        data[outIdx + 3] = 0; // no data -> fully transparent (already so in color layer)
        continue;
      }

      const matches =
        highlightDirection === "atLeast"
          ? raw >= thresholdRaw
          : raw <= thresholdRaw;

      if (matches) {
        data[outIdx + 3] = 0; // matching area: leave untouched (no dimming)
      } else {
        data[outIdx] = 0;
        data[outIdx + 1] = 0;
        data[outIdx + 2] = 0;
        data[outIdx + 3] = HIGHLIGHT_DIM_ALPHA; // non-matching: dim
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  source.updateImage({ url: canvas.toDataURL("image/png") });
}
