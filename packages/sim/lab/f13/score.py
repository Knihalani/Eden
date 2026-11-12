"""F13: screen 1's scorer (pre-registered in 04d69058). Reads match.ts rows.

    python3 -I score.py MATCH.jsonl [--k 2] [--neutral-cap 0.02]

Per grounds mode (none, day, day+who), the threshold is fit on train (hidden against neutral, seeds as given): the
lowest score at which train's neutral tasks given a packet stay at or under the cap, and the planted-hit share is
then read there. A task's hand-out is the rules among its top five that clear the threshold and pass the mode's
grounds, at most K. hidden: planted handed; control: the look-alike (the planted item of a control world) handed;
neutral: anything handed. Groups: train, reworded, dev20, longtail.
"""
import argparse
import json
from collections import defaultdict


def group(suite):
    if suite.startswith("dev20"):
        return "dev20"
    if suite == "longtail":
        return "longtail"
    return "reworded" if suite.endswith("r") else "train"


MODES = {"none": lambda r: True, "day": lambda r: r["day"], "day+who": lambda r: r["day"] and r["who"]}


MARGIN = False


def handed(row, tau, mode, k):
    ok = MODES[mode]
    base = row.get("med", 0) if MARGIN else 0
    return [r["id"] for r in row["top"] if r["s"] - base >= tau and ok(r)][:k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("match")
    ap.add_argument("--k", type=int, default=2)
    ap.add_argument("--neutral-cap", type=float, default=0.02)
    ap.add_argument("--margin", action="store_true", help="score is the cosine less the request's median rule score")
    a = ap.parse_args()
    global MARGIN
    MARGIN = a.margin
    rows = [json.loads(l) for l in open(a.match) if l.strip()]
    for mode in MODES:
        train_neutral = [r for r in rows if group(r["suite"]) == "train" and r["variant"] == "neutral"]
        cands = sorted({x["s"] - (r.get("med", 0) if MARGIN else 0) for r in train_neutral for x in r["top"]} | {1.0})
        tau = 1.0
        for c in cands:
            share = sum(bool(handed(r, c, mode, a.k)) for r in train_neutral) / len(train_neutral)
            if share <= a.neutral_cap:
                tau = c
                break
        print(f"mode {mode}: tau {tau:.4f} (train neutral packets <= {a.neutral_cap:.0%}), k {a.k}")
        tab = defaultdict(lambda: defaultdict(int))
        for r in rows:
            g = (group(r["suite"]), r["variant"])
            h = handed(r, tau, mode, a.k)
            t = tab[g]
            t["n"] += 1
            t["any"] += bool(h)
            t["planted"] += bool(r["planted"]) and r["planted"] in h
            t["items"] += len(h)
        for gname in ("train", "reworded", "dev20", "longtail"):
            hid, con, neu = tab[(gname, "hidden")], tab[(gname, "control")], tab[(gname, "neutral")]
            if not hid["n"]:
                continue
            ph, lh = hid["planted"], con["planted"]
            ratio = f"{lh / ph:.3f}" if ph else "inf"
            print(
                f"  {gname:9} planted {ph}/{hid['n']} ({100 * ph / hid['n']:.1f}%)"
                f"  look-alike {lh}/{con['n']} (per planted hit {ratio})"
                f"  neutral packets {neu['any']}/{neu['n']} ({100 * neu['any'] / neu['n']:.1f}%)"
                f"  hidden tasks given anything {hid['any']}/{hid['n']}"
            )


main()
