const params = new URLSearchParams(globalThis.location.search);
const manifestUrl = new URL(
  params.get("pack") ?? "./data/pack-azenhas/manifest.json",
  globalThis.location.href,
);
const packBaseUrl = new URL("./", manifestUrl);
const manifest = await fetch(manifestUrl).then((response) => response.json());
const parcelsGeojson = await fetch(new URL(manifest.data.parcels, manifestUrl)).then((response) =>
  response.json(),
);
const aoiGeojson = await fetch(new URL(manifest.data.aoi, manifestUrl)).then((response) =>
  response.json(),
);
const basemapUrl = new URL(manifest.basemap.file, manifestUrl);
const basemapKey = basemapUrl.pathname.split("/").pop() ?? "basemap.pmtiles";
const basemapFile = new File(
  [await fetch(basemapUrl).then((response) => response.arrayBuffer())],
  basemapKey,
  {
    type: "application/octet-stream",
  },
);
const basemapStyleKey = localStorage.getItem(`sintra-aoi-basemap-mode:${manifest.name}`) ?? "street";
const basemapStyleFiles = {
  street: new URL(manifest.style.file, manifestUrl),
  satellite: new URL(manifest.styles?.satellite?.file ?? "./satellite-style.json", manifestUrl),
};
const [streetStyle, satelliteStyle] = await Promise.all([
  fetch(basemapStyleFiles.street).then((response) => response.json()),
  fetch(basemapStyleFiles.satellite).then((response) => response.json()),
]);

const basemapStyles = {
  street: streetStyle,
  satellite: satelliteStyle,
};
const basemapModeLabel = {
  street: manifest.styles?.street?.label ?? "Street",
  satellite: manifest.styles?.satellite?.label ?? "Satellite",
};
let basemapMode = basemapStyles[basemapStyleKey] ? basemapStyleKey : "street";

const STORAGE_KEY = `sintra-aoi-feedback-v2:${manifest.name}`;

const STATUS_LABELS = {
  unknown: "Open",
  owner_known: "Knows owner",
  network_known: "Knows someone linked",
  possible_lead: "Possible lead",
  needs_research: "Needs research",
  no_local_lead: "No local lead",
};

const STATUS_ORDER = {
  owner_known: 0,
  network_known: 1,
  possible_lead: 2,
  needs_research: 3,
  unknown: 4,
  no_local_lead: 5,
};

const progressGridEl = document.querySelector("#metric-strip");
const datasetTitleEl = document.querySelector("#dataset-title");
const datasetDescriptionEl = document.querySelector("#dataset-description");
const parcelSearchEl = document.querySelector("#parcel-search");
const statusFilterEl = document.querySelector("#status-filter");
const sortModeEl = document.querySelector("#sort-mode");
const visibleCountEl = document.querySelector("#visible-count");
const parcelListEl = document.querySelector("#parcel-list");
const parcelTitleEl = document.querySelector("#parcel-title");
const parcelPositionEl = document.querySelector("#parcel-position");
const parcelSummaryEl = document.querySelector("#parcel-summary");
const knowledgeStatusEl = document.querySelector("#knowledge-status");
const leadNameEl = document.querySelector("#lead-name");
const contactTrailEl = document.querySelector("#contact-trail");
const confidenceRowEl = document.querySelector("#confidence-row");
const parcelNotesEl = document.querySelector("#parcel-notes");
const previousParcelEl = document.querySelector("#previous-parcel");
const nextParcelEl = document.querySelector("#next-parcel");
const saveStateEl = document.querySelector("#save-state");
const exportJsonEl = document.querySelector("#export-json");
const exportCsvEl = document.querySelector("#export-csv");
const clearFeedbackEl = document.querySelector("#clear-feedback");
const mapTitleEl = document.querySelector("#map-title");
const basemapStatusEl = document.querySelector("#basemap-status");

datasetTitleEl.textContent = manifest.name;
datasetDescriptionEl.textContent = `${manifest.parcelCount} plots in this local map pack. The basemap, labels, parcel geometry, and review data all load from local files.`;
basemapStatusEl.hidden = false;
basemapStatusEl.textContent =
  basemapMode === "satellite" ? `${basemapModeLabel.satellite} + labels` : `${basemapModeLabel.street} basemap`;

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadFeedback() {
  const fallback = { version: 2, parcels: {}, createdAt: new Date().toISOString() };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return fallback;
  }
}

let feedback = loadFeedback();

function saveFeedback() {
  feedback.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(feedback, null, 2));
}

const parcels = parcelsGeojson.features.map((feature) => ({
  ...feature.properties,
  objectId: feature.id ?? feature.properties.objectId,
  geometry: feature.geometry,
}));

let activeParcelId = parcels[0]?.objectId ?? null;
let mapLoaded = false;
let initialViewportApplied = false;
const BASEMAP_STORAGE_KEY = `sintra-aoi-basemap-mode:${manifest.name}`;

function cloneStyle(styleObject) {
  return JSON.parse(JSON.stringify(styleObject));
}

function prepareStyle(styleObject) {
  const next = cloneStyle(styleObject);
  next.glyphs = `${packBaseUrl.href}assets/fonts/{fontstack}/{range}.pbf`;
  next.sprite = new URL("assets/sprites/v4/light", packBaseUrl).href;
  if (next.sources?.satellite?.tiles?.length) {
    next.sources.satellite.tiles = [
      `${packBaseUrl.href}satellite/{z}/{x}/{y}.jpg`,
    ];
  }
  return next;
}

function feedbackKey(parcel) {
  return String(parcel.sourceObjectId);
}

function getParcelFeedback(parcel) {
  const key = feedbackKey(parcel);
  feedback.parcels[key] ??= {
    sourceObjectId: parcel.sourceObjectId,
    parcelObjectId: parcel.objectId,
    knowledgeStatus: "",
    leadName: "",
    contactTrail: "",
    confidence: "",
    notes: "",
    reviewedAt: null,
  };
  return feedback.parcels[key];
}

function parcelStatus(parcel) {
  return getParcelFeedback(parcel).knowledgeStatus || "unknown";
}

function actionable(parcel) {
  return ["owner_known", "network_known", "possible_lead"].includes(parcelStatus(parcel));
}

function parcelWasTouched(parcel) {
  const item = getParcelFeedback(parcel);
  return Boolean(
    item.reviewedAt ||
      item.knowledgeStatus ||
      item.leadName.trim() ||
      item.contactTrail.trim() ||
      item.confidence ||
      item.notes.trim(),
  );
}

function visibleParcels() {
  const query = normalizeText(parcelSearchEl.value);
  const filter = statusFilterEl.value;
  const sortMode = sortModeEl.value;

  const filtered = parcels.filter((parcel) => {
    const fb = getParcelFeedback(parcel);
    const status = parcelStatus(parcel);

    if (filter === "actionable" && !actionable(parcel)) {
      return false;
    }
    if (filter === "open" && (actionable(parcel) || status === "no_local_lead")) {
      return false;
    }
    if (filter === "no_local_lead" && status !== "no_local_lead") {
      return false;
    }
    if (!query) {
      return true;
    }

    const cue = parcel.selectedAddress
      ? `${parcel.selectedAddress.porta} ${parcel.selectedAddress.rua} ${parcel.selectedAddress.localidade}`
      : "";
    const haystack = [
      parcel.sourceObjectId,
      parcel.tipologia,
      parcel.qualificacaoSolo,
      parcel.freguesia,
      cue,
      fb.leadName,
      fb.contactTrail,
      fb.notes,
      STATUS_LABELS[status],
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  filtered.sort((left, right) => {
    if (sortMode === "parcel") {
      return left.sourceObjectId - right.sourceObjectId;
    }
    if (sortMode === "area") {
      return right.areaM2 - left.areaM2 || left.sourceObjectId - right.sourceObjectId;
    }
    const statusDiff = STATUS_ORDER[parcelStatus(left)] - STATUS_ORDER[parcelStatus(right)];
    return statusDiff || left.sourceObjectId - right.sourceObjectId;
  });

  return filtered;
}

function ensureActiveParcel() {
  const visible = visibleParcels();
  if (!visible.length) {
    activeParcelId = null;
    return visible;
  }
  if (!visible.some((parcel) => parcel.objectId === activeParcelId)) {
    activeParcelId = visible[0].objectId;
  }
  return visible;
}

function activeParcel() {
  return parcels.find((parcel) => parcel.objectId === activeParcelId) ?? null;
}

function statusChip(status) {
  return `<span class="status-chip status-chip--${status}">${STATUS_LABELS[status]}</span>`;
}

function parcelCardMarkup(parcel, index, total) {
  const status = parcelStatus(parcel);
  const cue = parcel.selectedAddress
    ? `${parcel.selectedAddress.porta || "?"} ${parcel.selectedAddress.rua}`
    : "No address cue found";
  const fb = getParcelFeedback(parcel);
  return `
    <article class="parcel-card ${parcel.objectId === activeParcelId ? "is-active" : ""}" data-parcel-id="${parcel.objectId}">
      <div class="parcel-card__top">
        <div>
          <strong>Parcel ${parcel.sourceObjectId}</strong>
          <div class="parcel-card__street">${escapeHtml(cue)}</div>
        </div>
        ${statusChip(status)}
      </div>
      <div class="parcel-card__meta">
        <span>${parcel.areaM2.toLocaleString()} m²</span>
        <span>${index + 1}/${total}</span>
      </div>
      ${fb.leadName ? `<div class="parcel-card__street">${escapeHtml(fb.leadName)}</div>` : ""}
    </article>
  `;
}

function renderMetrics() {
  const reviewed = parcels.filter((parcel) => parcelWasTouched(parcel)).length;
  const leads = parcels.filter((parcel) => actionable(parcel)).length;
  const strong = parcels.filter(
    (parcel) => actionable(parcel) && getParcelFeedback(parcel).confidence === "high",
  ).length;

  progressGridEl.innerHTML = [
    ["Reviewed", `${reviewed}/${parcels.length}`],
    ["Actionable", leads],
    ["High confidence", strong],
  ]
    .map(
      ([label, value]) => `
        <div class="metric-card">
          <span class="eyebrow">${label}</span>
          <strong>${value}</strong>
        </div>
      `,
    )
    .join("");

  saveStateEl.textContent = feedback.updatedAt
    ? `Saved ${new Date(feedback.updatedAt).toLocaleString()}`
    : "No saved notes yet";
}

function renderParcelList(visible) {
  visibleCountEl.textContent = `${visible.length} visible`;
  parcelListEl.innerHTML = visible.length
    ? visible.map((parcel, index) => parcelCardMarkup(parcel, index, visible.length)).join("")
    : `<article class="parcel-card"><strong>No plots match this filter.</strong><div class="parcel-card__street">Try clearing the search or broadening the filter.</div></article>`;
}

function renderParcelEditor(parcel, visible) {
  if (!parcel) {
    parcelTitleEl.textContent = "No plot selected";
    parcelPositionEl.textContent = "0 of 0";
    parcelSummaryEl.innerHTML = "<p>Nothing matches the current search.</p>";
    leadNameEl.value = "";
    contactTrailEl.value = "";
    parcelNotesEl.value = "";
    knowledgeStatusEl.querySelectorAll("[data-status]").forEach((button) => {
      button.classList.remove("is-active");
    });
    confidenceRowEl.querySelectorAll("[data-confidence]").forEach((button) => {
      button.classList.remove("is-active");
    });
    return;
  }

  const fb = getParcelFeedback(parcel);
  const status = parcelStatus(parcel);
  const position = visible.findIndex((item) => item.objectId === parcel.objectId);
  const cue = parcel.selectedAddress
    ? `${parcel.selectedAddress.porta || "?"} ${parcel.selectedAddress.rua}, ${
        parcel.selectedAddress.localidade
      }`
    : "No nearby address cue was captured for this plot";

  parcelTitleEl.textContent = `Parcel ${parcel.sourceObjectId}`;
  parcelPositionEl.textContent = `${position + 1} of ${visible.length}`;
  mapTitleEl.textContent = parcel.selectedAddress
    ? `${manifest.name} · ${cue}`
    : `${manifest.name} · Parcel ${parcel.sourceObjectId}`;

  parcelSummaryEl.innerHTML = `
    <strong>${escapeHtml(parcel.tipologia)} · ${parcel.areaM2.toLocaleString()} m²</strong>
    <p>${escapeHtml(parcel.qualificacaoSolo)} · ${escapeHtml(parcel.freguesia)}</p>
    <p><strong>Address cue:</strong> ${escapeHtml(cue)}</p>
  `;

  leadNameEl.value = fb.leadName;
  contactTrailEl.value = fb.contactTrail;
  parcelNotesEl.value = fb.notes;

  knowledgeStatusEl.querySelectorAll("[data-status]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.status === status);
  });
  confidenceRowEl.querySelectorAll("[data-confidence]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.confidence === fb.confidence);
  });
}

function markReviewed(parcel) {
  getParcelFeedback(parcel).reviewedAt = new Date().toISOString();
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportRows() {
  return parcels.map((parcel) => {
    const fb = getParcelFeedback(parcel);
    return {
      sourceObjectId: parcel.sourceObjectId,
      parcelObjectId: parcel.objectId,
      tipologia: parcel.tipologia,
      areaM2: parcel.areaM2,
      qualificacaoSolo: parcel.qualificacaoSolo,
      freguesia: parcel.freguesia,
      status: parcelStatus(parcel),
      statusLabel: STATUS_LABELS[parcelStatus(parcel)],
      leadName: fb.leadName,
      contactTrail: fb.contactTrail,
      confidence: fb.confidence,
      notes: fb.notes,
      reviewedAt: fb.reviewedAt,
      selectedAddressPorta: parcel.selectedAddress?.porta ?? "",
      selectedAddressRua: parcel.selectedAddress?.rua ?? "",
      selectedAddressLocalidade: parcel.selectedAddress?.localidade ?? "",
      selectedAddressDistanceToParcel: parcel.selectedAddress?.distanceToParcel ?? "",
      centroidLng: parcel.centroid?.[0] ?? "",
      centroidLat: parcel.centroid?.[1] ?? "",
    };
  });
}

const protocol = new pmtiles.Protocol();
protocol.add(new pmtiles.PMTiles(new pmtiles.FileSource(basemapFile)));
maplibregl.addProtocol("pmtiles", protocol.tile);

const map = new maplibregl.Map({
  container: "viewDiv",
  style: prepareStyle(basemapStyles[basemapMode]),
  center: manifest.view.center,
  zoom: manifest.view.zoom,
  maxZoom: manifest.basemap.maxzoom + 2,
  attributionControl: true,
});

map.addControl(new maplibregl.NavigationControl(), "top-left");

const basemapToggleButtons = [...document.querySelectorAll("[data-basemap-mode]")];

function updateBasemapUi() {
  for (const button of basemapToggleButtons) {
    const active = button.dataset.basemapMode === basemapMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  basemapStatusEl.textContent =
    basemapMode === "satellite"
      ? `${basemapModeLabel.satellite} + labels`
      : `${basemapModeLabel.street} basemap`;
}

function setBasemapMode(nextMode) {
  if (!basemapStyles[nextMode] || nextMode === basemapMode) {
    return;
  }
  basemapMode = nextMode;
  localStorage.setItem(BASEMAP_STORAGE_KEY, basemapMode);
  updateBasemapUi();
  map.setStyle(prepareStyle(basemapStyles[basemapMode]));
}

function addMapOverlays() {
  map.addSource("aoi", {
    type: "geojson",
    data: aoiGeojson,
  });
  map.addLayer({
    id: "aoi-outline",
    type: "line",
    source: "aoi",
    paint: {
      "line-color": "#193130",
      "line-width": 2,
      "line-dasharray": [3, 2],
      "line-opacity": 0.85,
    },
  });

  map.addSource("parcels", {
    type: "geojson",
    data: parcelsGeojson,
  });
  map.addLayer({
    id: "parcel-fill",
    type: "fill",
    source: "parcels",
    paint: {
      "fill-color": [
        "match",
        ["coalesce", ["feature-state", "status"], "unknown"],
        "owner_known",
        "#be6d3e",
        "network_known",
        "#2e6f73",
        "possible_lead",
        "#d7a64b",
        "no_local_lead",
        "#605b7b",
        "#eef0ea",
      ],
      "fill-opacity": [
        "case",
        ["boolean", ["feature-state", "active"], false],
        0.72,
        0.4,
      ],
    },
  });
  map.addLayer({
    id: "parcel-outline",
    type: "line",
    source: "parcels",
    paint: {
      "line-color": [
        "case",
        ["boolean", ["feature-state", "active"], false],
        "#193130",
        [
          "match",
          ["coalesce", ["feature-state", "status"], "unknown"],
          "owner_known",
          "#8d4925",
          "network_known",
          "#1b484b",
          "possible_lead",
          "#996c18",
          "no_local_lead",
          "#4f4b66",
          "#8d968f",
        ],
      ],
      "line-width": [
        "case",
        ["boolean", ["feature-state", "active"], false],
        2.5,
        1.05,
      ],
    },
  });

  map.addSource("active-cue", {
    type: "geojson",
    data: emptyCueFeatureCollection(),
  });
  map.addLayer({
    id: "active-cue",
    type: "circle",
    source: "active-cue",
    paint: {
      "circle-radius": 6,
      "circle-color": "#193130",
      "circle-stroke-color": "#f2ecdf",
      "circle-stroke-width": 2,
    },
  });
}

function handleParcelClick(event) {
  const feature = event.features?.[0];
  if (feature?.id != null) {
    selectParcel(Number(feature.id));
  }
}

function handleParcelEnter() {
  map.getCanvas().style.cursor = "pointer";
}

function handleParcelLeave() {
  map.getCanvas().style.cursor = "";
}

function bindMapEvents() {
  map.off("click", "parcel-fill", handleParcelClick);
  map.off("mouseenter", "parcel-fill", handleParcelEnter);
  map.off("mouseleave", "parcel-fill", handleParcelLeave);
  map.on("click", "parcel-fill", handleParcelClick);
  map.on("mouseenter", "parcel-fill", handleParcelEnter);
  map.on("mouseleave", "parcel-fill", handleParcelLeave);
}

map.on("style.load", () => {
  mapLoaded = true;
  addMapOverlays();
  bindMapEvents();
  syncParcelFeatureStates();
  if (!initialViewportApplied) {
    map.fitBounds(
      [
        [manifest.view.bbox[0], manifest.view.bbox[1]],
        [manifest.view.bbox[2], manifest.view.bbox[3]],
      ],
      { padding: 48, duration: 0 },
    );
    initialViewportApplied = true;
  }
  updateBasemapUi();
  renderAll();
});

for (const button of basemapToggleButtons) {
  button.addEventListener("click", () => {
    setBasemapMode(button.dataset.basemapMode);
  });
}

function emptyCueFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function activeCueFeature(parcel) {
  if (!parcel?.selectedAddress?.coordinates) {
    return emptyCueFeatureCollection();
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          title: `${parcel.selectedAddress.porta || "?"} ${parcel.selectedAddress.rua}`,
          localidade: parcel.selectedAddress.localidade ?? "",
        },
        geometry: {
          type: "Point",
          coordinates: parcel.selectedAddress.coordinates,
        },
      },
    ],
  };
}

function syncParcelFeatureStates() {
  if (!mapLoaded) {
    return;
  }
  for (const parcel of parcels) {
    map.setFeatureState(
      { source: "parcels", id: parcel.objectId },
      {
        status: parcelStatus(parcel),
        active: parcel.objectId === activeParcelId,
      },
    );
  }
}

function refreshMapSelection() {
  if (!mapLoaded) {
    return;
  }
  syncParcelFeatureStates();
  const parcel = activeParcel();
  map.getSource("active-cue").setData(activeCueFeature(parcel));
}

function parcelBounds(parcel) {
  const coordinates = parcel.geometry.coordinates[0];
  const lons = coordinates.map((point) => point[0]);
  const lats = coordinates.map((point) => point[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

function mapPadding() {
  if (globalThis.innerWidth < 1120) {
    return { top: 72, right: 28, bottom: 28, left: 28 };
  }
  return { top: 90, right: 120, bottom: 90, left: 420 };
}

function renderAll() {
  const visible = ensureActiveParcel();
  renderMetrics();
  renderParcelList(visible);
  renderParcelEditor(activeParcel(), visible);
  refreshMapSelection();
}

function selectParcel(parcelId, { zoom = true } = {}) {
  activeParcelId = parcelId;
  renderAll();
  if (!zoom || !mapLoaded) {
    return;
  }
  const parcel = activeParcel();
  if (parcel) {
    map.fitBounds(parcelBounds(parcel), {
      padding: mapPadding(),
      duration: 500,
      maxZoom: 17,
    });
  }
}

parcelListEl.addEventListener("click", (event) => {
  const card = event.target.closest("[data-parcel-id]");
  if (!card) {
    return;
  }
  selectParcel(Number(card.dataset.parcelId));
});

knowledgeStatusEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-status]");
  const parcel = activeParcel();
  if (!button || !parcel) {
    return;
  }
  const fb = getParcelFeedback(parcel);
  fb.knowledgeStatus = button.dataset.status;
  markReviewed(parcel);
  saveFeedback();
  renderAll();
});

confidenceRowEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-confidence]");
  const parcel = activeParcel();
  if (!button || !parcel) {
    return;
  }
  const fb = getParcelFeedback(parcel);
  fb.confidence = button.dataset.confidence;
  markReviewed(parcel);
  saveFeedback();
  renderAll();
});

for (const element of [leadNameEl, contactTrailEl, parcelNotesEl]) {
  element.addEventListener("input", () => {
    const parcel = activeParcel();
    if (!parcel) {
      return;
    }
    const fb = getParcelFeedback(parcel);
    fb.leadName = leadNameEl.value;
    fb.contactTrail = contactTrailEl.value;
    fb.notes = parcelNotesEl.value;
    if (fb.leadName.trim() || fb.contactTrail.trim() || fb.notes.trim()) {
      markReviewed(parcel);
    }
    saveFeedback();
    renderMetrics();
    renderParcelList(ensureActiveParcel());
  });
}

for (const element of [parcelSearchEl, statusFilterEl, sortModeEl]) {
  element.addEventListener("input", renderAll);
  element.addEventListener("change", renderAll);
}

previousParcelEl.addEventListener("click", () => {
  const visible = ensureActiveParcel();
  const index = visible.findIndex((parcel) => parcel.objectId === activeParcelId);
  if (index > 0) {
    selectParcel(visible[index - 1].objectId);
  }
});

nextParcelEl.addEventListener("click", () => {
  const visible = ensureActiveParcel();
  const parcel = activeParcel();
  if (parcel) {
    markReviewed(parcel);
    saveFeedback();
  }
  const index = visible.findIndex((item) => item.objectId === activeParcelId);
  const next = visible[Math.min(index + 1, visible.length - 1)];
  if (next) {
    selectParcel(next.objectId);
  } else {
    renderAll();
  }
});

exportJsonEl.addEventListener("click", () => {
  downloadFile(
    `sintra-aoi-review-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        source: manifest,
        feedback,
        rows: exportRows(),
      },
      null,
      2,
    ),
    "application/json",
  );
});

exportCsvEl.addEventListener("click", () => {
  const rows = exportRows();
  const headers = Object.keys(rows[0] ?? {});
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ].join("\n");
  downloadFile(
    `sintra-aoi-review-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
    "text/csv",
  );
});

clearFeedbackEl.addEventListener("click", () => {
  if (!confirm("Clear all saved local-knowledge notes in this browser?")) {
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  feedback = loadFeedback();
  renderAll();
});
