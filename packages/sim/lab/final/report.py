"""The final benchmark's report (served by subagents, D1101; single-shot agent). Read-only over a go.sh run directory.

    python3 -I packages/sim/lab/final/report.py RUN_DIR [--labels SUITE_FILE ...]

RUN_DIR holds raw.json, before.json, final.json and their .tl/tasks.jsonl (pi-ab). Prints, per arm: hidden facts
raised, control and neutral concerns (the in-run Sonnet grade). Paired by task (same seed, suite, template and
variant in both arms), each difference with a 95% bootstrap that resamples templates (all of a template's seeds and
variants together; 4,000 resamples, seed 7). Splits of hidden raised by each label the suite files' per-template
comments carry (`// key: value · key: value` above each template, areas from `// ---- area` lines). Stage attribution
for each Eden arm's hidden tasks, from the same run's push pools (`pushPools`): raised; reached the agent and not
raised (in a packet or an ask answer); dropped by the push check (in a push pool, not handed, not in an ask answer);
never retrieved (in no pool and no ask answer).
"""

import collections
import json
import os
import random
import re
import sys

ARMS = ["raw", "before", "final"]
PAIRS = [("final", "before"), ("final", "raw"), ("before", "raw")]


def load(run):
    rows = {}
    for arm in ARMS:
        f = os.path.join(run, f"{arm}.json")
        if not os.path.exists(f):
            continue
        res = {r["task"]: r for r in json.load(open(f))["results"]}
        tl = {}
        tf = os.path.join(run, f"{arm}.tl", "tasks.jsonl")
        if os.path.exists(tf):
            for line in open(tf):
                t = json.loads(line)
                tl[t["task"]] = t
        for task, r in res.items():
            w, suite, tmpl = task.split(":")[:3]
            base, _, kind = suite.partition("-")
            t = tl.get(task, {})
            planted = t.get("planted")
            cited = set(ids(t.get("cited")))
            asked = set(ids(t.get("askCited")))
            pools = t.get("pushPools") or []
            rows[(arm, task)] = dict(
                arm=arm, task=task, seed=w, suite=base, tmpl=tmpl, kind=kind or "hidden",
                key=f"{base}:{tmpl}", graded=not r.get("error") and r.get("facts") is not None,
                flag=any((r.get("facts") or {}).values()),
                pushed=bool(planted) and planted in cited, asked=bool(planted) and planted in asked,
                pooled=bool(planted) and any(planted in p.get("pool", []) for p in pools),
                # F7: on the API a check later than pushCheckWaitMs fails open to the pool's unchecked head (the
                # candidates, at most 5): would that head have held the planted item (fact or look-alike)?
                in_head=bool(planted) and any(planted in p.get("pool", [])[:5] for p in pools),
                checked_pool=any(p.get("check") == "yes" for p in pools),
                handed=bool(planted) and any(planted in p.get("handed", []) for p in pools),
                packets=len(t.get("cited") or []) > 0 if not isinstance(t.get("cited"), str) else t.get("cited") != "[]",
            )
    return rows


def ids(v):
    if isinstance(v, str):
        try:
            v = json.loads(v.replace("'", '"'))
        except ValueError:
            return []
    return v or []


def labels(files):
    """template name -> {label: value}, from each suite file's comments above `name: "..."`."""
    out = {}
    for f in files:
        area, pending = None, {}
        text = open(f, encoding="utf-8").read()
        # "five in each life area (work, family, …, in that order)": the areas by position when no section line names it.
        m = re.search(r"(\w+) in each life area \(([^)]*)\)", text)
        per = {"five": 5, "four": 4, "six": 6, "three": 3}.get(m.group(1), 0) if m else 0
        order = [a.strip() for a in m.group(2).replace("in that order", "").split(",") if a.strip()] if m else []
        index = 0
        for line in text.splitlines():
            s = line.strip()
            m = re.match(r"^// -{8,}\s*(\w[\w ]*)$", s)
            if m:
                area = m.group(1).strip()
                continue
            if s.startswith("//"):
                for part in s.lstrip("/ ").split("·"):
                    if ":" in part:
                        k, v = part.split(":", 1)
                        k = k.strip().lower()
                        if re.fullmatch(r"[a-z][a-z -]{1,20}", k):
                            pending[k] = v.strip()
                continue
            m = re.match(r'^name:\s*"([^"]+)"', s)
            if m:
                lab = dict(pending)
                if area:
                    lab["area"] = area
                elif per and index // per < len(order):
                    lab["area"] = order[index // per]
                out[m.group(1)] = lab
                pending = {}
                index += 1
    return out


def rate(xs):
    n = len(xs)
    return f"{sum(xs)}/{n} ({100 * sum(xs) / n:.1f}%)" if n else "0/0"


def paired(rows, a, b, kind):
    """Points of `a` minus `b` on one kind, tasks graded in both, bootstrap over templates."""
    by = collections.defaultdict(list)
    for (arm, task), r in rows.items():
        if arm != a or r["kind"] != kind or not r["graded"]:
            continue
        o = rows.get((b, task))
        if not o or not o["graded"]:
            continue
        by[r["key"]].append((int(r["flag"]), int(o["flag"])))
    pairs = [p for v in by.values() for p in v]
    if not pairs:
        return None
    point = 100 * sum(x - y for x, y in pairs) / len(pairs)
    keys = sorted(by)
    rnd = random.Random(7)
    ds = []
    for _ in range(4000):
        d = [x - y for k in rnd.choices(keys, k=len(keys)) for x, y in by[k]]
        ds.append(100 * sum(d) / len(d))
    ds.sort()
    up = sum(1 for x, y in pairs if x > y)
    down = sum(1 for x, y in pairs if y > x)
    return point, ds[100], ds[3899], len(pairs), len(keys), up, down


def main():
    run = sys.argv[1]
    files = sys.argv[sys.argv.index("--labels") + 1 :] if "--labels" in sys.argv else []
    rows = load(run)
    arms = [a for a in ARMS if any(k[0] == a for k in rows)]
    print("Served by subagents (D1101), single-shot agent (pi-ab --agent-sim single): compare arms within this run only.")
    print(f"run {run}; arms {', '.join(arms)}")
    print("\n== per arm (graded tasks)")
    for a in arms:
        xs = [r for (arm, _), r in rows.items() if arm == a]
        ungraded = sum(1 for r in xs if not r["graded"])
        line = [f"{a:7}"]
        for kind, name in (("hidden", "hidden raised"), ("control", "control concerns"), ("neutral", "neutral concerns")):
            line.append(f"{name} {rate([r['flag'] for r in xs if r['kind'] == kind and r['graded']])}")
        print("  " + "  ".join(line) + f"  ungraded {ungraded}")
    print("\n== paired differences (points; 95% CI, templates resampled; pairs, templates, up/down)")
    for a, b in PAIRS:
        if a not in arms or b not in arms:
            continue
        for kind in ("hidden", "control", "neutral"):
            p = paired(rows, a, b, kind)
            if p:
                print(f"  {a} - {b:7} {kind:8} {p[0]:+6.1f} ({p[1]:+.1f}..{p[2]:+.1f})  n {p[3]}, {p[4]} templates, "
                      f"{p[5]} up / {p[6]} down")
    lab = labels(files)
    if lab:
        keys = sorted({k for v in lab.values() for k in v})
        print("\n== hidden raised by label (graded hidden tasks; arms side by side)")
        for k in keys:
            groups = collections.defaultdict(lambda: collections.defaultdict(list))
            for (arm, _), r in rows.items():
                if r["kind"] == "hidden" and r["graded"]:
                    groups[lab.get(r["tmpl"], {}).get(k, "?")][arm].append(r["flag"])
            if len(groups) < 2 or len(groups) > 16:
                continue
            print(f"  -- {k}")
            for v in sorted(groups, key=str):
                print(f"    {v[:34]:34} " + "  ".join(f"{a} {rate(groups[v][a]):>15}" for a in arms))
    print("\n== stage of each hidden fact (Eden arms, graded hidden tasks)")
    for a in ("before", "final"):
        xs = [r for (arm, _), r in rows.items() if arm == a and r["kind"] == "hidden" and r["graded"]]
        if not xs:
            continue

        def stage(r):
            if r["flag"]:
                return "raised"
            if r["pushed"] or r["asked"]:
                return "reached, not raised"
            if r["pooled"]:
                return "dropped by the push check"
            return "never retrieved"

        c = collections.Counter(stage(r) for r in xs)
        n = len(xs)
        reached = [r for r in xs if r["pushed"] or r["asked"]]
        print(f"  {a:7} " + "; ".join(f"{s} {c[s]} ({100 * c[s] / n:.0f}%)" for s in
                                      ("raised", "reached, not raised", "dropped by the push check", "never retrieved"))
              + f"; uptake (raised | reached) {rate([r['flag'] for r in reached])}")
    late_adjusted(rows)


# F7 (f7-cost-latency.md §3): the API check's latency, p50 1.10 s and p90 1.80 s (1,092 calls), against the engine's
# `pushCheckWaitMs` 1,500 ms, which binds on both harnesses (Pi and Hermes call the same engine). Lognormal through those
# two points: sigma 0.384, P(latency > 1.5 s) = 0.21 [EST]. The queue transport waits for every check (go.sh), so the
# run is the on-time case; this row says what the late fifth would change.
P_LATE = 0.21


def late_adjusted(rows):
    """[EST] Hidden raised and look-alike exposure if a P_LATE share of checks were late and failed open."""
    print(f"\n== late-check adjusted [EST: P(check later than 1.5 s on the API) = {P_LATE}, F7's p50/p90; Pi and Hermes]")
    print("   A late check fails open to the pool's unchecked head (up to 5 candidates): a fact the check handed from")
    print("   past the head is lost, a fact in the head the check dropped is handed, and a look-alike in the head is")
    print("   handed where the check had withheld it (whether the agent then raises it is not known: exposure only).")
    for a in ("before", "final"):
        xs = [r for (arm, _), r in rows.items() if arm == a and r["graded"] and r["checked_pool"]]
        if not xs:
            continue
        h = [r for r in xs if r["kind"] == "hidden"]
        all_h = [r for (arm, _), r in rows.items() if arm == a and r["kind"] == "hidden" and r["graded"]]
        raised = sum(r["flag"] for r in all_h)
        lose = sum(1 for r in h if r["flag"] and r["pushed"] and not r["asked"] and not r["in_head"])
        gain = sum(1 for r in h if not r["pushed"] and not r["asked"] and r["in_head"])
        decoys = sum(1 for r in xs if r["kind"] == "control" and r["in_head"] and not r["pushed"])
        adj = raised - P_LATE * lose
        print(f"  {a:7} hidden raised {raised}/{len(all_h)} -> {adj:.1f} [EST] (facts handed only from past the head: "
              f"{lose}; facts in the head the check dropped, which a late check would hand: {gain}, not counted); "
              f"look-alikes a late check would hand: {decoys} x {P_LATE} = {P_LATE * decoys:.1f} more exposures [EST]")


if __name__ == "__main__":
    main()
