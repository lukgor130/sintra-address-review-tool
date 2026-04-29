#!/usr/bin/env python3

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path


DEFAULT_ENV_FILE = Path(".env.cloudflare.local")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"Missing required environment variable: {name}", file=sys.stderr)
        raise SystemExit(1)
    return value


def request_json(url: str, method: str = "GET", data: dict | None = None) -> dict:
    headers = {
        "Authorization": f"Bearer {require('CF_API_TOKEN')}",
        "Content-Type": "application/json",
    }
    body = None if data is None else json.dumps(data).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{error.code} {error.reason}: {body}") from error


def verify_token_user() -> dict:
    return request_json("https://api.cloudflare.com/client/v4/user/tokens/verify")


def verify_token() -> int:
    account_id = os.environ.get("CF_ACCOUNT_ID")
    payload = None
    if account_id:
        try:
            payload = request_json(
                f"https://api.cloudflare.com/client/v4/accounts/{account_id}/tokens/verify"
            )
        except RuntimeError:
            payload = None
    if payload is None:
        payload = verify_token_user()
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload.get("success") else 1


def resolve_zone_id() -> str:
    zone_id = os.environ.get("CF_ZONE_ID")
    if zone_id:
        return zone_id

    zone_name = os.environ.get("CF_ZONE_NAME") or os.environ.get("CF_DOMAIN")
    if not zone_name:
        print("Missing required environment variable: CF_ZONE_NAME or CF_ZONE_ID", file=sys.stderr)
        raise SystemExit(1)

    query = urllib.parse.urlencode({"name": zone_name})
    payload = request_json(f"https://api.cloudflare.com/client/v4/zones?{query}")
    results = payload.get("result") or []
    if not results:
        print(f"No Cloudflare zone found for {zone_name!r}", file=sys.stderr)
        raise SystemExit(1)
    return results[0]["id"]


def purge_cache(urls: list[str]) -> int:
    zone_id = resolve_zone_id()
    domain = os.environ.get("CF_DOMAIN", "maps.verrio.co").rstrip("/")
    files = urls or [
        f"https://{domain}/",
        f"https://{domain}/sintratotal/",
        f"https://{domain}/azenhas/",
    ]
    payload = request_json(
        f"https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache",
        method="POST",
        data={"files": files},
    )
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload.get("success") else 1


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def set_dns_target(target: str, proxied: bool) -> int:
    zone_id = resolve_zone_id()
    domain = require("CF_DOMAIN").rstrip(".")
    query = urllib.parse.urlencode({"name": domain})
    payload = request_json(
        f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?{query}"
    )
    results = payload.get("result") or []
    if not results:
        print(f"No DNS record found for {domain!r}", file=sys.stderr)
        return 1

    record = results[0]
    updated = request_json(
        f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record['id']}",
        method="PATCH",
        data={
            "type": "CNAME",
            "name": domain,
            "content": target,
            "proxied": proxied,
            "ttl": 1,
        },
    )
    print(json.dumps(updated, indent=2, sort_keys=True))
    return 0 if updated.get("success") else 1


def main() -> int:
    load_env_file(DEFAULT_ENV_FILE)

    parser = argparse.ArgumentParser(description="Cloudflare helper for this project.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("verify", help="Verify the Cloudflare API token.")
    purge_parser = subparsers.add_parser("purge", help="Purge cached URLs.")
    purge_parser.add_argument("urls", nargs="*", help="Optional URLs to purge explicitly.")
    point_parser = subparsers.add_parser(
        "point-pages",
        help="Point the project subdomain at a GitHub Pages host.",
    )
    point_parser.add_argument(
        "--target",
        default=os.environ.get("CF_PAGES_TARGET", "lukgor130.github.io"),
        help="GitHub Pages host to point the CNAME at.",
    )
    point_parser.add_argument(
        "--proxied",
        action=argparse.BooleanOptionalAction,
        default=env_bool("CF_PROXIED", True),
        help="Whether Cloudflare should proxy the CNAME and terminate TLS at the edge.",
    )

    args = parser.parse_args()

    if args.command == "verify":
        return verify_token()
    if args.command == "purge":
        return purge_cache(args.urls)
    if args.command == "point-pages":
        return set_dns_target(args.target, args.proxied)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
