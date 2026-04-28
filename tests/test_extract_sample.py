import io
import json
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


if __name__ == "__main__":
    unittest.main()
