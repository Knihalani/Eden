"""M12: hidden and decoys in the push's pool (pushPoolAt >= 0) and neutral packets, from funnel --json files.

usage: python3 -I poolscore.py A.json [B.json]   (B: the arm, compared with A task by task)
"""
import json
import sys


def load(path):
    d = json.load(open(path))
    rows = d["perTask"]
    out = {}
    for r in rows:
        out[(r["suite"], r["seed"], r["variant"], r["template"])] = r
    neutral = d.get("neutral") or {}
    return out, neutral


def tally(rows):
    t = {}
    for (suite, _seed, variant, _tpl), r in rows.items():
        s = t.setdefault(suite, {"hidden": [0, 0], "control": [0, 0], "handedH": 0, "handedC": 0})
        if variant not in ("hidden", "control"):
            continue
        s[variant][1] += 1
        if r.get("pushPoolAt", -1) >= 0:
            s[variant][0] += 1
        if r.get("pushHanded"):
            s["handedH" if variant == "hidden" else "handedC"] += 1
    return t


def neutral_packets(n):
    tot = 0
    for v in (n.get("suites") or n).values() if isinstance(n, dict) else []:
        if isinstance(v, dict) and "packets" in v:
            tot += v["packets"]
    return tot


def show(path):
    rows, n = load(path)
    t = tally(rows)
    H = C = HN = CN = hh = hc = 0
    for suite in sorted(t):
        s = t[suite]
        print(f"  {suite:10s} hidden in pool {s['hidden'][0]}/{s['hidden'][1]}  decoy in pool {s['control'][0]}/{s['control'][1]}"
              f"  handed {s['handedH']}/{s['handedC']}")
        H += s["hidden"][0]; HN += s["hidden"][1]; C += s["control"][0]; CN += s["control"][1]
        hh += s["handedH"]; hc += s["handedC"]
    print(f"  TOTAL      hidden in pool {H}/{HN} ({100*H/max(HN,1):.1f}%)  decoy in pool {C}/{CN} ({100*C/max(CN,1):.1f}%)"
          f"  handed {hh}/{hc}  neutral {json.dumps(n)[:300]}")
    return rows, (H, HN, C, CN)


if __name__ == "__main__":
    a, (h0, hn, c0, cn) = show(sys.argv[1])
    if len(sys.argv) > 2:
        b, (h1, _, c1, _) = show(sys.argv[2])
        gain = [k for k in a if k[2] == "hidden" and a[k].get("pushPoolAt", -1) < 0 and b.get(k, {}).get("pushPoolAt", -1) >= 0]
        loss = [k for k in a if k[2] == "hidden" and a[k].get("pushPoolAt", -1) >= 0 and b.get(k, {}).get("pushPoolAt", -1) < 0]
        print(f"  hidden: +{len(gain)} −{len(loss)}  ({100*(h1-h0)/hn:+.1f} pts); decoys {c0}→{c1} ({100*(c1-c0)/cn:+.1f} pts);"
              f" ratios hidden {h1/max(h0,1):.3f} decoys {c1/max(c0,1):.3f}")
