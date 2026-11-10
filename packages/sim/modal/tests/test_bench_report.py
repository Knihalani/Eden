"""bench_report.py: template clusters, the clustered bootstrap, McNemar, the MDE and the variance split."""
import json
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bench_report as bench  # noqa: E402


def shard(run, name, seed, outcomes, regrade=None, asks=None):
    """A shard directory: `outcomes` maps (suite, template, kind) -> {arm: raised}."""
    d = os.path.join(run, name)
    os.makedirs(os.path.join(d, "out.timeline"))
    tasks, results = [], []
    for (suite, template, kind), arms in outcomes.items():
        tid = f"w{seed}:{suite}{'' if kind == 'hidden' else '-' + kind}:{template}"
        tasks.append({"id": tid, "suite": suite, "kind": kind, "must": [{"id": template, "detail": "x"}]})
        for arm, raised in arms.items():
            results.append({"task": tid, "condition": arm, "facts": None if raised is None else {template: bool(raised)},
                            "costUsd": 0.001 if arm == "tools" else 0.002, "edenCostUsd": 0, "wallMs": 2000,
                            "modelCalls": 2})
    with open(os.path.join(d, "out.json"), "w") as f:
        json.dump({"seeds": [seed], "tasks": tasks, "results": results,
                   "background": [{"cardsUsd": 0.001 * sum(1 for r in results if r["condition"] != "tools")}]}, f)
    with open(os.path.join(d, "out.timeline", "tasks.jsonl"), "w") as f:
        for (task, arm), (calls, questions) in (asks or {}).items():
            events = [{"ev": "tool.ask_context", "data": {"tool": "ask_context"}}] * calls
            events += [{"ev": "tool.ask_context", "data": {"error": False}}] * calls
            events += [{"ev": "eden.ask", "data": {"question": "q", "items": 1}}] * questions + [{"ev": "eden.ask"}]
            f.write(json.dumps({"task": task, "condition": arm, "events": events}) + "\n")
    if regrade:
        with open(os.path.join(d, "regrade-hidden.json"), "w") as f:
            json.dump({"graded": regrade}, f)
    return d


class Load(unittest.TestCase):
    def test_rows_pair_arms_by_task_and_carry_template_and_seed(self):
        with tempfile.TemporaryDirectory() as run:
            shard(run, "s000", 41, {("train1", "isa", "hidden"): {"tools": 0, "eden": 1},
                                    ("train1", "isa", "control"): {"tools": 0, "eden": 0},
                                    ("train1", "mot", "hidden"): {"tools": 0, "eden": None}},
                  asks={("w41:train1:isa", "eden"): (2, 3)})
            rows, stats = bench.load([("g", [run])])
            self.assertEqual(stats["ungraded"], 1)
            hidden = bench.pairs(rows, "eden", "tools", "hidden")
            self.assertEqual(hidden, [("train1:isa", "41", 1.0, 1.0, 0.0)])   # the ungraded task has no pair
            self.assertEqual(len(bench.pairs(rows, "eden", "tools", "concerns")), 1)
            # $ per 1,000: the agent's bill plus, in arms with Eden, a share of the background cards.
            usd = {p[0]: (p[3], p[4]) for p in bench.pairs(rows, "eden", "tools", "usd")}
            self.assertAlmostEqual(usd["train1:isa"][0], 3.0)
            self.assertAlmostEqual(usd["train1:isa"][1], 1.0)
            row = rows[("g", os.path.join(run, "s000"), "w41:train1:isa")]
            self.assertEqual((row["arms"]["eden"]["askCalls"], row["arms"]["eden"]["questions"]), (2.0, 3.0))

    def test_sonnet_replaces_the_runs_verdict_only_where_it_graded(self):
        with tempfile.TemporaryDirectory() as run:
            shard(run, "s000", 41, {("train1", "isa", "hidden"): {"eden": 1, "tools": 1},
                                    ("train1", "mot", "hidden"): {"eden": 1, "tools": 0}},
                  regrade=[{"task": "w41:train1:isa", "condition": "eden", "grader": "claude-sonnet-5-5",
                            "facts": {"isa": False}},
                           {"task": "w41:train1:mot", "condition": "eden", "grader": "claude-sonnet-5-5",
                            "facts": None, "error": "x"},
                           {"task": "w41:train1:isa", "condition": "tools", "grader": "claude-haiku-5-5",
                            "facts": {"isa": False}}])
            plain, _ = bench.load([("g", [run])])
            rows, stats = bench.load([("g", [run])], sonnet=True)
            self.assertEqual((stats["sonnetGraded"], stats["sonnetFailed"]), (1, 1))
            get = lambda rs: {p[0]: (p[3], p[4]) for p in bench.pairs(rs, "eden", "tools", "hidden")}
            self.assertEqual(get(plain), {"train1:isa": (1.0, 1.0), "train1:mot": (1.0, 0.0)})
            self.assertEqual(get(rows), {"train1:isa": (0.0, 1.0), "train1:mot": (1.0, 0.0)})


def synthetic(templates, seeds, effect_of):
    """[(template, seed, diff, a, b)] with a difference per (template index, seed index)."""
    return [(f"t{t}", str(s), effect_of(t, s), 0.0, 0.0) for t in range(templates) for s in range(seeds)]


class Stats(unittest.TestCase):
    def test_clustered_errors_widen_the_interval_and_independent_ones_do_not(self):
        # Every seed of a template shares its difference: 40 independent values, not 400.
        shared = synthetic(40, 10, lambda t, s: 1.0 if t % 2 else 0.0)
        flat, clustered = bench.naive(shared), bench.cluster_boot(bench.clusters(shared, 0), 2000)
        self.assertAlmostEqual(clustered[0], 0.5)
        self.assertGreater(clustered[3], 2.5 * flat[3])
        # Differences that vary only inside templates: clustering by template changes little.
        mixed = synthetic(40, 10, lambda t, s: 1.0 if (t + s) % 2 else 0.0)
        flat, clustered = bench.naive(mixed), bench.cluster_boot(bench.clusters(mixed, 0), 2000)
        self.assertLess(clustered[3], 1.2 * flat[3])

    def test_the_bootstrap_is_a_ratio_over_unequal_clusters_and_repeats(self):
        cl = [(3.0, 3), (0.0, 1), (1.0, 2)]
        a, b = bench.cluster_boot(cl, 500), bench.cluster_boot(cl, 500)
        self.assertEqual(a, b)
        self.assertAlmostEqual(a[0], 4 / 6)
        self.assertTrue(0 <= a[1] <= a[0] <= a[2] <= 1)
        self.assertIsNone(bench.cluster_boot([], 10))
        self.assertTrue(math.isnan(bench.cluster_boot([(1.0, 2)], 10)[3]))

    def test_mcnemar_is_the_exact_binomial_on_discordant_pairs(self):
        ps = [("t", "1", 1.0, 1.0, 0.0)] * 8 + [("t", "1", -1.0, 0.0, 1.0)] * 2 + [("t", "1", 0.0, 1.0, 1.0)] * 50
        b, c, p = bench.mcnemar(ps)
        self.assertEqual((b, c), (8, 2))
        self.assertAlmostEqual(p, 2 * (1 + 10 + 45) / 1024)
        self.assertEqual(bench.mcnemar([("t", "1", 0.0, 1.0, 1.0)]), (0, 0, 1.0))
        # Thousands of discordant pairs: no overflow, a p-value in range.
        big = [("t", "1", 1.0, 1.0, 0.0)] * 3000 + [("t", "1", -1.0, 0.0, 1.0)] * 2900
        self.assertTrue(0 < bench.mcnemar(big)[2] <= 1)

    def test_the_variance_split_says_what_more_seeds_can_buy(self):
        # All of the variance is between templates: more seeds buy nothing.
        between = bench.variance_parts(synthetic(50, 8, lambda t, s: 1.0 if t % 2 else 0.0))
        self.assertAlmostEqual(between["within"], 0.0)
        self.assertGreater(between["between"], 0.2)
        self.assertIsNone(bench.seeds_for(between, 0.01))
        # All of it is within templates: the half-width falls as 1/sqrt(seeds).
        within = bench.variance_parts(synthetic(50, 8, lambda t, s: 1.0 if s % 2 else 0.0))
        self.assertAlmostEqual(within["between"], 0.0)
        need = bench.seeds_for(within, 0.05)
        self.assertAlmostEqual(need, within["within"] / (50 * (0.05 / bench.Z95) ** 2))

    def test_the_mde_is_2_8_clustered_standard_errors(self):
        with tempfile.TemporaryDirectory() as run:
            for seed in (41, 42, 43):
                shard(run, f"s{seed}", seed, {("train1", f"t{i}", "hidden"): {"eden": (i + seed) % 3 > 0, "tools": i % 5 == 0}
                                              for i in range(30)})
            rows, stats = bench.load([("g", [run])])
            res = bench.analyse(rows, "eden", "tools", "hidden", draws=1000)
            self.assertEqual((res["n"], res["templates"], res["seeds"]), (90, 30, 3))
            self.assertAlmostEqual(res["mde"], bench.MDE_FACTOR * res["seClustered"])
            self.assertAlmostEqual(res["effect"], res["rateA"] - res["rateB"])
            lines, summary = bench.report(rows, stats, [("eden", "tools")], ["g"], ["hidden", "usd"], 1.5, 500)
            text = "\n".join(lines)
            self.assertIn("clustered by template", text)
            self.assertIn("McNemar exact", text)
            self.assertIn("MDE", text)
            self.assertIn("eden|tools|pooled|hidden", summary)


if __name__ == "__main__":
    unittest.main()
