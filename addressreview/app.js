const data = await fetch("./data/sample.json").then((response) => response.json());

const MAPSERVICE_CONFIG_URL = `https://sig.cm-sintra.pt/MuniSIG/REST/sites/${
  data.meta.siteId
}/map/mapservices/${data.meta.basemapMapserviceId ?? "24"}`;

function parseConnectionString(connectionString = "") {
  return connectionString.split(";").reduce((values, chunk) => {
    const separatorIndex = chunk.indexOf("=");
    if (separatorIndex > 0) {
      values[chunk.slice(0, separatorIndex)] = chunk.slice(separatorIndex + 1);
    }
    return values;
  }, {});
}

function loadJsonp(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const callbackName = `__sintraMapservice_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    const script = document.createElement("script");
    const separator = url.includes("?") ? "&" : "?";
    const cleanup = () => {
      script.remove();
      delete globalThis[callbackName];
      clearTimeout(timeout);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Map service config request timed out"));
    }, timeoutMs);

    globalThis[callbackName] = (payload) => {
      cleanup();
      resolve(payload);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("Map service config request failed"));
    };
    script.src = `${url}${separator}f=json&callback=${callbackName}`;
    document.head.append(script);
  });
}

async function resolveBasemapConnection() {
  try {
    const serviceConfig = await loadJsonp(MAPSERVICE_CONFIG_URL);
    const connection = parseConnectionString(serviceConfig.connectionString);
    return {
      url: connection.url || data.meta.basemapServiceUrl,
      token: connection.token || data.meta.basemapToken,
      usedFreshToken: Boolean(connection.token),
    };
  } catch (error) {
    console.warn("Using stored basemap token because the live token could not be refreshed.", error);
    return {
      url: data.meta.basemapServiceUrl,
      token: data.meta.basemapToken,
      usedFreshToken: false,
    };
  }
}

const basemapConnection = await resolveBasemapConnection();

const [
  { default: esriConfig },
  { default: ArcGISMap },
  { default: MapView },
  { default: MapImageLayer },
  { default: GraphicsLayer },
  GraphicModule,
  ExtentModule,
  reactiveUtilsModule,
] = await Promise.all([
  import("https://js.arcgis.com/4.32/@arcgis/core/config.js"),
  import("https://js.arcgis.com/4.32/@arcgis/core/Map.js"),
  import("https://js.arcgis.com/4.32/@arcgis/core/views/MapView.js"),
  import("https://js.arcgis.com/4.32/@arcgis/core/layers/MapImageLayer.js"),
  import("https://js.arcgis.com/4.32/@arcgis/core/layers/GraphicsLayer.js"),
  import("https://js.arcgis.com/4.32/@arcgis/core/Graphic.js"),
  import("https://js.arcgis.com/4.32/@arcgis/core/geometry/Extent.js"),
  import("https://js.arcgis.com/4.32/@arcgis/core/core/reactiveUtils.js"),
]);

const Graphic = GraphicModule.default;
const Extent = ExtentModule.default;
const reactiveUtils = reactiveUtilsModule.default ?? reactiveUtilsModule;

const STORAGE_KEY = "sintra-address-review-feedback-v2";
const TIER_ORDER = { gold: 0, silver: 1, blue: 2 };
const TIER_LABELS = { gold: "Gold", silver: "Silver", blue: "Blue" };
const MODEL_TIER_MAP = { gold: "gold", silver: "silver", nearby: "blue", blue: "blue" };
const REASON_LABELS = {
  same_frontage: "Same frontage",
  adjacent_no_road: "Adjacent, no road",
  road_separated: "Road separated",
  wrong_side: "Wrong side",
  too_far: "Too far",
  duplicate_or_noise: "Noise",
};

const TIER_STYLES = {
  gold: {
    fill: [217, 164, 49, 0.96],
    outline: [122, 77, 5, 1],
    text: [255, 252, 246, 1],
  },
  silver: {
    fill: [200, 206, 214, 0.96],
    outline: [89, 98, 112, 1],
    text: [26, 33, 42, 1],
  },
  blue: {
    fill: [45, 119, 184, 0.92],
    outline: [18, 78, 132, 1],
    text: [255, 252, 246, 1],
  },
};

const progressGridEl = document.querySelector("#progress-grid");
const parcelTitleEl = document.querySelector("#parcel-title");
const parcelPositionEl = document.querySelector("#parcel-position");
const parcelSummaryEl = document.querySelector("#parcel-summary");
const bestCandidateEl = document.querySelector("#best-candidate");
const parcelDecisionEl = document.querySelector("#parcel-decision");
const parcelNotesEl = document.querySelector("#parcel-notes");
const previousParcelEl = document.querySelector("#previous-parcel");
const nextParcelEl = document.querySelector("#next-parcel");
const candidateCountEl = document.querySelector("#candidate-count");
const candidateListEl = document.querySelector("#candidate-list");
const saveStateEl = document.querySelector("#save-state");
const exportJsonEl = document.querySelector("#export-json");
const exportCsvEl = document.querySelector("#export-csv");
const clearFeedbackEl = document.querySelector("#clear-feedback");
const mapTitleEl = document.querySelector("#map-title");
const basemapStatusEl = document.querySelector("#basemap-status");
const overlayEl = document.querySelector("#map-overlay");

let activeParcelIndex = 0;
let activeCandidateId = null;

function normalizeTier(tier) {
  return MODEL_TIER_MAP[tier] ?? "blue";
}

function loadFeedback() {
  const fallback = { version: 2, parcels: {}, candidates: {}, createdAt: new Date().toISOString() };
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
  renderProgress();
}

function parcelKey(parcel) {
  return String(parcel.sourceObjectId);
}

function candidateKey(parcel, candidate) {
  return `${parcel.sourceObjectId}:${candidate.objectId}`;
}

function getParcelFeedback(parcel) {
  const key = parcelKey(parcel);
  feedback.parcels[key] ??= {
    sourceObjectId: parcel.sourceObjectId,
    parcelObjectId: parcel.objectId,
    selectedCandidateObjectId: null,
    parcelDecision: "",
    notes: "",
    reviewedAt: null,
  };
  return feedback.parcels[key];
}

function getCandidateFeedback(parcel, candidate) {
  const key = candidateKey(parcel, candidate);
  feedback.candidates[key] ??= {
    sourceObjectId: parcel.sourceObjectId,
    parcelObjectId: parcel.objectId,
    candidateObjectId: candidate.objectId,
    porta: candidate.porta,
    rua: candidate.rua,
    localidade: candidate.localidade,
    modelTier: normalizeTier(candidate.tier),
    correctedTier: normalizeTier(candidate.tier),
    isBestCandidate: false,
    reasons: [],
    reviewed: false,
  };
  return feedback.candidates[key];
}

function activeParcel() {
  return data.parcels[activeParcelIndex];
}

function activeCandidate(parcel = activeParcel()) {
  return parcel.addressCandidates.find((candidate) => candidate.objectId === activeCandidateId);
}

function tierForCandidate(parcel, candidate) {
  return getCandidateFeedback(parcel, candidate).correctedTier;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tierBadge(tier, label = TIER_LABELS[tier]) {
  return `<span class="tier-badge tier-badge--${tier}">${label}</span>`;
}

let basemapUrl = basemapConnection.url;
let basemapToken = basemapConnection.token;
let basemapLayerRetryCount = 0;
let basemapRecoveryPromise = null;

if (!basemapConnection.usedFreshToken) {
  basemapStatusEl.hidden = false;
  basemapStatusEl.textContent = "Using stored basemap token";
}

esriConfig.request.interceptors.push({
  urls: basemapUrl,
  before({ requestOptions }) {
    requestOptions.query = {
      ...(requestOptions.query ?? {}),
      token: basemapToken,
    };
  },
});

const sampleExtent = new Extent({
  xmin: data.meta.sampleBbox.xmin - 120,
  ymin: data.meta.sampleBbox.ymin - 120,
  xmax: data.meta.sampleBbox.xmax + 120,
  ymax: data.meta.sampleBbox.ymax + 120,
  spatialReference: data.meta.spatialReference,
});

function createBasemapLayer() {
  return new MapImageLayer({ url: basemapUrl, opacity: 0.96 });
}

let basemapLayer = createBasemapLayer();
const parcelLayer = new GraphicsLayer();
const hitLayer = new GraphicsLayer();
const map = new ArcGISMap({ layers: [basemapLayer, parcelLayer, hitLayer] });

async function recoverBasemapLayer() {
  if (basemapRecoveryPromise) {
    return basemapRecoveryPromise;
  }

  basemapRecoveryPromise = (async () => {
    if (basemapLayerRetryCount >= 1) {
      basemapStatusEl.hidden = false;
      basemapStatusEl.textContent = "Basemap token expired. Run python3 extract_sample.py.";
      return;
    }

    basemapLayerRetryCount += 1;
    basemapStatusEl.hidden = false;
    basemapStatusEl.textContent = "Refreshing basemap token...";

    try {
      const refreshedConnection = await resolveBasemapConnection();
      basemapUrl = refreshedConnection.url || basemapUrl;
      basemapToken = refreshedConnection.token || basemapToken;

      const replacementLayer = createBasemapLayer();
      map.remove(basemapLayer);
      basemapLayer.destroy();
      basemapLayer = replacementLayer;
      map.add(basemapLayer, 0);
      wireBasemapLayer(basemapLayer);
      await basemapLayer.load();
      basemapStatusEl.hidden = true;
    } catch (error) {
      console.error("Basemap refresh failed.", error);
      basemapStatusEl.hidden = false;
      basemapStatusEl.textContent = "Basemap token expired. Run python3 extract_sample.py.";
    } finally {
      basemapRecoveryPromise = null;
    }
  })();

  return basemapRecoveryPromise;
}

function wireBasemapLayer(layer) {
  layer.when(
    () => {
      basemapStatusEl.hidden = true;
    },
    (error) => {
      console.warn("Basemap layer failed to load.", error);
      recoverBasemapLayer();
    },
  );
}

wireBasemapLayer(basemapLayer);

const view = new MapView({
  container: "viewDiv",
  map,
  extent: sampleExtent,
  spatialReference: data.meta.spatialReference,
  constraints: {
    geometry: sampleExtent.expand(1.3),
    minScale: 7500,
    maxScale: 250,
  },
  popup: { dockEnabled: false },
  background: { color: [244, 238, 228, 1] },
});

view.ui.components = ["zoom", "attribution"];

const parcelGraphics = new globalThis.Map();
const candidateGraphics = new globalThis.Map();

function polygonSymbol(active) {
  return {
    type: "simple-fill",
    color: active ? [217, 164, 49, 0.18] : [23, 32, 42, 0.04],
    outline: {
      color: active ? [122, 77, 5, 1] : [23, 32, 42, 0.32],
      width: active ? 3 : 1,
    },
  };
}

for (const parcel of data.parcels) {
  const graphic = new Graphic({
    geometry: {
      type: "polygon",
      rings: parcel.geometry.rings,
      spatialReference: data.meta.spatialReference,
    },
    symbol: polygonSymbol(false),
    attributes: parcel,
  });
  parcelGraphics.set(parcel.objectId, graphic);
  parcelLayer.add(graphic);
}

function parcelExtent(parcel) {
  const points = parcel.geometry.rings.flat();
  return Extent.fromJSON({
    xmin: Math.min(...points.map((point) => point[0])),
    ymin: Math.min(...points.map((point) => point[1])),
    xmax: Math.max(...points.map((point) => point[0])),
    ymax: Math.max(...points.map((point) => point[1])),
    spatialReference: data.meta.spatialReference,
  });
}

function screenPointFromMap(x, y) {
  return view.toScreen({
    type: "point",
    x,
    y,
    spatialReference: data.meta.spatialReference,
  });
}

function diamondPath(x, y, size) {
  return `${x} ${y - size} ${x + size} ${y} ${x} ${y + size} ${x - size} ${y}`;
}

function overlayCandidateMarkup(parcel, candidate) {
  const tier = tierForCandidate(parcel, candidate);
  const point = screenPointFromMap(candidate.x, candidate.y);
  const boundaryPoint = screenPointFromMap(
    candidate.nearestBoundaryPoint.x,
    candidate.nearestBoundaryPoint.y,
  );
  const style = TIER_STYLES[tier];
  const active = candidate.objectId === activeCandidateId;
  const isBest = getParcelFeedback(parcel).selectedCandidateObjectId === candidate.objectId;
  const dx = boundaryPoint.x - point.x;
  const dy = boundaryPoint.y - point.y;
  const length = Math.hypot(dx, dy) || 1;
  const directionX = dx / length;
  const directionY = dy / length;
  const badgeDistance = active || isBest ? 20 : 15;
  const badgeX = point.x + directionX * badgeDistance;
  const badgeY = point.y + directionY * badgeDistance;
  const badgeRadius = active || isBest ? 10.5 : 8.5;
  const letter = tier === "gold" ? "G" : tier === "silver" ? "S" : "B";
  const lineEndX = point.x + directionX * Math.max(4, badgeDistance - badgeRadius);
  const lineEndY = point.y + directionY * Math.max(4, badgeDistance - badgeRadius);

  return `
    <g>
      <line
        x1="${boundaryPoint.x.toFixed(1)}"
        y1="${boundaryPoint.y.toFixed(1)}"
        x2="${lineEndX.toFixed(1)}"
        y2="${lineEndY.toFixed(1)}"
        stroke="rgba(${style.outline[0]}, ${style.outline[1]}, ${style.outline[2]}, ${tier === "blue" ? "0.35" : "0.55"})"
        stroke-width="${active || isBest ? 2 : 1.25}"
        stroke-dasharray="${tier === "blue" ? "4 4" : "none"}"
      />
      ${
        tier === "gold"
          ? `<polygon
              points="${diamondPath(badgeX, badgeY, badgeRadius)}"
              fill="rgba(${style.fill[0]}, ${style.fill[1]}, ${style.fill[2]}, ${style.fill[3]})"
              stroke="rgba(${style.outline[0]}, ${style.outline[1]}, ${style.outline[2]}, ${style.outline[3]})"
              stroke-width="${active || isBest ? 2.4 : 1.7}"
            />`
          : `<circle
              cx="${badgeX.toFixed(1)}"
              cy="${badgeY.toFixed(1)}"
              r="${badgeRadius.toFixed(1)}"
              fill="rgba(${style.fill[0]}, ${style.fill[1]}, ${style.fill[2]}, ${style.fill[3]})"
              stroke="rgba(${style.outline[0]}, ${style.outline[1]}, ${style.outline[2]}, ${style.outline[3]})"
              stroke-width="${active || isBest ? 2.2 : 1.5}"
            />`
      }
      <text
        x="${badgeX.toFixed(1)}"
        y="${(badgeY + 4).toFixed(1)}"
        text-anchor="middle"
        font-family="Arial, sans-serif"
        font-size="${active || isBest ? 12 : 10.5}"
        font-weight="800"
        fill="rgba(${style.text[0]}, ${style.text[1]}, ${style.text[2]}, ${style.text[3]})"
      >${letter}</text>
    </g>
  `;
}

function renderMapOverlay(parcel) {
  if (!parcel || !view.ready) {
    overlayEl.innerHTML = "";
    return;
  }

  const overlayWidth = overlayEl.clientWidth || view.width || 1;
  const overlayHeight = overlayEl.clientHeight || view.height || 1;
  const polygonPoints = parcel.geometry.rings[0]
    .map(([x, y]) => screenPointFromMap(x, y))
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");

  overlayEl.innerHTML = `
    <svg class="map-overlay__svg" viewBox="0 0 ${overlayWidth} ${overlayHeight}" preserveAspectRatio="none">
      <polygon
        points="${polygonPoints}"
        fill="rgba(217, 164, 49, 0.21)"
        stroke="rgba(122, 77, 5, 0.98)"
        stroke-width="3"
        stroke-linejoin="round"
      />
      ${parcel.addressCandidates.map((candidate) => overlayCandidateMarkup(parcel, candidate)).join("")}
    </svg>
  `;
}

function refreshParcelGraphics() {
  for (const [parcelId, graphic] of parcelGraphics) {
    graphic.symbol = polygonSymbol(parcelId === activeParcel().objectId);
  }
}

function refreshHitGraphics(parcel) {
  hitLayer.removeAll();
  candidateGraphics.clear();

  for (const candidate of parcel.addressCandidates) {
    const graphic = new Graphic({
      geometry: {
        type: "point",
        x: candidate.x,
        y: candidate.y,
        spatialReference: data.meta.spatialReference,
      },
      symbol: {
        type: "simple-marker",
        size: 24,
        color: [255, 255, 255, 0.001],
        outline: { color: [255, 255, 255, 0.001], width: 0.5 },
      },
      attributes: candidate,
    });
    candidateGraphics.set(candidate.objectId, graphic);
    hitLayer.add(graphic);
  }
}

function zoomToParcel(parcel) {
  const parcelBox = parcelExtent(parcel);
  const selected = activeCandidate(parcel);
  const best = parcel.addressCandidates.find(
    (candidate) => candidate.objectId === getParcelFeedback(parcel).selectedCandidateObjectId,
  );
  const focusCandidates = [selected, best].filter(Boolean);
  const xs = [parcelBox.xmin, parcelBox.xmax, ...focusCandidates.map((candidate) => candidate.x)];
  const ys = [parcelBox.ymin, parcelBox.ymax, ...focusCandidates.map((candidate) => candidate.y)];
  const focusExtent = Extent.fromJSON({
    xmin: Math.min(...xs),
    ymin: Math.min(...ys),
    xmax: Math.max(...xs),
    ymax: Math.max(...ys),
    spatialReference: data.meta.spatialReference,
  });
  view.when(() => view.goTo(focusExtent.expand(1.55), { duration: 520 }).catch(() => {}));
}

function renderProgress() {
  const parcelFeedback = Object.values(feedback.parcels);
  const candidateFeedback = Object.values(feedback.candidates);
  const reviewedParcels = parcelFeedback.filter(
    (item) => item.reviewedAt || item.parcelDecision || item.notes,
  ).length;
  const correctedCandidates = candidateFeedback.filter(
    (item) => item.reviewed && item.correctedTier && item.correctedTier !== item.modelTier,
  ).length;
  const labelledCandidates = candidateFeedback.filter((item) => item.reviewed).length;

  progressGridEl.innerHTML = [
    ["Parcels", `${reviewedParcels}/${data.parcels.length}`],
    ["Candidate labels", labelledCandidates],
    ["Corrections", correctedCandidates],
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
    : "No saved labels yet";
}

function renderParcelControls(parcel) {
  const parcelFb = getParcelFeedback(parcel);
  const selectedAddress = parcel.addressCandidates.find(
    (candidate) =>
      candidate.objectId === (parcelFb.selectedCandidateObjectId ?? parcel.selectedAddress?.objectId),
  );
  const modelPick = parcel.selectedAddress;

  parcelTitleEl.textContent = `Parcel ${parcel.sourceObjectId}`;
  parcelPositionEl.textContent = `${activeParcelIndex + 1} of ${data.parcels.length}`;
  mapTitleEl.textContent = selectedAddress
    ? `Parcel ${parcel.sourceObjectId} · ${selectedAddress.porta} ${selectedAddress.rua}`
    : `Parcel ${parcel.sourceObjectId}`;

  parcelSummaryEl.innerHTML = `
    <strong>Model pick: ${escapeHtml(modelPick?.porta ?? "?")} ${escapeHtml(modelPick?.rua ?? "")}</strong>
    <p>${escapeHtml(parcel.qualificacaoSolo)} · ${parcel.areaM2.toLocaleString()} m²</p>
    <p>${escapeHtml(parcel.freguesia)}</p>
  `;

  const selectedCandidateObjectId = parcelFb.selectedCandidateObjectId ?? parcel.selectedAddress?.objectId;
  bestCandidateEl.innerHTML = parcel.addressCandidates
    .map(
      (candidate) => `
        <option value="${candidate.objectId}" ${candidate.objectId === selectedCandidateObjectId ? "selected" : ""}>
          ${candidate.porta || "?"} · ${candidate.rua} · model ${TIER_LABELS[normalizeTier(candidate.tier)]}
        </option>
      `,
    )
    .join("");

  parcelNotesEl.value = parcelFb.notes || "";

  parcelDecisionEl.querySelectorAll("[data-parcel-decision]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.parcelDecision === parcelFb.parcelDecision);
  });
}

function candidateCardMarkup(parcel, candidate, index) {
  const modelTier = normalizeTier(candidate.tier);
  const candidateFb = getCandidateFeedback(parcel, candidate);
  const correctedTier = candidateFb.correctedTier;
  const selected = candidate.objectId === activeCandidateId;
  const best = getParcelFeedback(parcel).selectedCandidateObjectId === candidate.objectId;
  const reasonButtons = Object.entries(REASON_LABELS)
    .map(
      ([reason, label]) => `
        <button
          type="button"
          class="reason-chip ${candidateFb.reasons.includes(reason) ? "is-active" : ""}"
          data-candidate-id="${candidate.objectId}"
          data-reason="${reason}"
        >${label}</button>
      `,
    )
    .join("");

  return `
    <article class="candidate-card ${selected ? "is-active" : ""}" data-candidate-card="${candidate.objectId}">
      <div class="candidate-card__top">
        <div>
          <strong>${escapeHtml(candidate.porta || "?")} ${escapeHtml(candidate.rua)}</strong>
          <div class="candidate-card__meta">
            ${escapeHtml(candidate.localidade)} · ${candidate.distanceToParcel.toFixed(1)} m to parcel · ${
              candidate.roadCrossing
                ? `road-separated${candidate.crossedStreetNames?.length ? ` via ${escapeHtml(candidate.crossedStreetNames.join(", "))}` : ""}`
                : "no road crossing"
            }
          </div>
        </div>
        <span>${tierBadge(modelTier, `Model ${TIER_LABELS[modelTier]}`)}</span>
      </div>
      <div class="candidate-card__actions" aria-label="Correct tier for candidate ${index + 1}">
        ${["gold", "silver", "blue"]
          .map(
            (tier) => `
              <button
                type="button"
                class="${correctedTier === tier ? "is-active" : ""}"
                data-candidate-id="${candidate.objectId}"
                data-tier="${tier}"
              >${TIER_LABELS[tier]}</button>
            `,
          )
          .join("")}
        <button
          type="button"
          class="${best ? "is-active" : ""}"
          data-candidate-id="${candidate.objectId}"
          data-best-candidate
        >Best address</button>
      </div>
      <div class="candidate-card__reasons">${reasonButtons}</div>
    </article>
  `;
}

function renderCandidates(parcel) {
  candidateCountEl.textContent = `${parcel.addressCandidates.length} shown`;
  candidateListEl.innerHTML = parcel.addressCandidates
    .slice()
    .sort((a, b) => {
      const tierDiff = TIER_ORDER[tierForCandidate(parcel, a)] - TIER_ORDER[tierForCandidate(parcel, b)];
      return tierDiff || a.distanceToParcel - b.distanceToParcel;
    })
    .map((candidate, index) => candidateCardMarkup(parcel, candidate, index))
    .join("");
}

function renderAll() {
  const parcel = activeParcel();
  const parcelFb = getParcelFeedback(parcel);
  activeCandidateId = activeCandidateId ?? parcelFb.selectedCandidateObjectId ?? parcel.selectedAddress?.objectId;

  renderProgress();
  renderParcelControls(parcel);
  renderCandidates(parcel);
  refreshParcelGraphics();
  refreshHitGraphics(parcel);
  renderMapOverlay(parcel);
  zoomToParcel(parcel);
}

function setBestCandidate(parcel, candidateId) {
  const parcelFb = getParcelFeedback(parcel);
  parcelFb.selectedCandidateObjectId = candidateId;
  parcelFb.reviewedAt = new Date().toISOString();
  for (const candidate of parcel.addressCandidates) {
    const candidateFb = getCandidateFeedback(parcel, candidate);
    candidateFb.isBestCandidate = candidate.objectId === candidateId;
    if (candidate.objectId === candidateId) {
      candidateFb.reviewed = true;
    }
  }
  activeCandidateId = candidateId;
  saveFeedback();
  renderAll();
}

bestCandidateEl.addEventListener("change", () => {
  setBestCandidate(activeParcel(), Number(bestCandidateEl.value));
});

parcelDecisionEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-parcel-decision]");
  if (!button) {
    return;
  }
  const parcelFb = getParcelFeedback(activeParcel());
  parcelFb.parcelDecision = button.dataset.parcelDecision;
  parcelFb.reviewedAt = new Date().toISOString();
  if (button.dataset.parcelDecision === "gold_correct") {
    parcelFb.selectedCandidateObjectId = activeParcel().selectedAddress?.objectId ?? null;
    for (const candidate of activeParcel().addressCandidates) {
      getCandidateFeedback(activeParcel(), candidate).isBestCandidate =
        candidate.objectId === parcelFb.selectedCandidateObjectId;
    }
  }
  saveFeedback();
  renderAll();
});

parcelNotesEl.addEventListener("input", () => {
  const parcelFb = getParcelFeedback(activeParcel());
  parcelFb.notes = parcelNotesEl.value;
  if (parcelNotesEl.value.trim()) {
    parcelFb.reviewedAt = new Date().toISOString();
  }
  saveFeedback();
});

candidateListEl.addEventListener("click", (event) => {
  const bestButton = event.target.closest("[data-best-candidate]");
  const tierButton = event.target.closest("[data-tier]");
  const reasonButton = event.target.closest("[data-reason]");
  const card = event.target.closest("[data-candidate-card]");
  const parcel = activeParcel();

  if (bestButton) {
    setBestCandidate(parcel, Number(bestButton.dataset.candidateId));
    return;
  }

  if (tierButton) {
    const candidate = parcel.addressCandidates.find(
      (item) => item.objectId === Number(tierButton.dataset.candidateId),
    );
    const candidateFb = getCandidateFeedback(parcel, candidate);
    candidateFb.correctedTier = tierButton.dataset.tier;
    candidateFb.reviewed = true;
    activeCandidateId = candidate.objectId;
    saveFeedback();
    renderAll();
    return;
  }

  if (reasonButton) {
    const candidate = parcel.addressCandidates.find(
      (item) => item.objectId === Number(reasonButton.dataset.candidateId),
    );
    const candidateFb = getCandidateFeedback(parcel, candidate);
    const reason = reasonButton.dataset.reason;
    candidateFb.reasons = candidateFb.reasons.includes(reason)
      ? candidateFb.reasons.filter((item) => item !== reason)
      : [...candidateFb.reasons, reason];
    candidateFb.reviewed = true;
    activeCandidateId = candidate.objectId;
    saveFeedback();
    renderAll();
    return;
  }

  if (card) {
    activeCandidateId = Number(card.dataset.candidateCard);
    renderAll();
  }
});

previousParcelEl.addEventListener("click", () => {
  activeParcelIndex = Math.max(0, activeParcelIndex - 1);
  activeCandidateId = null;
  renderAll();
});

nextParcelEl.addEventListener("click", () => {
  const parcel = activeParcel();
  const selectedCandidateId = Number(bestCandidateEl.value);
  if (selectedCandidateId) {
    const parcelFb = getParcelFeedback(parcel);
    parcelFb.selectedCandidateObjectId = selectedCandidateId;
    parcelFb.reviewedAt = new Date().toISOString();
    for (const candidate of parcel.addressCandidates) {
      const candidateFb = getCandidateFeedback(parcel, candidate);
      candidateFb.isBestCandidate = candidate.objectId === selectedCandidateId;
      if (candidate.objectId === selectedCandidateId) {
        candidateFb.reviewed = true;
      }
    }
    saveFeedback();
  }
  activeParcelIndex = Math.min(data.parcels.length - 1, activeParcelIndex + 1);
  activeCandidateId = null;
  renderAll();
});

parcelLayer.on("click", (event) => {
  const parcelObjectId = event.graphic?.attributes?.objectId;
  const index = data.parcels.findIndex((parcel) => parcel.objectId === parcelObjectId);
  if (index >= 0) {
    activeParcelIndex = index;
    activeCandidateId = null;
    renderAll();
  }
});

hitLayer.on("click", (event) => {
  const candidate = event.graphic?.attributes;
  if (candidate?.objectId) {
    activeCandidateId = candidate.objectId;
    renderAll();
  }
});

reactiveUtils.watch(
  () => view.stationary,
  (stationary) => {
    if (stationary) {
      renderMapOverlay(activeParcel());
    }
  },
);

function trainingRows() {
  return data.parcels.flatMap((parcel) =>
    parcel.addressCandidates.map((candidate) => {
      const parcelFb = getParcelFeedback(parcel);
      const candidateFb = getCandidateFeedback(parcel, candidate);
      return {
        sourceObjectId: parcel.sourceObjectId,
        parcelObjectId: parcel.objectId,
        candidateObjectId: candidate.objectId,
        porta: candidate.porta,
        rua: candidate.rua,
        localidade: candidate.localidade,
        modelTier: normalizeTier(candidate.tier),
        correctedTier: candidateFb.correctedTier,
        modelBestCandidate: parcel.selectedAddress?.objectId === candidate.objectId,
        isBestCandidate: parcelFb.selectedCandidateObjectId === candidate.objectId,
        parcelReviewed: Boolean(parcelFb.reviewedAt || parcelFb.parcelDecision || parcelFb.notes),
        candidateReviewed: Boolean(candidateFb.reviewed),
        parcelDecision: parcelFb.parcelDecision,
        reasons: candidateFb.reasons.join("|"),
        notes: parcelFb.notes,
        distanceToParcel: candidate.distanceToParcel,
        distanceToCentroid: candidate.distanceToCentroid,
        roadCrossing: candidate.roadCrossing,
        crossedStreetCount: candidate.crossedStreetCount,
        crossedStreetCodes: (candidate.crossedStreetCodes ?? []).join("|"),
        crossedStreetNames: (candidate.crossedStreetNames ?? []).join("|"),
        nearestStreetCode: candidate.nearestStreetCode,
        nearestStreetName: candidate.nearestStreetName,
        nearestStreetDistanceToPath: candidate.nearestStreetDistanceToPath,
        nearestStreetDistanceToCandidate: candidate.nearestStreetDistanceToCandidate,
        nearestStreetDistanceToParcel: candidate.nearestStreetDistanceToParcel,
        codRua: candidate.codRua,
        x: candidate.x,
        y: candidate.y,
      };
    }),
  );
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

exportJsonEl.addEventListener("click", () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    source: data.meta,
    feedback,
    rows: trainingRows(),
  };
  downloadFile(
    `sintra-address-training-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
});

exportCsvEl.addEventListener("click", () => {
  const rows = trainingRows();
  const headers = Object.keys(rows[0] ?? {});
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ].join("\n");
  downloadFile(
    `sintra-address-training-${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
    "text/csv",
  );
});

clearFeedbackEl.addEventListener("click", () => {
  if (!confirm("Clear all saved training feedback in this browser?")) {
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  feedback = loadFeedback();
  activeCandidateId = null;
  renderAll();
});

view.when(() => {
  renderAll();
});
