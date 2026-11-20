import { GridMap, LAYERS, BASEMAPS, renderLegend } from "./map.js";
import { plotCumulative, plotAnnual, plotEffort } from "./charts.js";
import { SpeciesTable } from "./species.js";

const DATA = "data/";
const params = new URLSearchParams(location.search);
const embed = params.get("embed");

const fmt = (v, d = 0) => (v == null ? "–" : Number(v).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));
const signed = (v, d = 1) => `${v > 0 ? "+" : ""}${fmt(v, d)}`;

async function getJson(name) {
  const r = await fetch(DATA + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

function setText(sel, text) {
  document.querySelectorAll(sel).forEach((el) => { el.textContent = text; });
}

function renderIndicators(summary, ts) {
  const ind = summary.indicator;
  const [start, end] = summary.window;
  const annual = ts.bootstrap.annual;
  const last = annual.mean.length - 1;
  const cards = [
    {
      value: fmt(summary.checklist.species),
      label: "Alien species on the national checklist",
      sub: `${fmt(summary.checklist.records)} checklist records; ${fmt(summary.checklist.unmatched)} names not matched to the GBIF backbone`,
    },
    {
      value: fmt(summary.checklist.observed),
      label: "Recorded in GBIF occurrence data",
      sub: `${fmt(summary.checklist.invasive_observed)} of them flagged as invasive`,
    },
    {
      value: fmt(ind.discoveries_in_window),
      label: `New alien species ${start}–${end}`,
      sub: "first records in the occurrence cube",
    },
    {
      value: `${fmt(annual.mean[last], 1)}<small> /yr</small>`,
      label: `Fitted rate of establishment in ${end}`,
      sub: `95% CI ${fmt(annual.lower[last], 1)} – ${fmt(annual.upper[last], 1)} species per year`,
    },
    {
      value: `${signed(ind.annual_change_pct)}<small> %/yr</small>`,
      label: "Trend in the rate of establishment",
      sub: `95% CI ${signed(ind.annual_change_pct_ci[0])} to ${signed(ind.annual_change_pct_ci[1])} % (β₁ = ${fmt(ind.beta1, 4)})`,
      accent: ind.annual_change_pct_ci[0] > 0 ? "up" : ind.annual_change_pct_ci[1] < 0 ? "down" : "",
    },
  ];
  document.getElementById("indicator-cards").innerHTML = cards.map((c) => `
    <div class="kpi ${c.accent ? `kpi-${c.accent}` : ""}">
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`).join("");
}

function renderSources(summary) {
  const { cube, checklist, backbone } = summary.sources;
  const link = (doi) => (doi ? `<a href="https://doi.org/${doi}">https://doi.org/${doi}</a>` : "");
  const cubeCitation = cube.citation ? cube.citation.replace(`https://doi.org/${cube.doi}`, link(cube.doi)) : link(cube.doi);
  const clCitation = checklist.citation ? checklist.citation.replace(`https://doi.org/${checklist.doi}`, link(checklist.doi)) : "";
  document.getElementById("sources").innerHTML = `
    <li><strong>Occurrence data.</strong> ${cubeCitation}.
      ${cube.license ? `Licensed under <a href="${cube.license_url}">${cube.license}</a>.` : ""}
      ${fmt(summary.cube.records)} cube records on the ${summary.cube.grid} (${fmt(summary.cube.resolution_m / 1000)} km),
      ${summary.cube.period[0]} – ${summary.cube.period[1]}.</li>
    <li><strong>Checklist.</strong> ${clCitation}</li>
    <li><strong>Taxonomy.</strong> ${backbone}.</li>
    <li><strong>Software.</strong> b3alien ${summary.b3alien_version}
      (<a href="https://github.com/mtrekels/b3alien">github.com/mtrekels/b3alien</a>), data generated on ${summary.generated}.</li>`;
}

function renderEmbedSnippets() {
  const base = location.href.split(/[?#]/)[0];
  const snippets = [
    ["Interactive map", `${base}?embed=map&layer=alien_richness`, 520],
    ["Cumulative discoveries", `${base}?embed=cumulative`, 420],
    ["Rate of establishment", `${base}?embed=annual`, 420],
    ["Headline indicators", `${base}?embed=indicators`, 220],
  ];
  document.getElementById("embed-snippets").innerHTML = snippets.map(([title, url, h]) => `
    <div class="snippet">
      <div class="snippet-head"><span>${title}</span><a href="${url}" target="_blank" rel="noopener">open</a></div>
      <pre><code>${`<iframe src="${url}"\n        width="100%" height="${h}" style="border:0" loading="lazy"\n        title="${title}"></iframe>`.replace(/</g, "&lt;")}</code></pre>
    </div>`).join("");
}

function initMap(coarse) {
  const layerSelect = document.getElementById("layer-select");
  const basemapSelect = document.getElementById("basemap-select");
  const opacity = document.getElementById("opacity");
  const legend = document.getElementById("legend");
  const help = document.getElementById("layer-help");

  layerSelect.innerHTML = Object.entries(LAYERS).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join("");
  basemapSelect.innerHTML = Object.entries(BASEMAPS).map(([k, b]) => `<option value="${k}">${b.label}</option>`).join("");

  const layer = params.get("layer") in LAYERS ? params.get("layer") : "alien_richness";
  const basemap = params.get("basemap") in BASEMAPS ? params.get("basemap") : "light";
  layerSelect.value = layer;
  basemapSelect.value = basemap;
  help.textContent = LAYERS[layer].help;

  const map = new GridMap(document.getElementById("map"), {
    coarse,
    loadFine: () => getJson("grid_1km.json"),
    layer,
    basemap,
    cooperativeGestures: !embed,
    hash: true,
    onResolution: (info) => renderLegend(legend, info),
  });

  layerSelect.addEventListener("change", () => {
    map.setLayer(layerSelect.value);
    help.textContent = LAYERS[layerSelect.value].help;
  });
  basemapSelect.addEventListener("change", () => map.setBasemap(basemapSelect.value));
  opacity.addEventListener("input", () => map.setOpacity(Number(opacity.value)));
  return map;
}

function applyEmbed() {
  if (!embed) return;
  const target = document.querySelector(`[data-embed~="${embed}"]`);
  if (!target) return;
  document.body.classList.add("embed");
  target.classList.add("embed-target");
  // Hide everything that is not the target or one of its ancestors.
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (sib !== el && !["SCRIPT", "LINK", "STYLE"].includes(sib.tagName)) sib.classList.add("embed-hidden");
    }
  }
}

function showError(message) {
  const el = document.getElementById("load-error");
  el.hidden = false;
  el.textContent = el.textContent ? `${el.textContent} ${message}` : message;
}

/** Run one component; a failure is reported but does not stop the others. */
async function component(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(name, err);
    showError(`The ${name} could not be shown (${err.message}).`);
  }
}

async function main() {
  applyEmbed();
  let summary, ts;
  try {
    [summary, ts] = await Promise.all([getJson("summary.json"), getJson("timeseries.json")]);
  } catch (err) {
    console.error(err);
    showError(`The data could not be loaded (${err.message}). Serve the site over HTTP, ` +
      `e.g. "python -m http.server" in the site folder.`);
    return;
  }
  setText("[data-region]", summary.region);
  setText("[data-window]", `${summary.window[0]}–${summary.window[1]}`);
  document.title = `Alien species establishment · ${summary.region}`;

  const show = (name) => !embed || embed === name;
  await component("indicators", () => renderIndicators(summary, ts));
  await component("data sources", () => renderSources(summary));
  await component("embed examples", () => renderEmbedSnippets());
  if (show("cumulative")) await component("cumulative chart", () => plotCumulative(document.getElementById("chart-cumulative"), ts));
  if (show("annual")) await component("annual chart", () => plotAnnual(document.getElementById("chart-annual"), ts));
  if (show("effort")) await component("sampling effort chart", () => plotEffort(document.getElementById("chart-effort"), ts));
  if (show("map")) await component("map", async () => initMap(await getJson("grid_10km.json")));
  if (show("species")) await component("species table", async () => new SpeciesTable(document.getElementById("species"), await getJson("species.json")));
}

main();
