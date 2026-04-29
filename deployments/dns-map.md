# DNS And Publishing Map

Preferred publishing model: Option A, with `maps.verrio.co` as the index and route-based apps beneath it.

| App name | Local folder | Public URL | Cloudflare project | GitHub branch | Build command | Output directory | DNS record | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Blank root | `/` | `https://maps.verrio.co/` | `verrio-maps` | `main` | `python3 scripts/build_deploy_bundle.py` | `deploy-root` | `maps.verrio.co` only; do not edit until confirmed | Active | Root must stay intentionally blank and must not expose navigation, branding, or app discovery. |
| Address Review | `/addressreview` | `https://maps.verrio.co/addressreview/` | `verrio-maps` | `main` | `python3 scripts/build_deploy_bundle.py` | `deploy-root` | `maps.verrio.co` route only | Active | This is the only supported public route for the address review app. |
| Azenhas | `/azenhas` | `https://maps.verrio.co/azenhas/` | `verrio-maps` | `main` | `python3 scripts/build_deploy_bundle.py` | `deploy-root` | `maps.verrio.co` route only | Active legacy route | Working app preserved in place to avoid breaking the current deployment before a dedicated route migration. |
| Sintra Total | `/sintratotal` | `https://maps.verrio.co/sintratotal/` | `verrio-maps` | `main` | `python3 scripts/build_deploy_bundle.py` | `deploy-root` | `maps.verrio.co` route only | Active legacy route | Depends on shared explorer assets under `/addressreview`. |

# Notes

- Safe DNS scope for this repo is limited to `maps.verrio.co` and documented child routes or child subdomains beneath it.
- Do not edit `verrio.co`, `www.verrio.co`, or apex website records from this repository workflow.
- Legacy compatibility route: `/app/` redirects to `/addressreview/` and should not be published, linked, or documented as a primary app URL.
- Publish from `deploy-root/` so oversized local cache files are not shipped to Cloudflare.
- Update this file every time a public URL, output directory, branch rule, or Cloudflare target changes.
