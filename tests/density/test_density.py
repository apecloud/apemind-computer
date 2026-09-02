#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("density", ROOT / "scripts" / "density.py")
assert SPEC and SPEC.loader
density = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = density
SPEC.loader.exec_module(density)


class DensitySafetyTest(unittest.TestCase):
    def test_prefix_must_start_with_density(self) -> None:
        self.assertEqual(density.assert_safe_prefix("density"), "density")
        self.assertEqual(density.assert_safe_prefix("density-stg"), "density-stg")
        for prefix in ("", "ci", "user", "den", "Density", "density/" ):
            with self.assertRaises(ValueError):
                density.assert_safe_prefix(prefix)

    def test_keys_stay_under_host_id_rules(self) -> None:
        keys = density.instance_keys("density", 1, 3)
        self.assertEqual(keys, ["density0001", "density0002", "density0003"])
        self.assertTrue(all(density.owns_key("density", key) for key in keys))
        self.assertFalse(density.owns_key("density", "cic4da7207703ac076"))
        self.assertFalse(density.owns_key("density", "density0001/../etc"))

    def test_stop_when_capacity_or_many_failures(self) -> None:
        full = density.BatchResult(ok=0, fail=1, lat_s={}, fail_codes={"507:max instances reached": 1})
        self.assertEqual(
            density.should_stop(full, {"instances": {"running": 10, "max": 200}}, 10),
            "host returned 507 capacity",
        )
        many = density.BatchResult(ok=2, fail=8, lat_s={}, fail_codes={"409:start failed": 8})
        self.assertEqual(density.should_stop(many, {"instances": {"running": 12, "max": 200}}, 10), "too many failures in this batch")
        ok = density.BatchResult(ok=10, fail=0, lat_s={}, fail_codes={})
        self.assertIsNone(density.should_stop(ok, {"instances": {"running": 10, "max": 200}}, 10))
        self.assertEqual(
            density.should_stop(ok, {"instances": {"running": 200, "max": 200}}, 10),
            "at max_instances",
        )


if __name__ == "__main__":
    unittest.main()
