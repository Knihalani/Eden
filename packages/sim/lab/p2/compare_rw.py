"""P2's funnel comparison across the reworded train (D820, docs/research/p2-push-check.md), lab only.

    python3 -I compare_rw.py --arm NAME=run.json ... [--base NAME]

Each file is a `bun run funnel --json` run with `-- --neutral`, on `train` or `train-rw`. A reworded task pairs with its
original by suite (the `rw` suffix dropped), seed, variant and template. Per arm: hidden and decoys surfaced, planted
(decoy) handed in the candidates packet (`pushHanded`), neutral tasks given a packet, and the tasks given any packet;
then, against `--base`, the planted handed gained and lost task by task.
"""
import argparse
import json


def load(path):
    j = json.load(open(path))
    out = {}
    for r in j["perTask"] + j.get("neutral", {}).get("perTask", []):
        v = r.get("variant", "neutral")
        out[(r["suite"].removesuffix("rw"), r["seed"], v, r["template"])] = r
    return out


def figures(rows):
    out = {}
    for v in ("hidden", "control", "neutral"):
        ks = [k for k in rows if k[2] == v]
        out[v] = {
            "n": len(ks),
            "surfaced": sum(1 for k in ks if rows[k].get("surfacedBy")),
            "handed": sum(1 for k in ks if rows[k].get("pushHanded")),
            "packets": sum(1 for k in ks if rows[k].get("pushHandedN", 0) > 0),
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", action="append", required=True)
    ap.add_argument("--base")
    a = ap.parse_args()
    arms = {}
    for spec in a.arm:
        name, path = spec.split("=", 1)
        arms[name] = load(path)
    print(f"{'arm':14} {'hidden surf':>11} {'decoy surf':>10} {'planted handed':>14} {'decoy handed':>12} {'neutral pkts':>12}")
    for name, rows in arms.items():
        f = figures(rows)
        h, c, n = f["hidden"], f["control"], f["neutral"]
        print(
            f"{name:14} {h['surfaced']:>5}/{h['n']:<5} {c['surfaced']:>4}/{c['n']:<5} {h['handed']:>8}/{h['n']:<5}"
            f" {c['handed']:>6}/{c['n']:<5} {n['packets']:>6}/{n['n']:<5}"
        )
    if a.base:
        b = arms[a.base]
        for name, rows in arms.items():
            if name == a.base:
                continue
            ks = [k for k in rows if k in b and k[2] == "hidden"]
            gain = sum(1 for k in ks if rows[k].get("pushHanded") and not b[k].get("pushHanded"))
            loss = sum(1 for k in ks if b[k].get("pushHanded") and not rows[k].get("pushHanded"))
            print(f"{name} vs {a.base}: planted handed +{gain} -{loss} of {len(ks)} paired hidden tasks")


if __name__ == "__main__":
    main()
