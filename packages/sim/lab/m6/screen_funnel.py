"""M6 (D920-D929): the pre-registered offline screen on real funnel packets (the engine's trimmer in the loop).

    python3 -I packages/sim/lab/m6/screen_funnel.py --labels L.jsonl [--labels ...] --base BASE.jsonl --arm ARM.jsonl

BASE and ARM are `hidden-funnel --packets F --packet-parts` dumps of the same suites and seeds, ARM with
`packetTrim`. For each task the planted item's line is found in its packets by citation order; a planted fact (or
look-alike) keeps its key detail when every labelled key token is among its line's tokens. Reported per set
(prep.py's split of suites): facts and look-alikes whose base line keeps it and how many the arm keeps, and bytes
of item lines and of whole packets, arm against base.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m6lib as L  # noqa: E402
from prep import set_of, unit_key  # noqa: E402


def tasks(path):
    out = {}
    for line in open(path):
        if line.strip():
            r = json.loads(line)
            out[(r["suite"], r["seed"], r["variant"], r["template"])] = r
    return out


def planted_line(r):
    """The planted item's packet line (the first packet citing it) and its title, or None."""
    for p in r["packets"]:
        if r["planted"] in p["ids"]:
            lines = [x for x in p["text"].split("\n") if x.startswith("- [")]
            k = p["ids"].index(r["planted"])
            if k < len(lines):
                return lines[k]
    return None


def item_bytes(r):
    return sum(len(x.encode()) for p in r["packets"] for x in p["text"].split("\n") if x.startswith("- ["))


def packet_bytes(r):
    return sum(len(p["text"].encode()) for p in r["packets"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", action="append", default=[])
    ap.add_argument("--base", required=True)
    ap.add_argument("--arm", required=True)
    a = ap.parse_args()
    labels = {}
    for f in a.labels:
        for line in open(f):
            if line.strip():
                x = json.loads(line)
                labels[x["key"]] = x
    base, arm = tasks(a.base), tasks(a.arm)
    st = {}
    for k, b in base.items():
        r = arm.get(k)
        if r is None:
            continue
        s = st.setdefault(set_of(k[0]), {"fact": [0, 0], "decoy": [0, 0], "ib": [0, 0], "pb": [0, 0], "tasks": 0})
        s["tasks"] += 1
        s["ib"][0] += item_bytes(b)
        s["ib"][1] += item_bytes(r)
        s["pb"][0] += packet_bytes(b)
        s["pb"][1] += packet_bytes(r)
        if b["variant"] not in ("hidden", "control"):
            continue
        role = "fact" if b["variant"] == "hidden" else "decoy"
        it = next((i for p in b.get("parts", []) for i in p if i["id"] == b["planted"]), None)
        if it is None:
            continue
        lab = labels.get(unit_key(role, b.get("detail", ""), it["title"], [x[0] for x in it["parts"]]))
        if not lab or not lab["words"]:
            continue
        lb, la = planted_line(b), planted_line(r)
        row = {"title": "", "words": lab["words"]}
        if lb is None or not L.key_ok(row, lb):
            continue
        s[role][0] += 1
        if la is not None and L.key_ok(row, la):
            s[role][1] += 1
    for name, s in sorted(st.items()):
        f, d = s["fact"], s["decoy"]
        print(
            f"{name:<6} tasks {s['tasks']:>6}  fact keep {100*f[1]/max(f[0],1):5.1f}% ({f[1]}/{f[0]})  "
            f"look-alike keep {100*d[1]/max(d[0],1):5.1f}% ({d[1]}/{d[0]})  item bytes {100*s['ib'][1]/max(s['ib'][0],1):5.1f}%  "
            f"packet bytes {100*s['pb'][1]/max(s['pb'][0],1):5.1f}%"
        )


if __name__ == "__main__":
    main()
