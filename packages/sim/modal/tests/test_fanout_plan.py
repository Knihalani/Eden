"""fanout_plan.py: shards, the cap split, commands and merging (python3 -I -m unittest discover -s packages/sim/modal)."""
import json
import os
import shutil
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


class Resume(unittest.TestCase):
    """R4 (D813): each shard is saved as it returns, and a restarted collector re-launches only the unfinished ones."""

    def setUp(self):
        self.planned = plan.plan_pi_ab("train1", "41,42,43", 3.0, "r", PI)
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def returned(self, shard, code=0, commit="c1"):
        r = result(shard.name, "pi-ab", code=code, ledger=json.dumps({"costUsd": 0.4}),
                   out={"timeline": "/tmp/shard/x.timeline", "results": [shard.seeds[0]]},
                   timeline={"tasks.jsonl": "{}\n"}, cap=shard.cap_usd)
        plan.save_shard(self.dir, r, plan.shard_fingerprint(shard, commit))
        return r

    def test_a_restart_runs_only_the_unfinished_shards_and_merges_as_one_run(self):
        a, b, c = self.planned
        self.returned(a)
        self.returned(b, code=1)  # failed: it runs again
        # Killed before c returned. Without --resume the finished shard is not overwritten.
        with self.assertRaises(plan.PlanError):
            plan.resume_plan(self.dir, self.planned, "c1")
        finished, left = plan.resume_plan(self.dir, self.planned, "c1", resume=True)
        self.assertEqual([r["name"] for r in finished], [a.name])
        self.assertEqual([s.name for s in left], [b.name, c.name])
        # What was read back merges as the shard returned it: its ledger, results and local timeline.
        rest = [self.returned(b), self.returned(c)]
        m = plan.merge(self.dir, finished + rest, 3.0)
        self.assertAlmostEqual(m["spentUsd"], 1.2)
        self.assertEqual(m["failed"], [])
        with open(os.path.join(self.dir, a.name, "out.json")) as f:
            doc = json.load(f)
        self.assertEqual(doc["results"], [a.seeds[0]])
        self.assertEqual(doc["timeline"], os.path.join(self.dir, a.name, "out.timeline"))
        self.assertIn("out.timeline/tasks.jsonl", finished[0]["files"])
        self.assertNotIn(plan.RETURNED, finished[0]["files"])
        # Everything finished: a second restart re-launches nothing.
        self.assertEqual(len(plan.resume_plan(self.dir, self.planned, "c1", resume=True)[1]), 0)

    def test_another_plan_or_commit_cannot_reuse_the_run(self):
        self.returned(self.planned[0])
        with self.assertRaises(plan.PlanError):
            plan.resume_plan(self.dir, self.planned, "c2", resume=True)
        cheaper = plan.plan_pi_ab("train1", "41,42,43", 1.5, "r", PI)
        with self.assertRaises(plan.PlanError):
            plan.resume_plan(self.dir, cheaper, "c1", resume=True)
        other = plan.plan_pi_ab("train2", "44", 1.0, "r", PI)
        with self.assertRaises(plan.PlanError):
            plan.resume_plan(self.dir, other, "c1", resume=True)

    def test_a_rerun_shard_starts_clean_and_its_failed_attempt_still_counts(self):
        a = self.planned[0]
        failed = result(a.name, "pi-ab", code=1, ledger=json.dumps({"costUsd": 0.3}), cap=a.cap_usd)
        failed["files"]["stale.txt"] = b"from the failed attempt"
        plan.save_shard(self.dir, failed, plan.shard_fingerprint(a, "c1"))
        again = self.returned(a)
        self.assertNotIn("stale.txt", plan.load_shard(self.dir, a)["files"])
        m = plan.merge(self.dir, [again], 3.0)
        self.assertAlmostEqual(m["spentUsd"], 0.4)
        self.assertAlmostEqual(m["earlierAttemptsUsd"], 0.3)

    def test_the_wave_loop_saves_shards_in_completion_order_and_names_the_lost_one(self):
        a, b, c = self.planned
        r_c = result(c.name, "pi-ab", ledger="", cap=c.cap_usd)
        r_a = result(a.name, "pi-ab", ledger="", cap=a.cap_usd)
        lines = []
        # c finishes first, then Modal loses one shard (an exception, no name), then a.
        done = plan.collect_wave(self.dir, [a, b, c], iter([r_c, RuntimeError("lost"), r_a]), "c1", "pi-ab",
                                 log=lines.append)
        self.assertEqual([(r["name"], r["code"]) for r in done], [(c.name, 0), (a.name, 0), (b.name, -1)])
        self.assertTrue(any("failed in Modal" in line for line in lines))
        finished, left = plan.resume_plan(self.dir, self.planned, "c1", resume=True)
        self.assertEqual(sorted(r["name"] for r in finished), sorted([a.name, c.name]))
        self.assertEqual([s.name for s in left], [b.name])

    def test_a_new_run_directory_runs_everything(self):
        finished, left = plan.resume_plan(os.path.join(self.dir, "new"), self.planned, "c1")
        self.assertEqual((finished, len(left)), ([], 3))


def with_requests(name, sent, limited):
    return result(name, "pi-ab", out={"requests": {"sent": sent, "retried": limited, "statuses": {"429": limited}}})


class Presets(unittest.TestCase):
    def test_a_preset_is_one_command_and_args_after_it_replace_its_flags(self):
        kind, suites, args = plan.with_preset("bench-fewer", ["--variants", "hidden", "--days", "8"])
        self.assertEqual((kind, suites), ("pi-ab", "train"))
        self.assertEqual(args.count("--variants"), 1)
        self.assertEqual(plan.flag_value(args, "--variants"), "hidden")
        self.assertEqual(plan.flag_value(args, "--conditions"), "tools,eden,eden~minus-fewer")
        self.assertEqual(json.loads(plan.flag_value(args, "--variant-config")), {"minus-fewer": {"pushCandidatesSettled": 0}})
        self.assertEqual(plan.flag_value(args, "--days"), "8")
        self.assertIn("--tenant-prompt", args)
        # pi-ab refuses --variants beside --days: the preset's own is dropped with it.
        self.assertNotIn("--variants", plan.with_preset("bench-fewer", ["--days", "8"])[2])
        shards = plan.plan_pi_ab(suites, "41-43", 3.0, "r", args)
        self.assertEqual([s.seeds for s in shards], [["41"], ["42"], ["43"]])

    def test_every_preset_plans_and_names_only_variants_it_configures(self):
        for name in plan.PRESETS:
            kind, suites, args = plan.with_preset(name)
            shards = plan.plan_pi_ab(suites, "41", 1.0, "r", args)
            given = json.loads(plan.flag_value(args, "--variant-config", "{}"))
            for cond in plan.split_list(plan.flag_value(shards[0].args, "--conditions")):
                if "~" in cond:
                    self.assertIn(cond.split("~", 1)[1].split("+")[0], given, name)

    def test_the_yield_bench_runs_the_default_against_sourceYield_off_at_scale(self):
        _, suites, args = plan.with_preset("bench-yield", ["--variants", "hidden", "--limit", "16"])
        self.assertEqual(plan.flag_value(args, "--conditions"), "eden,eden~off-yield")
        self.assertEqual(json.loads(plan.flag_value(args, "--variant-config")), {"off-yield": {"sourceYield": False}})
        self.assertEqual((plan.flag_value(args, "--noise-sources"), plan.flag_value(args, "--notify-share")),
                         ("995", "0.05"))
        shards = plan.plan_pi_ab(suites, "45-68", 3.6, "r", args)
        self.assertEqual((len(shards), shards[0].cap_usd), (24, 0.15))
        # Two arms on six hidden worlds: five shards at once under 60 streams, in the 1,000-source containers.
        self.assertEqual((plan.streams_per_shard(shards[0]), plan.wave_width(shards)), (12, 5))
        self.assertEqual(plan.resources("pi-ab", args), plan.resources("pi-ab", ["--noise-sources", "995"]))

    def test_an_unknown_preset_and_a_planner_owned_flag_are_refused(self):
        with self.assertRaises(plan.PlanError):
            plan.with_preset("bench-nothing")
        _, suites, args = plan.with_preset("bench-tools", ["--budget", "9"])
        with self.assertRaises(plan.PlanError):
            plan.plan_pi_ab(suites, "41", 1.0, "r", args)

    def test_an_equals_flag_replaces_the_presets_and_a_valueless_one_is_refused(self):
        _, _, args = plan.with_preset("bench-fewer", ["--conditions=tools,eden"])
        self.assertEqual(args.count("--conditions"), 1)
        self.assertEqual(plan.flag_value(args, "--conditions"), "tools,eden")
        self.assertFalse(any(a.startswith("--conditions=") for a in args))
        for extra in (["--cards"], ["--conditions", "--tenant-prompt"], ["--conditions="], ["--variants", ""],
                      ["--days"]):
            with self.assertRaises(plan.PlanError):
                plan.with_preset("bench-fewer", extra)

    def test_a_shard_with_no_arm_is_refused_not_counted_as_zero_streams(self):
        shard = plan.plan_pi_ab("train1", "41", 1.0, "r", ["--conditions", ","])[0]
        with self.assertRaises(plan.PlanError):
            plan.wave_width([shard])

    def test_seed_ranges(self):
        self.assertEqual(plan.expand_seeds("41-44,48,43"), ["41", "42", "43", "44", "48"])
        with self.assertRaises(plan.PlanError):
            plan.expand_seeds("44-41")


class Concurrency(unittest.TestCase):
    def shards(self, extra=(), seeds="41-48", preset="bench-fewer"):
        _, suites, args = plan.with_preset(preset, list(extra))
        return plan.plan_pi_ab(suites, seeds, 8.0, "r", args)

    def test_streams_are_arms_times_worlds(self):
        # train is six suites; hidden and control are a world each: 3 arms x 12 worlds.
        self.assertEqual(plan.streams_per_shard(self.shards()[0]), 36)
        self.assertEqual(plan.streams_per_shard(self.shards(["--variants", "hidden"])[0]), 18)
        # A --days user is one world a seed.
        self.assertEqual(plan.streams_per_shard(self.shards(["--days", "8"])[0]), 3)
        self.assertEqual(plan.streams_per_shard(plan.plan_funnel("train1", "41", "r")[0]), 0)

    def test_waves_stay_under_the_streams_limit(self):
        self.assertEqual(plan.wave_width(self.shards()), 1)                       # 36 a shard under 60
        self.assertEqual(plan.wave_width(self.shards(["--variants", "hidden"])), 3)  # 18 a shard
        self.assertEqual(plan.wave_width(self.shards(["--days", "8"])), 20)
        # One shard over the limit is refused, never run above it; so is a suite group the planner cannot count.
        with self.assertRaises(plan.PlanError):
            plan.wave_width(self.shards(), max_streams=10)
        self.assertEqual(plan.wave_width(self.shards(), max_streams=36), 1)
        for group in plan.UNCOUNTED_GROUPS:
            with self.assertRaises(plan.PlanError):
                plan.wave_width(plan.plan_pi_ab(group, "41", 1.0, "r", ["--conditions", "tools,eden"]))
        self.assertEqual(plan.wave_width(plan.plan_funnel("train1,train2", "41", "r")), 2)
        with self.assertRaises(plan.PlanError):
            plan.wave_width(self.shards(), max_streams=0)
        wave, left = plan.waves(self.shards(["--variants", "hidden"]), 3)
        self.assertEqual((len(wave), len(left)), (3, 5))

    def test_a_wave_that_met_the_rate_limit_halves_the_next(self):
        calm = [with_requests("s000", 1000, 5), with_requests("s001", 1000, 0)]
        self.assertEqual(plan.next_width(4, calm), 4)
        storm = [with_requests("s000", 1000, 400), with_requests("s001", 1000, 0)]
        self.assertEqual(plan.retry_share(storm), (0.2, 2000, 400))
        self.assertEqual(plan.next_width(4, storm), 2)
        self.assertEqual(plan.next_width(1, storm), 1)
        # A failed shard has no summary: it neither narrows nor hides the others' retries.
        self.assertEqual(plan.next_width(4, [{"name": "s002", "files": {}}]), 4)
        self.assertEqual(plan.next_width(4, storm + [{"name": "s002", "files": {}}]), 2)


class Cli(unittest.TestCase):
    def test_plan_prints_and_refuses(self):
        self.assertEqual(plan.main(["plan", "--kind", "pi-ab", "--suites", "train1", "--seeds", "41"]), 2)


if __name__ == "__main__":
    unittest.main()
