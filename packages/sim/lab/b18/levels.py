"""B18 (docs/research/b18-heldout18.md): each arm's level on hidden facts and its concerns, on Haiku's grade (the
run's grader) and on Sonnet's (regrade-sonnet.json beside each out.json, `i3-regrade.ts`).

    python3 -I levels.py --short DIR [DIR ...] --days DIR [DIR ...] [--anchored a,b,c] [--read]

Per horizon and pooled, for all tasks, seeds 41-42 alone (A29's scale) and the `--anchored` templates (D466): hidden
raised per arm with a bootstrap 95% interval (5,000 draws; whole templates resampled for short and pooled, whole users
for days, as the pre-registration says), and the paired differences between arms the same way. Then control and
neutral concerns per arm: Haiku-flagged, and confirmed (Haiku flagged it and Sonnet keeps it). `--read` prints each
flagged answer with both verdicts, for the by-hand read.
"""
import argparse
import json
import os
import random

ARMS = ["tools", "eden~pre", "eden"]
NAMES = {"tools": "tools", "eden~pre": "pre", "eden": "now"}
PAIRS = [("eden", "eden~pre"), ("eden", "tools"), ("eden~pre", "tools")]


def load(dirs, horizon):
    rows = []
    for d in dirs:
        run = json.load(open(os.path.join(d, "out.json")))
        seed = run["seeds"][0]
        tasks = {t["id"]: t for t in run["tasks"]}
        sonnet = {}
        p = os.path.join(d, "regrade-sonnet.json")
        if os.path.exists(p):
            for g in json.load(open(p))["graded"]:
                if g.get("readable", True) and g.get("facts") is not None:
                    sonnet[(g["task"], g["condition"])] = g["facts"]
        for r in run["results"]:
            t = tasks.get(r["task"])
            if not t or t["kind"] not in ("hidden", "control", "neutral") or r.get("facts") is None:
                continue
            s = sonnet.get((r["task"], r["condition"]))
            hidden = t["kind"] == "hidden"
            haiku = all(r["facts"].values()) if hidden else any(r["facts"].values())
            if hidden:
                son = all(s.values()) if s is not None else None
            else:
                # Only flagged answers are regraded: a concern is confirmed when Sonnet keeps it.
                son = (any(s.values()) if s is not None else None) if haiku else False
            rows.append({
                "horizon": horizon, "seed": seed, "task": r["task"], "arm": r["condition"], "kind": t["kind"],
                "template": t["type"], "haiku": haiku, "sonnet": son, "answer": r.get("answer", ""),
            })
    return rows


def boot(units, stat, draws=5000):
    """`units`: cluster -> list of rows; `stat`: rows -> number. The point value and a 95% percentile interval."""
    rng = random.Random(1)
    keys = sorted(units)
    point = stat([x for k in keys for x in units[k]])
    vals = []
    for _ in range(draws):
        pick = [keys[rng.randrange(len(keys))] for _ in keys]
        v = stat([x for k in pick for x in units[k]])
        if v is not None:
            vals.append(v)
    vals.sort()
    return point, vals[int(0.025 * len(vals))], vals[min(len(vals) - 1, int(0.975 * len(vals)))]


def clusters(rows, by):
    out = {}
    for r in rows:
        out.setdefault(tuple(r[k] for k in by), []).append(r)
    return out


def section(title, rows, grade, by):
    hidden = [r for r in rows if r["kind"] == "hidden" and r[grade] is not None]
    # One entry per (horizon, seed, task): the arms' verdicts side by side.
    tasks = {}
    for r in hidden:
        tasks.setdefault((r["horizon"], r["seed"], r["task"]), {"template": r["template"], "seed": r["seed"],
                                                                "horizon": r["horizon"]})[r["arm"]] = r[grade]
    full = [t for t in tasks.values() if all(a in t for a in ARMS)]
    units = clusters(full, by)
    print(f"  {title}, {grade}: {len(full)} hidden tasks, {len(units)} clusters ({'+'.join(by)})")
    if not full:
        return
    for a in ARMS:
        n = sum(t[a] for t in full)
        p, lo, hi = boot(units, lambda xs, a=a: 100 * sum(x[a] for x in xs) / len(xs) if xs else None)
        print(f"    {NAMES[a]:6} {n:3}/{len(full)} = {p:5.1f}% ({lo:.1f}..{hi:.1f})")
    for a, b in PAIRS:
        p, lo, hi = boot(units, lambda xs, a=a, b=b: 100 * sum(x[a] - x[b] for x in xs) / len(xs) if xs else None)
        only_a = sum(1 for t in full if t[a] and not t[b])
        only_b = sum(1 for t in full if t[b] and not t[a])
        print(f"    {NAMES[a]} - {NAMES[b]}: {p:+5.1f} points ({lo:+.1f}..{hi:+.1f}); only {NAMES[a]} {only_a}, "
              f"only {NAMES[b]} {only_b}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--short", nargs="*", default=[])
    ap.add_argument("--days", nargs="*", default=[])
    ap.add_argument("--anchored", default="")
    ap.add_argument("--read", action="store_true")
    a = ap.parse_args()
    short, days = load(a.short, "short"), load(a.days, "days")
    anchored = set(filter(None, a.anchored.split(",")))
    subsets = [("all", lambda r: True), ("seeds 41-42", lambda r: r["seed"] in (41, 42))]
    if anchored:
        subsets.append(("anchored", lambda r: r["template"] in anchored))
        subsets.append(("not anchored", lambda r: r["template"] not in anchored))
    for name, keep in subsets:
        print(f"\n== hidden facts raised: {name}")
        for grade in ("haiku", "sonnet"):
            section("short", [r for r in short if keep(r)], grade, ("template",))
            section("days (users resampled)", [r for r in days if keep(r)], grade, ("seed",))
            section("days (templates resampled)", [r for r in days if keep(r)], grade, ("template",))
            section("short + days", [r for r in short + days if keep(r)], grade, ("template",))
    print("\n== concerns on control and neutral answers: Haiku-flagged / confirmed by Sonnet / answers")
    for horizon, rows in (("short", short), ("days", days), ("both", short + days)):
        for kind in ("control", "neutral"):
            cells = []
            for arm in ARMS:
                rs = [r for r in rows if r["arm"] == arm and r["kind"] == kind]
                unread = sum(1 for r in rs if r["haiku"] and r["sonnet"] is None)
                cells.append(f"{NAMES[arm]} {sum(r['haiku'] for r in rs)} / {sum(bool(r['sonnet']) for r in rs)} / "
                             f"{len(rs)}" + (f" ({unread} not regraded)" if unread else ""))
            print(f"  {horizon:5} {kind:8} " + "   ".join(cells))
    if a.read:
        print("\n== flagged answers")
        for r in short + days:
            if r["kind"] != "hidden" and r["haiku"]:
                print(f"\n--- {r['horizon']} {NAMES[r['arm']]} {r['task']} ({r['kind']}): Haiku concern, Sonnet "
                      f"{'keeps' if r['sonnet'] else 'drops' if r['sonnet'] is False else 'not graded'}\n{r['answer']}")


main()
