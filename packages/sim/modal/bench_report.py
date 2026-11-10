"""The powered bench's report (F3, D487): paired effects between arms of pi-ab fan-out runs, with tasks clustered by
template. Lab tooling, not product code; no Modal and no numpy in it (`tests/test_bench_report.py`).

Tasks that share a template share their errors (the same request and planted fact in another seed's world), so an
interval that treats every task as independent is too narrow (Miller, arXiv 2411.00640). For each `--pair A:B` (the
effect is A − B, on tasks both arms finished) and each metric this prints:

- the paired effect with a **cluster bootstrap** interval: templates resampled with their tasks, `--draws` times;
- the task-level (naive) interval and a seed-clustered one beside it, and the design effect (clustered variance over
  naive variance);
- for the yes/no metrics the exact paired McNemar test (it assumes independent pairs: read it beside the clustered
  interval, not instead of it);
- the **minimum detectable effect** of the run: the true effect a two-sided 5% test finds with 80% power, 2.80 × the
  clustered standard error;
- how far more seeds could narrow the interval: the between-template share of the variance does not shrink with
  seeds, so the report gives the half-width's floor and the seeds a target half-width needs (`--target`, points).

    python3 -I packages/sim/modal/bench_report.py --pair eden:tools --pair eden~minus-fewer:eden \\
        --group cached=.local/modal/f3-b-41 --group inrun=.local/modal/f3-b-45,.local/modal/f3-b-49 \\
        [--sonnet] [--target 1.5] [--draws 5000] [--json OUT]

A run directory is what `lab_fanout.py` leaves: one directory a shard with `out.json`, its `out.timeline/tasks.jsonl`
(ask calls and questions a task) and any `regrade*.json` beside it (`regrade.ts`; with `--sonnet` a Sonnet verdict
replaces the run's grader's wherever Sonnet graded the answer).
"""
import json
import math
import os
import random
import sys

DRAWS = 5000
# Two-sided 5%, 80% power: z(0.975) + z(0.80).
MDE_FACTOR = 1.959964 + 0.841621
Z95 = 1.959964
# metric -> (label, scale, unit, the task kinds it is read on, yes/no)
METRICS = {
    "hidden": ("hidden facts raised", 100, "points", ("hidden",), True),
    "concerns": ("false concerns (control, neutral)", 100, "points", ("control", "neutral"), True),
    "usd": ("$ per 1,000 tasks", 1, "$/1k", None, False),
    "wall": ("wall mean", 1, "s", None, False),
    "turns": ("agent model turns a task", 1, "turns", None, False),
    "askCalls": ("ask_context calls a task", 1, "calls", None, False),
    "questions": ("questions asked a task", 1, "questions", None, False),
}


def template_of(task):
    """A task's template: the fact it is graded on (hidden-context suites), else the last part of its id."""
    must = task.get("must") or []
    name = must[0]["id"] if must and isinstance(must[0], dict) and must[0].get("id") else task["id"].rsplit(":", 1)[-1]
    return f"{task.get('suite', '')}:{name}"


def read_sonnet(shard_dir):
    """Sonnet's verdict per (task, arm) from the shard's regrade files; an answer it failed on is in `failed`."""
    verdict, failed = {}, set()
    for name in sorted(os.listdir(shard_dir)):
        if not (name.startswith("regrade") and name.endswith(".json")):
            continue
        with open(os.path.join(shard_dir, name)) as f:
            graded = json.load(f).get("graded", [])
        for g in graded:
            if "sonnet" not in g.get("grader", ""):
                continue
            key = (g["task"], g["condition"])
            if g.get("facts") is None or g.get("error"):
                if key not in verdict:
                    failed.add(key)
            else:
                verdict[key] = float(any(g["facts"].values()))
                failed.discard(key)
    return verdict, failed


def read_asks(shard_dir):
    """Each (task, arm)'s `ask_context` calls and questions, from the shard's timeline; {} without one."""
    path = os.path.join(shard_dir, "out.timeline", "tasks.jsonl")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            calls = questions = 0
            for e in rec.get("events", []):
                data = e.get("data") or {}
                if e.get("ev") == "tool.ask_context" and "tool" in data:
                    calls += 1
                elif e.get("ev") == "eden.ask" and "question" in data:
                    questions += 1
            out[(rec["task"], rec["condition"])] = (calls, questions)
    return out


def load(groups, sonnet=False):
    """Rows keyed (group, shard, task): its kind, template, seed and each arm's metrics. `groups`: [(name, [dirs])]."""
    rows, stats = {}, {"sonnetGraded": 0, "sonnetFailed": 0, "ungraded": 0, "shards": 0}
    for group, runs in groups:
        for run in runs:
            for name in sorted(os.listdir(run)):
                shard = os.path.join(run, name)
                path = os.path.join(shard, "out.json")
                if not os.path.exists(path):
                    continue
                stats["shards"] += 1
                with open(path) as f:
                    doc = json.load(f)
                tasks = {t["id"]: t for t in doc["tasks"]}
                eden_runs = sum(1 for r in doc["results"] if not r["condition"].startswith(("tools", "none")))
                background = sum(b.get("cardsUsd", 0) + b.get("bridgeUsd", 0) for b in doc.get("background", []))
                share = background / max(eden_runs, 1)
                verdict, failed = read_sonnet(shard) if sonnet else ({}, set())
                asks = read_asks(shard)
                for r in doc["results"]:
                    task = tasks.get(r["task"])
                    if task is None:
                        continue
                    if r.get("facts") is None:
                        stats["ungraded"] += 1
                        continue
                    key2 = (r["task"], r["condition"])
                    raised = float(any(r["facts"].values()))
                    if key2 in verdict:
                        raised = verdict[key2]
                        stats["sonnetGraded"] += 1
                    elif key2 in failed:
                        stats["sonnetFailed"] += 1
                    with_eden = not r["condition"].startswith(("tools", "none"))
                    m = {
                        "raised": raised,
                        "usd": (r["costUsd"] + r.get("edenCostUsd", 0) + (share if with_eden else 0)) * 1000,
                        "wall": r["wallMs"] / 1000,
                        "turns": float(r.get("modelCalls", 0)),
                    }
                    if key2 in asks:
                        m["askCalls"], m["questions"] = (float(x) for x in asks[key2])
                    row = rows.setdefault((group, shard, r["task"]), {
                        "group": group, "kind": task["kind"], "template": template_of(task),
                        "seed": str((doc.get("seeds") or ["?"])[0]) if len(doc.get("seeds") or []) == 1 else shard,
                        "arms": {},
                    })
                    row["arms"][r["condition"]] = m
    return rows, stats


def value(row, arm, metric):
    m = row["arms"].get(arm)
    if m is None:
        return None
    return m.get("raised" if metric in ("hidden", "concerns") else metric)


def pairs(rows, a, b, metric, group=None):
    """[(template, seed, A − B, A, B)] over the tasks both arms finished, of the metric's kinds (and one group)."""
    kinds = METRICS[metric][3]
    out = []
    for row in rows.values():
        if (kinds and row["kind"] not in kinds) or (group and row["group"] != group):
            continue
        x, y = value(row, a, metric), value(row, b, metric)
        if x is None or y is None:
            continue
        out.append((row["template"], row["seed"], x - y, x, y))
    return out


def clusters(ps, by):
    """Each cluster's (sum of differences, tasks), in a fixed order; `by` 0 clusters by template, 1 by seed."""
    acc = {}
    for p in ps:
        s = acc.setdefault(p[by], [0.0, 0])
        s[0] += p[2]
        s[1] += 1
    return [tuple(acc[k]) for k in sorted(acc)]


def cluster_boot(cl, draws=DRAWS, seed=1):
    """The mean difference's bootstrap over clusters: (point, lo, hi, se). Whole clusters are drawn with replacement
    and the statistic is the ratio of sums (clusters differ in size when an arm lost tasks)."""
    n = sum(c[1] for c in cl)
    if not n:
        return None
    point = sum(c[0] for c in cl) / n
    if len(cl) < 2:
        return (point, float("nan"), float("nan"), float("nan"))
    rng, k, vals = random.Random(seed), len(cl), []
    for _ in range(draws):
        s = m = 0
        for i in rng.choices(range(k), k=k):
            s += cl[i][0]
            m += cl[i][1]
        vals.append(s / m)
    vals.sort()
    mean = sum(vals) / draws
    se = math.sqrt(sum((v - mean) ** 2 for v in vals) / (draws - 1))
    return (point, vals[int(0.025 * draws)], vals[int(0.975 * draws) - 1], se)


def naive(ps):
    """The task-level interval, every pair independent: (point, lo, hi, se)."""
    n = len(ps)
    if not n:
        return None
    mean = sum(p[2] for p in ps) / n
    if n < 2:
        return (mean, float("nan"), float("nan"), float("nan"))
    se = math.sqrt(sum((p[2] - mean) ** 2 for p in ps) / (n - 1) / n)
    return (mean, mean - Z95 * se, mean + Z95 * se, se)


def mcnemar(ps):
    """The exact paired McNemar test on a yes/no metric: (A only, B only, two-sided p)."""
    b = sum(1 for p in ps if p[3] > p[4])
    c = sum(1 for p in ps if p[3] < p[4])
    n, k = b + c, min(b, c)
    if n == 0:
        return (0, 0, 1.0)
    # log-space binomial tail at p = 1/2, so thousands of discordant pairs do not overflow.
    tail = sum(math.exp(math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) - n * math.log(2))
               for i in range(k + 1))
    return (b, c, min(1.0, 2 * tail))


def variance_parts(ps):
    """Between-template and within-template variance of the paired difference (one-way ANOVA, unbalanced), with the
    templates and the mean tasks a template: what more seeds can and cannot shrink."""
    by = {}
    for p in ps:
        by.setdefault(p[0], []).append(p[2])
    k, n = len(by), len(ps)
    if k < 2 or n <= k:
        return None
    grand = sum(p[2] for p in ps) / n
    ssw = sum(sum((d - sum(v) / len(v)) ** 2 for d in v) for v in by.values())
    ssb = sum(len(v) * (sum(v) / len(v) - grand) ** 2 for v in by.values())
    within = ssw / (n - k)
    n0 = (n - sum(len(v) ** 2 for v in by.values()) / n) / (k - 1)
    between = max(0.0, (ssb / (k - 1) - within) / n0)
    return {"templates": k, "perTemplate": n / k, "between": between, "within": within}


def seeds_for(parts, half_width):
    """Tasks a template (seeds) for a 95% half-width of `half_width` (the metric's own units) with these templates;
    None when the between-template variance alone is wider than that."""
    k = parts["templates"]
    room = k * (half_width / Z95) ** 2 - parts["between"]
    return None if room <= 0 else parts["within"] / room


def analyse(rows, a, b, metric, group=None, draws=DRAWS):
    ps = pairs(rows, a, b, metric, group)
    if not ps:
        return None
    by_template = cluster_boot(clusters(ps, 0), draws)
    by_seed = cluster_boot(clusters(ps, 1), draws)
    flat = naive(ps)
    out = {
        "n": len(ps), "templates": len({p[0] for p in ps}), "seeds": len({p[1] for p in ps}),
        "rateA": sum(p[3] for p in ps) / len(ps), "rateB": sum(p[4] for p in ps) / len(ps),
        "effect": by_template[0], "clustered": by_template[1:3], "seClustered": by_template[3],
        "naive": flat[1:3], "seNaive": flat[3], "seedClustered": by_seed[1:3],
        "mde": MDE_FACTOR * by_template[3],
        "designEffect": (by_template[3] / flat[3]) ** 2 if flat[3] and flat[3] == flat[3] and flat[3] > 0 else None,
        "parts": variance_parts(ps),
    }
    if METRICS[metric][4]:
        out["mcnemar"] = mcnemar(ps)
    return out


def fmt(res, metric, target=None):
    label, scale, unit, _, binary = METRICS[metric]
    d = 1 if scale == 100 else 3
    f = lambda x: f"{x * scale:+.{d}f}"
    lo, hi = res["clustered"]
    star = "*" if lo > 0 or hi < 0 else ""
    lines = [
        f"  {label}: {f(res['effect'])} {unit} ({f(lo)}..{f(hi)}){star} clustered by template; "
        f"n {res['n']} pairs, {res['templates']} templates, {res['seeds']} seeds; "
        f"A {res['rateA'] * scale:.{d}f}, B {res['rateB'] * scale:.{d}f}",
        f"    task-level ({f(res['naive'][0])}..{f(res['naive'][1])}), by seed ({f(res['seedClustered'][0])}.."
        f"{f(res['seedClustered'][1])}); design effect "
        + (f"{res['designEffect']:.2f}" if res["designEffect"] is not None else "—")
        + f"; half-width {(hi - lo) / 2 * scale:.{d}f}, MDE {res['mde'] * scale:.{d}f} {unit} (80% power, 5% two-sided)",
    ]
    if binary:
        b, c, p = res["mcnemar"]
        lines.append(f"    McNemar exact (pairs taken as independent): A only {b}, B only {c}, p {p:.4f}")
    parts = res["parts"]
    if parts and target:
        floor = Z95 * math.sqrt(parts["between"] / parts["templates"]) * scale
        need = seeds_for(parts, target / scale)
        lines.append(
            f"    more seeds: floor ±{floor:.{d}f} {unit} with {parts['templates']} templates; ±{target:g} needs "
            + (f"{need:.1f} tasks a template (now {parts['perTemplate']:.1f})" if need is not None
               else "more templates, not more seeds"))
    return lines


def report(rows, stats, pair_list, groups, metrics, target=None, draws=DRAWS):
    lines, summary = [], {}
    lines.append(f"shards {stats['shards']}; ungraded results dropped {stats['ungraded']}"
                 + (f"; Sonnet graded {stats['sonnetGraded']}, failed {stats['sonnetFailed']} (the run's verdict kept)"
                    if stats["sonnetGraded"] or stats["sonnetFailed"] else ""))
    scopes = [("pooled", None)] + ([(g, g) for g in groups] if len(groups) > 1 else [])
    for a, b in pair_list:
        for scope, group in scopes:
            lines.append(f"\n[{a} − {b}] {scope}   (* the clustered interval excludes zero)")
            for metric in metrics:
                res = analyse(rows, a, b, metric, group, draws)
                if res is None:
                    continue
                summary[f"{a}|{b}|{scope}|{metric}"] = res
                lines += fmt(res, metric, target if metric == "hidden" else None)
    return lines, summary


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="bench_report.py")
    ap.add_argument("--pair", action="append", required=True, help="A:B, the effect A − B")
    ap.add_argument("--group", action="append", required=True, help="NAME=RUN_DIR[,RUN_DIR]")
    ap.add_argument("--metrics", default=",".join(METRICS))
    ap.add_argument("--sonnet", action="store_true")
    ap.add_argument("--target", type=float, default=1.5, help="the hidden half-width aimed for, points")
    ap.add_argument("--draws", type=int, default=DRAWS)
    ap.add_argument("--json")
    a = ap.parse_args(argv)
    groups = [(g.split("=", 1)[0], g.split("=", 1)[1].split(",")) for g in a.group]
    pair_list = [tuple(p.split(":", 1)) for p in a.pair]
    metrics = [m for m in a.metrics.split(",") if m]
    unknown = [m for m in metrics if m not in METRICS]
    if unknown or any(len(p) != 2 for p in pair_list):
        print(f"unknown metric {unknown} or a --pair not written A:B", file=sys.stderr)
        return 2
    rows, stats = load(groups, a.sonnet)
    lines, summary = report(rows, stats, pair_list, [g for g, _ in groups], metrics, a.target, a.draws)
    print("\n".join(lines))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"stats": stats, "effects": summary}, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
