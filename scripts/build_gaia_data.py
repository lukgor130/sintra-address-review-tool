#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent.parent
APP_DATA = ROOT / "apps" / "gaiatotal" / "data"
DGT_API = "https://ogcapi.dgterritorio.gov.pt/collections"
GAIA_BBOX = "-8.731,40.936,-8.439,41.205"


def fetch_json(collection: str, params: dict[str, str]) -> dict:
    query = urlencode({"f": "json", **params})
    with urlopen(f"{DGT_API}/{collection}/items?{query}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def centroid(geometry: dict) -> tuple[float, float] | None:
    coordinates = geometry.get("coordinates")
    if not coordinates:
        return None
    xs: list[float] = []
    ys: list[float] = []

    def walk(value):
        if isinstance(value[0], (int, float)):
            xs.append(value[0])
            ys.append(value[1])
            return
        for child in value:
            walk(child)

    walk(coordinates)
    if not xs:
        return None
    return sum(xs) / len(xs), sum(ys) / len(ys)


def point_in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    previous = len(ring) - 1
    for current, current_point in enumerate(ring):
        xi, yi = current_point
        xj, yj = ring[previous]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-30) + xi:
            inside = not inside
        previous = current
    return inside


def geometry_contains_point(geometry: dict, point: tuple[float, float]) -> bool:
    if geometry.get("type") == "Polygon":
        return point_in_ring(point, geometry["coordinates"][0])
    if geometry.get("type") == "MultiPolygon":
        return any(point_in_ring(point, polygon[0]) for polygon in geometry["coordinates"])
    return False


def build_soil_regime_tiles(workdir: Path) -> dict:
    source = fetch_json("crus", {"filter": "dtcc='1317'", "limit": "10000"})
    features = []
    counts: dict[str, int] = {}
    for feature in source.get("features", []):
        properties = feature.get("properties") or {}
        regime = properties.get("classe_2021") or "Unknown"
        counts[regime] = counts.get(regime, 0) + 1
        features.append(
            {
                "type": "Feature",
                "id": properties.get("fid"),
                "properties": {
                    "fid": properties.get("fid"),
                    "classe": regime,
                    "categoria": properties.get("categoria_2021"),
                    "qualificacao": properties.get("classificacao_e_qualificacao"),
                    "area_ha": round(float(properties.get("area_ha") or 0), 4),
                    "fonte": "DGT CRUS",
                },
                "geometry": feature.get("geometry"),
            }
        )

    source_path = workdir / "crus-regime.geojson"
    write_json(source_path, {"type": "FeatureCollection", "features": features})

    mbtiles = workdir / "crus-regime.mbtiles"
    pmtiles = APP_DATA / "crus-regime.pmtiles"
    if pmtiles.exists():
        pmtiles.unlink()
    subprocess.run(
        [
            "tippecanoe",
            "--force",
            f"--output={mbtiles}",
            "--layer=soil_regime",
            "--minimum-zoom=9",
            "--maximum-zoom=16",
            "--simplification=8",
            "--detect-shared-borders",
            "--no-tile-size-limit",
            "--no-feature-limit",
            str(source_path),
        ],
        check=True,
        cwd=ROOT,
    )
    subprocess.run(["pmtiles", "convert", str(mbtiles), str(pmtiles)], check=True, cwd=ROOT)
    return {"featureCount": len(features), "counts": counts}


def check_cadastro_predial() -> dict:
    municipality = fetch_json("municipios", {"filter": "dtmn='1317'", "limit": "1"})
    gaia_geometry = municipality["features"][0]["geometry"]
    cadastro = fetch_json("cadastro", {"bbox": GAIA_BBOX, "limit": "10000"})
    inside = []
    for feature in cadastro.get("features", []):
        point = centroid(feature.get("geometry") or {})
        if point and geometry_contains_point(gaia_geometry, point):
            inside.append(feature)
    return {
        "gaiaFeatureCount": len(inside),
        "bboxFeatureCount": len(cadastro.get("features", [])),
    }


def main() -> None:
    APP_DATA.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gaia-data-") as temp_dir:
        soil = build_soil_regime_tiles(Path(temp_dir))
    cadastro = check_cadastro_predial()
    manifest = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "target": "Vila Nova de Gaia",
        "publicUrl": "https://maps.verrio.co/gaiatotal/",
        "datasets": {
            "soilRegime": {
                "title": "CRUS Portugal Continental · Vila Nova de Gaia",
                "source": f"{DGT_API}/crus",
                "tileTemplate": "./data/crus-regime.pmtiles",
                "storage": "PMTiles vector archive",
                **soil,
                "note": "Official DGT soil-regime layer used for urban/rustic designation because DGT Cadastro Predial exposes no Gaia parcel records through the public OGC API as of this cache build.",
            },
            "cadastroPredial": {
                "title": "DGT Cadastro Predial (Continente)",
                "source": f"{DGT_API}/cadastro",
                **cadastro,
                "note": "The Gaia municipal bounding box was checked and centroid-clipped against CAOP2025 Vila Nova de Gaia. Local GeoJSON upload remains available for private parcel packs.",
            },
        },
    }
    (APP_DATA / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote Gaia data cache to {APP_DATA}")


if __name__ == "__main__":
    main()
