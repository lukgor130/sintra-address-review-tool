# Sintra Address Review Tool

Internal review tool for validating Sintra parcel-to-address candidate selection.

## Purpose

- Load a sample of Sintra `Áreas Livres e Expectantes` parcels.
- Compare candidate `Nº policia` addresses against the municipal basemap.
- Review/correct gold, silver, and blue tiers.
- Export JSON/CSV training data for the address-selection algorithm.
- Build a pre-cached AOI parcel map for local ownership and connection research.
- Run the AOI map from a fully local pack with no ArcGIS runtime dependency.

## Refresh Sample Data

The review page refreshes the municipal basemap token at startup. If the live
token endpoint is unavailable and the stored token has expired, regenerate the
sample before review.

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 extract_sample.py
```

## Build An AOI Review Pack

The local-knowledge mode accepts a zipped shapefile AOI and generates a fully
local map pack:

- parcel geometry and local-review metadata
- a clipped local Protomaps basemap in `PMTiles`
- local glyph and sprite assets for labels/icons
- a manifest the browser app can load directly

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 -m venv .venv-aoi
. .venv-aoi/bin/activate
pip install pyshp pyproj
python3 scripts/build_aoi_pack.py \
  --aoi-zip "/Users/lukeg/Downloads/Azenhas AOI.zip" \
  --aoi-name "Azenhas do Mar" \
  --output-dir app/data/pack-azenhas
```

This writes a local pack under `app/data/pack-azenhas/`, including:

- `manifest.json`
- `basemap.pmtiles`
- `style.json`
- `aoi.geojson`
- `parcels.geojson`
- `assets/fonts/`
- `assets/sprites/`

## Run Locally

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 scripts/serve_app.py --dir app --port 8011
```

Then open:

- http://127.0.0.1:8011
- http://127.0.0.1:8011/aoi.html

Use `scripts/serve_app.py` instead of `python -m http.server` because PMTiles
requires HTTP byte-range support.

## Main Files

- `extract_sample.py`
- `app/index.html`
- `app/aoi.html`
- `app/styles.css`
- `app/aoi.css`
- `app/app.js`
- `app/aoi.js`
- `app/vendor/`
- `app/data/sample.json`
- `app/data/pack-azenhas/`
- `scripts/build_aoi_pack.py`
- `scripts/serve_app.py`
- `output/playwright/`
