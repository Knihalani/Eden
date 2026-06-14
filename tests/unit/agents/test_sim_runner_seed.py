"""Tests for the deterministic test-seeding hook (visual builder §8.1).

The builder lets the user pin a ``seed:`` integer into
``eden-sim-eval.yaml``. The runner must propagate that seed
into every child process as the ``EDEN_SEED`` env var, and the
generated driver script must call ``random.seed(int(EDEN_SEED))``
before any user-level randomness.

These tests exercise ``SubprocessSimAdapter`` end-to-end with
tiny synthetic uploads.
"""

from __future__ import annotations

import json
import os
import random
import tempfile
import textwrap
import unittest
from pathlib import Path

from eden.sim_runner import SubprocessSimAdapter, _seed_env


def _write_upload(
    tmp: Path,
    *,
    seed: int | None,
    scenario_body: str,
) -> Path:
    """Create a fake agent upload with an eden-sim-eval.yaml and
    a single scenarios/``scenario_x.py`` whose ``SimEnv`` writes
    the first ``random.random()`` value to a file the test can
    read back.
    """
    upload = tmp / "upload"
    upload.mkdir(parents=True)
    scenarios_dir = upload / "scenarios"
    scenarios_dir.mkdir()

    yaml = {
        "target": {"module": "agent", "framework": "raw"},
        "scenarios": [
            {
                "id": "scenario_x",
                "env_class_name": "SimEnv",
                "max_episodes": 1,
            }
        ],
    }
    if seed is not None:
        yaml["seed"] = seed

    (upload / "eden-sim-eval.yaml").write_text(
        "\n".join(f"{k}: {v}" for k, v in _flatten(yaml)) + "\n"
    )

    (scenarios_dir / "scenario_x.py").write_text(scenario_body)
    return upload


def _flatten(obj, prefix=""):
    """Tiny YAML emitter sufficient for the test fixtures."""
    if isinstance(obj, dict):
        out = []
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                out.append((f"{prefix}{k}", v))
            else:
                out.append((f"{prefix}{k}", v))
        return out
    return [(prefix, obj)]


def _scenario_body(out_file: Path) -> str:
    return textwrap.dedent(
        f"""
        import os, random, json

        class SimEnv:
            def reset(self):
                return {{}}, {{}}
            def step(self, action):
                # Write the first random draw so the parent test
                # can read it back from the disk.
                with open("{out_file}", "w") as f:
                    f.write(repr(random.random()))
                return {{}}, 0.0, True, False, {{}}
        """
    )


class SeedEnvHelperTests(unittest.TestCase):
    def test_none_when_no_seed(self):
        self.assertIsNone(_seed_env({}))

    def test_none_when_seed_missing(self):
        self.assertIsNone(_seed_env({"target": {"module": "agent"}}))

    def test_none_when_seed_is_none(self):
        self.assertIsNone(_seed_env({"seed": None}))

    def test_none_when_seed_negative(self):
        self.assertIsNone(_seed_env({"seed": -1}))

    def test_none_when_seed_not_int(self):
        self.assertIsNone(_seed_env({"seed": "abc"}))

    def test_int_seed_produces_env(self):
        env = _seed_env({"seed": 42})
        self.assertIsNotNone(env)
        self.assertEqual(env["EDEN_SEED"], "42")

    def test_int_seed_preserves_other_env_vars(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["FOO_BAR_BAZ"] = "present"
            try:
                env = _seed_env({"seed": 7})
                self.assertEqual(env.get("FOO_BAR_BAZ"), "present")
                self.assertEqual(env["EDEN_SEED"], "7")
            finally:
                del os.environ["FOO_BAR_BAZ"]


class DriverForTests(unittest.TestCase):
    def test_prepends_random_seed_when_seed_set(self):
        adapter = SubprocessSimAdapter()
        scenario = {
            "id": "scenario_x",
            "env_class_name": "SimEnv",
            "max_episodes": 1,
        }
        body = adapter._driver_for(scenario)
        # The seed import + random.seed call must be present at
        # the top of the driver, before any other code.
        self.assertLess(
            body.index('import os, random'),
            body.index('import json, importlib.util'),
        )
        self.assertIn('random.seed(int(_seed))', body)
        self.assertIn('os.environ.get("EDEN_SEED")', body)


class EndToEndSeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_seed_propagates_to_driver(self):
        """Two runs with seed=42 must produce identical output."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            out1 = tmp / "out1.txt"
            out2 = tmp / "out2.txt"
            upload1 = _write_upload(
                tmp / "u1",
                seed=42,
                scenario_body=_scenario_body(out1),
            )
            upload2 = _write_upload(
                tmp / "u2",
                seed=42,
                scenario_body=_scenario_body(out2),
            )
            adapter = SubprocessSimAdapter()
            r1 = await adapter.run_scenarios(
                upload_path=upload1,
                eval_yaml={
                    "target": {"module": "agent"},
                    "scenarios": [
                        {
                            "id": "scenario_x",
                            "env_class_name": "SimEnv",
                            "max_episodes": 1,
                        }
                    ],
                    "seed": 42,
                },
            )
            r2 = await adapter.run_scenarios(
                upload_path=upload2,
                eval_yaml={
                    "target": {"module": "agent"},
                    "scenarios": [
                        {
                            "id": "scenario_x",
                            "env_class_name": "SimEnv",
                            "max_episodes": 1,
                        }
                    ],
                    "seed": 42,
                },
            )
            self.assertEqual(r1.status, "passed", r1.error)
            self.assertEqual(r2.status, "passed", r2.error)
            self.assertTrue(out1.exists(), "first run did not write output")
            self.assertTrue(out2.exists(), "second run did not write output")
            self.assertEqual(out1.read_text(), out2.read_text())

    async def test_no_seed_leaves_random_alone(self):
        """Two runs without a seed must differ (extremely likely)."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            out1 = tmp / "out1.txt"
            out2 = tmp / "out2.txt"
            upload1 = _write_upload(
                tmp / "u1",
                seed=None,
                scenario_body=_scenario_body(out1),
            )
            upload2 = _write_upload(
                tmp / "u2",
                seed=None,
                scenario_body=_scenario_body(out2),
            )
            adapter = SubprocessSimAdapter()
            r1 = await adapter.run_scenarios(
                upload_path=upload1,
                eval_yaml={
                    "target": {"module": "agent"},
                    "scenarios": [
                        {
                            "id": "scenario_x",
                            "env_class_name": "SimEnv",
                            "max_episodes": 1,
                        }
                    ],
                },
            )
            r2 = await adapter.run_scenarios(
                upload_path=upload2,
                eval_yaml={
                    "target": {"module": "agent"},
                    "scenarios": [
                        {
                            "id": "scenario_x",
                            "env_class_name": "SimEnv",
                            "max_episodes": 1,
                        }
                    ],
                },
            )
            self.assertEqual(r1.status, "passed", r1.error)
            self.assertEqual(r2.status, "passed", r2.error)
            # Sanity: not equal. The chance of collision on
            # random.random() is ~2^-53.
            self.assertNotEqual(out1.read_text(), out2.read_text())


if __name__ == "__main__":
    unittest.main()
