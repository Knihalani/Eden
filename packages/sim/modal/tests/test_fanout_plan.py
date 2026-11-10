"""fanout_plan.py: shards, the cap split, commands and merging (python3 -I -m unittest discover -s packages/sim/modal)."""
import json
import os
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fanout_plan as plan  # noqa: E402

PI = ["--conditions", "tools,eden", "--model", "claude-haiku-5-5"]


class PiAbPlan(unittest.TestCase):
    def test_one_seed_per_shard_and_the_cap_split(self):
        shards = plan.plan_pi_ab("train1,train2,train3", "41,42,43,44", 4.0, "r", PI, suites_per_shard=2)
        self.assertEqual(len(shards), 8)
        self.assertTrue(all(len(s.seeds) == 1 for s in shards))
        self.assertEqual({tuple(s.suites) for s in shards}, {("train1", "train2"), ("train3",)})
        self.assertEqual([s.cap_usd for s in shards], [0.5] * 8)
        self.assertLessEqual(sum(s.cap_usd for s in shards), 4.0)
        self.assertEqual(len({s.run_label for s in shards}), 8)

    def test_a_cards_list_is_merged_into_one_file_per_shard(self):
        args = PI + ["--cards", "a.jsonl,b.jsonl"]
        shard = plan.plan_pi_ab("train1", "41", 1.0, "r", args)[0]
        cmd = plan.shard_command(shard)
        merged = plan.shard_paths(shard)["cards_in"]
        self.assertEqual(cmd[cmd.index("--cards") + 1], merged)
        self.assertNotIn("a.jsonl,b.jsonl", cmd)
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as out:
            with open(os.path.join(repo, "a.jsonl"), "w") as f:
                f.write('{"h":"1"}')  # no trailing newline: the merge adds one
            with open(os.path.join(repo, "b.jsonl"), "w") as f:
                f.write('{"h":"2"}\n')
            old = plan.SHARD_DIR
            plan.SHARD_DIR = out
            try:
                dest = plan.prepare_shard(shard, repo)
            finally:
                plan.SHARD_DIR = old
            with open(dest) as f:
                self.assertEqual(f.read().splitlines(), ['{"h":"1"}', '{"h":"2"}'])

    def test_one_cards_file_is_passed_as_is(self):
        shard = plan.plan_pi_ab("train1", "41", 1.0, "r", PI + ["--cards", "a.jsonl"])[0]
        cmd = plan.shard_command(shard)
        self.assertEqual(cmd[cmd.index("--cards") + 1], "a.jsonl")
        self.assertIsNone(plan.prepare_shard(shard, "/nonexistent"))

    def test_the_split_rounds_down(self):
        each = plan.split_cap(1.0, 3)
        self.assertEqual(each, 0.333)
        self.assertLessEqual(each * 3, 1.0)

    def test_no_cap_no_run(self):
        for cap in (None, 0, -1, float("nan"), float("inf")):
            with self.assertRaises(plan.PlanError):
                plan.plan_pi_ab("train1", "41", cap, "r", PI)
        with self.assertRaises(plan.PlanError):
            plan.split_cap(0.001, 10)

    def test_the_planner_owns_spend_and_output_flags(self):
        for owned in ("--spend-cap", "--spend-ledger", "--seeds", "--out", "--budget", "--run-label"):
            with self.assertRaises(plan.PlanError):
                plan.plan_pi_ab("train1", "41", 1.0, "r", PI + [owned, "x"])
        with self.assertRaises(plan.PlanError):
            plan.plan_pi_ab("train1", "41", 1.0, "r", PI + ["--spend-cap=9"])

    def test_held_out_needs_blind(self):
        with self.assertRaises(plan.PlanError):
            plan.plan_pi_ab("heldout13", "41", 1.0, "r", PI)
        shards = plan.plan_pi_ab("heldout13", "41", 1.0, "r", PI + ["--blind"])
        self.assertNotIn("--blind", shards[0].args)

    def test_each_shard_gets_its_own_ledger_cap_and_budget(self):
        s = plan.plan_pi_ab("train1", "41,42", 1.0, "r", PI)[1]
        cmd = plan.shard_command(s)
        val = lambda f: cmd[cmd.index(f) + 1]  # noqa: E731
        self.assertEqual(cmd[:2], ["bun", "packages/sim/src/lab/pi-ab.ts"])
        self.assertEqual(val("--seeds"), "42")
        self.assertEqual(val("--spend-cap"), "0.500")
        self.assertEqual(val("--budget"), "0.500")
        self.assertTrue(val("--spend-ledger").endswith(".ledger.jsonl"))
        self.assertLess(float(val("--spend-headroom")), 0.5)
        self.assertEqual(cmd[-4:], PI)

    def test_scale_runs_get_bigger_containers(self):
        self.assertEqual(plan.resources("pi-ab", PI)["memory"], plan.MEMORY_MIB["pi-ab"])
        big = plan.resources("pi-ab", PI + ["--noise-sources", "995"])["memory"]
        self.assertGreaterEqual(big, 20000)
        self.assertTrue(plan.is_scale(["--noise-sources=995"]))
        self.assertFalse(plan.is_scale(["--noise-sources", "5"]))


class FunnelPlan(unittest.TestCase):
    def test_cells_and_blocks(self):
        shards = plan.plan_funnel("train1,train2", "41,42,43", "f", ["--", "--noise-sources", "995"])
        self.assertEqual(len(shards), 6)
        cells = {(s.suites[0], s.seeds[0]) for s in shards}
        self.assertEqual(len(cells), 6)
        blocks = plan.plan_funnel("train1,train2", "41,42,43", "f", [], shards=3)
        covered = [(a, b) for s in blocks for a in s.suites for b in s.seeds]
        self.assertEqual(sorted(covered), sorted((a, b) for a in ("train1", "train2") for b in ("41", "42", "43")))
        self.assertTrue(all(s.cap_usd == 0 for s in blocks))

    def test_funnel_command_keeps_hidden_funnel_flags_after_the_separator(self):
        s = plan.plan_funnel("heldout13", "41", "f", ["--blind", "--jobs", "2", "--", "--noise-sources", "995"])[0]
        cmd = plan.shard_command(s)
        self.assertEqual(cmd.count("--blind"), 1)
        self.assertLess(cmd.index("--jobs"), cmd.index("--"))
        self.assertGreater(cmd.index("--noise-sources"), cmd.index("--"))

    def test_funnel_refuses_live_calls_and_owned_flags(self):
        with self.assertRaises(plan.PlanError):
            plan.plan_funnel("train1", "41", "f", ["--", "--reader", "live"])
        with self.assertRaises(plan.PlanError):
            plan.plan_funnel("train1", "41", "f", ["--json", "x.json"])
        with self.assertRaises(plan.PlanError):
            plan.plan_funnel("heldout13", "41", "f", [])


def result(name, kind, code=0, ledger="", out=None, timeline=None, cap=0.5):
    files = {"ledger.jsonl": ledger.encode()}
    if out is not None:
        files["out.json"] = json.dumps(out).encode()
    for k, v in (timeline or {}).items():
        files[f"out.timeline/{k}"] = v.encode()
    return {"name": name, "kind": kind, "code": code, "capUsd": cap, "seconds": 1.0, "files": files}


class Merge(unittest.TestCase):
    def test_spend_is_summed_and_checked_against_the_cap(self):
        rows = [json.dumps({"costUsd": 0.1, "run": "r-000"}), json.dumps({"costUsd": 0.15, "run": "r-000"})]
        with tempfile.TemporaryDirectory() as d:
            m = plan.merge(d, [result("s000", "pi-ab", ledger="\n".join(rows) + "\n{torn"),
                               result("s001", "pi-ab", code=1, ledger=json.dumps({"costUsd": 0.6}), cap=0.5)], 1.0)
            self.assertAlmostEqual(m["spentUsd"], 0.85)
            self.assertTrue(m["withinCap"])
            self.assertEqual(m["overCap"], ["s001"])
            self.assertEqual(m["failed"], ["s001"])
            with open(os.path.join(d, "ledger.jsonl")) as f:
                self.assertEqual(len(f.read().splitlines()), 4)
            m2 = plan.merge(d, [result("s000", "pi-ab", ledger=json.dumps({"costUsd": 1.2}), cap=1.0)], 1.0)
            self.assertFalse(m2["withinCap"])

    def test_pi_ab_results_point_at_their_local_timeline(self):
        with tempfile.TemporaryDirectory() as d:
            r = result("s000-train1-41", "pi-ab", out={"timeline": "/tmp/shard/x.timeline", "tasks": []},
                       timeline={"tasks.jsonl": "{}\n"})
            plan.merge(d, [r], 1.0)
            with open(os.path.join(d, "s000-train1-41", "out.json")) as f:
                doc = json.load(f)
            self.assertEqual(doc["timeline"], os.path.join(d, "s000-train1-41", "out.timeline"))
            self.assertTrue(os.path.exists(doc["timeline"] + "/tasks.jsonl"))
            cmds = plan.report_commands(d, [r])
            self.assertEqual([c[1] for c in cmds], ["packages/sim/src/lab/pi-ab-report.ts",
                                                    "packages/sim/src/lab/pi-cost-report.ts"])

    def test_funnel_rows_are_pooled_for_the_score(self):
        with tempfile.TemporaryDirectory() as d:
            a = result("s000", "funnel", out={"perTask": [{"suite": "train1", "variant": "hidden"}]}, cap=0)
            b = result("s001", "funnel", out={"perTask": [{"suite": "train2", "variant": "control"}]}, cap=0)
            plan.merge(d, [a, b])
            with open(os.path.join(d, "funnel.json")) as f:
                self.assertEqual(len(json.load(f)["perTask"]), 2)
            self.assertEqual(plan.report_commands(d, [a, b])[0][2], "packages/sim/lab/scripts/funnel-score.py")

    def test_a_shard_cannot_write_outside_the_run(self):
        with tempfile.TemporaryDirectory() as d:
            bad = result("s000", "funnel")
            bad["files"]["../../escape"] = b"x"
            with self.assertRaises(ValueError):
                plan.write_shard(d, bad)
            with self.assertRaises(ValueError):
                plan.write_shard(d, {"name": "/abs", "files": {}})

    def test_compressed_files_round_trip(self):
        # lab_fanout.py returns zlib-compressed bytes and unpacks them before merge.
        self.assertEqual(zlib.decompress(zlib.compress(b"abc")), b"abc")


class Cli(unittest.TestCase):
    def test_plan_prints_and_refuses(self):
        self.assertEqual(plan.main(["plan", "--kind", "pi-ab", "--suites", "train1", "--seeds", "41"]), 2)


if __name__ == "__main__":
    unittest.main()
