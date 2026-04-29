# Cloudflare Pages Runbook

## Project

- Serving target for `maps.verrio.co`: `verrio-maps`
- Prepared model in this repository: one Cloudflare Pages project serving `maps.verrio.co`
- Routing model: Option A, route-based apps under a single host

## Public Routes

- `https://maps.verrio.co/`
- `https://maps.verrio.co/addressreview/`
- `https://maps.verrio.co/azenhas/`
- `https://maps.verrio.co/sintratotal/`

The root path `/` is intentionally blank and should not be turned into a public landing page.
The legacy `/app/` path should remain a compatibility redirect only and must not be treated as a primary route.

## Build And Output

- Build command: `python3 scripts/build_deploy_bundle.py`
- Output directory: `deploy-root`
- Functions directory: `/functions`
- Wrangler config: `/wrangler.jsonc`

## Environment And Bindings

- Required for shared AOI notes API: D1 binding named `AOI_DB`
- Local Cloudflare helper variables live in `.env.cloudflare.local`
- Do not commit secrets or dashboard-only IDs into tracked files unless explicitly intended

## Safe DNS Edits

- Only the `maps.verrio.co` record, and only after the user explicitly requests a DNS change
- Child records beneath the maps namespace, such as `*.maps.verrio.co`, only when they are documented in `/deployments/dns-map.md`

## Forbidden DNS Edits

- `verrio.co`
- `www.verrio.co`
- apex/root website records
- any DNS record used by the main marketing or landing site

## Deployment Notes

- This repository previously carried GitHub Pages-oriented artifacts. They are now treated as legacy references only.
- Do not change DNS as part of routine code deployment.
- Do not deploy the raw repo root because it contains oversized local cache files that exceed Worker asset limits.
- After any Cloudflare configuration change, update this file and `/deployments/dns-map.md` in the same commit.
