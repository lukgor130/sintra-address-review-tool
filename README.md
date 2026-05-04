# Sintra Address Review Tool

This repository is the deployment workspace for Sintra and map-related tools that must publish only under `maps.verrio.co`.

It must stay separate from the main `verrio.co` website.

## Non-Negotiable Boundaries

- Never deploy this repository to `verrio.co` or `www.verrio.co`
- Never update the main website repository from this workspace
- Never change DNS for the root/apex Verrio website from this repo workflow
- Prefer Cloudflare Pages or Workers over GitHub Pages
- Prefer Option A routing:
  - `https://maps.verrio.co/addressreview/`
  - `https://maps.verrio.co/azenhas/`
  - `https://maps.verrio.co/sintratotal/`
- `https://maps.verrio.co/` itself should stay blank and reveal no public information

## Current Audit

### Active App Runtime Folders

- `addressreview/`
  - Sintra address review app
  - shared explorer assets used by `sintratotal/`
  - source cache and AOI pack data
- `azenhas/`
  - local knowledge AOI app
  - self-contained data pack and vendor assets
- `sintratotal/`
  - cached source explorer
  - depends on shared explorer assets in `addressreview/`

### Deployment And Infra Files

- `wrangler.jsonc`
- `functions/api/aoi.js`
- `cloudflare/aoi-notes-schema.sql`
- `scripts/cloudflare.py`
- `scripts/serve_app.py`

### Data Generation And Test Files

- `extract_sample.py`
- `scripts/build_aoi_pack.py`
- `tests/test_extract_sample.py`

### Legacy Or Archived Material

- `archive/old-output/docs-github-pages-mirror/`
  - duplicated static site pages from the previous GitHub Pages-style layout
- `archive/old-output/playwright-screenshots/`
  - generated screenshots
- `archive/old-output/playwright-cli/`
  - generated Playwright CLI logs and snapshots

## Target Structure

The repository is being normalized toward this structure:

```text
/apps
  /addressreview
  /azenhas
  /sintratotal

/packages
  /shared-ui
  /shared-data

/deployments
  dns-map.md
  cloudflare-pages.md
  github.md

/archive
  /old-output
  /old-experiments

/scripts
/tests
AGENTS.md
README.md
wrangler.jsonc
```

For safety, the working runtime folders remain in place for now. New work should treat `/apps` as the canonical destination for migrated app sources, while `/deployments` is the source of truth for publishing rules.

`/app/` is now legacy-only. It exists solely as a redirect shim to `/addressreview/` and must not receive new code, assets, or public links.

## Local Run

Serve the repository root so route-based apps and Pages Functions-compatible paths are available together:

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 scripts/serve_app.py --dir . --port 8011
```

Useful local URLs:

- `http://127.0.0.1:8011/`
- `http://127.0.0.1:8011/addressreview/`
- `http://127.0.0.1:8011/addressreview/aoi.html`
- `http://127.0.0.1:8011/azenhas/`
- `http://127.0.0.1:8011/sintratotal/`

Use `scripts/serve_app.py` instead of `python -m http.server` because PMTiles support needs HTTP byte-range handling.

The root URL is intentionally blank. Only the documented child routes should expose app content.
The legacy `/app/` path should only be used to verify redirects during migration.

## Deployment Bundle

Do not publish the raw repository root directly from Cloudflare. This repo contains local cache files that are too large for Worker asset deployment and are not needed on the public routes.

Build the public deployment bundle with:

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 scripts/build_deploy_bundle.py
```

This writes the deployable site to `deploy-root/`, including:

- blank root `/`
- `addressreview/`
- `azenhas/`
- `sintratotal/`
- legacy `/app/` redirect shims
- Cloudflare Pages function bundle files for `/api/aoi`

The deployment bundle intentionally excludes oversized local cache files such as:

- `addressreview/data/source-cache/addresses-full.json`
- `addressreview/data/source-cache/roads-full.json`

## Data Workflows

Refresh the parcel sample:

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 extract_sample.py
```

Cache the full source layers:

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 extract_sample.py --cache-source-layers
```

By default this writes to `addressreview/data/source-cache/`.

Build an AOI pack:

```bash
cd "/Users/lukeg/Documents/Personal Projects/sintra-address-review-tool"
python3 -m venv .venv-aoi
. .venv-aoi/bin/activate
pip install pyshp pyproj
python3 scripts/build_aoi_pack.py \
  --aoi-zip "/Users/lukeg/Downloads/Azenhas AOI.zip" \
  --aoi-name "Azenhas do Mar" \
  --output-dir addressreview/data/pack-azenhas
```

## Deployment

Target deployment platform: Cloudflare Workers with Worker Assets and a D1-backed AOI notes API.

Working assumptions for this repo:

- one Cloudflare Pages project serves `maps.verrio.co`
- apps are exposed by route under that host
- `src/worker.js` serves static assets and routes `/api/aoi` to the AOI notes API
- `functions/api/aoi.js` stores the mutable parcel notes layer in D1
- the D1 binding name is `AOI_DB`
- the root route `/` remains intentionally blank
- Cloudflare deploys `deploy-root/`, not the raw repo root

Before deploying, `npx wrangler deploy --dry-run` must list both `env.ASSETS` and `env.AOI_DB`.
If `AOI_DB` is missing, the AOI app can render but shared notes will stay in browser fallback mode.

Before deployment:

1. Confirm the target app and public URL in `deployments/dns-map.md`
2. Confirm Cloudflare project details in `deployments/cloudflare-pages.md`
3. Confirm GitHub workflow rules in `deployments/github.md`
4. Run the local smoke test
5. Commit with a clear message

## What Must Never Be Touched

- DNS for `verrio.co`
- DNS for `www.verrio.co`
- the `verrio` Git remote
- the main website repository or landing page deployment
- `CNAME` or root-domain publishing behavior without explicit instruction
- any public landing page or app directory at `maps.verrio.co/`
- any new code or deployment target that treats `/app/` as a primary route

## Key Files

- `AGENTS.md`
- `deployments/dns-map.md`
- `deployments/cloudflare-pages.md`
- `deployments/github.md`
- `functions/api/aoi.js`
- `cloudflare/aoi-notes-schema.sql`
- `scripts/serve_app.py`
- `scripts/build_aoi_pack.py`
- `extract_sample.py`
