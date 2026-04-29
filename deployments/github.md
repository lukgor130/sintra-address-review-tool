# GitHub Runbook

## Repository

- Repository name: `lukgor130/sintra-address-review-tool`
- Default branch: `main`
- Main website repository remote present locally: `verrio`
- Rule: do not push mapping changes to the `verrio` remote

## Deployment Branches

- Confirm protected deployment branches in GitHub before the next production push
- Until verified, assume `main` is the only deployment candidate for this repository

## GitHub Pages

- GitHub Pages should be treated as unused for the target state of this repository
- Legacy GitHub Pages artifacts were preserved under `/archive/old-output/`
- Do not re-enable or reconfigure GitHub Pages without explicit instruction

## Push Workflow

- Make changes on a feature branch when possible
- Push to `origin`
- Open a pull request for any deployment-affecting change unless the user explicitly asks for a direct push
- Keep deployment documentation in the same branch and PR as the code change

## Pull Requests

- PRs should clearly state the target app and target public URL
- PRs that alter deployment behavior must mention updates to:
  - `/deployments/dns-map.md`
  - `/deployments/cloudflare-pages.md`
  - `/deployments/github.md`
- Do not merge deployment changes that touch `verrio.co` or `www.verrio.co` settings from this repo
