# M5 (docs/research/m5-nudge-narrow.md): the narrower nudge's paired effect, `eden~deep − eden` (askNudgeDeep, D460,
# against the current askNudge), with the agent's asks (`toolCalls`: the eden arm's one tool is ask_context) beside
# hidden, concerns, $/1k and wall, and the pre-registered rule. Copied from M4's nudge.py, which reads:
# M4 (docs/research/m4-nudge.md): the ask nudge's paired effect, `eden − eden~minus-nudge`, Haiku-graded and
# Sonnet-graded, from lab_fanout runs (.local/modal/<run>/<shard>/out.json) and the Sonnet regrades beside each shard
# (<shard>/regrade-*.json, `regrade.ts --graders claude-sonnet-5-5`). Sonnet's verdict replaces the run's wherever
# Sonnet graded an answer (all hidden answers, and the control and neutral answers Haiku called a concern); an answer
# Sonnet failed to grade keeps Haiku's verdict and is counted. Bootstrap 95%: 5,000 draws, seed 1, tasks resampled
# within each (shard, kind) stratum, as M1's parts.py. `--templates F` (comma list of template names) adds the
# subset of tasks whose template (the task id's last part) is one of them (A12's 91 targeted templates). Pooled and per run group (`--group
# NAME=RUN,RUN`).
# usage: python3 -I narrow.py [--templates F] [--json OUT] --group short=RUN_DIR[,RUN_DIR] --group long=RUN_DIR...
import json, os, statistics as st, sys

import numpy as np

args = sys.argv[1:]


def opt(name, default=None, many=False):
    vals = []
    while name in args:
        i = args.index(name)
        vals.append(args[i + 1])
        del args[i : i + 2]
    return vals if many else (vals[-1] if vals else default)


A, B = "eden~deep", "eden"
TFILE = opt("--templates")
TEMPLATES = set(open(TFILE).read().strip().split(",")) if TFILE else set()
OUT = opt("--json")
GROUPS = [g.split("=", 1) for g in opt("--group", many=True)]
DRAWS = 5000

X = {}  # (group, shard, task) -> {arm: {haiku, sonnet, usd, wall}}
KIND, TEMPLATE = {}, {}
stats = {"sonnetGraded": 0, "sonnetFailed": 0, "sonnetFlips": {"hidden": [0, 0], "concern": [0, 0]}}

for group, runs in GROUPS:
    for run in runs.split(","):
        for name in sorted(os.listdir(run)):
            sdir = os.path.join(run, name)
            p = os.path.join(sdir, "out.json")
            if not os.path.exists(p):
                continue
            d = json.load(open(p))
            tasks = {t["id"]: t for t in d["tasks"]}
            eden_runs = sum(1 for r in d["results"] if r["condition"] != "tools")
            bk = sum(b.get("cardsUsd", 0) + b.get("bridgeUsd", 0) for b in d.get("background", [])) / max(eden_runs, 1)
            sonnet, failed = {}, set()
            for f in sorted(os.listdir(sdir)):
                if not (f.startswith("regrade") and f.endswith(".json")):
                    continue
                for g in json.load(open(os.path.join(sdir, f))).get("graded", []):
                    if "sonnet" not in g.get("grader", ""):
                        continue
                    k2 = (g["task"], g["condition"])
                    if g.get("facts") is None or g.get("error"):
                        failed.add(k2)
                    else:
                        sonnet[k2] = float(any(g["facts"].values()))
                        failed.discard(k2)
            for r in d["results"]:
                if r.get("facts") is None or r["condition"] not in (A, B):
                    continue
                t = tasks[r["task"]]
                haiku = float(any(r["facts"].values()))
                k2 = (r["task"], r["condition"])
                if k2 in sonnet:
                    stats["sonnetGraded"] += 1
                    kk = "hidden" if t["kind"] == "hidden" else "concern"
                    if sonnet[k2] != haiku:
                        stats["sonnetFlips"][kk][int(sonnet[k2] > haiku)] += 1
                elif k2 in failed:
                    stats["sonnetFailed"] += 1
                k = (group, sdir, r["task"])
                KIND[k] = t["kind"]
                TEMPLATE[k] = r["task"].rsplit(":", 1)[-1] in TEMPLATES
                X.setdefault(k, {})[r["condition"]] = {
                    "haiku": haiku,
                    "sonnet": sonnet.get(k2, haiku),
                    "sonnetSeen": k2 in sonnet,
                    "usd": (r["costUsd"] + r["edenCostUsd"] + bk) * 1000,
                    "wall": r["wallMs"] / 1000,
                    "asks": r["toolCalls"],
                }

done = [k for k in X if A in X[k] and B in X[k]]
print(f"tasks paired {len(done)} (dropped {len(X) - len(done)} an arm did not finish)")
print(f"Sonnet graded {stats['sonnetGraded']} answers, failed {stats['sonnetFailed']} (Haiku's verdict kept); "
      f"flips hidden −{stats['sonnetFlips']['hidden'][0]} +{stats['sonnetFlips']['hidden'][1]}, "
      f"concern −{stats['sonnetFlips']['concern'][0]} +{stats['sonnetFlips']['concern'][1]}")
unseen = sum(1 for k in done if KIND[k] == "hidden" for a in (A, B) if not X[k][a]["sonnetSeen"])
print(f"hidden answers Sonnet did not grade (Haiku's verdict kept): {unseen}")

rng = np.random.default_rng(1)


def boot(keys, f):
    strata = {}
    for k in keys:
        strata.setdefault((k[0], k[1], KIND[k]), []).append(f(k))
    groups = [np.array(v) for v in strata.values()]
    n = sum(len(g) for g in groups)
    if not n:
        return None
    point = sum(g.sum() for g in groups) / n
    sums = np.zeros(DRAWS)
    for g in groups:
        sums += g[rng.integers(0, len(g), size=(DRAWS, len(g)))].sum(axis=1)
    vals = np.sort(sums / n)
    return [float(point), float(vals[int(0.025 * DRAWS)]), float(vals[int(0.975 * DRAWS) - 1]), n]


def fmt(p, s=100):
    if p is None:
        return "—"
    star = "*" if p[1] > 0 or p[2] < 0 else " "
    return f"{p[0]*s:+.1f} ({p[1]*s:+.1f}..{p[2]*s:+.1f}){star} n {p[3]}"


def fmt3(p):
    return "—" if p is None else f"{p[0]:+.3f} ({p[1]:+.3f}..{p[2]:+.3f})" + ("*" if p[1] > 0 or p[2] < 0 else "")


eff = lambda f: (lambda k: X[k][A][f] - X[k][B][f])  # the narrower trigger minus the current one
summary = {}
scopes = [("pooled", lambda k: True)] + [(g, (lambda g: lambda k: k[0] == g)(g)) for g, _ in GROUPS]
print(f"\nThe effect, {A} − {B} (points; $/1k; s; asks a task). * the interval excludes zero.")
for name, keep in scopes:
    ks = [k for k in done if keep(k)]
    hid = [k for k in ks if KIND[k] == "hidden"]
    con = [k for k in ks if KIND[k] != "hidden"]
    tgt = [k for k in hid if TEMPLATE[k]]
    rest = [k for k in hid if not TEMPLATE[k]]
    rate = lambda keys, a, f: st.mean(X[k][a][f] for k in keys) if keys else float("nan")
    row = {
        "hiddenSonnet": boot(hid, eff("sonnet")),
        "hiddenHaiku": boot(hid, eff("haiku")),
        "concernsSonnet": boot(con, eff("sonnet")),
        "concernsHaiku": boot(con, eff("haiku")),
        "targetedSonnet": boot(tgt, eff("sonnet")),
        "targetedHaiku": boot(tgt, eff("haiku")),
        "otherSonnet": boot(rest, eff("sonnet")),
        "usdPer1k": boot(ks, eff("usd")),
        "wallMean": boot(ks, eff("wall")),
        "asks": boot(ks, eff("asks")),
        "rates": {a: {"hiddenSonnet": rate(hid, a, "sonnet"), "hiddenHaiku": rate(hid, a, "haiku"),
                      "concernsSonnet": rate(con, a, "sonnet"), "concernsHaiku": rate(con, a, "haiku")}
                  for a in (A, B)},
    }
    summary[name] = row
    print(f"\n[{name}] hidden {len(hid)}, control+neutral {len(con)}, targeted-template hidden {len(tgt)}")
    for a in (A, B):
        r = row["rates"][a]
        print(f"  {a:18} hidden Sonnet {r['hiddenSonnet']:.3f} Haiku {r['hiddenHaiku']:.3f}; "
              f"concerns Sonnet {r['concernsSonnet']:.4f} Haiku {r['concernsHaiku']:.4f}")
    print(f"  hidden, Sonnet    {fmt(row['hiddenSonnet'])}")
    print(f"  hidden, Haiku     {fmt(row['hiddenHaiku'])}")
    print(f"  concerns, Sonnet  {fmt(row['concernsSonnet'])}")
    print(f"  concerns, Haiku   {fmt(row['concernsHaiku'])}")
    print(f"  targeted, Sonnet  {fmt(row['targetedSonnet'])}")
    print(f"  targeted, Haiku   {fmt(row['targetedHaiku'])}")
    print(f"  other templates, Sonnet {fmt(row['otherSonnet'])}")
    print(f"  $/1k              {fmt3(row['usdPer1k'])}")
    print(f"  wall mean s       {fmt3(row['wallMean'])}")
    print(f"  asks a task       {fmt3(row['asks'])}")
    for a in (A, B):
        print(f"  {a:18} asks a task {rate(ks, a, 'asks'):.3f}")

# The pre-registered rule (m5-nudge-narrow.md §0): promote askNudgeDeep if, pooled, the targeted-template hidden effect
# (Sonnet) has its point at or above −1.0 point and its interval not wholly below zero, concerns are not up, and the
# asks, $/1k and wall point estimates are all below zero; else delete it.
pl = summary["pooled"]
t, c = pl["targetedSonnet"], pl["concernsSonnet"]
concerns_up = c is not None and c[0] > 0 and c[1] > 0
targeted_ok = t is not None and t[0] >= -0.01 and t[2] >= 0
falls = all(pl[m] is not None and pl[m][0] < 0 for m in ("asks", "usdPer1k", "wallMean"))
promote = targeted_ok and not concerns_up and falls
print(f"\nRULE: targeted Sonnet {fmt(t)} ok={targeted_ok}; concerns up {concerns_up}; asks {fmt3(pl['asks'])}, "
      f"$/1k {fmt3(pl['usdPer1k'])}, wall {fmt3(pl['wallMean'])} fall={falls} -> "
      f"{'PROMOTE' if promote else 'DELETE'} askNudgeDeep")
summary["rule"] = {"promote": promote, "targetedOk": targeted_ok, "concernsUp": concerns_up, "falls": falls, **stats}
if OUT:
    with open(OUT, "w") as f:
        json.dump(summary, f, indent=1)
