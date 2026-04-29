# Repository Rules

This repository is for Sintra and mapping applications only.

- Never deploy anything from this repository to `verrio.co` or `www.verrio.co`.
- All public apps from this repository must target `maps.verrio.co` or a clearly documented child route or subdomain beneath it.
- Never modify Cloudflare DNS records for the root Verrio website unless the user explicitly says so.
- Never modify the main website repository.
- Never change `CNAME`, root deployment files, or root-domain publishing settings without explicit instruction.
- Each app must live in `/apps/{app-name}`.
- Each app must have its own `index.html` or build output.
- Each app must have a documented public URL.
- Any deployment change must update `/deployments/dns-map.md`.
- Any Cloudflare setting change must update `/deployments/cloudflare-pages.md`.
- Any GitHub setting change must update `/deployments/github.md`.

# Deployment Model

- Preferred model: Option A, with `maps.verrio.co` as the index and route-based apps beneath it.
- Default public routes:
  - `https://maps.verrio.co/addressreview/`
  - `https://maps.verrio.co/azenhas/`
  - `https://maps.verrio.co/sintratotal/`
- `https://maps.verrio.co/` must remain intentionally blank and must not advertise any apps.
- `/app/` is legacy-only and must remain a redirect shim to `/addressreview/`.
- Do not link to `/app/`, deploy new assets to `/app/`, or treat `/app/` as a supported public route.
- Treat `/azenhas` and `/sintratotal` as active runtime paths until each app is fully migrated into `/apps`.

# Forbidden Targets

- `verrio.co`
- `www.verrio.co`
- the `verrio` Git remote
- any Cloudflare zone or DNS record intended for the main public website

# Deployment Safety Checklist

Before deployment:

- Confirm the app name.
- Confirm the target URL.
- Confirm the output directory.
- Confirm no files related to `verrio.co` or `www.verrio.co` are changed.
- Confirm `/deployments/dns-map.md` is updated.
- Run a local smoke test.
- Commit with a clear message.
