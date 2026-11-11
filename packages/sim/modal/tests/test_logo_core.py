"""logo_core.py (M14, D1021): the LOGO screen's splits, metrics and text transforms (stdlib only)."""
import json
import os
import random
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "lab", "m14"))
import logo_core as lc  # noqa: E402


def row(src, group, fact="Fact text", decoy="Decoy text that is longer", others=("x", "y")):
    it = lambda t: {"source": "gmail", "title": "T", "text": t}  # noqa: E731
    return {"src": src, "group": group, "world": "w", "task": "t", "archetype": "", "lang": "en",
            "requests": ["do it"], "fact": it(fact), "decoy": it(decoy), "neutrals": [it("n")],
            "others": [it(o) for o in others]}


class LogoCoreTest(unittest.TestCase):
    def test_group_split_keeps_a_group_whole_and_is_stable(self):
        self.assertEqual(lc.group_split("train3/x"), lc.group_split("train3/x"))
        shares = [lc.group_split(f"g{i}") for i in range(2000)]
        self.assertAlmostEqual(shares.count("test") / 2000, 0.2, delta=0.04)

    def test_load_source_splits_by_group_and_names_rows(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.jsonl")
            with open(p, "w") as f:
                for g in range(50):
                    for _ in range(3):
                        f.write(json.dumps(row("raw", f"g{g}")) + "\n")
            s = lc.load_source(f"g9={p}")
            self.assertEqual(len(s.train) + len(s.test), 150)
            self.assertFalse({r["group"] for r in s.train} & {r["group"] for r in s.test})
            self.assertEqual({r["src"] for r in s.train + s.test}, {"g9"})
        with self.assertRaises(ValueError):
            lc.load_source("nofile")

    def test_auc_and_pair_win(self):
        self.assertEqual(lc.auc([3, 4], [1, 2]), 1.0)
        self.assertEqual(lc.auc([1], [1]), 0.5)
        self.assertEqual(lc.pair_win([2, 1, 1], [1, 2, 1]), 0.5)

    def test_grade_reads_twin_hard_on_tasks_where_length_cannot_help(self):
        rows = [row("s", "a", fact="a long fact text here", decoy="short"), row("s", "b", fact="f", decoy="much longer decoy")]
        items = [{"fact": 0.9, "decoy": 0.1, "neutrals": [0.2], "others": [0.0, 0.0]},
                 {"fact": 0.2, "decoy": 0.8, "neutrals": [0.2], "others": [0.0, 0.0]}]
        pair = lambda f, d: [{"fact": (f, 1), "decoy": (d, 1), "neutrals": [(0.1, 1)], "others": [(0.0, 0), (0.0, 0)]}]  # noqa: E731
        g = lc.grade(rows, items, [pair(0.9, 0.1), pair(0.2, 0.8)])
        self.assertEqual(g["twin"], 0.5)
        self.assertEqual(g["hard_tasks"], 1)
        self.assertEqual(g["twin_hard"], 0.0)
        self.assertEqual(g["fact_at1"], 0.5)
        self.assertEqual(g["relevance"], 1.0)

    def test_normalise_types_dates_money_codes_and_names(self):
        t = lc.normalise("Pay £1,250.00 to Halden on Thu 5 Nov 2026 at 14:30, ref QX-4471, email jo@ex.co.uk")
        for tag in ("⟨money⟩", "⟨date⟩", "⟨time⟩", "⟨ref⟩", "⟨email⟩", "⟨name⟩"):
            self.assertIn(tag, t)
        self.assertNotIn("1,250", t)
        self.assertEqual(lc.normalise("2026-11-05"), " ⟨date⟩ ")

    def test_noise_is_seeded_and_keeps_most_words(self):
        text = "The meeting with the landlord on Thursday is moved to the following week because of the inspection."
        a = lc.noise(text, random.Random(3))
        self.assertEqual(a, lc.noise(text, random.Random(3)))
        kept = sum(w.lower().strip(".") in a.lower() for w in text.split())
        self.assertGreater(kept, len(text.split()) // 2)

    def test_length_balanced_halves_the_length_cue(self):
        rows = [row("s", f"g{i}", fact="long fact " * 5, decoy="d") for i in range(30)]
        rows += [row("s", f"h{i}", fact="f", decoy="long decoy " * 5) for i in range(10)]
        b = lc.length_balanced(rows, 1)
        self.assertEqual(len(b), 20)
        longer = sum(len(lc.item_text(r["fact"])) > len(lc.item_text(r["decoy"])) for r in b)
        self.assertEqual(longer, 10)

    def test_cap_rows(self):
        self.assertEqual(len(lc.cap_rows(list(range(10)), 4, 1)), 4)
        self.assertEqual(lc.cap_rows([1, 2], 0, 1), [1, 2])


if __name__ == "__main__":
    unittest.main()
