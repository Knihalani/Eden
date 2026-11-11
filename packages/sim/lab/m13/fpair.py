"""M13: the funnel's push with and without `pushGate`, task by task: planted facts handed by the push (`pushHanded`),
surfaced (delivered or cited), look-alikes handed, and neutral tasks given any packet, per suite and in total.

    python3 -I packages/sim/lab/m13/fpair.py BASE.json GATE.json
"""
import json, sys
from collections import defaultdict


def rows(path):
    return {(r["suite"], r["seed"], r["variant"], r["template"]): r for r in json.load(open(path))["perTask"]}


def main():
    base, gate = rows(sys.argv[1]), rows(sys.argv[2])
    agg = defaultdict(lambda: defaultdict(int))
    lost = []
    for k, b in base.items():
        g = gate[k]
        suite, _, variant, _ = k
        for name in (suite, "TOTAL"):
            a = agg[name]
            if variant == "hidden":
                a["hidden"] += 1
                a["handed b"] += bool(b.get("pushHanded"))
                a["handed g"] += bool(g.get("pushHanded"))
                a["surfaced b"] += bool(b.get("delivered") or b.get("askCited"))
                a["surfaced g"] += bool(g.get("delivered") or g.get("askCited"))
            elif variant == "control":
                a["decoy handed b"] += bool(b.get("pushHanded"))
                a["decoy handed g"] += bool(g.get("pushHanded"))
            elif variant == "neutral":
                a["neutral"] += 1
                a["neutral pkt b"] += (b.get("packets") or 0) > 0
                a["neutral pkt g"] += (g.get("packets") or 0) > 0
        if variant == "hidden" and b.get("pushHanded") and not g.get("pushHanded"):
            lost.append(k)
    for name, a in sorted(agg.items(), key=lambda x: x[0] == "TOTAL"):
        print(f"{name:10} hidden handed {a['handed b']}->{a['handed g']} of {a['hidden']}, surfaced {a['surfaced b']}->"
              f"{a['surfaced g']}, decoys handed {a['decoy handed b']}->{a['decoy handed g']}, neutral packets "
              f"{a['neutral pkt b']}->{a['neutral pkt g']} of {a['neutral']}")
    print("lost:", len(lost), lost[:12])


if __name__ == "__main__":
    main()
