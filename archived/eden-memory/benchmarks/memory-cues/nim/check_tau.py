"""Control for E2(a): baseline BM25F_ctx (no aliases) at the tau values the alias variants were re-tuned to."""
import os
os.environ.setdefault("CUES", "fixture/cues-all.json")
import e2
b = e2.build({})
for t in (4.14, 5.04, 5.46):
    r = e2.eval_sets(e2.run_all(b, t, 0.7))
    print(t, "test", {k: round(v, 3) for k, v in r["test"].items() if isinstance(v, float)}, "nim r4", r["test_nim_pos"]["r4"], "nim-neg fir", round(r["test_nim_neg"]["fir"], 3))
