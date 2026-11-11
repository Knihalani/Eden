"""P3 (docs/research/p3-baselines.md): the readout of baselines (a), (b) and (c) from pi-ab runs.

    python3 -I report.py [--days] [--pair A:B ...] [--cluster template|user] RUN_DIR [RUN_DIR ...]

Each RUN_DIR holds `out.json` (pi-ab's results) and `out.tl/tasks.jsonl` (its timeline), and optionally
`regrade-sonnet.json` (`i3-regrade.ts`), whose verdict replaces the run's grader's wherever Sonnet graded the answer.
A RUN_DIR may name a model with `--agent DIR=LABEL` so two runs of one arm with different agents pair as two arms.

Per arm: hidden raised; the planted item handed at its own request (a packet or an ask answer of that request cited
it) and raised given handed ("in hand, not raised" is its complement); with `--days`, handed earlier the same day only
and not that day; control and neutral concerns (the grader's, and confirmed: Sonnet keeps it); neutral requests given
a packet and items a packet. Paired differences are bootstrapped over clusters (templates for short runs, users for
days), 5,000 draws, 95%.
"""
import argparse
import collections
import json
import os
import random


def load(d, label=None):
    run = json.load(open(os.path.join(d, "out.json")))
    seed = run["seeds"][0]
    tasks = run["tasks"]
    byid = {t["id"]: t for t in tasks}
    # Day of each task: tasks run in plan order and a day ends at its recap.
    day, days = 0, {}
    for t in tasks:
        days[t["id"]] = day
        if t["id"].endswith(":recap"):
            day += 1
    sonnet = {}
    p = os.path.join(d, "regrade-sonnet.json")
    if os.path.exists(p):
        for g in json.load(open(p))["graded"]:
            if g.get("readable", True) and g.get("facts") is not None:
                sonnet[(g["task"], g["condition"])] = g["facts"]
    tl = {}
    tlp = os.path.join(d, "out.tl", "tasks.jsonl")
    if os.path.exists(tlp):
        for line in open(tlp):
            x = json.loads(line)
            tl[(x["task"], x["condition"])] = x
    rows = []
    for r in run["results"]:
        t = byid.get(r["task"])
        if not t or t["kind"] not in ("hidden", "control", "neutral") or r.get("facts") is None:
            continue
        cond = r["condition"] if label is None else f"{r['condition']}@{label}"
        x = tl.get((r["task"], r["condition"]), {})
        cited = set(x.get("cited") or [])
        asked = set(x.get("askCited") or [])
        planted = t.get("planted")
        hidden = t["kind"] == "hidden"
        haiku = all(r["facts"].values()) if hidden else any(r["facts"].values())
        s = sonnet.get((r["task"], r["condition"]))
        graded = (all(s.values()) if hidden else any(s.values())) if s is not None else haiku
        rows.append(
            dict(
                seed=seed,
                task=r["task"],
                template=f"{t['suite'].replace('-control', '').replace('-neutral', '')}:{t.get('type', r['task'])}",
                kind=t["kind"],
                day=days[r["task"]],
                cond=cond,
                raised=graded if hidden else None,
                haiku=haiku,
                concern=haiku and not hidden,
                confirmed=(haiku and graded) if not hidden else None,
                own=bool(planted and (planted in cited or planted in asked)),
                ids=cited | asked,
                planted=planted,
                packet=len(cited) > 0,
                items=len(cited),
                cost=r.get("costUsd", 0) + r.get("edenCostUsd", 0),
                wall=r.get("wallMs", 0) / 1000,
            )
        )
    # Handed earlier the same day: any earlier task of the day (same arm) cited it.
    seen = collections.defaultdict(set)
    order = {t["id"]: i for i, t in enumerate(tasks)}
    for row in sorted(rows, key=lambda r: order[r["task"]]):
        key = (row["cond"], row["day"])
        row["earlier"] = bool(row["planted"] and row["planted"] in seen[key])
        seen[key] |= row["ids"]
    return rows


def ci(draws):
    draws.sort()
    return draws[int(0.025 * len(draws))], draws[int(0.975 * len(draws)) - 1]


def boot_rate(rows, key, cluster, n=5000):
    by = collections.defaultdict(list)
    for r in rows:
        by[r[cluster]].append(r[key])
    keys = sorted(by)
    rng = random.Random(7)
    out = []
    for _ in range(n):
        v = [x for k in rng.choices(keys, k=len(keys)) for x in by[k]]
        out.append(100 * sum(v) / max(1, len(v)))
    return ci(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--days", action="store_true")
    ap.add_argument("--pair", action="append", default=[])
    ap.add_argument("--agent", action="append", default=[], help="DIR=LABEL")
    ap.add_argument("--cluster", default=None)
    a = ap.parse_args()
    labels = dict(x.split("=", 1) for x in a.agent)
    rows = [r for d in a.dirs for r in load(d, labels.get(d))]
    cluster = a.cluster or ("seed" if a.days else "template")
    arms = sorted({r["cond"] for r in rows})
    hid = [r for r in rows if r["kind"] == "hidden"]
    print(f"== {len(a.dirs)} runs, arms {', '.join(arms)}; clusters: {cluster}")
    for arm in arms:
        h = [r for r in hid if r["cond"] == arm]
        if not h:
            continue
        lo, hi = boot_rate(h, "raised", cluster)
        own = [r for r in h if r["own"]]
        line = f"  {arm:16} hidden raised {sum(r['raised'] for r in h)}/{len(h)} = {100 * sum(r['raised'] for r in h) / len(h):5.1f}% ({lo:.1f}..{hi:.1f})"
        if own:
            ro = sum(r["raised"] for r in own)
            lo2, hi2 = boot_rate(own, "raised", cluster)
            line += f"; handed at its request {len(own)} ({100 * len(own) / len(h):.0f}%), raised {ro} = {100 * ro / len(own):.1f}% ({lo2:.1f}..{hi2:.1f}); in hand not raised {100 - 100 * ro / len(own):.1f}%"
        print(line)
        if a.days:
            ear = [r for r in h if not r["own"] and r["earlier"]]
            no = [r for r in h if not r["own"] and not r["earlier"]]
            print(f"  {'':16} earlier that day only {len(ear)} (raised {sum(r['raised'] for r in ear)}); not that day {len(no)} (raised {sum(r['raised'] for r in no)})")
        for kind in ("control", "neutral"):
            k = [r for r in rows if r["cond"] == arm and r["kind"] == kind]
            if k:
                pk = sum(r["packet"] for r in k)
                print(
                    f"  {'':16} {kind}: {len(k)}; concerns {sum(r['concern'] for r in k)}, confirmed {sum(bool(r['confirmed']) for r in k)}; "
                    f"packet on {pk} ({100 * pk / len(k):.0f}%), items a packet {sum(r['items'] for r in k) / max(1, pk):.1f}"
                )
        allr = [r for r in rows if r["cond"] == arm]
        print(f"  {'':16} cost per 1,000 task runs ${1000 * sum(r['cost'] for r in allr) / len(allr):.3f} (agent + Eden per task), wall {sum(r['wall'] for r in allr) / len(allr):.2f} s")
    for p in a.pair:
        x, y = p.split(":")
        bx = {(r["seed"], r["task"]): r for r in hid if r["cond"] == x}
        by_ = {(r["seed"], r["task"]): r for r in hid if r["cond"] == y}
        common = sorted(set(bx) & set(by_))
        if not common:
            print(f"  [{x} - {y}] no common tasks")
            continue
        diffs = collections.defaultdict(list)
        for k in common:
            diffs[bx[k][cluster]].append(bx[k]["raised"] - by_[k]["raised"])
        pt = 100 * sum(v for vs in diffs.values() for v in vs) / len(common)
        keys = sorted(diffs)
        rng = random.Random(11)
        draws = []
        for _ in range(5000):
            v = [d for k in rng.choices(keys, k=len(keys)) for d in diffs[k]]
            draws.append(100 * sum(v) / len(v))
        lo, hi = ci(draws)
        only_x = sum(bx[k]["raised"] and not by_[k]["raised"] for k in common)
        only_y = sum(by_[k]["raised"] and not bx[k]["raised"] for k in common)
        print(f"  [{x} - {y}] hidden raised {pt:+.1f} points ({lo:+.1f}..{hi:+.1f}), {len(common)} pairs, {len(keys)} clusters; only {x} {only_x}, only {y} {only_y}")
        # Given the fact was handed at its own request in both arms: raised, paired.
        both = [k for k in common if bx[k]["own"] and by_[k]["own"]]
        if both:
            rx = sum(bx[k]["raised"] for k in both)
            ry = sum(by_[k]["raised"] for k in both)
            print(f"  {'':10} handed at its request in both: {len(both)}; raised {rx} against {ry} ({100 * (rx - ry) / len(both):+.1f} points)")


main()
