#!/usr/bin/env python3

from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "deploy-root"


def reset_output() -> None:
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True, exist_ok=True)


def copy_file(relative_path: str) -> None:
    source = ROOT / relative_path
    destination = OUTPUT / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def copy_tree(relative_path: str) -> None:
    source = ROOT / relative_path
    destination = OUTPUT / relative_path
    shutil.copytree(source, destination, dirs_exist_ok=True)


def write_public_source_cache() -> None:
    source_cache = ROOT / "addressreview" / "data" / "source-cache"
    output_cache = OUTPUT / "addressreview" / "data" / "source-cache"
    output_cache.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((source_cache / "manifest.json").read_text(encoding="utf-8"))
    datasets = manifest.get("datasets", {})
    public_manifest = {
        **manifest,
        "datasets": {
            "parcels": datasets["parcels"],
            "regulatoryLimits": datasets["regulatoryLimits"],
        },
    }
    (output_cache / "manifest.json").write_text(
        json.dumps(public_manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    shutil.copy2(
        source_cache / "parcels-livre-expectante.json",
        output_cache / "parcels-livre-expectante.json",
    )
    shutil.copytree(
        source_cache / "limites-regulamentares",
        output_cache / "limites-regulamentares",
        dirs_exist_ok=True,
    )


def build_addressreview() -> None:
    for relative_path in [
        "addressreview/index.html",
        "addressreview/aoi.html",
        "addressreview/aoi.css",
        "addressreview/aoi.js",
        "addressreview/app.js",
        "addressreview/source-explorer.html",
        "addressreview/source-explorer.css",
        "addressreview/source-explorer.js",
        "addressreview/data/sample.json",
        "addressreview/data/aoi-azenhas.json",
    ]:
        copy_file(relative_path)

    copy_tree("addressreview/vendor")
    copy_tree("addressreview/data/pack-azenhas")
    write_public_source_cache()


def main() -> None:
    reset_output()

    for file_path in ["index.html", "404.html", "robots.txt"]:
        copy_file(file_path)

    build_addressreview()
    copy_tree("azenhas")
    copy_tree("sintratotal")
    copy_tree("app")

    print(f"Wrote deployment bundle to {OUTPUT}")


if __name__ == "__main__":
    main()
