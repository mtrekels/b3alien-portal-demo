"""
Build the data files of the GBF Target 6 demonstration portal.

Runs the b3alien workflow (GBIF occurrence cube on the EEA grid + GRIIS checklist
in ColDP format) and exports compact JSON files that the static web page reads.
The web page does not need Python, a database or a map server: the EEA cell
codes are enough to draw the grid in the browser.

Example
-------
python pipeline/build_data.py \
    --cube PT_cube_mainland_new.zip \
    --checklist GRIIS_PT_ColDP_extended.zip \
    --region "Mainland Portugal" \
    --cube-doi 10.15468/dl.nuv5kq
"""

import argparse
import ast
import json
import math
from datetime import date
from importlib.metadata import version
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from b3alien import b3cube, griis, simulation, utils

ROOT = Path(__file__).resolve().parents[1]

FIELDS = ["alien_richness", "alien_occurrences", "richness", "occurrences", "observers"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _round(values, ndigits=3):
    """Round floats for compact JSON; NaN/inf become None."""
    out = []
    for v in np.asarray(values, dtype=float):
        out.append(None if not math.isfinite(v) else round(float(v), ndigits))
    return out


def _write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.2f} MB)")


def _gbif_download_metadata(doi):
    """Citation and license of a GBIF download (looked up by DOI)."""
    if not doi:
        return {}
    try:
        r = requests.get(f"https://api.gbif.org/v1/occurrence/download/{doi}", timeout=30)
        r.raise_for_status()
        meta = r.json()
    except Exception as e:  # offline: keep the DOI only
        print(f"  could not fetch GBIF download metadata: {e}")
        return {"doi": doi}
    created = pd.Timestamp(meta.get("created")).strftime("%-d %B %Y") if meta.get("created") else ""
    license_url = meta.get("license", "")
    license_name = {
        "http://creativecommons.org/licenses/by-nc/4.0/legalcode": "CC BY-NC 4.0",
        "http://creativecommons.org/licenses/by/4.0/legalcode": "CC BY 4.0",
        "http://creativecommons.org/publicdomain/zero/1.0/legalcode": "CC0 1.0",
    }.get(license_url, license_url)
    return {
        "doi": doi,
        "citation": f"GBIF.org ({created}) GBIF Occurrence Download https://doi.org/{doi}",
        "license": license_name,
        "license_url": license_url.replace("/legalcode", ""),
        "records": meta.get("totalRecords"),
    }


def _checklist_metadata(coldp_zip):
    """Title, DOI and version of a ColDP checklist (from metadata.yaml)."""
    import zipfile
    import yaml

    meta = {}
    try:
        with zipfile.ZipFile(coldp_zip) as zf:
            name = next(n for n in zf.namelist() if n.endswith("metadata.yaml"))
            meta = yaml.safe_load(zf.read(name)) or {}
    except Exception as e:
        print(f"  could not read checklist metadata: {e}")
    doi = meta.get("doi")
    title = meta.get("title", "GRIIS checklist")
    issued = meta.get("issued") or meta.get("version")
    creators = [
        f"{c.get('family', '')} {c.get('given', '')[:1]}.".strip()
        for c in meta.get("creator", []) or [] if c.get("family")
    ]
    authors = ", ".join(creators[:3]) + (" et al." if len(creators) > 3 else "")
    citation = f"{authors} ({str(issued)[:4]}). {title}. Version {issued}." if authors else f"{title}."
    if doi:
        citation += f" https://doi.org/{doi}"
    return {"title": title, "doi": doi, "version": str(issued) if issued else None,
            "citation": citation, "license": meta.get("license")}


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

def load_checklist(coldp, match_dir, rematch):
    print("1/5 Checklist")
    if rematch or not (match_dir / "merged_distr.txt").exists():
        griis.do_taxon_matching(str(coldp), output_dir=str(match_dir))
    else:
        print(f"  using cached matching in {match_dir}")
    cl = griis.CheckList(str(match_dir))
    merged = pd.read_csv(match_dir / "merged_distr.txt", sep="\t", dtype={"id": str})
    profile = pd.read_csv(match_dir / "speciesprofile.txt", sep="\t", dtype={"id": str})
    return cl, merged, profile


def grid_layers(cube, alien_keys):
    """Per-cell statistics on the native 1 km grid and aggregated to 10 km."""
    print("3/5 Grid layers")
    df = cube.df
    cell = df["cellcode"].cat.codes.to_numpy().astype(np.int64)
    sp = df["specieskey"].cat.codes.to_numpy().astype(np.int64)
    occ = df["occurrences"].to_numpy(dtype=float)
    obs = df["distinctobservers"].to_numpy(dtype=float) if "distinctobservers" in df else np.zeros_like(occ)
    n_sp = len(df["specieskey"].cat.categories)

    species_cats = df["specieskey"].cat.categories
    is_alien_cat = np.asarray(pd.Index(species_cats).astype(str).isin([str(k) for k in alien_keys]))
    alien = is_alien_cat[sp]

    parsed = utils.parse_eea_cellcode(pd.Series(df["cellcode"].cat.categories))
    res = int(parsed["resolution"].iloc[0])
    if (parsed["resolution"] != res).any():
        raise ValueError("Mixed grid resolutions are not supported.")
    x = parsed["x"].to_numpy()
    y = parsed["y"].to_numpy()

    layers = {}
    for target in sorted({res, max(res, 10000)}):
        e = x // target
        n = y // target
        keys = e * 10_000_000 + n
        uniq, idx_of_cat = np.unique(keys, return_inverse=True)
        tcell = idx_of_cat[cell]
        n_cells = len(uniq)

        def nunique(mask):
            pairs = np.unique(tcell[mask] * n_sp + sp[mask])
            return np.bincount(pairs // n_sp, minlength=n_cells)

        stats = {
            "alien_richness": nunique(alien),
            "alien_occurrences": np.bincount(tcell[alien], weights=occ[alien], minlength=n_cells),
            "richness": nunique(np.ones_like(alien)),
            "occurrences": np.bincount(tcell, weights=occ, minlength=n_cells),
            "observers": np.bincount(tcell, weights=obs, minlength=n_cells),
        }
        rows = np.column_stack([uniq // 10_000_000, uniq % 10_000_000] +
                               [stats[f] for f in FIELDS]).astype(np.int64)
        label = f"{target // 1000}km" if target >= 1000 else f"{target}m"
        layers[label] = {
            "resolution": int(target),
            "crs": utils.EEA_CRS,
            "description": "Cell lower-left corner = (e, n) x resolution metres in EPSG:3035 "
                           f"(EEA cell code '{label}E{{e}}N{{n}}').",
            "fields": ["e", "n"] + FIELDS,
            "max": {f: int(stats[f].max()) for f in FIELDS},
            "rows": rows.tolist(),
        }
        print(f"  {label}: {n_cells:,} cells")
    return layers


def time_series(cube, cl, start, end, n_boot):
    print("4/5 Rate of establishment (Solow-Costello + bootstrap)")
    d_s, d_c = b3cube.cumulative_species(cube, cl.species)
    years_all, rate_all = b3cube.calculate_rate(d_c)
    df = pd.DataFrame({"year": years_all, "rate": rate_all})
    years, rate = b3cube.filter_time_window(df, start, end)

    C1, vec1 = simulation.simulate_solow_costello_scipy(years, rate)
    boot = simulation.parallel_bootstrap_solow_costello(years, rate, n_iterations=n_boot)
    curves = boot["c1_all"]                       # cumulative fitted curves (B, T)
    annual = np.diff(curves, axis=1, prepend=0)   # fitted annual numbers

    print("  survey effort")
    observers = b3cube.get_survey_effort(cube, calc_type="distinct")
    observers["year"] = observers["date"].dt.year
    totals = b3cube.get_survey_effort(cube, calc_type="total")
    totals = totals.groupby(totals["time"].dt.year)["total_occurrences"].sum()
    effort = observers.set_index("year")[["distinct_observers"]].join(totals.rename("occurrences"), how="outer")
    effort = effort[(effort.index >= 1900)].fillna(0)

    beta1 = float(vec1[1])
    ts = {
        "window": [int(start), int(end)],
        "years": [int(v) for v in years],
        "discoveries": _round(rate, 0),
        "cumulative": _round(np.cumsum(rate), 0),
        "fit": {
            "cumulative": _round(np.cumsum(C1), 2),
            "annual": _round(C1, 3),
            "beta1": round(beta1, 5),
        },
        "bootstrap": {
            "iterations": int(len(curves)),
            "beta1_ci": _round(boot["beta1_ci"], 5),
            "cumulative": {"mean": _round(boot["c1_mean"], 2), "lower": _round(boot["c1_lower"], 2),
                           "upper": _round(boot["c1_upper"], 2)},
            "annual": {"mean": _round(annual.mean(axis=0), 3),
                       "lower": _round(np.percentile(annual, 2.5, axis=0), 3),
                       "upper": _round(np.percentile(annual, 97.5, axis=0), 3)},
        },
        "all_years": {"years": [int(v) for v in years_all], "discoveries": _round(rate_all, 0)},
        "effort": {"years": [int(v) for v in effort.index],
                   "distinct_observers": _round(effort["distinct_observers"], 0),
                   "occurrences": _round(effort["occurrences"], 0)},
    }
    return ts, d_s


def species_table(cl, merged, profile, d_s, cube):
    print("5/5 Species table")
    prof = profile.set_index("id")
    rows = {}
    for _, r in merged.iterrows():
        keys = r["speciesKey"]
        key = None
        if isinstance(keys, str) and keys.startswith("["):
            parsed = ast.literal_eval(keys)  # list literal written by b3alien
            key = None if parsed == ["Uncertain"] else str(parsed[0])
        name = r.get("scientificName")
        p = prof.loc[r["id"]] if r["id"] in prof.index else None
        invasive = bool(p is not None and p["isInvasive"] == "Invasive")
        habitat = None if p is None or pd.isna(p["habitat"]) else p["habitat"]
        rk = key or f"unmatched:{r['id']}"
        if rk in rows:  # e.g. several subspecies of one species
            rows[rk]["invasive"] |= invasive
            continue
        rows[rk] = {"name": name, "authorship": None if pd.isna(r.get("authorship")) else r.get("authorship"),
                    "kingdom": None if pd.isna(r.get("kingdom")) else r.get("kingdom"),
                    "key": key, "matched": key is not None, "invasive": invasive, "habitat": habitat}

    d = d_s.copy()
    d["species"] = d["species"].astype(str)
    d["year"] = d["time"].astype(str).str[:4].astype(int)
    stats = d.groupby("species").agg(first_year=("year", "min"), cells=("cell", "nunique"),
                                     occurrences=("occurrences", "sum"))
    out = []
    for r in rows.values():
        s = stats.loc[r["key"]] if r["key"] in stats.index else None
        r["observed"] = s is not None
        r["first_year"] = int(s["first_year"]) if s is not None else None
        r["cells"] = int(s["cells"]) if s is not None else 0
        r["occurrences"] = int(s["occurrences"]) if s is not None else 0
        out.append(r)
    out.sort(key=lambda r: (not r["observed"], r["name"] or ""))
    print(f"  {len(out)} taxa, {sum(r['observed'] for r in out)} observed in the cube")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cube", required=True, help="GBIF cube download on the EEA grid (csv or zip)")
    ap.add_argument("--checklist", required=True, help="GRIIS checklist in ColDP format (zip)")
    ap.add_argument("--region", default="Mainland Portugal")
    ap.add_argument("--cube-doi", default=None, help="DOI of the GBIF download, for the citation")
    ap.add_argument("--start", type=int, default=1970)
    ap.add_argument("--end", type=int, default=2022)
    ap.add_argument("--bootstrap", type=int, default=200)
    ap.add_argument("--out", default=str(ROOT / "site" / "data"))
    ap.add_argument("--work", default=str(ROOT / "pipeline" / "work"), help="cache for the taxon matching")
    ap.add_argument("--rematch", action="store_true", help="redo the taxon matching (GBIF API)")
    args = ap.parse_args()

    out = Path(args.out)
    match_dir = Path(args.work) / "checklist_matched"

    cl, merged, profile = load_checklist(args.checklist, match_dir, args.rematch)

    print("2/5 Occurrence cube")
    cube = b3cube.OccurrenceCube(args.cube, source="gbif")
    if cube.grid_type != "eea":
        raise SystemExit("This portal expects a cube on the EEA reference grid.")
    months = sorted(cube.df["yearmonth"].cat.categories.astype(str))
    print(f"  {len(cube.df):,} records, {cube.data.shape[1]:,} cells, {cube.data.shape[2]:,} species")

    layers = grid_layers(cube, cl.species)
    ts, d_s = time_series(cube, cl, args.start, args.end, args.bootstrap)
    species = species_table(cl, merged, profile, d_s, cube)

    observed = [s for s in species if s["observed"]]
    beta1 = ts["fit"]["beta1"]
    summary = {
        "region": args.region,
        "generated": date.today().isoformat(),
        "b3alien_version": version("b3alien"),
        "window": ts["window"],
        "checklist": {
            "records": int(len(merged)),
            "species": sum(s["matched"] for s in species),
            "unmatched": sum(not s["matched"] for s in species),
            "observed": len(observed),
            "invasive_observed": sum(s["invasive"] for s in observed),
        },
        "cube": {
            "records": int(len(cube.df)),
            "cells": int(cube.data.shape[1]),
            "species": int(cube.data.shape[2]),
            "grid": "EEA reference grid",
            "resolution_m": layers[min(layers, key=lambda k: layers[k]["resolution"])]["resolution"],
            "period": [months[0], months[-1]],
        },
        "indicator": {
            "discoveries_in_window": int(sum(v or 0 for v in ts["discoveries"])),
            "beta1": beta1,
            "beta1_ci": ts["bootstrap"]["beta1_ci"],
            "annual_change_pct": round((math.exp(beta1) - 1) * 100, 2),
            "annual_change_pct_ci": [round((math.exp(b) - 1) * 100, 2) for b in ts["bootstrap"]["beta1_ci"]],
            "fitted_rate_last_year": ts["bootstrap"]["annual"]["mean"][-1],
        },
        "sources": {
            "cube": _gbif_download_metadata(args.cube_doi),
            "checklist": _checklist_metadata(args.checklist),
            "backbone": "Catalogue of Life eXtended Release (GBIF taxonomic backbone)",
        },
    }

    print("Writing data files")
    _write_json(out / "summary.json", summary)
    _write_json(out / "timeseries.json", ts)
    _write_json(out / "species.json", species)
    for label, layer in layers.items():
        _write_json(out / f"grid_{label}.json", layer)


if __name__ == "__main__":
    main()
