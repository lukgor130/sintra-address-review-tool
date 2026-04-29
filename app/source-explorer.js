const SOURCE_BASE = new URL("./data/source-cache/", import.meta.url);
const MANIFEST_URL = new URL("manifest.json", SOURCE_BASE);
const STREET_STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const SATELLITE_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const EPSG_3763 =
  "+proj=tmerc +lat_0=39.6682583333333 +lon_0=-8.13310833333333 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs";
const STORAGE_KEY = "sintra-source-explorer-state-v2";

const proj4Lib = globalThis.proj4;
if (!proj4Lib) {
  throw new Error("proj4 failed to load");
}
proj4Lib.defs("EPSG:3763", EPSG_3763);

const [manifest, parcelsLayerData, streetStyle] = await Promise.all([
  fetch(MANIFEST_URL).then((response) => response.json()),
  fetch(new URL("parcels-livre-expectante.json", SOURCE_BASE)).then((response) => response.json()),
  fetch(STREET_STYLE_URL).then((response) => response.json()),
]);

const parcelCounts = parcelsLayerData.features.reduce(
  (acc, feature) => {
    const tipologia = String(feature.attributes?.Tipologia ?? "").trim().toLowerCase();
    if (tipologia === "livre") {
      acc.livre += 1;
    } else if (tipologia === "expectante") {
      acc.expectante += 1;
    } else {
      acc.other += 1;
    }
    acc.total += 1;
    return acc;
  },
  { total: 0, livre: 0, expectante: 0, other: 0 },
);

function cloneStyle(styleObject) {
  return JSON.parse(JSON.stringify(styleObject));
}

function buildSatelliteStyle(baseStyle) {
  const next = cloneStyle(baseStyle);
  next.sources = {
    ...(cloneStyle(baseStyle.sources) || {}),
    satellite: {
      type: "raster",
      tiles: [SATELLITE_TILE_URL],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community.",
    },
  };
  next.layers = [
    {
      id: "satellite-basemap",
      type: "raster",
      source: "satellite",
    },
    ...next.layers.filter((layer) => ["line", "symbol", "circle"].includes(layer.type)),
  ];
  return next;
}

const basemapStyles = {
  street: streetStyle,
  satellite: buildSatelliteStyle(streetStyle),
};

const mapTitleEl = document.querySelector("#map-title");
const mapStatusEl = document.querySelector("#map-status");
const summaryStripEl = document.querySelector("#summary-strip");
const regulatoryListEl = document.querySelector("#regulatory-layer-list");
const inspectorStateEl = document.querySelector("#selection-state");
const selectionSummaryEl = document.querySelector("#selection-summary");
const fitVisibleButton = document.querySelector("#fit-visible-button");
const clearSelectionButton = document.querySelector("#clear-selection-button");
const parcelVisibleToggle = document.querySelector("#parcel-visible-toggle");
const regulatoryMasterToggle = document.querySelector("#regulatory-master-toggle");
const regulatoryMasterState = document.querySelector("#regulatory-master-state");
const parcelLivreCountEl = document.querySelector("#parcel-livre-count");
const parcelExpectanteCountEl = document.querySelector("#parcel-expectante-count");
const mapEmptyState = document.createElement("div");
mapEmptyState.className = "map-empty-state";
mapEmptyState.textContent = "No layers visible";
document.querySelector(".map-panel").append(mapEmptyState);

let state;
let map = null;
let selectedFeature = null;
let selectedLayerName = "";
let parcelBounds = null;
let mapReady = false;
let basemapMode = "street";
const loadedRegulatoryLayers = new Map();
const regulatoryDataCache = new Map();

function loadState() {
  const fallback = {
    basemapMode: "street",
    parcelsVisible: true,
    regulatoryVisible: {
      30: false,
      31: false,
      32: false,
    },
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      ...fallback,
      ...parsed,
      parcelsVisible:
        parsed.parcelsVisible ??
        parsed.parcelsFillVisible ??
        parsed.parcelsOutlineVisible ??
        fallback.parcelsVisible,
    };
  } catch {
    return fallback;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state, null, 2));
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-GB");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function projectPoint(point) {
  const [x, y] = point;
  return proj4Lib("EPSG:3763", "EPSG:4326", [x, y]);
}

function projectGeometry(geometry) {
  if (!geometry) {
    return null;
  }
  if (geometry.rings) {
    return {
      type: "Polygon",
      coordinates: geometry.rings.map((ring) => ring.map((point) => projectPoint(point))),
    };
  }
  if (geometry.paths) {
    return {
      type: "MultiLineString",
      coordinates: geometry.paths.map((path) => path.map((point) => projectPoint(point))),
    };
  }
  if (typeof geometry.x === "number" && typeof geometry.y === "number") {
    return {
      type: "Point",
      coordinates: projectPoint([geometry.x, geometry.y]),
    };
  }
  return null;
}

function expandBounds(bounds, coordinates) {
  if (!coordinates) {
    return bounds;
  }
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    const [lon, lat] = coordinates;
    if (!bounds) {
      return [lon, lat, lon, lat];
    }
    return [
      Math.min(bounds[0], lon),
      Math.min(bounds[1], lat),
      Math.max(bounds[2], lon),
      Math.max(bounds[3], lat),
    ];
  }
  for (const coordinate of coordinates) {
    bounds = expandBounds(bounds, coordinate);
  }
  return bounds;
}

function arcGisFeatureToGeoJson(feature, datasetName) {
  const properties = { ...(feature.attributes || {}), datasetName };
  const id = feature.attributes?.OBJECTID ?? feature.attributes?.OBJECT_ID ?? feature.attributes?.ID;
  const geometry = projectGeometry(feature.geometry);
  return {
    type: "Feature",
    id,
    properties,
    geometry,
  };
}

function layerToGeoJson(layerData, datasetName) {
  const features = [];
  let bounds = null;
  for (const feature of layerData.features || []) {
    const geoJsonFeature = arcGisFeatureToGeoJson(feature, datasetName);
    if (geoJsonFeature.geometry) {
      bounds = expandBounds(bounds, geoJsonFeature.geometry.coordinates);
    }
    features.push(geoJsonFeature);
  }
  return {
    type: "FeatureCollection",
    features,
    bounds,
  };
}

function keyForRegulatory(layerId) {
  return String(layerId);
}

function setMapStatus(message) {
  mapStatusEl.textContent = message;
}

function setLayerChip(chipEl, on) {
  chipEl.textContent = on ? "On" : "Off";
}

function buildSummary() {
  const regulatoryTotal = manifest.datasets.regulatoryLimits.layers.reduce(
    (sum, layer) => sum + layer.count,
    0,
  );
  summaryStripEl.innerHTML = [
    ["Parcels", formatNumber(parcelCounts.total)],
    ["Livre", formatNumber(parcelCounts.livre)],
    ["Expectante", formatNumber(parcelCounts.expectante)],
    ["Regulatory", formatNumber(regulatoryTotal)],
    ["Snapshot", new Date(manifest.generatedAt).toLocaleDateString()],
  ]
    .map(
      ([label, value]) => `
        <div class="summary-card">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `,
    )
    .join("");
}

function buildRegulatoryControls() {
  regulatoryListEl.innerHTML = manifest.datasets.regulatoryLimits.layers
    .map(
      (layer) => `
        <label class="layer-row" data-regulatory-row="${layer.layerId}">
          <input type="checkbox" data-regulatory-toggle="${layer.layerId}" />
          <span class="layer-swatch layer-swatch--${layer.layerId === 30 ? "uopg" : layer.layerId === 31 ? "augi" : "aru"}" aria-hidden="true"></span>
          <span class="layer-copy">
            <strong>${escapeHtml(layer.layerName)}</strong>
            <span>${formatNumber(layer.count)} features · ${escapeHtml(layer.file.split("/").pop())}</span>
          </span>
          <span class="state-chip" data-regulatory-state="${layer.layerId}">Off</span>
        </label>
      `,
    )
    .join("");
}

function layerVisible(layerId) {
  if (layerId === "parcels-fill" || layerId === "parcels-outline") {
    return Boolean(state.parcelsVisible);
  }
  return Boolean(state.regulatoryVisible[keyForRegulatory(layerId)]);
}

function visibleLayerIds() {
  const ids = [];
  if (state.parcelsVisible) {
    ids.push("parcels-fill");
  }
  if (state.parcelsVisible) {
    ids.push("parcels-outline");
  }
  for (const layer of manifest.datasets.regulatoryLimits.layers) {
    if (state.regulatoryVisible[keyForRegulatory(layer.layerId)] && loadedRegulatoryLayers.has(layer.layerId)) {
      ids.push(`regulatory-fill-${layer.layerId}`, `regulatory-line-${layer.layerId}`);
    }
  }
  return ids;
}

function updateMapEmptyState() {
  mapEmptyState.style.display = visibleLayerIds().length ? "none" : "block";
}

function syncParcelState() {
  parcelVisibleToggle.checked = Boolean(state.parcelsVisible);
  parcelVisibleToggle.setAttribute("aria-checked", String(Boolean(state.parcelsVisible)));
}

function syncRegulatoryState() {
  const visible = manifest.datasets.regulatoryLimits.layers.map((layer) =>
    Boolean(state.regulatoryVisible[keyForRegulatory(layer.layerId)]),
  );
  const allOn = visible.every(Boolean);
  const someOn = visible.some(Boolean);
  regulatoryMasterToggle.checked = allOn;
  regulatoryMasterToggle.indeterminate = someOn && !allOn;
  regulatoryMasterState.textContent = someOn ? "On" : "Off";

  for (const layer of manifest.datasets.regulatoryLimits.layers) {
    const chip = document.querySelector(`[data-regulatory-state="${layer.layerId}"]`);
    const checkbox = document.querySelector(`[data-regulatory-toggle="${layer.layerId}"]`);
    if (chip && checkbox) {
      const on = Boolean(state.regulatoryVisible[keyForRegulatory(layer.layerId)]);
      checkbox.checked = on;
      setLayerChip(chip, on);
    }
  }
}

function syncUi() {
  syncParcelState();
  syncRegulatoryState();
  updateMapEmptyState();
  buildSummary();
  saveState();
}

function setSelection(feature, layerName) {
  selectedFeature = feature ?? null;
  selectedLayerName = layerName ?? "";
  if (!selectedFeature) {
    inspectorStateEl.textContent = "None";
    selectionSummaryEl.textContent =
      "Click a parcel or regulatory feature to inspect its attributes.";
    if (map.getSource("selection-source")) {
      map.getSource("selection-source").setData({
        type: "FeatureCollection",
        features: [],
      });
    }
    return;
  }

  inspectorStateEl.textContent = layerName;
  const properties = selectedFeature.properties || {};
  const rows = [];

  if (properties.datasetName === "parcels") {
    rows.push(["Source", "Parcels"]);
    rows.push(["OBJECT_ID", properties.OBJECT_ID ?? properties.OBJECTID ?? ""]);
    rows.push(["Tipologia", properties.Tipologia ?? ""]);
    rows.push(["Area m2", properties.Area_m2 ? formatNumber(properties.Area_m2) : ""]);
    rows.push(["Qualif. Solo", properties.Qualif_Solo ?? ""]);
    rows.push(["Freguesia", properties.Freguesia ?? ""]);
    rows.push(["Em UOPG", properties.Em_UOPG ?? ""]);
    rows.push(["Em AUGI", properties.Em_AUGI ?? ""]);
    rows.push(["Em ARU", properties.Em_ARU ?? ""]);
  } else if (properties.datasetName === "regulatory-30") {
    rows.push(["Source", "Limites Regulamentares"]);
    rows.push(["Layer", "Unidades Operativas de Planeamento e Gestão"]);
    rows.push(["OBJECTID", properties.OBJECTID ?? ""]);
    rows.push(["Designation", properties.DESIGNACAO ?? ""]);
    rows.push(["Area m2", properties["Shape.STArea()"] ? formatNumber(properties["Shape.STArea()"]) : ""]);
    rows.push(["Length m", properties["Shape.STLength()"] ? formatNumber(properties["Shape.STLength()"]) : ""]);
  } else if (properties.datasetName === "regulatory-31") {
    rows.push(["Source", "Limites Regulamentares"]);
    rows.push(["Layer", "Áreas Urbanas de Génese Ilegal"]);
    rows.push(["OBJECTID", properties.OBJECTID ?? ""]);
    rows.push(["AUGI No.", properties.N_AUGI ?? ""]);
    rows.push(["Name", properties.NOME ?? ""]);
    rows.push(["Area m2", properties["Shape.STArea()"] ? formatNumber(properties["Shape.STArea()"]) : ""]);
    rows.push(["Length m", properties["Shape.STLength()"] ? formatNumber(properties["Shape.STLength()"]) : ""]);
  } else if (properties.datasetName === "regulatory-32") {
    rows.push(["Source", "Limites Regulamentares"]);
    rows.push(["Layer", "Áreas de Reabilitação Urbana"]);
    rows.push(["OBJECTID", properties.OBJECTID ?? ""]);
    rows.push(["Designation", properties.Designacao ?? ""]);
    rows.push(["Mode", properties.Modalidade ?? ""]);
    rows.push(["Area m2", properties["Shape.STArea()"] ? formatNumber(properties["Shape.STArea()"]) : ""]);
    rows.push(["Length m", properties["Shape.STLength()"] ? formatNumber(properties["Shape.STLength()"]) : ""]);
  } else {
    rows.push(["Source", layerName]);
    rows.push(["OBJECTID", properties.OBJECTID ?? ""]);
  }

  selectionSummaryEl.innerHTML = `
    <dl>
      ${rows
        .filter(([, value]) => value !== "" && value !== null && value !== undefined)
        .map(
          ([label, value]) => `
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(value)}</dd>
          `,
        )
        .join("")}
    </dl>
  `;

  if (map.getSource("selection-source")) {
    map.getSource("selection-source").setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: selectedFeature.geometry,
          properties: { ...selectedFeature.properties },
        },
      ],
    });
  }
}

function collectRenderedFeatureLayers() {
  if (!mapReady || !map.getLayer("parcels-fill")) {
    return [];
  }
  return visibleLayerIds().filter((layerId) => map.getLayer(layerId));
}

function addSelectionLayer() {
  map.addSource("selection-source", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [],
    },
  });
  map.addLayer({
    id: "selection-fill",
    type: "fill",
    source: "selection-source",
    paint: {
      "fill-color": "#fff8e4",
      "fill-opacity": 0.14,
    },
  });
  map.addLayer({
    id: "selection-line",
    type: "line",
    source: "selection-source",
    paint: {
      "line-color": "#18212a",
      "line-width": 3,
      "line-opacity": 0.92,
    },
  });
}

function addParcelsLayer() {
  const collection = layerToGeoJson(parcelsLayerData, "parcels");
  parcelBounds = collection.bounds;
  if (!map.getSource("parcels-source")) {
    map.addSource("parcels-source", {
      type: "geojson",
      data: collection,
    });
  }
  if (!map.getLayer("parcels-fill")) {
    map.addLayer({
      id: "parcels-fill",
      type: "fill",
      source: "parcels-source",
      paint: {
        "fill-color": [
          "match",
          ["coalesce", ["get", "Tipologia"], ""],
          "Livre",
          "#6b7d3d",
          "Expectante",
          "#d9a431",
          "#a59f91",
        ],
        "fill-opacity": 0.18,
      },
    });
  }
  if (!map.getLayer("parcels-outline")) {
    map.addLayer({
      id: "parcels-outline",
      type: "line",
      source: "parcels-source",
      paint: {
        "line-color": [
          "match",
          ["coalesce", ["get", "Tipologia"], ""],
          "Livre",
          "#40511d",
          "Expectante",
          "#7a4d05",
          "#6b675e",
        ],
        "line-width": 1.3,
        "line-opacity": 0.84,
      },
    });
  }
  applyParcelVisibility();
}

async function ensureRegulatoryLayer(layerConfig) {
  const layerId = layerConfig.layerId;
  if (loadedRegulatoryLayers.has(layerId)) {
    return loadedRegulatoryLayers.get(layerId);
  }

  if (!regulatoryDataCache.has(layerId)) {
    regulatoryDataCache.set(
      layerId,
      await fetch(new URL(layerConfig.file, SOURCE_BASE)).then((response) => response.json()),
    );
  }
  const layerData = regulatoryDataCache.get(layerId);
  const collection = layerToGeoJson(layerData, `regulatory-${layerId}`);
  const sourceId = `regulatory-source-${layerId}`;
  const fillId = `regulatory-fill-${layerId}`;
  const lineId = `regulatory-line-${layerId}`;
  const palette = layerPalette[layerId];

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "geojson",
      data: collection,
    });
  }
  if (!map.getLayer(fillId)) {
    map.addLayer({
      id: fillId,
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": palette.fill,
        "fill-opacity": 0.14,
      },
    });
  }
  if (!map.getLayer(lineId)) {
    map.addLayer({
      id: lineId,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": palette.line,
        "line-width": 1.35,
        "line-opacity": 0.9,
      },
    });
  }

  const layerRecord = {
    ...layerConfig,
    sourceId,
    fillId,
    lineId,
    bounds: collection.bounds,
    loaded: true,
  };
  loadedRegulatoryLayers.set(layerId, layerRecord);
  return layerRecord;
}

function applyParcelVisibility() {
  if (!map?.getLayer("parcels-fill") || !map?.getLayer("parcels-outline")) {
    return;
  }
  const visibility = state.parcelsVisible ? "visible" : "none";
  map.setLayoutProperty("parcels-fill", "visibility", visibility);
  map.setLayoutProperty("parcels-outline", "visibility", visibility);
  parcelVisibleToggle.checked = Boolean(state.parcelsVisible);
}

function setRegulatoryVisibility(layerConfig, visible) {
  state.regulatoryVisible[keyForRegulatory(layerConfig.layerId)] = visible;
  const chip = document.querySelector(`[data-regulatory-state="${layerConfig.layerId}"]`);
  const checkbox = document.querySelector(`[data-regulatory-toggle="${layerConfig.layerId}"]`);
  if (checkbox) {
    checkbox.checked = visible;
  }
  if (chip) {
    setLayerChip(chip, visible);
  }
  if (loadedRegulatoryLayers.has(layerConfig.layerId)) {
    const record = loadedRegulatoryLayers.get(layerConfig.layerId);
    map.setLayoutProperty(record.fillId, "visibility", visible ? "visible" : "none");
    map.setLayoutProperty(record.lineId, "visibility", visible ? "visible" : "none");
  }
  syncRegulatoryState();
  updateMapEmptyState();
  saveState();
}

async function toggleRegulatoryLayer(layerConfig, visible) {
  state.regulatoryVisible[keyForRegulatory(layerConfig.layerId)] = visible;
  const checkbox = document.querySelector(`[data-regulatory-toggle="${layerConfig.layerId}"]`);
  const chip = document.querySelector(`[data-regulatory-state="${layerConfig.layerId}"]`);
  if (checkbox) {
    checkbox.disabled = true;
  }
  mapStatusEl.textContent = visible ? `Loading ${layerConfig.layerName}` : "Hiding layer";
  try {
    if (visible) {
      const record = await ensureRegulatoryLayer(layerConfig);
      map.setLayoutProperty(record.fillId, "visibility", "visible");
      map.setLayoutProperty(record.lineId, "visibility", "visible");
    } else if (loadedRegulatoryLayers.has(layerConfig.layerId)) {
      const record = loadedRegulatoryLayers.get(layerConfig.layerId);
      map.setLayoutProperty(record.fillId, "visibility", "none");
      map.setLayoutProperty(record.lineId, "visibility", "none");
    }
    if (chip) {
      setLayerChip(chip, visible);
    }
  } finally {
    if (checkbox) {
      checkbox.disabled = false;
    }
    syncRegulatoryState();
    updateMapEmptyState();
    saveState();
    setMapStatus(readyStatusText());
  }
}

function fitVisibleLayers() {
  const bounds = [];
  if (map.getSource("parcels-source") && state.parcelsVisible) {
    if (parcelBounds) {
      bounds.push(parcelBounds);
    }
  }
  for (const layer of manifest.datasets.regulatoryLimits.layers) {
    if (!state.regulatoryVisible[keyForRegulatory(layer.layerId)]) {
      continue;
    }
    const record = loadedRegulatoryLayers.get(layer.layerId);
    if (record?.bounds) {
      bounds.push(record.bounds);
    }
  }
  if (!bounds.length) {
    return;
  }
  const merged = bounds.reduce(
    (acc, current) => [
      Math.min(acc[0], current[0]),
      Math.min(acc[1], current[1]),
      Math.max(acc[2], current[2]),
      Math.max(acc[3], current[3]),
    ],
  );
  map.fitBounds(
    [
      [merged[0], merged[1]],
      [merged[2], merged[3]],
    ],
    {
      padding: 42,
      maxZoom: 15,
      duration: 600,
    },
  );
}

function setupEvents() {
  parcelVisibleToggle.addEventListener("change", () => {
    state.parcelsVisible = parcelVisibleToggle.checked;
    applyParcelVisibility();
    syncUi();
  });

  regulatoryMasterToggle.addEventListener("change", async () => {
    const nextVisible = regulatoryMasterToggle.checked;
    if (nextVisible) {
      await Promise.all(
        manifest.datasets.regulatoryLimits.layers.map((layer) => toggleRegulatoryLayer(layer, true)),
      );
    } else {
      for (const layer of manifest.datasets.regulatoryLimits.layers) {
        setRegulatoryVisibility(layer, false);
      }
    }
    syncUi();
  });

  for (const layer of manifest.datasets.regulatoryLimits.layers) {
    const checkbox = document.querySelector(`[data-regulatory-toggle="${layer.layerId}"]`);
    checkbox.addEventListener("change", async () => {
      await toggleRegulatoryLayer(layer, checkbox.checked);
      syncUi();
    });
  }

  for (const button of document.querySelectorAll("[data-basemap-mode]")) {
    button.addEventListener("click", () => setBasemapMode(button.dataset.basemapMode));
  }

  fitVisibleButton.addEventListener("click", () => fitVisibleLayers());
  clearSelectionButton.addEventListener("click", () => setSelection(null, ""));
}

function updateMapCursor(event) {
  if (!mapReady) {
    return;
  }
  const features = map.queryRenderedFeatures(event.point, {
    layers: collectRenderedFeatureLayers(),
  });
  map.getCanvas().style.cursor = features.length ? "pointer" : "";
}

function updateSelectionFromClick(event) {
  if (!mapReady) {
    return;
  }
  const features = map.queryRenderedFeatures(event.point, {
    layers: collectRenderedFeatureLayers(),
  });
  if (!features.length) {
    setSelection(null, "");
    return;
  }
  const feature = features[0];
  const layerName =
    feature.properties?.datasetName === "parcels"
      ? "Parcels"
      : feature.properties?.datasetName === "regulatory-30"
        ? "UOPG"
        : feature.properties?.datasetName === "regulatory-31"
          ? "AUGI"
          : feature.properties?.datasetName === "regulatory-32"
            ? "ARU"
            : feature.layer?.id ?? "Feature";
  setSelection(
    {
      geometry: feature.geometry,
      properties: { ...(feature.properties || {}) },
    },
    layerName,
  );
}

function syncMapTitle() {
  mapTitleEl.textContent = `${parcelCounts.total.toLocaleString("en-GB")} parcels · ${parcelCounts.livre.toLocaleString(
    "en-GB",
  )} Livre · ${parcelCounts.expectante.toLocaleString("en-GB")} Expectante`;
  parcelLivreCountEl.textContent = `${formatNumber(parcelCounts.livre)} features`;
  parcelExpectanteCountEl.textContent = `${formatNumber(parcelCounts.expectante)} features`;
}

function updateBasemapUi() {
  for (const button of document.querySelectorAll("[data-basemap-mode]")) {
    const active = button.dataset.basemapMode === basemapMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (mapReady) {
    setMapStatus(readyStatusText());
  }
}

function readyStatusText() {
  const label = basemapMode === "satellite" ? "Satellite + labels" : "Street";
  return `${label} basemap · local cache ready`;
}

function setBasemapMode(nextMode) {
  if (!basemapStyles[nextMode] || nextMode === basemapMode) {
    return;
  }
  basemapMode = nextMode;
  state.basemapMode = nextMode;
  saveState();
  mapReady = false;
  updateBasemapUi();
  setMapStatus(`${nextMode === "satellite" ? "Satellite + labels" : "Street"} basemap loading…`);
  map.setStyle(cloneStyle(basemapStyles[basemapMode]));
}

function setupMap() {
  map = new maplibregl.Map({
    container: "map",
    style: cloneStyle(basemapStyles[basemapMode]),
    center: [-9.15, 38.8],
    zoom: 11,
    minZoom: 8,
    maxZoom: 18,
    attributionControl: true,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.on("style.load", async () => {
    try {
      addParcelsLayer();
      addSelectionLayer();
      loadedRegulatoryLayers.clear();
      await loadPersistedRegulatoryLayers();
      syncMapTitle();
      syncUi();
      mapReady = true;
      updateBasemapUi();
      if (selectedFeature) {
        setSelection(selectedFeature, selectedLayerName);
      }
      fitVisibleLayers();
      map.resize();
    } catch (error) {
      console.error("Failed to restore source layers after style reload", error);
      mapReady = true;
      setMapStatus("Basemap loaded, but some local layers failed to restore");
    }
  });

  map.on("mousemove", updateMapCursor);
  map.on("click", updateSelectionFromClick);
  map.on("mouseleave", () => {
    map.getCanvas().style.cursor = "";
  });
  return map;
}

function restoreRegulatoryState() {
  state.parcelsVisible = Boolean(
    state.parcelsVisible ?? state.parcelsFillVisible ?? state.parcelsOutlineVisible ?? true,
  );
  state.basemapMode = basemapStyles[state.basemapMode] ? state.basemapMode : "street";
  basemapMode = state.basemapMode;
  for (const layer of manifest.datasets.regulatoryLimits.layers) {
    state.regulatoryVisible[keyForRegulatory(layer.layerId)] = Boolean(
      state.regulatoryVisible[keyForRegulatory(layer.layerId)],
    );
  }
}

function initRegulatoryRows() {
  buildRegulatoryControls();
  for (const layer of manifest.datasets.regulatoryLimits.layers) {
    const checkbox = document.querySelector(`[data-regulatory-toggle="${layer.layerId}"]`);
    checkbox.checked = Boolean(state.regulatoryVisible[keyForRegulatory(layer.layerId)]);
  }
}

async function loadPersistedRegulatoryLayers() {
  for (const layer of manifest.datasets.regulatoryLimits.layers) {
    if (state.regulatoryVisible[keyForRegulatory(layer.layerId)]) {
      await toggleRegulatoryLayer(layer, true);
    } else {
      setRegulatoryVisibility(layer, false);
    }
  }
}

state = loadState();
restoreRegulatoryState();
initRegulatoryRows();
syncMapTitle();
syncUi();
updateBasemapUi();
setMapStatus(`${basemapMode === "satellite" ? "Satellite + labels" : "Street"} basemap loading…`);
setupEvents();
setupMap();

window.addEventListener("resize", () => {
  if (mapReady) {
    map.resize();
  }
});
