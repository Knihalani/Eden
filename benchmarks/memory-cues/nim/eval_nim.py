"""E1 evaluator: apply every R1 method at its ALREADY-TUNED dev parameters (out/results-fir{0.05,0.0}.json, copied from R1)
to the original test split (sanity: must equal R1) and to the new test_nim split. No re-tuning.

Env: CUES=fixture/cues-all.json OUT_SFX=_all (features computed over original + test_nim cues).
Usage: python eval_nim.py  -> out/e1-eval.json, out/e1-eval.txt
"""
import json, os, sys
import numpy as np
sys.argv = ["eval.py", "0.05", "x", "y"]  # import eval.py as a library (no main)
import eval as E
from lexpy import toks

rng = np.random.default_rng(0)
C, mems = E.C, E.mems
TEST = [q for q in C if C[q]["c"]["split"] == "test"]
NIM = [q for q in C if C[q]["c"]["split"] == "test_nim"]
cat = lambda q: C[q]["c"]["cat"]

# R1 overlap class (cue vs gold rows): none / common (only df>5 tokens) / rare
live = [m for m in mems.values() if not m["superseded_by"]]
df = {}
for m in live:
    for t in set(toks(f"{m['subject']} {m['text']}")):
        df[t] = df.get(t, 0) + 1
def ovclass(q):
    c = C[q]["c"]
    if not c["gold"]:
        return None
    ct = set(toks(c["cue"]))
    shared = set()
    for g in c["gold"]:
        shared |= ct & set(toks(f"{mems[g]['subject']} {mems[g]['text']}"))
    if not shared:
        return "none"
    return "rare" if min(df.get(t, 0) for t in shared) <= 5 else "common"
OV = {q: ovclass(q) for q in C}


def rec4(q, pk):
    g = C[q]["gold"]
    return len(g & set(pk[:E.K])) / len(g)


def stats(ids, pk):
    pos = [q for q in ids if C[q]["gold"]]; neg = [q for q in ids if not C[q]["gold"]]
    r = [rec4(q, pk[q]) for q in pos]
    prec = [d in C[q]["gold"] for q in pos for d in pk[q][:E.K]]
    fir = [1.0 if pk[q] else 0.0 for q in neg]
    out = dict(n_pos=len(pos), n_neg=len(neg), r4=float(np.mean(r)) if r else None, prec=float(np.mean(prec)) if prec else None,
               fir=float(np.mean(fir)) if fir else None, bullets=float(np.mean([len(pk[q][:E.K]) for q in pos])) if pos else None)
    if r:
        b = [np.mean(np.array(r)[rng.integers(0, len(r), len(r))]) for _ in range(2000)]
        out["r4_ci"] = [float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))]
    return out


def packets_for(name, params, methods):
    if params is None:
        key = name.replace(" (Eden today)", "")
        return {q: E.m0[q][key] for q in C}
    m = methods[name]
    return {q: E.packet(C[q], m, params) for q in C}


def main():
    methods = {**E.M(""), **E.M("_ctx")}
    report = {}
    lines = []
    for fir in ("0.05", "0.0"):
        tuned = json.load(open(f"out/results-fir{fir}.json"))
        rows = []
        for r in tuned:
            pk = packets_for(r["name"], r["params"], methods)
            t = stats(TEST, pk)
            # sanity: R1 test packets must be reproduced exactly (M0 excluded: Eden code has changed since R1)
            same = sum(pk[q] == r["packets"][q] for q in TEST) if r["params"] is not None else None
            row = dict(name=r["name"], params=r["params"], test=t, test_repro=same,
                       nim_para=stats([q for q in NIM if cat(q) == "nim-para"], pk),
                       nim_policy=stats([q for q in NIM if cat(q) == "nim-policy"], pk),
                       nim_pos=stats([q for q in NIM if C[q]["gold"]], pk),
                       nim_neg=stats([q for q in NIM if not C[q]["gold"]], pk),
                       nim_pos_testmem=stats([q for q in NIM if C[q]["gold"] and C[q]["c"].get("gold_orig_split") == "test"], pk),
                       test_none=stats([q for q in TEST if OV[q] == "none"], pk),
                       test_rare=stats([q for q in TEST if OV[q] == "rare"], pk),
                       nim_kind={k: stats([q for q in NIM if cat(q) == "nim-para" and mems[next(iter(C[q]["gold"]))]["kind"] == k], pk)
                                 for k in sorted({m["kind"] for m in mems.values()})})
            rows.append(row)
        report[fir] = rows
        lines.append(f"\n=== operating point: dev FIR <= {fir} (R1-tuned params, not re-tuned) ===")
        lines.append("method | TEST r@4 | TEST FIR | TEST prec | repro | none(test) r@4 | NIM-para r@4 [CI] | NIM-policy r@4 | NIM-pos prec | NIM-pos bullets | NIM-neg FIR | NIM-pos(test mems) r@4")
        for x in rows:
            f = lambda v: "-" if v is None else f"{v:.3f}"
            lines.append(f"{x['name']} | {f(x['test']['r4'])} | {f(x['test']['fir'])} | {f(x['test']['prec'])} | {x['test_repro']} | {f(x['test_none']['r4'])} | "
                         f"{f(x['nim_para']['r4'])} [{x['nim_para']['r4_ci'][0]:.2f},{x['nim_para']['r4_ci'][1]:.2f}] | {f(x['nim_policy']['r4'])} | {f(x['nim_pos']['prec'])} | {f(x['nim_pos']['bullets'])} | {f(x['nim_neg']['fir'])} | {f(x['nim_pos_testmem']['r4'])}")
    ovc = {}
    for q in NIM:
        if C[q]["gold"]:
            ovc[OV[q]] = ovc.get(OV[q], 0) + 1
    lines.append(f"\nR1 overlap class of test_nim positives: {ovc}")
    json.dump(report, open("out/e1-eval.json", "w"), indent=1, default=float)
    open("out/e1-eval.txt", "w").write("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
