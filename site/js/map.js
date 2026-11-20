/* global maplibregl */
import { gridToGeoJSON, bounds, resolutionLabel } from "./eea.js";

// Zoom level at which the map switches from the 10 km to the 1 km grid.
const FINE_ZOOM = 8;

const RAMPS = {
  alien: ["#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#fc4e2a", "#e31a1c", "#b10026"],
  richness: ["#ffffcc", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#0c2c84"],
  effort: ["#f2f0f7", "#dadaeb", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3", "#4a1486"],
};

export const LAYERS = {
  alien_richness: {
    label: "Alien species (checklist)",
    unit: "alien species",
    ramp: RAMPS.alien,
    help: "Number of species of the GRIIS checklist recorded in the cell.",
  },
  alien_occurrences: {
    label: "Alien species occurrences",
    unit: "occurrences of alien species",
    ramp: RAMPS.alien,
    help: "Number of occurrences of checklist species in the cell.",
  },
  richness: {
    label: "All species",
    unit: "species",
    ramp: RAMPS.richness,
    help: "Observed species richness: number of species recorded in the cell (all taxa).",
  },
  observers: {
    label: "Sampling effort: observers",
    unit: "observers (summed per species and month)",
    ramp: RAMPS.effort,
    help: "Sum of the distinct observers per species and month: a proxy for sampling effort.",
  },
  occurrences: {
    label: "Sampling effort: occurrences",
    unit: "occurrences",
    ramp: RAMPS.effort,
    help: "Total number of GBIF occurrences in the cell (all taxa).",
  },
};

// Place names drawn above the grid (keyless Esri reference layer).
const LABELS = {
  tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
  attribution: "Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
};

export const BASEMAPS = {
  light: {
    label: "Light grey (Esri)",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    maxzoom: 16,
  },
  osm: {
    label: "OpenStreetMap",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  satellite: {
    label: "Satellite (Esri)",
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
};

function baseStyle(active) {
  const sources = {};
  const layers = [];
  for (const [id, b] of Object.entries(BASEMAPS)) {
    sources[`base-${id}`] = { type: "raster", tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom ?? 19 };
    layers.push({
      id: `base-${id}`, type: "raster", source: `base-${id}`,
      layout: { visibility: id === active ? "visible" : "none" },
    });
  }
  sources.labels = { type: "raster", tiles: LABELS.tiles, tileSize: 256, maxzoom: 16, attribution: LABELS.attribution };
  return { version: 8, sources, layers };
}

function colorExpression(field, max, ramp) {
  const top = Math.log10(1 + Math.max(max, 1));
  const stops = [];
  ramp.forEach((c, i) => stops.push((top * i) / (ramp.length - 1), c));
  return ["interpolate", ["linear"], ["log10", ["+", 1, ["to-number", ["get", field], 0]]], ...stops];
}

function format(v) {
  return v == null ? "–" : Number(v).toLocaleString("en-GB");
}

export class GridMap {
  /**
   * @param {HTMLElement} container
   * @param {object} opts {coarse: grid json, loadFine: () => Promise<grid json>, layer, basemap, onResolution}
   */
  constructor(container, opts) {
    this.opts = opts;
    this.field = opts.layer in LAYERS ? opts.layer : "alien_richness";
    this.basemap = opts.basemap in BASEMAPS ? opts.basemap : "light";
    this.opacity = 0.8;
    this.grids = { coarse: opts.coarse, fine: null };
    this.coarseGeo = gridToGeoJSON(opts.coarse);

    this.map = new maplibregl.Map({
      container,
      style: baseStyle(this.basemap),
      bounds: bounds(this.coarseGeo),
      fitBoundsOptions: { padding: 20 },
      maxZoom: 16,
      hash: opts.hash ?? false,  // #zoom/lat/lon in the URL: shareable and embeddable views
      attributionControl: { compact: true },
      cooperativeGestures: opts.cooperativeGestures ?? false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    this.map.addControl(new maplibregl.FullscreenControl(), "top-right");
    this.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "280px" });
    this.ready = new Promise((resolve) => this.map.on("load", () => { this._init(); resolve(); }));
  }

  _addGrid(id, geojson) {
    const m = this.map;
    m.addSource(id, { type: "geojson", data: geojson, tolerance: 0.05, buffer: 16 });
    m.addLayer({
      id: `${id}-fill`, type: "fill", source: id,
      paint: { "fill-color": "#000", "fill-opacity": this.opacity, "fill-antialias": false },
    }, "labels");
    m.on("mousemove", `${id}-fill`, (e) => this._hover(e));
    m.on("mouseleave", `${id}-fill`, () => this._unhover());
  }

  _init() {
    const m = this.map;
    m.addLayer({ id: "labels", type: "raster", source: "labels" });
    this._addGrid("coarse", this.coarseGeo);
    m.addSource("highlight", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    m.addLayer({ id: "highlight", type: "line", source: "highlight", paint: { "line-color": "#111", "line-width": 2 } });
    this._style();
    m.on("zoomend", () => this._resolutionChanged());
    this._resolutionChanged();

    // Load the 1 km grid in the background, after the first render.
    if (this.opts.loadFine) {
      this.opts.loadFine().then((fine) => {
        this.grids.fine = fine;
        this._addGrid("fine", gridToGeoJSON(fine));
        m.setLayerZoomRange("coarse-fill", 0, FINE_ZOOM);
        m.setLayerZoomRange("fine-fill", FINE_ZOOM, 24);
        this._style();
        this._resolutionChanged();
      }).catch((err) => console.error("Could not load the fine grid", err));
    }
  }

  _style() {
    const cfg = LAYERS[this.field];
    for (const id of ["coarse", "fine"]) {
      if (!this.map.getLayer(`${id}-fill`)) continue;
      const max = this.grids[id].max[this.field];
      this.map.setPaintProperty(`${id}-fill`, "fill-color", colorExpression(this.field, max, cfg.ramp));
      this.map.setPaintProperty(`${id}-fill`, "fill-opacity", this.opacity);
      this.map.setFilter(`${id}-fill`, [">", ["to-number", ["get", this.field], 0], 0]);
    }
  }

  activeGrid() {
    const fine = this.grids.fine && this.map.getZoom() >= FINE_ZOOM;
    return fine ? this.grids.fine : this.grids.coarse;
  }

  _resolutionChanged() {
    const grid = this.activeGrid();
    if (this.opts.onResolution) {
      this.opts.onResolution({
        resolution: grid.resolution,
        label: resolutionLabel(grid.resolution).replace("km", " km"),
        fineAvailable: Boolean(this.grids.fine),
        fineZoom: FINE_ZOOM,
        field: this.field,
        max: grid.max[this.field],
        config: LAYERS[this.field],
      });
    }
  }

  _hover(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    this.map.getCanvas().style.cursor = "crosshair";
    this.map.getSource("highlight").setData({ type: "FeatureCollection", features: [f] });
    const p = f.properties;
    const rows = Object.entries(LAYERS)
      .map(([k, c]) => `<tr${k === this.field ? ' class="active"' : ""}><th>${c.label}</th><td>${format(p[k])}</td></tr>`)
      .join("");
    this.popup.setLngLat(e.lngLat)
      .setHTML(`<div class="popup"><div class="popup-code">${p.code}</div><table>${rows}</table></div>`)
      .addTo(this.map);
  }

  _unhover() {
    this.map.getCanvas().style.cursor = "";
    this.map.getSource("highlight").setData({ type: "FeatureCollection", features: [] });
    this.popup.remove();
  }

  setLayer(field) {
    this.field = field;
    this._style();
    this._resolutionChanged();
  }

  setBasemap(id) {
    this.basemap = id;
    for (const b of Object.keys(BASEMAPS)) {
      this.map.setLayoutProperty(`base-${b}`, "visibility", b === id ? "visible" : "none");
    }
  }

  setOpacity(value) {
    this.opacity = value;
    this._style();
  }
}

/** Render a log-scale legend for the active layer. */
export function renderLegend(el, info) {
  const { config, max, label, fineAvailable, fineZoom } = info;
  const gradient = `linear-gradient(to right, ${config.ramp.join(", ")})`;
  const top = Math.log10(1 + Math.max(max, 1));
  const ticks = [];
  for (let p = 0; Math.pow(10, p) <= max; p++) ticks.push(Math.pow(10, p));
  if (!ticks.length || ticks[ticks.length - 1] !== max) ticks.push(max);
  const tickHtml = ticks
    .map((t) => `<span style="left:${(Math.log10(1 + t) / top) * 100}%">${t >= 1000 ? `${Math.round(t / 1000)}k` : t}</span>`)
    .join("");
  const res = fineAvailable
    ? `Grid: <strong>${label}</strong> cells (switches at zoom ${fineZoom})`
    : `Grid: <strong>${label}</strong> cells (loading 1 km grid…)`;
  el.innerHTML = `
    <div class="legend-title">${config.label}</div>
    <div class="legend-unit">${config.unit} per cell (log scale)</div>
    <div class="legend-bar" style="background:${gradient}"></div>
    <div class="legend-ticks">${tickHtml}</div>
    <div class="legend-res">${res}</div>`;
}
