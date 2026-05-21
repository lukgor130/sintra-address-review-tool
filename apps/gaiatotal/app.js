(() => {
  const GAIA_BOUNDS = [
    [-8.731, 40.936],
    [-8.439, 41.205],
  ];
  const GAIA_INITIAL_CENTER = [-8.61, 41.075];
  const STREET_STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
  const SATELLITE_TILE_URL =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const DATA_MANIFEST_URL = "./data/manifest.json";
  const GAIA_WFS = "https://opendata.gaiurb.pt/geoserver/wfs";
  const GAIA_WMS = "https://opendata.gaiurb.pt/geoserver/wms";
  const STORAGE_KEY = "gaia-pdm-explorer-state-v1";

  if (globalThis.pmtiles) {
    const pmtilesProtocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);
  }

  const pdmCategories = [
    {
      key: "mixed-i",
      label: "Expansão Urbana Mista · Tipo I",
      source: "Areas de Expansão Tipologia Mista - Tipo I 0.4",
      color: "#d69a48",
      summary:
        "Lowest-intensity mixed-use expansion land, likely suitable for modest residential-led development where delivery may depend on wider planning or infrastructure coordination.",
    },
    {
      key: "mixed-ii",
      label: "Expansão Urbana Mista · Tipo II",
      source: "Áreas de Expansão Tipologia Mista Tipo II 0.8",
      color: "#c87944",
      summary:
        "Medium-low mixed-use expansion land with more development capacity than Tipo I, but still likely requiring careful checks on execution units, access, and servicing.",
    },
    {
      key: "mixed-iii",
      label: "Expansão Urbana Mista · Tipo III",
      source: "Áreas de Expansão Tipologia Mista Tipo III 1.2",
      color: "#ad5e52",
      summary:
        "Medium-intensity mixed-use expansion land, potentially more interesting for larger schemes where planning coordination and infrastructure delivery are likely key constraints.",
    },
    {
      key: "mixed-iv",
      label: "Expansão Urbana Mista · Tipo IV",
      source: "Áreas de Expansão Tipologia Mista Tipo IV 1.8",
      color: "#7d4d75",
      summary:
        "Highest-intensity mixed-use expansion category, potentially the strongest candidate for scale, but also likely to carry greater planning, infrastructure, and execution complexity.",
    },
    {
      key: "housing",
      label: "Expansão Urbana · Moradia",
      source: "Áreas de Expansão Urbana Tipologia Moradia",
      color: "#8faa58",
      summary:
        "Expansion land intended for lower-density housing, most relevant for villa, townhouse, or small subdivision strategies rather than apartment-led development.",
    },
    {
      key: "transition",
      label: "Áreas de Transição",
      source: "Area de Transição",
      color: "#8fa0a7",
      summary:
        "Edge or buffer areas between urban and non-urban contexts, usually worth treating cautiously because development potential may be conditional, limited, or context-sensitive.",
    },
    {
      key: "transform-housing",
      label: "Transformação · Moradias",
      source: "Áreas Urbanizadas em Transformação de Moradias",
      color: "#c8b965",
      summary:
        "Existing urbanized areas expected to evolve while retaining a housing/low-density character, useful for infill, subdivision, or small redevelopment plays.",
    },
    {
      key: "transform-mixed",
      label: "Transformação · Tipologia Mista",
      source: "Áreas Urbanizadas em Transformação de Tipologia Mista",
      color: "#5f9689",
      summary:
        "Existing urbanized areas intended for change toward mixed-use or denser urban form, likely among the most interesting categories for proactive redevelopment outreach.",
    },
  ];

  const soilRegimeColors = {
    "Solo Urbano": "#4b9188",
    "Solo Rústico": "#8c9b52",
    "Solo Urbano (urbanizável – transitório)": "#d49a47",
  };

  const layerIds = {
    soilFill: "gaia-soil-regime-fill",
    soilLine: "gaia-soil-regime-line",
    pdmFill: "gaia-pdm-fill",
    pdmHalo: "gaia-pdm-halo",
    pdmLine: "gaia-pdm-line",
    perimeterLine: "gaia-perimeter-line",
    perimeterHalo: "gaia-perimeter-halo",
    parcelsFill: "gaia-parcels-fill",
    parcelsLine: "gaia-parcels-line",
    constraints: "gaia-constraints-wms",
    toponymyLine: "gaia-toponymy-line",
    toponymyLabel: "gaia-toponymy-label",
    selectedFill: "gaia-selected-fill",
    selectedLine: "gaia-selected-line",
    pinHalo: "gaia-coordinate-pin-halo",
    pinDot: "gaia-coordinate-pin-dot",
    };

  const sourceIds = {
    soilRegime: "gaia-soil-regime",
    pdm: "gaia-pdm",
    perimeter: "gaia-perimeter",
    parcels: "gaia-parcels",
    selected: "gaia-selected",
    constraints: "gaia-constraints",
    toponymy: "gaia-toponymy",
    coordinatePin: "gaia-coordinate-pin",
  };

  const elements = {
    pdmList: document.querySelector("#pdm-layer-list"),
    legend: document.querySelector("#legend"),
    pdmCount: document.querySelector("#pdm-count"),
    parcelCount: document.querySelector("#parcel-count"),
    basemapSummary: document.querySelector("#basemap-summary"),
    mapTitle: document.querySelector("#map-title"),
    mapStatus: document.querySelector("#map-status"),
    pdmMasterToggle: document.querySelector("#pdm-master-toggle"),
    pdmMasterState: document.querySelector("#pdm-master-state"),
    perimeterToggle: document.querySelector("#perimeter-toggle"),
    perimeterState: document.querySelector("#perimeter-state"),
    constraintsToggle: document.querySelector("#constraints-toggle"),
    constraintsState: document.querySelector("#constraints-state"),
    toponymyToggle: document.querySelector("#toponymy-toggle"),
    toponymyState: document.querySelector("#toponymy-state"),
    soilRegimeToggle: document.querySelector("#soil-regime-toggle"),
    soilRegimeState: document.querySelector("#soil-regime-state"),
    parcelVisibleToggle: document.querySelector("#parcel-visible-toggle"),
    uploadParcelsButton: document.querySelector("#upload-parcels-button"),
    parcelUploadInput: document.querySelector("#parcel-upload-input"),
    parcelHelper: document.querySelector("#parcel-helper"),
    fitGaiaButton: document.querySelector("#fit-gaia-button"),
    fitVisibleButton: document.querySelector("#fit-visible-button"),
    clearSelectionButton: document.querySelector("#clear-selection-button"),
    selectionState: document.querySelector("#selection-state"),
    selectionSummary: document.querySelector("#selection-summary"),
    basemapButtons: document.querySelectorAll("[data-basemap-mode]"),
  };

  let streetStyle = null;
  let dataManifest = null;
  let map = null;
  let pdmData = emptyCollection();
  let perimeterData = emptyCollection();
  let parcelData = emptyCollection();
  let toponymyData = null;
  let selectedData = emptyCollection();
  let coordinatePinData = emptyCollection();
  let currentPopup = null;
  let longPressTimer = null;

  const state = loadState();

  init();

  async function init() {
    buildPdmControls();
    buildLegend();
    bindControls();
    setStatus("Loading basemap style");

    try {
      [streetStyle, dataManifest] = await Promise.all([
        fetchJson(STREET_STYLE_URL),
        fetchJson(DATA_MANIFEST_URL),
      ]);
      updateManifestSummary();
      map = new maplibregl.Map({
        container: "map",
        style: getMapStyle(),
        center: GAIA_INITIAL_CENTER,
        zoom: 11.55,
        minZoom: 10.2,
        maxBounds: [
          [-8.86, 40.84],
          [-8.32, 41.3],
        ],
      });
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
      map.doubleClickZoom.disable();
      map.on("load", handleMapStyleReady);
      map.on("style.load", handleMapStyleReady);
      map.on("click", handleMapClick);
      map.on("dblclick", handleCoordinatePin);
      map.on("touchstart", startLongPressPin);
      map.on("touchend", cancelLongPressPin);
      map.on("touchmove", cancelLongPressPin);
      map.on("mousemove", handlePointer);
      updateBasemapButtons();
      updateMapModeClass();
      await loadPdmData();
      installDataLayers();
      fitGaia({ duration: 0 });
    } catch (error) {
      console.error(error);
      setStatus(`Could not initialize map: ${error.message}`);
    }
  }

  function loadState() {
    const fallback = {
      basemapMode: "street",
      pdmVisible: Object.fromEntries(pdmCategories.map((category) => [category.key, true])),
      perimeterVisible: true,
      soilRegimeVisible: true,
      constraintsVisible: false,
      toponymyVisible: false,
      parcelsVisible: true,
    };
    try {
      return { ...fallback, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
    } catch {
      return fallback;
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function emptyCollection() {
    return { type: "FeatureCollection", features: [] };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-GB");
  }

  function fetchJson(url) {
    return fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return response.json();
    });
  }

  function setStatus(message) {
    elements.mapStatus.textContent = message;
  }

  function setChip(element, enabled) {
    element.textContent = enabled ? "On" : "Off";
  }

  function buildPdmControls() {
    elements.pdmList.innerHTML = pdmCategories
      .map(
        (category) => `
          <label class="layer-row">
            <input type="checkbox" data-pdm-key="${category.key}" ${
              state.pdmVisible[category.key] ? "checked" : ""
            } />
            <span class="layer-swatch" style="background:${category.color}" aria-hidden="true"></span>
            <span class="layer-copy">
              <strong>${escapeHtml(category.label)}</strong>
              <span>${escapeHtml(category.source)}</span>
            </span>
            <button
              type="button"
              class="layer-info"
              aria-label="${escapeHtml(category.label)} development summary"
              aria-expanded="false"
              data-layer-info="${category.key}"
            >?</button>
            <span class="state-chip" id="chip-${category.key}">${
              state.pdmVisible[category.key] ? "On" : "Off"
            }</span>
            <span class="layer-description" id="desc-${category.key}">
              ${escapeHtml(category.summary)}
            </span>
          </label>
        `,
      )
      .join("");
    updatePdmMaster();
  }

  function buildLegend() {
    const items = pdmCategories.map(
      (category) =>
        `<span><i class="legend-swatch" style="background:${category.color}"></i>${escapeHtml(
          category.label.replace("Expansão Urbana ", "Exp. "),
        )}</span>`,
    );
    items.push(
      '<span><i class="legend-swatch" style="background:#4b9188"></i>Solo urbano</span>',
      '<span><i class="legend-swatch" style="background:#8c9b52"></i>Solo rústico</span>',
      '<span><i class="legend-swatch" style="background:#d49a47"></i>Urbanizável transitório</span>',
      '<span><i class="legend-swatch" style="background:transparent;border-color:#174d64"></i>Perímetro</span>',
      '<span><i class="legend-swatch" style="background:rgba(45,111,142,.18);border-color:#174d64"></i>Uploaded parcels</span>',
    );
    elements.legend.innerHTML = items.join("");
  }

  function updateManifestSummary() {
    const soilRegime = dataManifest?.datasets?.soilRegime;
    const cadastro = dataManifest?.datasets?.cadastroPredial;
    if (soilRegime) {
      elements.parcelCount.textContent = formatNumber(soilRegime.featureCount);
    }
    if (cadastro?.gaiaFeatureCount === 0) {
      elements.parcelHelper.textContent =
        "Cached DGT check found no public Cadastro Predial parcels inside Vila Nova de Gaia; CRUS supplies the official urban/rústico regime.";
    }
  }

  function bindControls() {
    elements.pdmMasterToggle.addEventListener("change", () => {
      for (const category of pdmCategories) {
        state.pdmVisible[category.key] = elements.pdmMasterToggle.checked;
      }
      saveState();
      buildPdmControls();
      bindPdmCheckboxes();
      bindLayerInfoButtons();
      updateLayerFilters();
    });
    bindPdmCheckboxes();
    bindLayerInfoButtons();

    elements.perimeterToggle.checked = state.perimeterVisible;
    setChip(elements.perimeterState, state.perimeterVisible);
    elements.perimeterToggle.addEventListener("change", () => {
      state.perimeterVisible = elements.perimeterToggle.checked;
      setChip(elements.perimeterState, state.perimeterVisible);
      saveState();
      updateLayerVisibility();
    });

    elements.constraintsToggle.checked = state.constraintsVisible;
    setChip(elements.constraintsState, state.constraintsVisible);
    elements.constraintsToggle.addEventListener("change", () => {
      state.constraintsVisible = elements.constraintsToggle.checked;
      setChip(elements.constraintsState, state.constraintsVisible);
      saveState();
      updateLayerVisibility();
    });

    elements.toponymyToggle.checked = state.toponymyVisible;
    setChip(elements.toponymyState, state.toponymyVisible);
    elements.toponymyToggle.addEventListener("change", async () => {
      state.toponymyVisible = elements.toponymyToggle.checked;
      setChip(elements.toponymyState, state.toponymyVisible);
      saveState();
      if (state.toponymyVisible && !toponymyData) {
        await loadToponymy();
        installDataLayers();
      }
      updateLayerVisibility();
    });

    elements.soilRegimeToggle.checked = state.soilRegimeVisible;
    setChip(elements.soilRegimeState, state.soilRegimeVisible);
    elements.soilRegimeToggle.addEventListener("change", () => {
      state.soilRegimeVisible = elements.soilRegimeToggle.checked;
      setChip(elements.soilRegimeState, state.soilRegimeVisible);
      saveState();
      updateLayerVisibility();
    });

    elements.parcelVisibleToggle.checked = state.parcelsVisible;
    elements.parcelVisibleToggle.addEventListener("change", () => {
      state.parcelsVisible = elements.parcelVisibleToggle.checked;
      saveState();
      updateLayerVisibility();
    });

    elements.uploadParcelsButton.addEventListener("click", () => elements.parcelUploadInput.click());
    elements.parcelUploadInput.addEventListener("change", handleParcelUpload);
    elements.fitGaiaButton.addEventListener("click", fitGaia);
    elements.fitVisibleButton.addEventListener("click", fitVisible);
    elements.clearSelectionButton.addEventListener("click", clearSelection);
    for (const button of elements.basemapButtons) {
      button.addEventListener("click", () => {
        state.basemapMode = button.dataset.basemapMode;
        saveState();
        updateBasemapButtons();
        updateMapModeClass();
        updateBasemapVisibility();
        updateOverlayPaint();
      });
    }
  }

  function bindPdmCheckboxes() {
    document.querySelectorAll("[data-pdm-key]").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        state.pdmVisible[checkbox.dataset.pdmKey] = checkbox.checked;
        document.querySelector(`#chip-${checkbox.dataset.pdmKey}`).textContent = checkbox.checked
          ? "On"
          : "Off";
        updatePdmMaster();
        saveState();
        updateLayerFilters();
      });
    });
  }

  function bindLayerInfoButtons() {
    document.querySelectorAll("[data-layer-info]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const expanded = button.getAttribute("aria-expanded") === "true";
        for (const otherButton of document.querySelectorAll("[data-layer-info]")) {
          otherButton.setAttribute("aria-expanded", "false");
        }
        button.setAttribute("aria-expanded", String(!expanded));
      });
    });
  }

  function updatePdmMaster() {
    const enabledCount = pdmCategories.filter((category) => state.pdmVisible[category.key]).length;
    elements.pdmMasterToggle.checked = enabledCount === pdmCategories.length;
    elements.pdmMasterToggle.indeterminate = enabledCount > 0 && enabledCount < pdmCategories.length;
    elements.pdmMasterState.textContent =
      enabledCount === pdmCategories.length ? "On" : enabledCount === 0 ? "Off" : "Some";
  }

  function getMapStyle() {
    const next = clone(streetStyle);
    next.sources = {
      ...(next.sources || {}),
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
        layout: { visibility: state.basemapMode === "satellite" ? "visible" : "none" },
        paint: { "raster-opacity": 0.92, "raster-saturation": -0.18, "raster-contrast": -0.08 },
      },
      ...(next.layers || []),
    ];
    return next;
  }

  function updateBasemapButtons() {
    for (const button of elements.basemapButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.basemapMode === state.basemapMode));
    }
    elements.basemapSummary.textContent = state.basemapMode === "satellite" ? "Satellite" : "Map";
  }

  function updateMapModeClass() {
    document.body.classList.toggle("is-satellite", state.basemapMode === "satellite");
  }

  async function loadPdmData() {
    setStatus("Loading Gaia PDM designation geometry");
    const descriptors = [
      ...pdmCategories.map((category) => category.source),
      "Perimetro Urbano",
    ];
    const cql = `descr IN (${descriptors.map((value) => `'${value.replaceAll("'", "''")}'`).join(",")})`;
    const url = new URL(GAIA_WFS);
    url.search = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: "grppdm:mvw_qualsolo_areas",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      CQL_FILTER: cql,
    }).toString();
    const data = await fetchJson(url);
    const categoryBySource = new Map(pdmCategories.map((category) => [category.source, category]));
    pdmData = {
      type: "FeatureCollection",
      features: (data.features || [])
        .filter((feature) => categoryBySource.has(feature.properties?.descr))
        .map((feature) => ({
          ...feature,
          properties: {
            ...feature.properties,
            pdmKey: categoryBySource.get(feature.properties.descr).key,
            pdmLabel: categoryBySource.get(feature.properties.descr).label,
          },
        })),
    };
    perimeterData = {
      type: "FeatureCollection",
      features: (data.features || []).filter(
        (feature) => feature.properties?.descr === "Perimetro Urbano",
      ),
    };
    elements.pdmCount.textContent = formatNumber(pdmData.features.length);
    elements.mapTitle.textContent = "Gaia PDM + urban/rústico regime";
    setStatus("Gaia PDM layers and cached DGT CRUS regime tiles are ready.");
  }

  async function loadToponymy() {
    setStatus("Loading official Gaia toponymy");
    const url = new URL(GAIA_WFS);
    url.search = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: "gaiaide_toponimia:eixosvia_gaiurb",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
    }).toString();
    toponymyData = await fetchJson(url);
    setStatus(`Toponymy loaded: ${formatNumber(toponymyData.features.length)} street segments.`);
  }

  function handleParcelUpload(event) {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      try {
        const data = JSON.parse(String(reader.result || "{}"));
        if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
          throw new Error("Expected a GeoJSON FeatureCollection");
        }
        parcelData = data;
        refreshSource(sourceIds.parcels, parcelData);
        elements.parcelCount.textContent = formatNumber(parcelData.features.length);
        elements.parcelHelper.textContent = `Loaded local parcel GeoJSON: ${escapeHtml(file.name)}.`;
        setStatus(`Local parcels ready: ${formatNumber(parcelData.features.length)} features.`);
      } catch (error) {
        setStatus(`Could not read parcel GeoJSON: ${error.message}`);
      } finally {
        event.target.value = "";
      }
    });
    reader.readAsText(file);
  }

  function handleMapStyleReady() {
    installDataLayers();
    updateLayerFilters();
    updateLayerVisibility();
    updateBasemapVisibility();
    updateOverlayPaint();
  }

  function installDataLayers() {
    if (!map || !map.isStyleLoaded()) {
      return;
    }
    addSoilRegimeSource();
    addOrRefreshGeoJson(sourceIds.pdm, pdmData);
    addOrRefreshGeoJson(sourceIds.perimeter, perimeterData);
    addOrRefreshGeoJson(sourceIds.parcels, parcelData);
    addOrRefreshGeoJson(sourceIds.selected, selectedData);
    addOrRefreshGeoJson(sourceIds.coordinatePin, coordinatePinData);
    if (toponymyData) {
      addOrRefreshGeoJson(sourceIds.toponymy, toponymyData);
    }
    addConstraintsSource();

    const beforeId = firstSymbolLayerId();
    addLayerOnce(
      {
        id: layerIds.soilFill,
        type: "fill",
        source: sourceIds.soilRegime,
        "source-layer": "soil_regime",
        paint: {
          "fill-color": soilRegimeColorExpression(),
          "fill-opacity": state.basemapMode === "satellite" ? 0.32 : 0.22,
        },
      },
      beforeId,
    );
    addLayerOnce(
      {
        id: layerIds.soilLine,
        type: "line",
        source: sourceIds.soilRegime,
        "source-layer": "soil_regime",
        minzoom: 12,
        paint: {
          "line-color": soilRegimeColorExpression(),
          "line-opacity": state.basemapMode === "satellite" ? 0.86 : 0.56,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.35, 16, 1.15],
        },
      },
      beforeId,
    );
    addLayerOnce(
      {
        id: layerIds.pdmFill,
        type: "fill",
        source: sourceIds.pdm,
        paint: {
          "fill-color": pdmColorExpression(),
          "fill-opacity": state.basemapMode === "satellite" ? 0.7 : 0.46,
        },
      },
      beforeId,
    );
    addLayerOnce(
      {
        id: layerIds.pdmHalo,
        type: "line",
        source: sourceIds.pdm,
        paint: {
          "line-color": "#fff8eb",
          "line-opacity": 0.78,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.3, 15, 4.2],
        },
      },
      beforeId,
    );
    addLayerOnce(
      {
        id: layerIds.pdmLine,
        type: "line",
        source: sourceIds.pdm,
        paint: {
          "line-color": pdmColorExpression(),
          "line-opacity": 0.96,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.1, 15, 2.3],
        },
      },
      beforeId,
    );
    addLayerOnce(
      {
        id: layerIds.constraints,
        type: "raster",
        source: sourceIds.constraints,
        paint: { "raster-opacity": 0.68 },
      },
      beforeId,
    );
    addLayerOnce(
      {
        id: layerIds.perimeterHalo,
        type: "line",
        source: sourceIds.perimeter,
        paint: {
          "line-color": "#fff8eb",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3.5, 15, 7],
          "line-opacity": 0.84,
        },
      },
      beforeId,
    );
    addLayerOnce(
      {
        id: layerIds.perimeterLine,
        type: "line",
        source: sourceIds.perimeter,
        paint: {
          "line-color": "#174d64",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 15, 3],
          "line-dasharray": [1.3, 1.1],
        },
      },
      beforeId,
    );
    addLayerOnce({
      id: layerIds.parcelsFill,
      type: "fill",
      source: sourceIds.parcels,
      paint: {
        "fill-color": "#2e6f8e",
        "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.35, 0.14],
      },
    });
    addLayerOnce({
      id: layerIds.parcelsLine,
      type: "line",
      source: sourceIds.parcels,
      paint: {
        "line-color": "#174d64",
        "line-opacity": 0.92,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.35, 16, 1.45],
      },
    });
    if (toponymyData) {
      addLayerOnce({
        id: layerIds.toponymyLine,
        type: "line",
        source: sourceIds.toponymy,
        paint: {
          "line-color": "#2d3f44",
          "line-opacity": 0.38,
          "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.45, 16, 1.4],
        },
      });
      addLayerOnce({
        id: layerIds.toponymyLabel,
        type: "symbol",
        source: sourceIds.toponymy,
        minzoom: 13,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "nome_rua"], ["get", "tipo"]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 13],
          "text-font": ["Noto Sans Regular"],
        },
        paint: {
          "text-color": "#28373a",
          "text-halo-color": "#fff8eb",
          "text-halo-width": 1.3,
        },
      });
    }
    addLayerOnce({
      id: layerIds.selectedFill,
      type: "fill",
      source: sourceIds.selected,
      paint: {
        "fill-color": "#f2e8d6",
        "fill-opacity": 0.16,
      },
    });
    addLayerOnce({
      id: layerIds.selectedLine,
      type: "line",
      source: sourceIds.selected,
      paint: {
        "line-color": "#1b2429",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 4],
      },
    });
    addLayerOnce({
      id: layerIds.pinHalo,
      type: "circle",
      source: sourceIds.coordinatePin,
      paint: {
        "circle-color": "#fff8eb",
        "circle-radius": 12,
        "circle-opacity": 0.95,
        "circle-stroke-color": "#1b2429",
        "circle-stroke-width": 2,
      },
    });
    addLayerOnce({
      id: layerIds.pinDot,
      type: "circle",
      source: sourceIds.coordinatePin,
      paint: {
        "circle-color": "#d44d3f",
        "circle-radius": 6,
        "circle-stroke-color": "#fff8eb",
        "circle-stroke-width": 2,
      },
    });
    updateLayerFilters();
    updateLayerVisibility();
    updateBasemapVisibility();
    updateOverlayPaint();
  }

  function addOrRefreshGeoJson(id, data) {
    if (map.getSource(id)) {
      map.getSource(id).setData(data);
      return;
    }
    map.addSource(id, { type: "geojson", data, generateId: true });
  }

  function refreshSource(id, data) {
    if (map?.getSource(id)) {
      map.getSource(id).setData(data);
    }
  }

  function addSoilRegimeSource() {
    if (map.getSource(sourceIds.soilRegime)) {
      return;
    }
    map.addSource(sourceIds.soilRegime, {
      type: "vector",
      url: `pmtiles://${new URL("./data/crus-regime.pmtiles", location.href).href}`,
      minzoom: 9,
      maxzoom: 16,
      attribution: "Urban/rustic soil regime © DGT CRUS.",
    });
  }

  function addConstraintsSource() {
    if (map.getSource(sourceIds.constraints)) {
      return;
    }
    const params = [
      "service=WMS",
      "version=1.1.1",
      "request=GetMap",
      "layers=grppdmcond:servidoes_restricoes_util_pub",
      "styles=",
      "format=image/png",
      "transparent=true",
      "srs=EPSG:3857",
      "bbox={bbox-epsg-3857}",
      "width=256",
      "height=256",
    ].join("&");
    map.addSource(sourceIds.constraints, {
      type: "raster",
      tiles: [`${GAIA_WMS}?${params}`],
      tileSize: 256,
      attribution: "PDM and constraints © GAIURB / Município de Vila Nova de Gaia.",
    });
  }

  function addLayerOnce(layer, beforeId) {
    if (map.getLayer(layer.id)) {
      return;
    }
    if (beforeId && map.getLayer(beforeId)) {
      map.addLayer(layer, beforeId);
    } else {
      map.addLayer(layer);
    }
  }

  function firstSymbolLayerId() {
    return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  }

  function pdmColorExpression() {
    const expression = ["match", ["get", "pdmKey"]];
    for (const category of pdmCategories) {
      expression.push(category.key, category.color);
    }
    expression.push("#8b8172");
    return expression;
  }

  function soilRegimeColorExpression() {
    const expression = ["match", ["get", "classe"]];
    for (const [label, color] of Object.entries(soilRegimeColors)) {
      expression.push(label, color);
    }
    expression.push("#9d9588");
    return expression;
  }

  function updateLayerFilters() {
    if (!map) {
      return;
    }
    const visibleKeys = pdmCategories
      .filter((category) => state.pdmVisible[category.key])
      .map((category) => category.key);
    for (const id of [layerIds.pdmFill, layerIds.pdmHalo, layerIds.pdmLine]) {
      if (map.getLayer(id)) {
        map.setFilter(id, visibleKeys.length ? ["in", ["get", "pdmKey"], ["literal", visibleKeys]] : ["==", ["get", "pdmKey"], "__none__"]);
      }
    }
  }

  function updateLayerVisibility() {
    if (!map) {
      return;
    }
    setVisibility([layerIds.soilFill, layerIds.soilLine], state.soilRegimeVisible);
    setVisibility([layerIds.perimeterHalo, layerIds.perimeterLine], state.perimeterVisible);
    setVisibility([layerIds.constraints], state.constraintsVisible);
    setVisibility([layerIds.toponymyLine, layerIds.toponymyLabel], state.toponymyVisible);
    setVisibility([layerIds.parcelsFill, layerIds.parcelsLine], state.parcelsVisible);
  }

  function updateBasemapVisibility() {
    if (!map?.getLayer("satellite-basemap")) {
      return;
    }
    const satellite = state.basemapMode === "satellite";
    map.setLayoutProperty(
      "satellite-basemap",
      "visibility",
      satellite ? "visible" : "none",
    );
    for (const layer of streetStyle?.layers || []) {
      if (!map.getLayer(layer.id)) {
        continue;
      }
      const keepForSatellite = layer.type === "symbol";
      map.setLayoutProperty(layer.id, "visibility", !satellite || keepForSatellite ? "visible" : "none");
    }
  }

  function updateOverlayPaint() {
    if (!map) {
      return;
    }
    const satellite = state.basemapMode === "satellite";
    setPaint(layerIds.soilFill, "fill-opacity", satellite ? 0.42 : 0.22);
    setPaint(layerIds.soilLine, "line-opacity", satellite ? 0.95 : 0.56);
    setPaint(layerIds.soilLine, "line-width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      12,
      satellite ? 0.7 : 0.35,
      16,
      satellite ? 1.8 : 1.15,
    ]);
    setPaint(layerIds.pdmFill, "fill-opacity", satellite ? 0.82 : 0.46);
    setPaint(layerIds.pdmHalo, "line-color", satellite ? "#fff8eb" : "#fff8eb");
    setPaint(layerIds.pdmHalo, "line-opacity", satellite ? 0.95 : 0.5);
    setPaint(layerIds.pdmHalo, "line-width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      satellite ? 3.4 : 2.3,
      15,
      satellite ? 6.2 : 4.2,
    ]);
    setPaint(layerIds.pdmLine, "line-opacity", satellite ? 1 : 0.96);
    setPaint(layerIds.pdmLine, "line-width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      10,
      satellite ? 1.8 : 1.1,
      15,
      satellite ? 3.2 : 2.3,
    ]);
    setPaint(layerIds.constraints, "raster-opacity", satellite ? 0.82 : 0.68);
  }

  function setPaint(id, property, value) {
    if (map.getLayer(id)) {
      map.setPaintProperty(id, property, value);
    }
  }

  function setVisibility(ids, visible) {
    for (const id of ids) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    }
  }

  function handlePointer(event) {
    if (!map) {
      return;
    }
    const layers = interactiveLayers().filter((id) => map.getLayer(id));
    const features = layers.length ? map.queryRenderedFeatures(event.point, { layers }) : [];
    map.getCanvas().style.cursor = features.length ? "pointer" : "";
  }

  function handleMapClick(event) {
    if (!map) {
      return;
    }
    const layers = interactiveLayers().filter((id) => map.getLayer(id));
    const [feature] = layers.length ? map.queryRenderedFeatures(event.point, { layers }) : [];
    if (!feature) {
      return;
    }
    selectFeature(feature, event.lngLat);
  }

  function handleCoordinatePin(event) {
    event.preventDefault();
    dropCoordinatePin(event.lngLat);
  }

  function startLongPressPin(event) {
    cancelLongPressPin();
    if (!event.lngLat || event.points?.length > 1) {
      return;
    }
    const lngLat = event.lngLat;
    longPressTimer = window.setTimeout(() => dropCoordinatePin(lngLat), 650);
  }

  function cancelLongPressPin() {
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  async function dropCoordinatePin(lngLat) {
    coordinatePinData = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [lngLat.lng, lngLat.lat] },
          properties: {},
        },
      ],
    };
    refreshSource(sourceIds.coordinatePin, coordinatePinData);
    const coords = `${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}`;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lngLat.lat.toFixed(6)},${lngLat.lng.toFixed(6)}`;
    elements.selectionState.textContent = "Pin";
    elements.selectionSummary.innerHTML = `
      <div class="pin-output">
        <strong>Coordinate pin</strong>
        <code>${escapeHtml(coords)}</code>
        <button type="button" class="copy-pin" data-copy="${escapeHtml(coords)}">Copy coordinates</button>
        <a href="${mapsUrl}" target="_blank" rel="noreferrer">Open in Google Maps</a>
      </div>
    `;
    elements.selectionSummary.querySelector(".copy-pin")?.addEventListener("click", async (event) => {
      await copyText(event.currentTarget.dataset.copy);
      event.currentTarget.textContent = "Copied";
    });
    if (currentPopup) {
      currentPopup.remove();
    }
    currentPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
      .setLngLat(lngLat)
      .setHTML(
        `<strong>Coordinate pin</strong><br><code>${escapeHtml(
          coords,
        )}</code><br><span>Double-click or long-press to move it.</span>`,
      )
      .addTo(map);
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.append(textArea);
    textArea.select();
    document.execCommand("copy");
    textArea.remove();
  }

  function interactiveLayers() {
    return [
      layerIds.parcelsFill,
      layerIds.parcelsLine,
      layerIds.soilFill,
      layerIds.soilLine,
      layerIds.pdmFill,
      layerIds.pdmLine,
      layerIds.perimeterLine,
      layerIds.toponymyLine,
      layerIds.toponymyLabel,
    ];
  }

  function selectFeature(feature, lngLat) {
    selectedData = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: clone(feature.geometry),
          properties: clone(feature.properties || {}),
        },
      ],
    };
    refreshSource(sourceIds.selected, selectedData);

    const title = featureTitle(feature);
    elements.selectionState.textContent = title.kind;
    elements.selectionSummary.innerHTML = attributesHtml(feature.properties || {}, title);
    if (currentPopup) {
      currentPopup.remove();
    }
    currentPopup = new maplibregl.Popup({ closeButton: false, maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(`<strong>${escapeHtml(title.name)}</strong><br>${escapeHtml(title.kind)}`)
      .addTo(map);
  }

  function featureTitle(feature) {
    const properties = feature.properties || {};
    if (feature.layer?.id?.startsWith("gaia-parcels")) {
      return { kind: "Parcel", name: properties.label || properties.nationalcadastralreference || "DGT parcel" };
    }
    if (feature.layer?.id?.startsWith("gaia-soil-regime")) {
      return { kind: "Urban/Rústico", name: properties.classe || "CRUS soil regime" };
    }
    if (feature.layer?.id?.includes("toponymy")) {
      return { kind: "Toponímia", name: properties.nome_rua || properties.tipo || "Street segment" };
    }
    if (feature.layer?.id?.includes("perimeter")) {
      return { kind: "Perimeter", name: "Perímetro Urbano" };
    }
    return { kind: "PDM", name: properties.pdmLabel || properties.descr || "PDM designation" };
  }

  function attributesHtml(properties, title) {
    const preferred = [
      ["Layer", title.name],
      ["Kind", title.kind],
      ["Source class", properties.descr],
      ["NIC", properties.nationalcadastralreference],
      ["Label", properties.label],
      ["Parcel area", properties.areavalue ? `${formatNumber(properties.areavalue)} m²` : ""],
      ["Regime", properties.classe],
      ["Category", properties.categoria],
      ["Qualification", properties.qualificacao],
      ["Area", properties.area_ha ? `${formatNumber(properties.area_ha)} ha` : ""],
      ["Street", properties.nome_rua],
      ["Freguesia", properties.freguesia],
      ["Group", properties.grupo],
      ["GID", properties.gid || properties.id],
    ].filter(([, value]) => value !== undefined && value !== null && value !== "");
    return `<dl>${preferred
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join("")}</dl>`;
  }

  function clearSelection() {
    selectedData = emptyCollection();
    coordinatePinData = emptyCollection();
    refreshSource(sourceIds.selected, selectedData);
    refreshSource(sourceIds.coordinatePin, coordinatePinData);
    elements.selectionState.textContent = "None";
    elements.selectionSummary.textContent =
      "Click a parcel, PDM area, perimeter, or street feature to inspect attributes.";
    if (currentPopup) {
      currentPopup.remove();
      currentPopup = null;
    }
  }

  function fitGaia(options = {}) {
    const padding = { top: 150, right: 56, bottom: 56, left: 56 };
    map.fitBounds(GAIA_BOUNDS, { padding, duration: 650, ...options });
  }

  function fitVisible() {
    const bounds = featureBounds([
      ...pdmData.features.filter((feature) => state.pdmVisible[feature.properties?.pdmKey]),
      ...(state.perimeterVisible ? perimeterData.features : []),
      ...(state.parcelsVisible ? parcelData.features : []),
    ]);
    if (bounds) {
      map.fitBounds(bounds, { padding: 60, duration: 700 });
    } else {
      fitGaia();
    }
  }

  function featureBounds(features) {
    let bounds = null;
    for (const feature of features) {
      bounds = expandBounds(bounds, feature.geometry?.coordinates);
    }
    return bounds ? [[bounds[0], bounds[1]], [bounds[2], bounds[3]]] : null;
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
})();
