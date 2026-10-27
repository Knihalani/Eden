"""E1 threshold-free view: (1) ungated recall@4 (ranking only), (2) recall@4 at an ORACLE threshold chosen on the pooled
test negatives (R1 test 80 + kimi 98) for FIR in {5, 10, 20, 50}%. Illustrative upper bounds, not tunable operating points.
Env as eval_nim.py; optional EXTRA=out/e5-feats.json adds cos_nemo features."""
import json, os, sys
import numpy as np
sys.argv = ["eval.py", "0.05", "x", "y"]
import eval as E

C = E.C
if os.environ.get("EXTRA") and os.path.exists(os.environ["EXTRA"]):
    ex = json.load(open(os.environ["EXTRA"]))
    for q, fs in ex.items():
        for k, v in fs.items():
            C[q]["f"][k] = np.array(v)
SETS = {
    "R1 test pos": [q for q in C if C[q]["c"]["split"] == "test" and C[q]["gold"]],
    "R1 test none-overlap": None,
    "nim-para": [q for q in C if C[q]["c"]["cat"] == "nim-para"],
    "nim-para (test mems)": [q for q in C if C[q]["c"]["cat"] == "nim-para" and C[q]["c"].get("gold_orig_split") == "test"],
    "nim-policy": [q for q in C if C[q]["c"]["cat"] == "nim-policy"],
}
ov = json.load(open("out/overlap.json"))
SETS["R1 test none-overlap"] = [q for q in SETS["R1 test pos"] if ov.get(q) == "none"]
NEG = [q for q in C if not C[q]["gold"] and C[q]["c"]["split"] in ("test", "test_nim")]
FEATS = ["bm25_ctx", "bm25c_ctx", "tri_ctx", "cos_b8_ctx", "cos_r32_ctx", "cos_bge_ctx", "cos_mini_ctx", "ce_ctx"] + (["cos_nemo_ctx"] if "cos_nemo_ctx" in C[NEG[0]]["f"] else [])


def r4(q, feat, thr=-1e18):
    f = C[q]["f"][feat]; order = np.argsort(-f, kind="stable")[:4]
    pk = [C[q]["docs"][i] for i in order if f[i] >= thr]
    return len(C[q]["gold"] & set(pk)) / len(C[q]["gold"])


out = {}
lines = ["scorer | " + " | ".join(f"{s} ungated r@4" for s in SETS) + " | " + " | ".join(f"nim-para r@4 @FIR{int(f*100)}" for f in (0.05, 0.1, 0.2, 0.5)) + " | " + " | ".join(f"R1-none r@4 @FIR{int(f*100)}" for f in (0.05, 0.2))]
for feat in FEATS:
    row = {s: float(np.mean([r4(q, feat) for q in ids])) for s, ids in SETS.items()}
    tops = np.array([C[q]["f"][feat].max() for q in NEG])
    for f in (0.05, 0.1, 0.2, 0.5):
        thr = np.quantile(tops, 1 - f)  # a fraction f of pooled negatives have top-1 >= thr
        row[f"para@{f}"] = float(np.mean([r4(q, feat, thr) for q in SETS["nim-para"]]))
        row[f"none@{f}"] = float(np.mean([r4(q, feat, thr) for q in SETS["R1 test none-overlap"]]))
    out[feat] = row
    lines.append(f"{feat} | " + " | ".join(f"{row[s]:.3f}" for s in SETS) + " | " + " | ".join(f"{row[f'para@{f}']:.3f}" for f in (0.05, 0.1, 0.2, 0.5)) + " | " + " | ".join(f"{row[f'none@{f}']:.3f}" for f in (0.05, 0.2)))
print(f"pooled negatives: {len(NEG)}")
print("\n".join(lines))
json.dump(out, open("out/e1-curves.json", "w"), indent=1)
