#!/usr/bin/env python3

import argparse
import json
import math
import os
import unicodedata
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from urllib.error import HTTPError, URLError


BASE_URL = "https://sig.cm-sintra.pt"
OUTPUT_DIR = os.path.join(
    "/Users/lukeg/Documents/Personal Projects",
    "sintra-address-review-tool",
    "addressreview",
    "data",
)
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "sample.json")
AOI_OUTPUT_FILE = os.path.join(OUTPUT_DIR, "aoi-azenhas.json")
SOURCE_CACHE_DIR = os.path.join(OUTPUT_DIR, "source-cache")

SITE_ID = "ApoioInvestidor"
PARCEL_SERVICE_ID = "0"
BASEMAP_SERVICE_ID = "24"

PARCEL_LAYER_ID = 12
ADDRESS_LAYER_ID = 44
STREET_LAYER_ID = 45

TARGET_OBJECT_ID = 4948
SAMPLE_HALF_SIZE_METERS = 1200
SAMPLE_COUNT = 25
ADDRESS_SEARCH_PADDING_METERS = 120
MAX_ADDRESS_CANDIDATES = 12
SILVER_DISTANCE_THRESHOLD_METERS = 28
SILVER_CENTROID_SLACK_METERS = 75
SILVER_SAME_STREET_THRESHOLD_METERS = 45
ROAD_CROSSING_TOLERANCE_METERS = 3.5
ROAD_CROSSING_START_TRIM_METERS = 3.0
ROAD_CROSSING_END_TRIM_METERS = 0.75
REQUEST_TIMEOUT_SECONDS = 60
REQUEST_RETRIES = 3
REQUEST_RETRY_BACKOFF_SECONDS = 1.5
QUERY_OBJECT_IDS_BATCH_SIZE = 200
TIER_ORDER = {"gold": 0, "silver": 1, "nearby": 2}
SPATIAL_REFERENCE = {"wkid": 3763}

def request_json(url: str, params: dict | None = None, method: str = "GET") -> dict:
    request = url
    if params:
        encoded = urllib.parse.urlencode(params)
        if method.upper() == "POST":
            request = urllib.request.Request(
                url,
                data=encoded.encode("utf-8"),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
        else:
            separator = "&" if "?" in url else "?"
            request = f"{url}{separator}{encoded}"
    last_error = None
    for attempt in range(REQUEST_RETRIES):
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return json.load(response)
        except (TimeoutError, URLError, HTTPError, json.JSONDecodeError) as error:
            last_error = error
            is_retryable_http = not isinstance(error, HTTPError) or error.code in {408, 429}
            if attempt == REQUEST_RETRIES - 1 or not is_retryable_http:
                raise
            time.sleep(REQUEST_RETRY_BACKOFF_SECONDS * (attempt + 1))
    raise RuntimeError(f"Request failed after retries: {url}") from last_error


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
    pieces = []
    for char in ascii_value.lower():
        if char.isalnum():
            pieces.append(char)
        else:
            pieces.append("-")
    slug = "".join(pieces).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "layer"


def get_json(url: str, params: dict | None = None) -> dict:
    return request_json(url, params=params, method="GET")


def parse_connection_string(connection_string: str) -> dict:
    values = {}
    for chunk in connection_string.split(";"):
        if "=" not in chunk:
            continue
        key, value = chunk.split("=", 1)
        values[key] = value
    return values


def get_mapservice_config(mapservice_id: str) -> dict:
    return get_json(
        f"{BASE_URL}/MuniSIG/REST/sites/{SITE_ID}/map/mapservices/{mapservice_id}?f=pjson"
    )


def fetch_layer_definition(service_url: str, layer_id: int | str, token: str) -> dict:
    return get_json(f"{service_url}/{layer_id}", {"f": "pjson", "token": token})


def fetch_layer_ids(
    service_url: str,
    layer_id: int | str,
    token: str,
    where: str = "1=1",
) -> list[int]:
    response = get_json(
        f"{service_url}/{layer_id}/query",
        {
            "where": where,
            "returnIdsOnly": "true",
            "f": "pjson",
            "token": token,
        },
    )
    return sorted(response.get("objectIds", []))


def fetch_layer_features(
    service_url: str,
    layer_id: int | str,
    token: str,
    *,
    where: str = "1=1",
    out_fields: str = "*",
    return_geometry: bool = True,
    batch_size: int = QUERY_OBJECT_IDS_BATCH_SIZE,
) -> dict:
    layer_definition = fetch_layer_definition(service_url, layer_id, token)
    object_ids = fetch_layer_ids(service_url, layer_id, token, where=where)
    features = []
    query_url = f"{service_url}/{layer_id}/query"

    for start in range(0, len(object_ids), batch_size):
        batch = object_ids[start : start + batch_size]
        if not batch:
            continue
        batch_response = request_json(
            query_url,
            {
                "objectIds": ",".join(str(object_id) for object_id in batch),
                "outFields": out_fields,
                "returnGeometry": "true" if return_geometry else "false",
                "f": "pjson",
                "token": token,
            },
            method="POST",
        )
        features.extend(batch_response.get("features", []))

    return {
        "serviceUrl": service_url,
        "layerId": int(layer_id),
        "layerName": layer_definition.get("name"),
        "geometryType": layer_definition.get("geometryType"),
        "where": where,
        "objectIdField": layer_definition.get("objectIdField"),
        "fields": layer_definition.get("fields", []),
        "maxRecordCount": layer_definition.get("maxRecordCount"),
        "features": features,
    }


def centroid_of_ring(ring: list[list[float]]) -> tuple[float, float]:
    if ring[0] != ring[-1]:
        ring = ring + [ring[0]]

    area_factor = 0.0
    centroid_x = 0.0
    centroid_y = 0.0

    for start, end in zip(ring, ring[1:]):
        cross = start[0] * end[1] - end[0] * start[1]
        area_factor += cross
        centroid_x += (start[0] + end[0]) * cross
        centroid_y += (start[1] + end[1]) * cross

    if abs(area_factor) < 1e-9:
        xs = [point[0] for point in ring[:-1]]
        ys = [point[1] for point in ring[:-1]]
        return (sum(xs) / len(xs), sum(ys) / len(ys))

    area_factor *= 0.5
    return (centroid_x / (6 * area_factor), centroid_y / (6 * area_factor))


def polygon_bbox(rings: list[list[list[float]]]) -> tuple[float, float, float, float]:
    xs = [point[0] for ring in rings for point in ring]
    ys = [point[1] for ring in rings for point in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def expand_bbox(
    bbox: tuple[float, float, float, float] | None,
    other: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    if bbox is None:
        return other
    return (
        min(bbox[0], other[0]),
        min(bbox[1], other[1]),
        max(bbox[2], other[2]),
        max(bbox[3], other[3]),
    )


def shp_shape_rings(shape) -> list[list[list[float]]]:
    parts = list(shape.parts) + [len(shape.points)]
    rings = []
    for start, end in zip(parts, parts[1:]):
        rings.append([[float(x), float(y)] for x, y in shape.points[start:end]])
    return rings


def load_aoi_geometry(zip_path: str) -> dict:
    try:
        import shapefile
    except ModuleNotFoundError as error:
        raise ModuleNotFoundError(
            "AOI shapefile support requires the optional 'pyshp' package. "
            "Create a venv and run: pip install pyshp"
        ) from error

    with tempfile.TemporaryDirectory(prefix="sintra_aoi_") as temp_dir:
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(temp_dir)

        shp_files = sorted(Path(temp_dir).glob("*.shp"))
        if not shp_files:
            raise FileNotFoundError("No .shp file found inside AOI zip archive")

        reader = shapefile.Reader(str(shp_files[0]))
        if not reader.shapes():
            raise ValueError("AOI shapefile does not contain any polygon features")

        shape = reader.shapes()[0]
        return {
            "rings": shp_shape_rings(shape),
            "spatialReference": SPATIAL_REFERENCE,
        }


def point_in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    if ring[0] != ring[-1]:
        ring = ring + [ring[0]]
    for start, end in zip(ring, ring[1:]):
        x1, y1 = start
        x2, y2 = end
        intersects = ((y1 > y) != (y2 > y)) and (
            x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1
        )
        if intersects:
            inside = not inside
    return inside


def point_to_segment_distance(
    point: tuple[float, float], start: list[float], end: list[float]
) -> float:
    nearest_x, nearest_y = nearest_point_on_segment(point, start, end)
    return math.hypot(point[0] - nearest_x, point[1] - nearest_y)


def nearest_point_on_segment(
    point: tuple[float, float], start: list[float], end: list[float]
) -> tuple[float, float]:
    px, py = point
    x1, y1 = start
    x2, y2 = end
    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return (x1, y1)
    t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    nearest_x = x1 + t * dx
    nearest_y = y1 + t * dy
    return (nearest_x, nearest_y)


def point_to_polygon_distance(point: tuple[float, float], rings: list[list[list[float]]]) -> float:
    if point_in_ring(point, rings[0]):
        return 0.0
    distances = []
    for ring in rings:
        ring_points = ring if ring[0] == ring[-1] else ring + [ring[0]]
        for start, end in zip(ring_points, ring_points[1:]):
            distances.append(point_to_segment_distance(point, start, end))
    return min(distances) if distances else math.inf


def nearest_point_on_polygon_boundary(
    point: tuple[float, float], rings: list[list[list[float]]]
) -> tuple[float, float]:
    best_distance = math.inf
    best_point = point
    for ring in rings:
        ring_points = ring if ring[0] == ring[-1] else ring + [ring[0]]
        for start, end in zip(ring_points, ring_points[1:]):
            candidate_point = nearest_point_on_segment(point, start, end)
            distance = math.hypot(point[0] - candidate_point[0], point[1] - candidate_point[1])
            if distance < best_distance:
                best_distance = distance
                best_point = candidate_point
    return best_point


def orientation(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> bool:
    return (
        min(a[0], c[0]) - 1e-9 <= b[0] <= max(a[0], c[0]) + 1e-9
        and min(a[1], c[1]) - 1e-9 <= b[1] <= max(a[1], c[1]) + 1e-9
    )


def segments_intersect(
    a1: tuple[float, float],
    a2: tuple[float, float],
    b1: tuple[float, float],
    b2: tuple[float, float],
) -> bool:
    o1 = orientation(a1, a2, b1)
    o2 = orientation(a1, a2, b2)
    o3 = orientation(b1, b2, a1)
    o4 = orientation(b1, b2, a2)

    if ((o1 > 0 > o2) or (o1 < 0 < o2)) and ((o3 > 0 > o4) or (o3 < 0 < o4)):
        return True

    if abs(o1) <= 1e-9 and on_segment(a1, b1, a2):
        return True
    if abs(o2) <= 1e-9 and on_segment(a1, b2, a2):
        return True
    if abs(o3) <= 1e-9 and on_segment(b1, a1, b2):
        return True
    if abs(o4) <= 1e-9 and on_segment(b1, a2, b2):
        return True

    return False


def trim_segment(
    start: tuple[float, float],
    end: tuple[float, float],
    trim_start: float,
    trim_end: float,
) -> tuple[tuple[float, float], tuple[float, float]]:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    if length <= 1e-9:
        return (start, end)
    trim_start = min(trim_start, length * 0.45)
    trim_end = min(trim_end, max(0.0, length - trim_start))
    ux = dx / length
    uy = dy / length
    return (
        (start[0] + ux * trim_start, start[1] + uy * trim_start),
        (end[0] - ux * trim_end, end[1] - uy * trim_end),
    )


def segment_bbox(
    start: tuple[float, float], end: tuple[float, float]
) -> tuple[float, float, float, float]:
    return (
        min(start[0], end[0]),
        min(start[1], end[1]),
        max(start[0], end[0]),
        max(start[1], end[1]),
    )


def bbox_distance(
    first: tuple[float, float, float, float], second: tuple[float, float, float, float]
) -> float:
    dx = max(0.0, first[0] - second[2], second[0] - first[2])
    dy = max(0.0, first[1] - second[3], second[1] - first[3])
    return math.hypot(dx, dy)


def segment_to_segment_distance(
    a1: tuple[float, float],
    a2: tuple[float, float],
    b1: tuple[float, float],
    b2: tuple[float, float],
) -> float:
    if segments_intersect(a1, a2, b1, b2):
        return 0.0
    return min(
        point_to_segment_distance(a1, list(b1), list(b2)),
        point_to_segment_distance(a2, list(b1), list(b2)),
        point_to_segment_distance(b1, list(a1), list(a2)),
        point_to_segment_distance(b2, list(a1), list(a2)),
    )


def build_street_segments(street_features: list[dict]) -> list[dict]:
    street_segments = []
    for feature in street_features:
        attrs = feature.get("attributes", {})
        street_code = attrs.get("COD_RUA", attrs.get("Cod_rua"))
        street_name = (attrs.get("NOME") or attrs.get("Nome_rua") or "").strip()
        for path in feature.get("geometry", {}).get("paths", []):
            if len(path) < 2:
                continue
            for line_start, line_end in zip(path, path[1:]):
                start = tuple(line_start)
                end = tuple(line_end)
                if start == end:
                    continue
                street_segments.append(
                    {
                        "code": street_code,
                        "name": street_name,
                        "start": start,
                        "end": end,
                        "bbox": segment_bbox(start, end),
                    }
                )
    return street_segments


def street_barrier_metrics(
    start: tuple[float, float], end: tuple[float, float], street_segments: list[dict]
) -> dict:
    if start == end:
        return {
            "roadCrossing": False,
            "crossedStreetCount": 0,
            "crossedStreetCodes": [],
            "crossedStreetNames": [],
            "nearestStreetCode": None,
            "nearestStreetName": None,
            "nearestStreetDistanceToPath": None,
            "nearestStreetDistanceToCandidate": None,
            "nearestStreetDistanceToParcel": None,
        }

    trimmed_start, trimmed_end = trim_segment(
        start,
        end,
        ROAD_CROSSING_START_TRIM_METERS,
        ROAD_CROSSING_END_TRIM_METERS,
    )
    path_bbox = segment_bbox(trimmed_start, trimmed_end)
    candidate_bbox = (start[0], start[1], start[0], start[1])
    parcel_bbox = (end[0], end[1], end[0], end[1])
    best_path_distance = math.inf
    best_candidate_distance = math.inf
    best_parcel_distance = math.inf
    nearest_street_code = None
    nearest_street_name = None
    crossed_streets: dict[tuple[int | None, str], dict] = {}

    for segment in street_segments:
        path_lower_bound = bbox_distance(path_bbox, segment["bbox"])
        candidate_lower_bound = bbox_distance(candidate_bbox, segment["bbox"])
        parcel_lower_bound = bbox_distance(parcel_bbox, segment["bbox"])
        if (
            path_lower_bound > ROAD_CROSSING_TOLERANCE_METERS
            and path_lower_bound >= best_path_distance
            and candidate_lower_bound >= best_candidate_distance
            and parcel_lower_bound >= best_parcel_distance
        ):
            continue

        path_distance = segment_to_segment_distance(
            trimmed_start, trimmed_end, segment["start"], segment["end"]
        )
        candidate_distance = point_to_segment_distance(start, segment["start"], segment["end"])
        parcel_distance = point_to_segment_distance(end, segment["start"], segment["end"])

        if path_distance < best_path_distance:
            best_path_distance = path_distance
            nearest_street_code = segment["code"]
            nearest_street_name = segment["name"] or None
        best_candidate_distance = min(best_candidate_distance, candidate_distance)
        best_parcel_distance = min(best_parcel_distance, parcel_distance)

        if path_distance <= ROAD_CROSSING_TOLERANCE_METERS:
            crossed_streets[(segment["code"], segment["name"])] = {
                "code": segment["code"],
                "name": segment["name"],
            }

    crossed_codes = [item["code"] for item in crossed_streets.values() if item["code"] is not None]
    crossed_names = [item["name"] for item in crossed_streets.values() if item["name"]]
    return {
        "roadCrossing": bool(crossed_streets),
        "crossedStreetCount": len(crossed_streets),
        "crossedStreetCodes": crossed_codes,
        "crossedStreetNames": crossed_names,
        "nearestStreetCode": nearest_street_code,
        "nearestStreetName": nearest_street_name,
        "nearestStreetDistanceToPath": None
        if math.isinf(best_path_distance)
        else round(best_path_distance, 2),
        "nearestStreetDistanceToCandidate": None
        if math.isinf(best_candidate_distance)
        else round(best_candidate_distance, 2),
        "nearestStreetDistanceToParcel": None
        if math.isinf(best_parcel_distance)
        else round(best_parcel_distance, 2),
    }


def parcel_query(token: str, params: dict, method: str = "GET") -> dict:
    return request_json(
        f"{BASE_URL}/arcgis/rest/services/Internet/ApoioInvestidor/MapServer/{PARCEL_LAYER_ID}/query",
        params | {"f": "pjson", "token": token},
        method=method,
    )


def basemap_query(layer_id: int, token: str, params: dict, method: str = "GET") -> dict:
    return request_json(
        f"{BASE_URL}/arcgis/rest/services/Internet/Base_cartografica_Dez2014/MapServer/{layer_id}/query",
        params | {"f": "pjson", "token": token},
        method=method,
    )


def load_target_parcel(parcel_token: str) -> dict:
    data = parcel_query(
        parcel_token,
        {
            "where": f"OBJECT_ID={TARGET_OBJECT_ID}",
            "returnGeometry": "true",
            "outFields": "OBJECTID,OBJECT_ID,Tipologia,Area_m2,Qualif_Solo,Freguesia",
        },
    )
    return data["features"][0]


def load_sample_parcels(parcel_token: str, center: tuple[float, float]) -> list[dict]:
    cx, cy = center
    envelope = f"{cx - SAMPLE_HALF_SIZE_METERS},{cy - SAMPLE_HALF_SIZE_METERS},{cx + SAMPLE_HALF_SIZE_METERS},{cy + SAMPLE_HALF_SIZE_METERS}"
    data = parcel_query(
        parcel_token,
        {
            "geometry": envelope,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "3763",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outFields": "OBJECTID,OBJECT_ID,Tipologia,Area_m2,Qualif_Solo,Freguesia",
        },
    )

    features = data["features"]
    for feature in features:
        parcel_center = centroid_of_ring(feature["geometry"]["rings"][0])
        feature["_distance_to_target"] = math.hypot(parcel_center[0] - cx, parcel_center[1] - cy)
    features.sort(key=lambda feature: feature["_distance_to_target"])
    return features[:SAMPLE_COUNT]


def load_aoi_parcels(parcel_token: str, aoi_geometry: dict) -> list[dict]:
    data = parcel_query(
        parcel_token,
        {
            "geometry": json.dumps(aoi_geometry, separators=(",", ":")),
            "geometryType": "esriGeometryPolygon",
            "inSR": "3763",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outFields": "OBJECTID,OBJECT_ID,Tipologia,Area_m2,Qualif_Solo,Freguesia",
            "returnExceededLimitFeatures": "true",
        },
        method="POST",
    )
    features = data.get("features", [])
    features.sort(key=lambda feature: feature["attributes"].get("OBJECT_ID", 0))
    return features


def parcel_search_envelope(parcel: dict, padding_meters: float) -> str:
    rings = parcel["geometry"]["rings"]
    xmin, ymin, xmax, ymax = polygon_bbox(rings)
    return (
        f"{xmin - padding_meters},"
        f"{ymin - padding_meters},"
        f"{xmax + padding_meters},"
        f"{ymax + padding_meters}"
    )


def load_nearby_streets(parcel: dict, base_token: str) -> list[dict]:
    data = basemap_query(
        STREET_LAYER_ID,
        base_token,
        {
            "geometry": parcel_search_envelope(parcel, ADDRESS_SEARCH_PADDING_METERS),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "3763",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outFields": "OBJECTID,COD_RUA,NOME",
        },
    )
    return build_street_segments(data.get("features", []))


def classify_candidate_tiers(candidates: list[dict]) -> list[dict]:
    if not candidates:
        return []

    candidates.sort(
        key=lambda item: (
            item["roadCrossing"],
            item["distanceToParcel"],
            item["distanceToCentroid"],
            item["objectId"],
        )
    )

    best = candidates[0]
    best["tier"] = "gold"

    for candidate in candidates[1:]:
        same_street = bool(best.get("codRua")) and candidate.get("codRua") == best.get("codRua")
        close_enough = candidate["distanceToParcel"] <= max(
            SILVER_DISTANCE_THRESHOLD_METERS,
            best["distanceToParcel"] + 18,
        )
        same_street_adjacent = same_street and candidate["distanceToParcel"] <= max(
            SILVER_SAME_STREET_THRESHOLD_METERS,
            best["distanceToParcel"] + 30,
        )
        centroid_aligned = candidate["distanceToCentroid"] <= (
            best["distanceToCentroid"] + SILVER_CENTROID_SLACK_METERS
        )
        if not candidate["roadCrossing"] and (same_street_adjacent or (close_enough and (same_street or centroid_aligned))):
            candidate["tier"] = "silver"
        else:
            candidate["tier"] = "nearby"

    candidates.sort(
        key=lambda item: (
            TIER_ORDER[item["tier"]],
            item["roadCrossing"],
            item["distanceToParcel"],
            item["distanceToCentroid"],
            item["objectId"],
        )
    )
    return candidates[:MAX_ADDRESS_CANDIDATES]


def load_address_candidates(parcel: dict, base_token: str) -> list[dict]:
    rings = parcel["geometry"]["rings"]
    envelope = parcel_search_envelope(parcel, ADDRESS_SEARCH_PADDING_METERS)
    streets = load_nearby_streets(parcel, base_token)

    data = basemap_query(
        ADDRESS_LAYER_ID,
        base_token,
        {
            "geometry": envelope,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "3763",
            "spatialRel": "esriSpatialRelIntersects",
            "returnGeometry": "true",
            "outFields": "OBJECTID,Porta,Rua,Localidade,Cod_rua",
        },
    )

    centroid = centroid_of_ring(rings[0])
    candidates = []
    for feature in data.get("features", []):
        point = (feature["geometry"]["x"], feature["geometry"]["y"])
        distance_to_parcel = point_to_polygon_distance(point, rings)
        distance_to_centroid = math.hypot(point[0] - centroid[0], point[1] - centroid[1])
        nearest_boundary_point = nearest_point_on_polygon_boundary(point, rings)
        road_metrics = street_barrier_metrics(point, nearest_boundary_point, streets)
        attrs = feature["attributes"]
        candidates.append(
            {
                "objectId": attrs["OBJECTID"],
                "porta": (attrs.get("Porta") or "").strip(),
                "rua": (attrs.get("Rua") or "").strip(),
                "localidade": (attrs.get("Localidade") or "").strip(),
                "codRua": attrs.get("Cod_rua"),
                "x": feature["geometry"]["x"],
                "y": feature["geometry"]["y"],
                "nearestBoundaryPoint": {
                    "x": round(nearest_boundary_point[0], 3),
                    "y": round(nearest_boundary_point[1], 3),
                },
                "distanceToParcel": round(distance_to_parcel, 2),
                "distanceToCentroid": round(distance_to_centroid, 2),
                **road_metrics,
            }
        )

    return classify_candidate_tiers(candidates)


def serialize_parcel(feature: dict, candidates: list[dict]) -> dict:
    attrs = feature["attributes"]
    centroid = centroid_of_ring(feature["geometry"]["rings"][0])
    selected = candidates[0] if candidates else None
    return {
        "objectId": attrs["OBJECTID"],
        "sourceObjectId": attrs["OBJECT_ID"],
        "tipologia": attrs["Tipologia"],
        "areaM2": round(attrs["Area_m2"], 2),
        "qualificacaoSolo": attrs["Qualif_Solo"],
        "freguesia": attrs["Freguesia"],
        "geometry": feature["geometry"],
        "centroid": {"x": round(centroid[0], 3), "y": round(centroid[1], 3)},
        "selectedAddress": selected,
        "addressCandidates": candidates,
    }


def serialize_bbox(bbox: tuple[float, float, float, float]) -> dict:
    return {
        "xmin": round(bbox[0], 3),
        "ymin": round(bbox[1], 3),
        "xmax": round(bbox[2], 3),
        "ymax": round(bbox[3], 3),
    }


def build_payload(
    parcels: list[dict],
    *,
    basemap_service_url: str,
    basemap_token: str,
    generated_for: str,
    dataset_type: str,
    sample_bbox: tuple[float, float, float, float],
    extra_meta: dict | None = None,
) -> dict:
    return {
        "meta": {
            "siteId": SITE_ID,
            "sampleCount": len(parcels),
            "addressSearchPaddingMeters": ADDRESS_SEARCH_PADDING_METERS,
            "basemapMapserviceId": BASEMAP_SERVICE_ID,
            "basemapServiceUrl": basemap_service_url,
            "basemapToken": basemap_token,
            "generatedFor": generated_for,
            "datasetType": dataset_type,
            "spatialReference": SPATIAL_REFERENCE,
            "sampleBbox": serialize_bbox(sample_bbox),
            **(extra_meta or {}),
        },
        "parcels": parcels,
    }


def write_json_file(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def cache_source_layers(output_dir: str) -> dict:
    parcel_token, base_service_url, base_token = load_tokens()
    parcel_service_url = f"{BASE_URL}/arcgis/rest/services/Internet/ApoioInvestidor/MapServer"
    base_map_url = base_service_url

    parcel_filter = "UPPER(Tipologia) IN ('LIVRE','EXPECTANTE')"
    parcel_layers = fetch_layer_features(
        parcel_service_url,
        PARCEL_LAYER_ID,
        parcel_token,
        where=parcel_filter,
        out_fields="*",
    )
    address_layer = fetch_layer_features(
        base_map_url,
        ADDRESS_LAYER_ID,
        base_token,
        out_fields="*",
    )
    road_layer = fetch_layer_features(
        base_map_url,
        STREET_LAYER_ID,
        base_token,
        out_fields="*",
    )
    regulatory_group = fetch_layer_definition(parcel_service_url, 29, parcel_token)
    regulatory_layers = []
    for layer_id in (30, 31, 32):
        regulatory_layers.append(
            fetch_layer_features(parcel_service_url, layer_id, parcel_token, out_fields="*")
        )

    parcels_file = os.path.join(output_dir, "parcels-livre-expectante.json")
    addresses_file = os.path.join(output_dir, "addresses-full.json")
    roads_file = os.path.join(output_dir, "roads-full.json")

    write_json_file(parcels_file, parcel_layers)
    write_json_file(addresses_file, address_layer)
    write_json_file(roads_file, road_layer)

    regulatory_manifest = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "groupLayer": regulatory_group,
        "layers": [],
    }
    for layer in regulatory_layers:
        filename = f"{layer['layerId']}-{slugify(layer['layerName'] or 'regulatory-layer')}.json"
        relative_path = os.path.join("limites-regulamentares", filename)
        write_json_file(os.path.join(output_dir, relative_path), layer)
        regulatory_manifest["layers"].append(
            {
                "layerId": layer["layerId"],
                "layerName": layer["layerName"],
                "file": relative_path,
                "count": len(layer["features"]),
                "geometryType": layer["geometryType"],
            }
        )

    manifest = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "siteId": SITE_ID,
        "parcelServiceUrl": parcel_service_url,
        "basemapServiceUrl": base_map_url,
        "datasets": {
            "parcels": {
                "file": os.path.basename(parcels_file),
                "where": parcel_filter,
                "count": len(parcel_layers["features"]),
                "geometryType": parcel_layers["geometryType"],
            },
            "addresses": {
                "file": os.path.basename(addresses_file),
                "count": len(address_layer["features"]),
                "geometryType": address_layer["geometryType"],
            },
            "roads": {
                "file": os.path.basename(roads_file),
                "count": len(road_layer["features"]),
                "geometryType": road_layer["geometryType"],
            },
            "regulatoryLimits": regulatory_manifest,
        },
    }

    write_json_file(os.path.join(output_dir, "manifest.json"), manifest)
    return manifest


def load_tokens() -> tuple[str, str, str]:
    parcel_service = get_mapservice_config(PARCEL_SERVICE_ID)
    parcel_conn = parse_connection_string(parcel_service["connectionString"])
    parcel_token = parcel_conn["token"]

    base_service = get_mapservice_config(BASEMAP_SERVICE_ID)
    base_conn = parse_connection_string(base_service["connectionString"])
    base_token = base_conn["token"]
    return parcel_token, base_conn["url"], base_token


def generate_sample_payload() -> dict:
    parcel_token, base_service_url, base_token = load_tokens()
    target = load_target_parcel(parcel_token)
    target_center = centroid_of_ring(target["geometry"]["rings"][0])
    sample_features = load_sample_parcels(parcel_token, target_center)

    parcels = []
    sample_bbox = None

    for feature in sample_features:
        candidates = load_address_candidates(feature, base_token)
        parcel = serialize_parcel(feature, candidates)
        parcels.append(parcel)

        rings = feature["geometry"]["rings"]
        sample_bbox = expand_bbox(sample_bbox, polygon_bbox(rings))

    return build_payload(
        parcels,
        basemap_service_url=base_service_url,
        basemap_token=base_token,
        generated_for="Parcel to nearest house-number review",
        dataset_type="training-review",
        sample_bbox=sample_bbox,
        extra_meta={
            "targetObjectId": TARGET_OBJECT_ID,
            "sampleHalfSizeMeters": SAMPLE_HALF_SIZE_METERS,
        },
    )


def generate_aoi_payload(aoi_zip: str, aoi_name: str) -> dict:
    parcel_token, base_service_url, base_token = load_tokens()
    aoi_geometry = load_aoi_geometry(aoi_zip)
    parcel_features = load_aoi_parcels(parcel_token, aoi_geometry)

    parcels = []
    sample_bbox = polygon_bbox(aoi_geometry["rings"])

    for feature in parcel_features:
        candidates = load_address_candidates(feature, base_token)
        parcel = serialize_parcel(feature, candidates)
        parcels.append(parcel)
        sample_bbox = expand_bbox(sample_bbox, polygon_bbox(feature["geometry"]["rings"]))

    return build_payload(
        parcels,
        basemap_service_url=base_service_url,
        basemap_token=base_token,
        generated_for="Local knowledge parcel review",
        dataset_type="aoi-review",
        sample_bbox=sample_bbox,
        extra_meta={
            "aoiName": aoi_name,
            "aoiGeometry": aoi_geometry,
            "aoiBbox": serialize_bbox(polygon_bbox(aoi_geometry["rings"])),
        },
    )


def write_payload(payload: dict, output_file: str) -> None:
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare parcel review datasets.")
    parser.add_argument(
        "--cache-source-layers",
        action="store_true",
        help="Cache the full parcel, address, road, and regulatory layers locally.",
    )
    parser.add_argument(
        "--cache-dir",
        default=SOURCE_CACHE_DIR,
        help="Directory used for the source-layer cache.",
    )
    parser.add_argument(
        "--aoi-zip",
        help="Path to a zipped shapefile representing an area of interest.",
    )
    parser.add_argument(
        "--aoi-name",
        default="Area of interest",
        help="Friendly AOI name stored in the exported metadata.",
    )
    parser.add_argument(
        "--output",
        help="Output JSON file path. Defaults to the sample or AOI dataset location.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.cache_source_layers:
        manifest = cache_source_layers(args.cache_dir)
        print(
            f"Cached {manifest['datasets']['parcels']['count']} parcels, "
            f"{manifest['datasets']['addresses']['count']} addresses, "
            f"{manifest['datasets']['roads']['count']} roads, "
            f"{sum(layer['count'] for layer in manifest['datasets']['regulatoryLimits']['layers'])} regulatory features "
            f"to {args.cache_dir}"
        )
        return

    if args.aoi_zip:
        payload = generate_aoi_payload(args.aoi_zip, args.aoi_name)
        output_file = args.output or AOI_OUTPUT_FILE
    else:
        payload = generate_sample_payload()
        output_file = args.output or OUTPUT_FILE

    write_payload(payload, output_file)
    print(f"Wrote {len(payload['parcels'])} parcels to {output_file}")


if __name__ == "__main__":
    main()
