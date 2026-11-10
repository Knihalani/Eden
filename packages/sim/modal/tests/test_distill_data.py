"""distill_data.py: split checks, records, estimates (python3 -I -m unittest discover -s packages/sim/modal)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import distill_data as dd  # noqa: E402


def row(i, keys, max_tokens=3000):
    target = json.dumps({"cards": [], "requests": [{"i": k, "q": []} for k in range(len(keys))]})
    return {"id": f"r{i}", "keys": keys, "maxTokens": max_tokens,
            "messages": [{"role": "system", "content": "s" * 3600}, {"role": "user", "content": "u" * 360},
                         {"role": "assistant", "content": target}]}


class Rows(unittest.TestCase):
    def test_splits_must_not_share_items(self):
        self.assertEqual(dd.check_rows([row(0, ["a", "b"])], [row(1, ["c"])])["heldoutItems"], 1)
        with self.assertRaises(ValueError):
            dd.check_rows([row(0, ["a", "b"])], [row(1, ["b"])])

    def test_rows_are_the_three_turn_card_call(self):
        bad = row(0, ["a"])
        bad["messages"] = bad["messages"][:2]
        with self.assertRaises(ValueError):
            dd.check_rows([bad], [])

    def test_prompt_completion_puts_the_loss_on_the_reply(self):
        r = dd.prompt_completion(row(0, ["a"]))
        self.assertEqual([m["role"] for m in r["prompt"]], ["system", "user"])
        self.assertEqual([m["role"] for m in r["completion"]], ["assistant"])

    def test_outputs_line_up_with_rows(self):
        text = dd.output_lines([row(0, ["a"]), row(1, ["b"])], ["x", "y"])
        self.assertEqual([json.loads(l)["id"] for l in text.splitlines()], ["r0", "r1"])
        with self.assertRaises(ValueError):
            dd.output_lines([row(0, ["a"])], [])


class Plans(unittest.TestCase):
    def test_offered_bases_are_servable_licences(self):
        for b in dd.BASES.values():
            self.assertEqual(b["licence"], "Apache-2.0")
            self.assertIn(b["gpu"], dd.GPU_USD_PER_HOUR)
            self.assertIn(b["serve_gpu"], dd.GPU_USD_PER_HOUR)
        self.assertIn(dd.DEFAULT_BASE, dd.BASES)

    def test_estimates_are_labelled_and_scale_with_epochs(self):
        rows = [row(i, ["a"]) for i in range(500)]
        one, two = dd.estimate_train("qwen2.5-1.5b", rows, 1), dd.estimate_train("qwen2.5-1.5b", rows, 2)
        self.assertTrue(one["estimate"])
        self.assertEqual(two["tokens"], 2 * one["tokens"])
        self.assertGreater(two["usd"], one["usd"])

    def test_generation_keeps_eden_s_cap_and_fits_the_context(self):
        self.assertEqual(dd.generation_params(row(0, ["a"], 3000)), {"temperature": 0.0, "max_tokens": 3000})
        self.assertLess(dd.generation_params(row(0, ["a"], 10 ** 6))["max_tokens"], dd.MAX_LENGTH * 2)

    def test_serve_args_take_no_key_on_the_command_line(self):
        args = dd.vllm_serve_args("/vol/models/x/merged")
        self.assertNotIn("--api-key", args)
        self.assertIn(dd.SERVED_NAME, args)

    def test_quality_per_dollar(self):
        self.assertEqual(dd.quality_per_dollar({"flagPrecision": None, "flagRecall": 1}, 1), 0.0)
        self.assertEqual(dd.quality_per_dollar({"flagPrecision": 1, "flagRecall": 1}, 0.5), 2.0)


if __name__ == "__main__":
    unittest.main()
