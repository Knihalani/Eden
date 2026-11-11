"""M13: score a FROZEN gate on the held-out sets against the shipped rule, and apply the pre-registered bar
(docs/research/m13-gate.md §0, commit 1d6ad8d9). Run once per frozen candidate; never tune on its output.

    .venv-m3/bin/python -I packages/sim/lab/m13/score.py RUN.pt [--json OUT.json]
"""
import argparse, json, os, sys
from collections import defaultdict

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import feats  # noqa: E402
import gate as G  # noqa: E402

LANGS = ["en", "de", "fr", "es", "it", "pt", "nl", "pl", "hi"]


def rate(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def model_of(path):
    ck = torch.load(path, weights_only=False)
    a = argparse.Namespace(**ck["args"])
    m = {"bag": G.Bag, "mil": G.Mil, "cnn": G.Cnn, "sign": G.Sign, "gru": G.Gru}[a.arch](a)
    m.load_state_dict(ck["state"])
    return m, a, ck["threshold"], ck.get("skel")


def decide(m, a, thr, skel, rows):
    G.prep(rows, a, skel)
    p, k = G.predict(m, rows, a)
    return [x >= thr for x in p], k


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--json")
    o = ap.parse_args()
    m, a, thr, skel = model_of(o.model)
    res, ok = {}, {}
    sets = {s: G.load(s) for s in ("s3", "s4", "m2t", "sim56")}
    fx = [dict(r, rule="none", rest=False, lang="en", src="fix", kind="") for r in
          json.load(open("packages/sim/lab/m13/fixtures.json"))]
    for name, rows in list(sets.items()) + [("fix", fx)]:
        g, _ = decide(m, a, thr, skel, rows)
        for r, x in zip(rows, g):
            r["gate"] = x
            r["ruled"] = r["rule"] != "none"
    s3, s4, m2t, sim = sets["s3"], sets["s4"], sets["m2t"], sets["sim56"]
    kind = lambda r: r["src"].split(":")[1]
    # 1. acting detected
    acting = {"S3 indirect": [r for r in s3 if kind(r) == "indirect"],
              "S4 act+qact": [r for r in s4 if kind(r) in ("act", "qact")], "M2T all": m2t}
    for k, rs in acting.items():
        g, rl = rate([r["gate"] for r in rs]), rate([r["ruled"] for r in rs])
        need = 0.98 if rl > 0.88 else rl + 0.10
        res[f"acting {k}"] = (round(g, 3), round(rl, 3), len(rs))
        ok[f"1 acting {k}"] = g >= need - 1e-9
    # 1 (addendum A): SIM56, the held-out hand-written families, and their reworded part
    for k, rs in {"SIM56": sim, "SIM56 reworded": [r for r in sim if r["src"].endswith(("r", "rw"))]}.items():
        g, rl = rate([r["gate"] for r in rs]), rate([r["ruled"] for r in rs])
        res[f"acting {k}"] = (round(g, 3), round(rl, 3), len(rs))
        ok[f"1 acting {k}"] = g >= rl - 0.01
    # 2. false starts
    fs = {"S3 chatter+statement": [r for r in s3 if kind(r) in ("chatter", "statement")],
          "S4 chatter+intent+statement": [r for r in s4 if kind(r) in ("chatter", "intent", "statement")]}
    for k, rs in fs.items():
        g, rl = sum(r["gate"] for r in rs), sum(r["ruled"] for r in rs)
        res[f"false {k}"] = (g, rl, len(rs))
        ok[f"2 false {k}"] = g <= rl / 2
    for k, rs in {"S3 log": [r for r in s3 if kind(r) == "log"], "S3 ask": [r for r in s3 if kind(r) == "question"],
                  "S4 log": [r for r in s4 if kind(r) == "log"], "S4 ask": [r for r in s4 if kind(r) == "ask"]}.items():
        g, rl = rate([r["gate"] for r in rs]), rate([r["ruled"] for r in rs])
        res[f"guard {k}"] = (round(g, 3), round(rl, 3), len(rs))
        ok[f"2 guard {k}"] = g <= rl + 0.02
    # 3. every language
    lang = defaultdict(dict)
    for L in LANGS:
        act = [r for r in s4 if r["lang"] == L and kind(r) in ("act", "qact")]
        neg = [r for r in s4 if r["lang"] == L and kind(r) in ("chatter", "intent", "statement")]
        mt = [r for r in m2t if r["lang"] == L]
        lang[L] = {"s4 acting": (round(rate([r["gate"] for r in act]), 3), round(rate([r["ruled"] for r in act]), 3), len(act)),
                   "s4 false": (round(rate([r["gate"] for r in neg]), 3), round(rate([r["ruled"] for r in neg]), 3), len(neg)),
                   "m2t": (round(rate([r["gate"] for r in mt]), 3), round(rate([r["ruled"] for r in mt]), 3), len(mt))}
    en = lang["en"]
    for L in LANGS[1:]:
        ok[f"3 lang {L}"] = (lang[L]["s4 acting"][0] >= en["s4 acting"][0] - 0.05
                             and lang[L]["s4 false"][0] <= en["s4 false"][0] + 0.05
                             and lang[L]["m2t"][0] >= en["m2t"][0] - 0.05)
    # 7. hard gates
    wrong = [r["text"] for r in fx if r["gate"] != r["needs"]]
    ok["7 fixtures"] = not wrong
    res["fixtures wrong"] = wrong
    res["by style M2T"] = {}
    st = defaultdict(list)
    for r in m2t:
        st[r["src"] if r["lang"] == "en" else "m2:foreign"].append(r)
    for k, rs in sorted(st.items()):
        res["by style M2T"][k] = (round(rate([r["gate"] for r in rs]), 3), round(rate([r["ruled"] for r in rs]), 3), len(rs))
    out = {"model": o.model, "threshold": thr, "results (gate, rule, n)": res, "languages (gate, rule, n)": lang,
           "bar": ok, "offline bar holds": all(ok.values())}
    print(json.dumps(out, indent=1, ensure_ascii=False))
    if o.json:
        json.dump(out, open(o.json, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
