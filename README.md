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

## Cache The Source Layers

Use the cache mode to pull the full source layers locally before doing spatial
indexing or model work:

- all `Livre` and `Expectante` parcels
- the full `Nº policia` address layer
- the full `Ruas` road layer
- the `Limites Regulamentares` sublayers

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 extract_sample.py --cache-source-layers
```

By default this writes to `app/data/source-cache/` with a manifest and one JSON
file per source layer. Use `--cache-dir` to point the cache somewhere else.

## Explore The Cache

Open the lightweight source explorer to browse the cached parcel and
regulatory layers, toggle them on and off, and inspect raw feature attributes:

- `http://127.0.0.1:8011/source-explorer.html`
- `http://127.0.0.1:8011/sintratotal/`

## Build An AOI Review Pack

The local-knowledge mode accepts a zipped shapefile AOI and generates a fully
local map pack:

- parcel geometry and local-review metadata
- a clipped local Protomaps basemap in `PMTiles`
- a local satellite tile cache with labels for a second basemap mode
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
- `satellite-style.json`
- `satellite/`
- `aoi.geojson`
- `parcels.geojson`
- `assets/fonts/`
- `assets/sprites/`

The satellite mode is built from public imagery tiles at pack-generation time
and then served locally from static files, so the deployed page has no runtime
imagery dependency.

## Shared AOI Notes

The AOI viewer now keeps parcel notes and tags in a shared Cloudflare D1
database, while the browser still keeps a local draft cache for fast editing and
offline recovery.

What lives where:

- GitHub Pages keeps the static AOI pack: manifest, parcel geometry, basemap,
  labels, and satellite tiles.
- Cloudflare Pages Functions serve the AOI notes API from `/api/aoi`.
- D1 stores the mutable overlay: one shared default session per AOI pack, plus
  optional private session links.

To enable it in Cloudflare Pages:

1. Create a D1 database.
2. Bind it to the Pages project as `AOI_DB`.
3. Apply [`cloudflare/aoi-notes-schema.sql`](cloudflare/aoi-notes-schema.sql).
4. Redeploy the Pages project so `/api/aoi` is available alongside the map.

The viewer will fall back to the local browser draft if the API is unavailable,
but shared edits only appear once the D1-backed API is live.

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

## Verify Deployment

After pushing changes to GitHub Pages, use the live checker to confirm the
custom domain has actually picked up the new commit:

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 scripts/check_pages_live.py
```

The check waits for the GitHub Pages build to finish and then verifies:

- the root domain stays blank
- `/sintratotal/` serves the Sintra Total explorer
- `/azenhas/` serves the Azenhas map

## Cloudflare Control

Keep the Cloudflare credentials in the ignored local file:

- `.env.cloudflare.local`

Use the helper to verify the token and update the `maps.verrio.co` DNS record
from the terminal:

```bash
python3 scripts/cloudflare.py verify
python3 scripts/cloudflare.py point-pages
```

The DNS record should stay pointed at `lukgor130.github.io` with Cloudflare
proxying turned on so Cloudflare terminates TLS at the edge and keeps
`maps.verrio.co` on a valid certificate.

If you are using Cloudflare Pages for the map site, also make sure the Pages
project has the D1 binding (`AOI_DB`) configured so the shared AOI notes API
can read and write the session records.

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
- `cloudflare/aoi-notes-schema.sql`
- `functions/api/aoi.js`
- `scripts/build_aoi_pack.py`
- `scripts/serve_app.py`
- `output/playwright/`
