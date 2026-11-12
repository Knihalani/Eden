"""F2-decoy: planted facts (hidden) and decoys (control) surfaced and handed, by path and by labelled decoy kind, from
funnel `--json` rows, against a base run task by task. No model.

    python3 -I score.py BASE.json [ARM.json]

Surfaced: delivered by any path, or cited by the funnel's ask. Handed: in the push's candidates packet. Path: the row's
`why` (candidates, grounded-conflict, grounded-card, fallback, sources, …) or "ask" when only the ask cited it.
"""
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from labels import labels  # noqa: E402

KINDS = labels()


def rows(path):
    return {(r["suite"], r["seed"], r["variant"], r["template"]): r for r in json.load(open(path))["perTask"]}


def path_of(r):
    if r.get("delivered"):
        return (r.get("why") or "other").split(":")[0]
    return "ask" if r.get("askCited") else None


def summary(rs):
    out = collections.Counter()
    for (suite, seed, v, t), r in rs.items():
        if v not in ("hidden", "control"):
            continue
        out[(v, "n")] += 1
        p = path_of(r)
        if p:
            out[(v, "surfaced")] += 1
            out[(v, "path " + p)] += 1
        if r.get("pushHanded"):
            out[(v, "handed")] += 1
        k = KINDS.get(t)
        if v == "control" and k:
            out[("kind " + k, "n")] += 1
            out[("kind " + k, "surfaced")] += bool(p)
            out[("kind " + k, "handed")] += bool(r.get("pushHanded"))
    return out


def main():
    base = rows(sys.argv[1])
    b = summary(base)
    arm = rows(sys.argv[2]) if len(sys.argv) > 2 else None
    a = summary(arm) if arm else None
    keys = sorted({k for k in b if k[1] in ("n", "surfaced", "handed") or k[1].startswith("path")})
    for k in keys:
        line = f"  {k[0]:10} {k[1]:24} {b[k]:5}"
        if a is not None:
            line += f" -> {a[k]:5} ({a[k] - b[k]:+d})"
        print(line)
    if arm:
        for v in ("hidden", "control"):
            gain = sum(1 for k, r in arm.items() if k[2] == v and path_of(r) and not path_of(base.get(k, {})))
            lost = sum(1 for k, r in base.items() if k[2] == v and path_of(r) and not path_of(arm.get(k, {})))
            print(f"  {v} surfaced task by task: +{gain} -{lost}")


if __name__ == "__main__":
    main()
