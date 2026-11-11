"""synth_data.py: M2's worlds, checks and labelled pairs (python3 -I -m unittest discover -s packages/sim/modal)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import synth_data as sd  # noqa: E402

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "..", "lab", "synth", "sample.jsonl")


class SynthDataTest(unittest.TestCase):
    def setUp(self):
        self.worlds = sd.load_worlds(SAMPLE)

    def test_sample_passes_the_checks(self):
        self.assertGreaterEqual(len(self.worlds), 3)
        for w in self.worlds:
            self.assertEqual(sd.check_world(w), [], w["id"])

    def test_one_changes_item_per_request_and_counts_agree(self):
        for w in self.worlds:
            ps = sd.pairs(w, with_text=False)
            by_req = {}
            for p in ps:
                by_req.setdefault(p["request"], []).append(p)
            for req, rows in by_req.items():
                self.assertEqual(sum(1 for p in rows if p["label"] == "changes"), 1, req)
        s = sd.summary(self.worlds)
        total = sum(len(sd.pairs(w, with_text=False)) for w in self.worlds)
        self.assertEqual(s["pairs"], total)
        self.assertEqual(s["changes"] + s["clear"] + s["unrelated"], total)

    def test_check_world_catches_broken_references(self):
        w = json.loads(json.dumps(self.worlds[0]))
        w["tasks"][0]["fact"] = "i99999"
        w["tasks"][1]["neutrals"].append(w["tasks"][1]["decoy"])
        p = sd.check_world(w)
        self.assertTrue(any("no item i99999" in x for x in p))
        self.assertTrue(any("already belongs" in x for x in p))

    def test_sample_pairs_keeps_every_labelled_pair_and_caps_unrelated(self):
        rows = sd.sample_pairs(self.worlds, unrelated=3, seed=1, with_text=False)
        reqs = {r["request"] + r["world"] for r in rows}
        unrel = sum(1 for r in rows if r["label"] == "unrelated")
        self.assertLessEqual(unrel, 3 * len(reqs))
        s = sd.summary(self.worlds)
        self.assertEqual(sum(1 for r in rows if r["label"] == "changes"), s["changes"])
        self.assertEqual(rows, sd.sample_pairs(self.worlds, unrelated=3, seed=1, with_text=False))

    def test_split_leaks_and_duplicates(self):
        fams = [{"id": t["family"], "cluster": t["family"]} for w in self.worlds for t in w["tasks"]]
        self.assertEqual(sd.split_leaks({"val": self.worlds}, fams), [])
        leak = sd.split_leaks({"val": self.worlds, "train": self.worlds[:1]}, fams)
        self.assertGreater(len(leak), 0)
        self.assertGreater(sd.duplicate_requests({"val": self.worlds, "test": self.worlds[:1]}), 0)

    def test_pair_groups_hold_one_planted_fact_and_its_twin(self):
        gs = sd.pair_groups(self.worlds, other=4, seed=1)
        normal = [g for g in gs if not g.get("neutral")]
        self.assertEqual(len(normal), sd.summary(self.worlds)["requests"])
        for g in normal:
            truths = [i["truth"] for i in g["items"]]
            self.assertEqual(truths.count("planted"), 1)
            self.assertIn("decoy", [i["role"] for i in g["items"]])
        for g in gs:
            if g.get("neutral"):
                self.assertNotIn("planted", [i["truth"] for i in g["items"]])
        self.assertEqual(gs, sd.pair_groups(self.worlds, other=4, seed=1))
        # Visibility agrees with pairs() (a silent change's earlier revision is gone once the edit lands).
        vis = {(p["world"], p["request"], p["item"]): p["visible"] for w in self.worlds for p in sd.pairs(w, False)}
        for g in gs:
            req = g["group"].split("/")[3]
            for i in g["items"]:
                self.assertEqual(i["visible"], vis[(g["world"], req, i["key"])], g["group"])


if __name__ == "__main__":
    unittest.main()
