"""i1_data.py: pairs joined to labels, targets, AUCs (python3 -I -m unittest discover -s packages/sim/modal)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import i1_data as d  # noqa: E402


def group(suite="train1", split="train"):
    return {
        "group": f"{suite}/41/isa", "suite": suite, "seed": 41, "template": "isa", "split": split,
        "request": "Move £5,000 into my ISA",
        "items": [
            {"key": "a", "title": "ISA 2026/27", "text": "£18,000 paid in", "truth": "planted"},
            {"key": "b", "title": "ISA 2025/26", "text": "£18,000 paid in", "truth": "decoy"},
            {"key": "c", "title": "Lunch", "text": "Noon", "truth": "other"},
        ],
    }


class Data(unittest.TestCase):
    def test_rows_join_labels_and_skip_unlabelled(self):
        labels = [{"group": "train1/41/isa", "key": "a", "y": 90}, {"group": "train1/41/isa", "key": "b", "y": 20}]
        rs = d.rows([group()], labels)
        self.assertEqual([r["key"] for r in rs], ["a", "b"])
        self.assertEqual(rs[0]["item"], "ISA 2026/27\n£18,000 paid in")
        self.assertAlmostEqual(rs[1]["y"], 0.2)

    def test_held_out_suites_are_refused(self):
        with self.assertRaises(ValueError):
            d.rows([group(suite="heldout18")], [])

    def test_targets(self):
        r = {"truth": "decoy", "y": 0.8}
        self.assertEqual(d.target_of(r, "opus"), 0.8)
        self.assertEqual(d.target_of(r, "truth"), 0.0)
        self.assertAlmostEqual(d.target_of(r, "mix"), 0.4)
        self.assertEqual(d.target_of({"truth": "planted", "y": 0.2}, "truth"), 1.0)

    def test_auc(self):
        self.assertEqual(d.auc([3, 4], [1, 2]), 1.0)
        self.assertEqual(d.auc([1], [2]), 0.0)
        self.assertEqual(d.auc([1], [1]), 0.5)
        self.assertAlmostEqual(d.auc([2, 0], [1]), 0.5)
        self.assertIsNone(d.auc([], [1]))

    def test_report(self):
        rs = d.rows([group()], [{"group": "train1/41/isa", "key": k, "y": y} for k, y in (("a", 90), ("b", 60), ("c", 5))])
        rep = d.report(rs, [3.0, 1.0, 0.0])
        self.assertEqual(rep["auc_planted_vs_decoy"], 1.0)
        self.assertEqual(rep["auc_planted_vs_rest"], 1.0)
        self.assertEqual(rep["teacher_planted_vs_decoy"], 1.0)
        self.assertEqual(rep["auc_vs_teacher"], 1.0)


if __name__ == "__main__":
    unittest.main()
