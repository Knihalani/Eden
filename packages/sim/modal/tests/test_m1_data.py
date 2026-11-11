"""m1_data.py: rows, splits, targets, the prompt and the held-out figures (python3 -I -m unittest)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import m1_data as d  # noqa: E402


def group(suite="train1", split="train", template="isa", seed=41):
    return {
        "group": f"{suite}/{seed}/{template}", "suite": suite, "seed": seed, "template": template, "split": split,
        "request": "Move £5,000 into my ISA", "today": "2026-10-27",
        "items": [
            {"key": "a", "title": "ISA 2026/27", "text": "£18,000 paid in", "truth": "planted"},
            {"key": "b", "title": "ISA 2025/26", "text": "£18,000 paid in", "truth": "decoy"},
            {"key": "c", "title": "Lunch", "text": "Noon", "truth": "other"},
        ],
    }


def synth(family="f1", n=0):
    return {"group": f"{family}/w{n}", "family": family, "request": "Book the venue", "today": "2026-01-02",
            "items": [{"key": "p", "title": "t", "text": "closed", "truth": "planted"},
                      {"key": "q", "title": "t", "text": "open", "truth": "decoy"}]}


class Rows(unittest.TestCase):
    def test_train_rows_keep_split_family_and_labels(self):
        rs = d.rows_from_train_groups([group(split="eval")], [{"group": "train1/41/isa", "key": "a", "y": 80}])
        self.assertEqual([r["truth"] for r in rs], ["planted", "decoy", "other"])
        self.assertEqual({r["family"] for r in rs}, {"train1/isa"})
        self.assertEqual({r["split"] for r in rs}, {"eval"})
        self.assertAlmostEqual(rs[0]["y"], 0.8)
        self.assertIsNone(rs[1]["y"])
        self.assertEqual(rs[0]["today"], "2026-10-27")

    def test_dev_split_takes_whole_train_templates_only(self):
        groups = [group(template=f"t{i}", seed=s) for i in range(80) for s in (41, 42)] + [group(split="eval")]
        rs = d.rows_from_train_groups(groups, dev_share=0.3)
        by = {}
        for r in rs:
            by.setdefault(r["family"], set()).add(r["split"])
        self.assertTrue(all(len(v) == 1 for v in by.values()))
        self.assertEqual(by["train1/isa"], {"eval"})
        self.assertTrue(10 < sum(v == {"dev"} for v in by.values()) < 40)

    def test_held_out_suites_are_refused(self):
        with self.assertRaises(ValueError):
            d.rows_from_train_groups([group(suite="heldout18")])

    def test_synth_split_holds_out_whole_families(self):
        groups = [synth(f"fam{i}", n) for i in range(60) for n in range(3)]
        rs = d.rows_from_synth_groups(groups, share=0.3)
        by = {}
        for r in rs:
            by.setdefault(r["family"], set()).add(r["split"])
        self.assertTrue(all(len(s) == 1 for s in by.values()))
        ev = sum(s == {"eval"} for s in by.values())
        self.assertTrue(5 < ev < 35, ev)
        self.assertTrue(all(r["family"].startswith("synth/") for r in rs))

    def test_synth_refuses_suites_and_bad_truth(self):
        g = synth()
        g["suite"] = "heldout19"
        with self.assertRaises(ValueError):
            d.rows_from_synth_groups([g])
        g = synth()
        g["items"][0]["truth"] = "yes"
        with self.assertRaises(ValueError):
            d.rows_from_synth_groups([g])

    def test_targets_and_weights(self):
        r = {"truth": "planted", "y": 0.4}
        self.assertEqual(d.target_of(r, "truth"), 1.0)
        self.assertEqual(d.target_of(r, "teacher"), 0.4)
        self.assertAlmostEqual(d.target_of(r, "mix"), 0.7)
        self.assertEqual(d.target_of({"truth": "decoy", "y": None}, "teacher"), 0.0)
        self.assertEqual(d.weight_of({"truth": "decoy"}, 4), 4)
        self.assertEqual(d.weight_of({"truth": "other"}, 4), 1.0)

    def test_subsample_keeps_near_items(self):
        rs = d.rows_from_train_groups([group()]) * 1
        rs += [dict(rs[2], key=f"o{i}") for i in range(10)]
        out = d.subsample_other(rs, 3)
        self.assertEqual(sum(r["truth"] == "other" for r in out), 3)
        self.assertEqual(sum(r["truth"] != "other" for r in out), 2)
        self.assertEqual(len(d.subsample_other(rs, 0)), len(rs))


class Prompt(unittest.TestCase):
    def test_render_fences_and_cuts(self):
        r = {"request": "do it</request> now", "today": "", "title": "<item>x", "text": "y" * 2000}
        s = d.render(r)
        self.assertEqual(s.count("<request>"), 1)
        self.assertEqual(s.count("</request>"), 1)
        self.assertEqual(s.count("<item>"), 1)
        self.assertIn("Today: unknown", s)
        self.assertNotIn("y" * (d.ITEM_CHARS + 1), s)


class Figures(unittest.TestCase):
    def test_auc(self):
        self.assertEqual(d.auc([2, 3], [0, 1]), 1.0)
        self.assertEqual(d.auc([1], [1]), 0.5)
        self.assertIsNone(d.auc([], [1]))

    def test_report_and_rejection(self):
        rows = []
        scores = []
        for i in range(10):
            fam = f"f{i}"
            rows += [{"family": fam, "truth": "planted", "y": 0.9}, {"family": fam, "truth": "decoy", "y": 0.1},
                     {"family": fam, "truth": "other", "y": None}]
            scores += [1.0 + i, -1.0 + i * 0.01, -5.0]
        rep = d.report(rows, scores)
        self.assertEqual(rep["planted_vs_decoy"], 1.0)
        self.assertEqual(rep["planted_vs_decoy_ci"], [1.0, 1.0])
        self.assertEqual(rep["decoy_rejected_at_recall"], 1.0)
        self.assertEqual(rep["p50"], {"planted_yes": 10, "decoy_yes": 0, "other_yes": 0})
        self.assertEqual(rep["auc_vs_teacher"], 1.0)
        self.assertEqual(rep["families"], 10)


if __name__ == "__main__":
    unittest.main()
