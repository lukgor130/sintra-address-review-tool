#!/usr/bin/env python3

import argparse
import json
import math
import subprocess
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path

from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import extract_sample as sample


BUILD_METADATA_URL = "https://build-metadata.protomaps.dev/builds.json"
STYLE_TEMPLATE_URL = "https://npm-style.protomaps.dev/style.json"
FONT_STACKS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"]
FONT_RANGES = ["0-255", "256-511"]
SPRITE_FILES = ["light.json", "light.png", "light@2x.json", "light@2x.png"]
SATELLITE_TILE_URL = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
)
BROWSER_VENDOR = {
    "maplibre-gl.js": "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
    "maplibre-gl.css": "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
    "pmtiles.js": "https://unpkg.com/pmtiles@4.4.1/dist/pmtiles.js",
}
PROTOMAPS_ASSET_BASE = "https://raw.githubusercontent.com/protomaps/basemaps-assets/main"


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def fetch_json(url: str) -> dict | list:
    return json.loads(fetch_bytes(url))


def latest_build() -> dict:
    builds = sorted(fetch_json(BUILD_METADATA_URL), key=lambda item: item["key"], reverse=True)
    return builds[0]


def reproject_xy(transformer: Transformer, x: float, y: float) -> list[float]:
    lon, lat = transformer.transform(x, y)
    return [round(lon, 7), round(lat, 7)]


def reproject_rings(transformer: Transformer, rings: list[list[list[float]]]) -> list[list[list[float]]]:
    return [[reproject_xy(transformer, x, y) for x, y in ring] for ring in rings]


def build_parcels_geojson(payload: dict, transformer: Transformer) -> dict:
    features = []
    for parcel in payload["parcels"]:
        properties = {
            key: value
            for key, value in parcel.items()
            if key not in {"geometry", "centroid"}
        }
        properties["centroid"] = reproject_xy(
            transformer,
            parcel["centroid"]["x"],
            parcel["centroid"]["y"],
        )
        if properties.get("selectedAddress"):
            properties["selectedAddress"] = {
                **properties["selectedAddress"],
                "coordinates": reproject_xy(
                    transformer,
                    properties["selectedAddress"]["x"],
                    properties["selectedAddress"]["y"],
                ),
            }
        features.append(
            {
                "type": "Feature",
                "id": parcel["objectId"],
                "properties": properties,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": reproject_rings(transformer, parcel["geometry"]["rings"]),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_aoi_geojson(payload: dict, transformer: Transformer) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": payload["meta"]["aoiName"],
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": reproject_rings(
                        transformer, payload["meta"]["aoiGeometry"]["rings"]
                    ),
                },
            }
        ],
    }


def build_view(payload: dict, transformer: Transformer) -> dict:
    bbox = payload["meta"]["sampleBbox"]
    min_lon, min_lat = reproject_xy(transformer, bbox["xmin"], bbox["ymin"])
    max_lon, max_lat = reproject_xy(transformer, bbox["xmax"], bbox["ymax"])
    center = [(min_lon + max_lon) / 2, (min_lat + max_lat) / 2]
    return {
        "bbox": [min_lon, min_lat, max_lon, max_lat],
        "center": [round(center[0], 7), round(center[1], 7)],
        "zoom": 14,
    }


def rewrite_style(style: dict) -> dict:
    return {
        **style,
        "glyphs": "./assets/fonts/{fontstack}/{range}.pbf",
        "sprite": "./assets/sprites/v4/light",
        "sources": {
            **style["sources"],
            "protomaps": {
                "type": "vector",
                "url": "pmtiles://basemap.pmtiles",
                "attribution": style["sources"]["protomaps"].get(
                    "attribution",
                    '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap</a>',
                ),
            },
        },
    }


def build_satellite_style(street_style: dict, satellite: dict) -> dict:
    satellite_layers = [
        deepcopy(layer)
        for layer in street_style["layers"]
        if layer.get("type") in {"line", "symbol", "circle"}
    ]
    return {
        **deepcopy(street_style),
        "sources": {
            **deepcopy(street_style["sources"]),
            "satellite": {
                "type": "raster",
                "tiles": [satellite["tileTemplate"]],
                "tileSize": 256,
                "minzoom": satellite["minzoom"],
                "maxzoom": satellite["maxzoom"],
                "attribution": satellite["attribution"],
            },
        },
        "layers": [
            {
                "id": "satellite-basemap",
                "type": "raster",
                "source": "satellite",
            },
            *satellite_layers,
        ],
    }


def write_json(path: Path, payload: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def download_file(url: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(fetch_bytes(url))


def lon_to_tile_x(lon: float, zoom: int) -> int:
    scale = 1 << zoom
    x = int(math.floor((lon + 180.0) / 360.0 * scale))
    return max(0, min(scale - 1, x))


def lat_to_tile_y(lat: float, zoom: int) -> int:
    scale = 1 << zoom
    clamped = max(min(lat, 85.05112878), -85.05112878)
    lat_rad = math.radians(clamped)
    y = int(
        math.floor(
            (1.0 - math.log(math.tan(lat_rad) + (1.0 / math.cos(lat_rad))) / math.pi)
            / 2.0
            * scale
        )
    )
    return max(0, min(scale - 1, y))


def tile_range_for_bbox(bbox: list[float], zoom: int, pad: int = 1) -> tuple[int, int, int, int]:
    min_lon, min_lat, max_lon, max_lat = bbox
    min_x = max(0, lon_to_tile_x(min_lon, zoom) - pad)
    max_x = min((1 << zoom) - 1, lon_to_tile_x(max_lon, zoom) + pad)
    min_y = max(0, lat_to_tile_y(max_lat, zoom) - pad)
    max_y = min((1 << zoom) - 1, lat_to_tile_y(min_lat, zoom) + pad)
    return min_x, min_y, max_x, max_y


def download_satellite_tiles(
    output_dir: Path,
    bbox: list[float],
    minzoom: int,
    maxzoom: int,
    source_url: str,
    worker_count: int = 8,
) -> dict:
    tasks: list[tuple[int, int, int, Path, str]] = []
    for zoom in range(minzoom, maxzoom + 1):
        min_x, min_y, max_x, max_y = tile_range_for_bbox(bbox, zoom)
        for x in range(min_x, max_x + 1):
            for y in range(min_y, max_y + 1):
                tile_path = output_dir / "satellite" / str(zoom) / str(x) / f"{y}.jpg"
                tasks.append((zoom, x, y, tile_path, source_url.format(z=zoom, x=x, y=y)))

    def fetch_tile(task: tuple[int, int, int, Path, str]) -> None:
        _, _, _, tile_path, url = task
        if tile_path.exists():
            return
        tile_path.parent.mkdir(parents=True, exist_ok=True)
        tile_path.write_bytes(fetch_bytes(url))

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        list(executor.map(fetch_tile, tasks))

    return {
        "tileTemplate": "./satellite/{z}/{x}/{y}.jpg",
        "minzoom": minzoom,
        "maxzoom": maxzoom,
        "tileCount": len(tasks),
        "attribution": "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community.",
    }


def extract_basemap(build_key: str, bbox: list[float], output_path: Path, maxzoom: int) -> None:
    build_url = f"https://build.protomaps.com/{build_key}"
    subprocess.run(
        [
            str(Path.home() / "bin" / "pmtiles"),
            "extract",
            build_url,
            str(output_path),
            f"--bbox={','.join(str(value) for value in bbox)}",
            f"--maxzoom={maxzoom}",
        ],
        check=True,
    )


def download_pack_assets(output_dir: Path) -> None:
    for filename in SPRITE_FILES:
        download_file(
            f"{PROTOMAPS_ASSET_BASE}/sprites/v4/{urllib.parse.quote(filename)}",
            output_dir / "assets" / "sprites" / "v4" / filename,
        )

    for font_stack in FONT_STACKS:
        for font_range in FONT_RANGES:
            download_file(
                f"{PROTOMAPS_ASSET_BASE}/fonts/{urllib.parse.quote(font_stack)}/{font_range}.pbf",
                output_dir / "assets" / "fonts" / font_stack / f"{font_range}.pbf",
            )


def download_vendor_assets(vendor_dir: Path) -> None:
    for filename, url in BROWSER_VENDOR.items():
        download_file(url, vendor_dir / filename)


def pack_manifest(
    *,
    aoi_name: str,
    build: dict,
    style_version: str,
    view: dict,
    parcel_count: int,
    maxzoom: int,
    satellite: dict,
) -> dict:
    return {
        "name": aoi_name,
        "generatedAt": sample.time.strftime("%Y-%m-%dT%H:%M:%SZ", sample.time.gmtime()),
        "format": "sintra-aoi-pack-v1",
        "basemap": {
            "type": "pmtiles",
            "file": "./basemap.pmtiles",
            "buildKey": build["key"],
            "version": build["version"],
            "maxzoom": maxzoom,
        },
        "style": {
            "file": "./style.json",
            "glyphs": "./assets/fonts/{fontstack}/{range}.pbf",
            "sprite": "./assets/sprites/v4/light",
            "styleVersion": style_version,
        },
        "styles": {
            "street": {
                "file": "./style.json",
                "label": "Street",
            },
            "satellite": {
                "file": "./satellite-style.json",
                "label": "Satellite",
                "tileTemplate": satellite["tileTemplate"],
                "minzoom": satellite["minzoom"],
                "maxzoom": satellite["maxzoom"],
            },
        },
        "data": {
            "aoi": "./aoi.geojson",
            "parcels": "./parcels.geojson",
        },
        "view": view,
        "parcelCount": parcel_count,
        "attribution": "OpenStreetMap contributors via Protomaps basemap extract.",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a fully local AOI map pack.")
    parser.add_argument("--aoi-zip", required=True, help="Path to zipped AOI shapefile.")
    parser.add_argument("--aoi-name", required=True, help="Human-readable AOI name.")
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory where the offline map pack should be written.",
    )
    parser.add_argument(
        "--style-version",
        default="5.7.2",
        help="Version of @protomaps/basemaps used for style generation.",
    )
    parser.add_argument(
        "--build-key",
        help="Specific Protomaps build key such as 20260428.pmtiles. Defaults to latest.",
    )
    parser.add_argument(
        "--maxzoom",
        type=int,
        default=15,
        help="Maximum zoom level to keep in the local basemap extract.",
    )
    parser.add_argument(
        "--satellite-maxzoom",
        type=int,
        default=18,
        help="Maximum zoom level to keep in the local satellite tile cache.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    payload = sample.generate_aoi_payload(args.aoi_zip, args.aoi_name)
    transformer = Transformer.from_crs(3763, 4326, always_xy=True)
    build = latest_build()
    if args.build_key:
        build = next(item for item in fetch_json(BUILD_METADATA_URL) if item["key"] == args.build_key)

    build_key_without_suffix = build["key"].replace(".pmtiles", "")
    view = build_view(payload, transformer)
    parcels_geojson = build_parcels_geojson(payload, transformer)
    aoi_geojson = build_aoi_geojson(payload, transformer)
    satellite = download_satellite_tiles(
        output_dir,
        view["bbox"],
        0,
        args.satellite_maxzoom,
        SATELLITE_TILE_URL,
    )

    style = fetch_json(
        f"{STYLE_TEMPLATE_URL}?version={urllib.parse.quote(args.style_version)}"
        f"&theme=light&tiles={urllib.parse.quote(build_key_without_suffix)}&lang=pt"
    )
    style = rewrite_style(style)
    satellite_style = build_satellite_style(style, satellite)

    write_json(output_dir / "manifest.json", pack_manifest(
        aoi_name=args.aoi_name,
        build=build,
        style_version=args.style_version,
        view=view,
        parcel_count=len(parcels_geojson["features"]),
        maxzoom=args.maxzoom,
        satellite=satellite,
    ))
    write_json(output_dir / "style.json", style)
    write_json(output_dir / "satellite-style.json", satellite_style)
    write_json(output_dir / "aoi.geojson", aoi_geojson)
    write_json(output_dir / "parcels.geojson", parcels_geojson)
    write_json(output_dir / "source-aoi.json", payload)

    extract_basemap(build["key"], view["bbox"], output_dir / "basemap.pmtiles", args.maxzoom)
    download_pack_assets(output_dir)
    download_vendor_assets(Path("app/vendor"))

    print(f"Wrote offline pack to {output_dir}")


if __name__ == "__main__":
    main()
