#!/usr/bin/env python3

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


DEFAULT_REPO = "lukgor130/sintra-address-review-tool"
DEFAULT_DOMAIN = "https://maps.verrio.co"
ROOT_SENTINELS = ["url=/azenhas/", "url=/sintratotal/", "Open the Azenhas map", "Open Sintra Total"]
SINTRATOTAL_SENTINELS = ["Sintra Total Explorer", "Cached source explorer"]
AZENHAS_SENTINELS = ["Sintra Local Knowledge Map", "Local Knowledge Review"]


def run_git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def fetch_text(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def latest_build(repo: str) -> dict:
    output = subprocess.run(
        [
            "gh",
            "api",
            f"repos/{repo}/pages/builds/latest",
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ).stdout
    return json.loads(output)


def text_has_any(text: str, sentinels: list[str]) -> bool:
    return any(sentinel in text for sentinel in sentinels)


def check_urls(domain: str) -> dict[str, str]:
    urls = {
        "root": domain.rstrip("/") + "/",
        "sintratotal": domain.rstrip("/") + "/sintratotal/",
        "azenhas": domain.rstrip("/") + "/azenhas/",
    }
    return {name: fetch_text(url) for name, url in urls.items()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Wait for the Pages build to match HEAD and verify the live HTML."
    )
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--domain", default=DEFAULT_DOMAIN)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--interval", type=int, default=20)
    args = parser.parse_args()

    head_sha = run_git("rev-parse", "HEAD")
    deadline = time.time() + args.timeout

    print(f"Waiting for GitHub Pages to serve {head_sha[:7]} at {args.domain} ...")

    while time.time() < deadline:
        build = latest_build(args.repo)
        build_commit = build.get("commit", "")
        status = build.get("status", "")
        print(f"Pages build status: {status} ({build_commit[:7] if build_commit else 'unknown'})")
        if build_commit.startswith(head_sha[:7]) and status == "built":
            break
        time.sleep(args.interval)
    else:
        print("Timed out waiting for GitHub Pages build to finish.", file=sys.stderr)
        return 1

    while time.time() < deadline:
        pages = check_urls(args.domain)
        root = pages["root"]
        sintratotal = pages["sintratotal"]
        azenhas = pages["azenhas"]
        root_ok = not text_has_any(root, ROOT_SENTINELS)
        sintratotal_ok = text_has_any(sintratotal, SINTRATOTAL_SENTINELS)
        azenhas_ok = text_has_any(azenhas, AZENHAS_SENTINELS)
        print(
            "Live checks:",
            {
                "root_ok": root_ok,
                "sintratotal_ok": sintratotal_ok,
                "azenhas_ok": azenhas_ok,
            },
        )
        if root_ok and sintratotal_ok and azenhas_ok:
            print("Live deployment matches the expected routes.")
            return 0
        time.sleep(args.interval)

    print("Timed out waiting for the live domain to reflect the current commit.", file=sys.stderr)
    print("Root should be blank, and /sintratotal/ and /azenhas/ should render their pages.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
