"""embed_score.py: packing, ranks and the screen's groups (python3 -I -m unittest discover -s packages/sim/modal)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import embed_score as es  # noqa: E402


def world(suite="train1", seed=41, variant="hidden"):
    return {
        "suite": suite, "seed": seed, "variant": variant,
        "tasks": [
            {"template": "car", "request": "Transfer the £8,000 for the car to Sam", "planted": "m2"},
            {"template": "deploy", "request": "Deploy the migration on Thursday", "planted": "m3"},
            {"template": "none", "request": "Anything new?", "planted": ""},
        ],
        "items": [
            {"id": "m1", "h": "h1", "title": "Lunch", "text": "Sandwiches at noon"},
            {"id": "m2", "h": "h2", "title": "HPI check", "text": "Outstanding finance on the vehicle"},
            {"id": "m3", "h": "h3", "title": "Change freeze", "text": "No deploy to production Thursday"},
        ],
    }


class Score(unittest.TestCase):
    def test_terms_follow_a15(self):
        self.assertEqual(es.terms("Move the £5,000 to my ISA"), ["move", "£5", "000", "isa"])
        self.assertFalse(es.shares_word("Transfer the £8,000 for the car", world()["items"][1]))
        self.assertTrue(es.shares_word("Deploy the migration", world()["items"][2]))

    def test_pack_shares_texts_across_worlds(self):
        texts, packed = es.pack([world(), world(suite="train2")])
        self.assertEqual(len(texts), 3)
        self.assertEqual(packed[0]["items"], packed[1]["items"])
        self.assertEqual([t["planted"] for t in packed[0]["tasks"]], [1, 2, -1])
        self.assertEqual(packed[1]["key"], ["train2", 41, "hidden"])

    def test_rank_counts_ties_against_the_item(self):
        self.assertEqual(es.rank_of([0.9, 0.5, 0.5], 1), 3)
        self.assertEqual(es.rank_of([0.9, 0.5, 0.1], 0), 1)

    def test_held_out_corpora_are_refused(self):
        with self.assertRaises(ValueError):
            es.check_train([world(suite="heldout13")])

    def test_screen_groups_and_counts(self):
        w = world()
        ranks = {("train1", 41, "hidden", "car"): 1, ("train1", 41, "hidden", "deploy"): 7}
        rows = {
            ("train1", 41, "hidden", "car"): {"pushPoolAt": -1, "delivered": False},
            ("train1", 41, "hidden", "deploy"): {"pushPoolAt": 0, "delivered": True},
        }
        s = es.screen([w], ranks, rows, ks=(1, 10))["hidden"]
        self.assertEqual(s["all"]["tasks"], 2)
        self.assertEqual(s["all"]["k1"], {"embedding": 1, "lexical": 1, "either": 2, "embeddingOnly": 1})
        self.assertEqual(s["all"]["k10"]["either"], 2)
        self.assertEqual(s["no shared word"]["tasks"], 1)
        self.assertEqual(s["no shared word"]["k1"]["embeddingOnly"], 1)
        self.assertEqual(s["not in lexical pool"]["tasks"], 1)
        self.assertEqual(s["not surfaced by the default"]["tasks"], 1)
        text = "\n".join(es.lines({"hidden": s}, "m"))
        self.assertLess(text.index(" all "), text.index("no shared word"))

    def test_a_task_missing_from_the_funnel_is_out_of_the_pool(self):
        self.assertFalse(es.in_pool(None, 5))
        self.assertFalse(es.in_pool({"pushPoolAt": None}, 5))
        self.assertTrue(es.in_pool({"pushPoolAt": 4}, 5))
        self.assertFalse(es.in_pool({"pushPoolAt": 5}, 5))


if __name__ == "__main__":
    unittest.main()
