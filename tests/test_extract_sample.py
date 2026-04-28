import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.error import URLError
from urllib.request import Request

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import extract_sample as sample


class GeometryTests(unittest.TestCase):
    def test_shp_shape_rings_splits_parts(self):
        shape = SimpleNamespace(
            points=[(0, 0), (2, 0), (2, 2), (0, 0), (4, 4), (5, 4), (4, 4)],
            parts=[0, 4],
        )

        rings = sample.shp_shape_rings(shape)

        self.assertEqual(
            rings,
            [
                [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 0.0]],
                [[4.0, 4.0], [5.0, 4.0], [4.0, 4.0]],
            ],
        )

    def test_build_street_segments_flattens_and_skips_zero_length(self):
        features = [
            {
                "attributes": {"Cod_rua": 7, "Nome_rua": "Rua Teste"},
                "geometry": {"paths": [[[0, 0], [5, 0], [5, 0], [10, 0]]]},
            }
        ]

        segments = sample.build_street_segments(features)

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["code"], 7)
        self.assertEqual(segments[0]["name"], "Rua Teste")
        self.assertEqual(segments[0]["bbox"], (0, 0, 5, 0))
        self.assertEqual(segments[1]["bbox"], (5, 0, 10, 0))

    def test_street_barrier_metrics_detects_crossing_and_dedupes_street(self):
        segments = sample.build_street_segments(
            [
                {
                    "attributes": {"Cod_rua": 11, "Nome_rua": "Rua Central"},
                    "geometry": {"paths": [[[5, -5], [5, 0], [5, 5]]]},
                }
            ]
        )

        metrics = sample.street_barrier_metrics((0, 0), (10, 0), segments)

        self.assertTrue(metrics["roadCrossing"])
        self.assertEqual(metrics["crossedStreetCount"], 1)
        self.assertEqual(metrics["crossedStreetCodes"], [11])
        self.assertEqual(metrics["crossedStreetNames"], ["Rua Central"])
        self.assertEqual(metrics["nearestStreetDistanceToPath"], 0.0)

    def test_street_barrier_metrics_tolerates_offset_centerline(self):
        segments = sample.build_street_segments(
            [
                {
                    "attributes": {"Cod_rua": 15, "Nome_rua": "Avenida Offset"},
                    "geometry": {"paths": [[[5, 3], [5, 8]]]},
                }
            ]
        )

        metrics = sample.street_barrier_metrics((0, 0), (10, 0), segments)

        self.assertTrue(metrics["roadCrossing"])
        self.assertEqual(metrics["crossedStreetCodes"], [15])
        self.assertAlmostEqual(metrics["nearestStreetDistanceToPath"], 3.0)

    def test_street_barrier_metrics_rejects_parallel_street(self):
        segments = sample.build_street_segments(
            [
                {
                    "attributes": {"Cod_rua": 21, "Nome_rua": "Rua Paralela"},
                    "geometry": {"paths": [[[0, 4], [10, 4]]]},
                }
            ]
        )

        metrics = sample.street_barrier_metrics((0, 0), (10, 0), segments)

        self.assertFalse(metrics["roadCrossing"])
        self.assertEqual(metrics["crossedStreetCount"], 0)
        self.assertAlmostEqual(metrics["nearestStreetDistanceToPath"], 4.0)


class RequestRetryTests(unittest.TestCase):
    def test_get_json_retries_transient_errors(self):
        payload = io.StringIO(json.dumps({"ok": True}))

        with mock.patch.object(
            sample.urllib.request,
            "urlopen",
            side_effect=[URLError("timeout"), URLError("timeout"), payload],
        ) as mocked_urlopen:
            with mock.patch.object(sample.time, "sleep") as mocked_sleep:
                result = sample.get_json("https://example.com/test")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(mocked_urlopen.call_count, 3)
        self.assertEqual(mocked_sleep.call_count, 2)

    def test_request_json_posts_form_body(self):
        payload = io.StringIO(json.dumps({"ok": True}))

        with mock.patch.object(sample.urllib.request, "urlopen", return_value=payload) as mocked_urlopen:
            result = sample.request_json(
                "https://example.com/query",
                params={"geometryType": "esriGeometryPolygon", "f": "pjson"},
                method="POST",
            )

        self.assertEqual(result, {"ok": True})
        request = mocked_urlopen.call_args.args[0]
        self.assertIsInstance(request, Request)
        self.assertEqual(request.get_method(), "POST")
        self.assertIn(b"geometryType=esriGeometryPolygon", request.data)


class CacheSourceLayerTests(unittest.TestCase):
    def test_fetch_layer_features_batches_object_ids(self):
        layer_definition = {
            "name": "Test Layer",
            "geometryType": "esriGeometryPolygon",
            "objectIdField": "OBJECTID",
            "fields": [{"name": "OBJECTID"}],
            "maxRecordCount": 2,
        }

        with mock.patch.object(sample, "fetch_layer_definition", return_value=layer_definition), mock.patch.object(
            sample,
            "fetch_layer_ids",
            return_value=[1, 2, 3, 4, 5],
        ), mock.patch.object(sample, "get_json") as mocked_get_json:
            mocked_get_json.side_effect = [
                {"features": [{"attributes": {"OBJECTID": 1}}]},
                {"features": [{"attributes": {"OBJECTID": 3}}]},
                {"features": [{"attributes": {"OBJECTID": 5}}]},
            ]

            result = sample.fetch_layer_features(
                "https://example.com/arcgis/rest/services/Service/MapServer",
                12,
                "token",
                batch_size=2,
            )

        self.assertEqual(
            [call.args[0] for call in mocked_get_json.call_args_list],
            [
                "https://example.com/arcgis/rest/services/Service/MapServer/12/query",
                "https://example.com/arcgis/rest/services/Service/MapServer/12/query",
                "https://example.com/arcgis/rest/services/Service/MapServer/12/query",
            ],
        )
        self.assertEqual(result["layerName"], "Test Layer")
        self.assertEqual([feature["attributes"]["OBJECTID"] for feature in result["features"]], [1, 3, 5])

    def test_cache_source_layers_writes_manifest_and_layer_files(self):
        parcel_layer = {
            "layerId": 12,
            "layerName": "Áreas Livres e Expectantes",
            "geometryType": "esriGeometryPolygon",
            "features": [{"attributes": {"OBJECTID": 1}}],
        }
        address_layer = {
            "layerId": 44,
            "layerName": "Nº policia",
            "geometryType": "esriGeometryPoint",
            "features": [{"attributes": {"OBJECTID": 11}}],
        }
        road_layer = {
            "layerId": 45,
            "layerName": "Ruas",
            "geometryType": "esriGeometryPolyline",
            "features": [{"attributes": {"OBJECTID": 21}}],
        }
        regulatory_group = {"name": "Limites Regulamentares", "layers": [30, 31, 32]}
        regulatory_layer = {
            "layerId": 30,
            "layerName": "Unidades Operativas de Planeamento e Gestão",
            "geometryType": "esriGeometryPolygon",
            "features": [{"attributes": {"OBJECTID": 31}}],
        }

        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(
            sample,
            "load_tokens",
            return_value=("parcel-token", "https://example.com/base", "base-token"),
        ), mock.patch.object(sample, "fetch_layer_features", side_effect=[
            parcel_layer,
            address_layer,
            road_layer,
            regulatory_layer,
            {**regulatory_layer, "layerId": 31, "layerName": "Áreas Urbanas de Génese Ilegal"},
            {**regulatory_layer, "layerId": 32, "layerName": "Áreas de Reabilitação Urbana"},
        ]), mock.patch.object(
            sample,
            "fetch_layer_definition",
            return_value=regulatory_group,
        ), mock.patch.object(sample.time, "strftime", return_value="2026-04-28T21:00:00Z"):
            manifest = sample.cache_source_layers(temp_dir)

            manifest_path = Path(temp_dir) / "manifest.json"
            parcels_path = Path(temp_dir) / "parcels-livre-expectante.json"
            addresses_path = Path(temp_dir) / "addresses-full.json"
            roads_path = Path(temp_dir) / "roads-full.json"
            regulatory_path = Path(temp_dir) / "limites-regulamentares" / "30-unidades-operativas-de-planeamento-e-gestao.json"

            self.assertTrue(manifest_path.exists())
            self.assertTrue(parcels_path.exists())
            self.assertTrue(addresses_path.exists())
            self.assertTrue(roads_path.exists())
            self.assertTrue(regulatory_path.exists())
            self.assertEqual(manifest["datasets"]["parcels"]["count"], 1)
            self.assertEqual(manifest["datasets"]["addresses"]["count"], 1)
            self.assertEqual(manifest["datasets"]["roads"]["count"], 1)
            self.assertEqual(len(manifest["datasets"]["regulatoryLimits"]["layers"]), 3)

            written_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(written_manifest["datasets"]["parcels"]["file"], "parcels-livre-expectante.json")
            self.assertEqual(
                written_manifest["datasets"]["regulatoryLimits"]["layers"][0]["file"],
                "limites-regulamentares/30-unidades-operativas-de-planeamento-e-gestao.json",
            )


if __name__ == "__main__":
    unittest.main()
