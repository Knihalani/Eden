"""Sanity check: e2.py's BM25F_ctx packets at the R1-tuned gate must equal R1's test packets; dry-run lex miss-driven."""
import json, os, time
os.environ.setdefault("CUES", "fixture/cues.json")
import e2
p = e2.TUNED["0.05"]; b = e2.build({})
pk = e2.run_all(b, p["t"], p["rel"])
R = [r for r in json.load(open("out/results-fir0.05.json")) if r["name"] == "M1 BM25F_ctx"][0]
print("same test packets", sum(pk[q] == R["packets"][q] for q in R["packets"]), len(R["packets"]))
print(e2.metrics(pk, [q for q in e2.C if e2.C[q]["split"] == "test"]))
t = time.time(); acc, st = e2.miss_driven("dev", "lex", p["t"], p["rel"]); print(round(time.time() - t, 1), "s", st)
