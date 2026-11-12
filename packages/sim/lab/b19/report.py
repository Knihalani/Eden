"""B19 (D1040–D1043, docs/research/b19-final-bench.md): the three-arm report. Each arm is one results file of
`hermes-ab.ts` or `pi-ab.ts` (run.sh writes STEM.json, STEM.tl/tasks.jsonl and ledger lines labelled STEM), so arms
with the same condition name (Eden before and Eden final) are told apart by file, not by condition. Lab tooling.

    python3 -I packages/sim/lab/b19/report.py --ledger .local/b19/ledger.jsonl \\
        --arm raw=.local/b19/runs/h-raw --arm before=.local/b19/runs/h-before --arm final=.local/b19/runs/h-final \\
        [--pair final:before --pair final:raw --pair before:raw] [--draws 5000] [--json OUT]

Per arm: hidden facts raised (the run's grader; run.sh grades with Sonnet 5.5), false concerns on control tasks
(the planted look-alike) and on neutral tasks, neutral-turn packets (share of neutral tasks handed any item, items a
neutral task), agent tokens a task, Eden's own spend per 1,000 tasks by ledger role (every `eden.*` line of the arm's
label, background cards and recap turns included, over the tasks that finished without an error), connector
calls a task (the agent's `search_<source>` calls, the calls Eden's
decision traces count on the task's clock, and the background backfill's reads spread over the arm's tasks), and
wall time a task, p50 and p90
(each stream's first task excluded: it pays the worker's start-up).

Each pair A:B prints A − B on the tasks both arms finished, with two 95% intervals from 5,000 bootstrap draws (seed
1): tasks resampled within clusters of the same template (short runs: suite and template, so a template's hidden,
control and neutral tasks over every seed move together) or of the same user-day (`--days` runs: a day's requests
share one transcript), and the naive task-level one beside it.
"""
import collections
import json
import math
import random
import sys

DRAWS = 5000


def args():
    out = {"arm": [], "pair": [], "ledger": None, "draws": DRAWS, "json": None}  # --arm NAME=STEM[,STEM…]
    a = sys.argv[1:]
    i = 0
    while i < len(a):
        k = a[i].lstrip("-")
        if k in ("arm", "pair"):
            out[k].append(a[i + 1])
        elif k in ("ledger", "json"):
            out[k] = a[i + 1]
        elif k == "draws":
            out[k] = int(a[i + 1])
        else:
            sys.exit(f"report.py: unknown flag {a[i]}")
        i += 2
    if not out["arm"]:
        sys.exit("report.py: needs --arm NAME=STEM")
    return out


def base_suite(suite):
    for tail in ("-control", "-neutral"):
        if suite.endswith(tail):
            return suite[: -len(tail)]
    return suite


def pct(xs, q):
    if not xs:
        return float("nan")
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))]


def read_arm(stem, ledger_rows):
    res = json.load(open(stem + ".json"))
    label = stem.rsplit("/", 1)[-1]
    tasks = {t["id"]: t for t in res["tasks"]}
    tl = [json.loads(line) for line in open(stem + ".tl/tasks.jsonl")]
    tl_by = {(t["task"], t["condition"]): t for t in tl}
    days = "user" in res and res["user"] and "worlds" in res["user"]
    day_of = {}
    if days:
        sizes = {w["seed"]: w["daySizes"] for w in res["user"]["worlds"]}
        by_cond = collections.defaultdict(list)
        for t in tl:
            by_cond[(t["condition"], t["seed"])].append(t)
        for (cond, seed), ts in by_cond.items():
            i = 0
            for d, n in enumerate(sizes[seed]):
                for _ in range(n):
                    if i < len(ts):
                        day_of[ts[i]["task"]] = f"{seed}:{d}"
                        i += 1
    # The first task of each stream (Hermes: a world under one condition; Pi: a seed's suite and variant) pays start-up.
    seen, first = set(), set()
    for t in tl:
        # Under `--days` a user is one stream whatever suite each request came from.
        stream = (t["condition"], t["seed"]) if days else (t["condition"], t["seed"], t["suite"])
        if stream not in seen:
            seen.add(stream)
            first.add(t["task"])
    rows = {}
    for r in res["results"]:
        t = tasks.get(r["task"])
        if not t or r.get("error"):
            continue
        rec = tl_by.get((r["task"], r["condition"]), {})
        ev = rec.get("events", [])
        agent_calls = sum(1 for e in ev if e["ev"].startswith("tool.search_") and e["ph"] == "B")
        # The engine's traces count what its connectors were sent (searches, polls, re-reads; partner.ts), per decision.
        eden_calls = sum(e.get("data", {}).get("sourceCalls", 0) for e in ev if e["ev"] == "eden.decision")
        graded = r.get("facts") is not None and len(t.get("must") or []) > 0
        rows[r["task"]] = {
            "kind": t["kind"],
            "cluster": day_of.get(r["task"]) if days else f"{base_suite(t.get('suite', ''))}:{t.get('type', '')}",
            "raised": (1.0 if any(r["facts"].values()) else 0.0) if graded else None,
            "packet": 1.0 if r.get("injectedItems", 0) > 0 else 0.0,
            "items": float(r.get("injectedItems", 0)),
            "tokens": float(r.get("promptTokens", 0) + r.get("completionTokens", 0)),
            "agentUsd": 1000 * r.get("costUsd", 0.0),
            "edenTaskUsd": 1000 * r.get("edenCostUsd", 0.0),
            "agentConn": float(agent_calls),
            "edenConn": float(eden_calls),
            # The agent's `ask_context` calls (Eden's MCP tool), from the timeline's tool spans.
            "asks": float(sum(1 for e in ev if e["ev"] == "tool.ask_context" and e["ph"] == "B")),
            "wall": r.get("wallMs", 0.0) / 1000,
            "first": r["task"] in first,
        }
    n = len(rows)
    roles = collections.defaultdict(lambda: [0, 0.0])
    for x in ledger_rows:
        if x.get("run") == label:
            roles[x.get("role", "?")][0] += 1
            roles[x.get("role", "?")][1] += x.get("costUsd", 0.0)
    bg_conn = sum(b.get("sourceCalls", 0) for b in res.get("background", []))
    flags = {
        "partial": bool(res.get("partial")),
        "stoppedStreams": res.get("stoppedStreams", 0),
        "errored": sum(1 for r in res["results"] if r.get("error")),
        "resumed": res.get("resumed"),
    }
    return {
        "label": label,
        "header": res,
        "rows": rows,
        "roles": dict(roles),
        "bgConn": bg_conn,
        "n": n,
        "days": days,
        "flags": flags,
    }


def read_arms(stems, ledger_rows):
    """One arm from several results files (Pi: one seed or user a process); task ids carry the seed, so none clash."""
    parts = [read_arm(s, ledger_rows) for s in stems]
    roles = collections.defaultdict(lambda: [0, 0.0])
    for p in parts:
        for k, v in p["roles"].items():
            roles[k][0] += v[0]
            roles[k][1] += v[1]
    rows = {}
    for p in parts:
        rows.update(p["rows"])
    return {
        "label": ",".join(p["label"] for p in parts),
        "rows": rows,
        "roles": dict(roles),
        "bgConn": sum(p["bgConn"] for p in parts),
        "n": sum(p["n"] for p in parts),
        "days": any(p["days"] for p in parts),
        "flags": {
            "partial": any(p["flags"]["partial"] for p in parts),
            "stoppedStreams": sum(p["flags"]["stoppedStreams"] for p in parts),
            "errored": sum(p["flags"]["errored"] for p in parts),
            "resumed": [p["flags"]["resumed"] for p in parts if p["flags"]["resumed"]],
        },
    }


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def summary(arm):
    rows = arm["rows"].values()
    by = lambda kind: [r for r in rows if r["kind"] == kind]  # noqa: E731
    hid = [r["raised"] for r in by("hidden") if r["raised"] is not None]
    ctl = [r["raised"] for r in by("control") if r["raised"] is not None]
    neu = [r["raised"] for r in by("neutral") if r["raised"] is not None]
    walls = [r["wall"] for r in rows if not r["first"]]
    n = max(1, arm["n"])
    eden_roles = {k: v for k, v in arm["roles"].items() if k.startswith("eden")}
    return {
        "flags": arm["flags"],
        "tasks": arm["n"],
        "hidden": {"raised": sum(hid), "n": len(hid), "rate": mean(hid)},
        "controlConcerns": {"concerns": sum(ctl), "n": len(ctl), "rate": mean(ctl)},
        "neutralConcerns": {"concerns": sum(neu), "n": len(neu), "rate": mean(neu)},
        "neutralPackets": {
            "withPacket": sum(r["packet"] for r in by("neutral")),
            "n": len(by("neutral")),
            "itemsPerTask": mean([r["items"] for r in by("neutral")]),
        },
        "agentTokensPerTask": mean([r["tokens"] for r in rows]),
        "agentUsdPer1k": mean([r["agentUsd"] for r in rows]),
        "edenUsdPer1kByRole": {k: 1000 * v[1] / n for k, v in sorted(eden_roles.items())},
        "edenCallsPer1kByRole": {k: 1000 * v[0] / n for k, v in sorted(eden_roles.items())},
        "edenUsdPer1k": 1000 * sum(v[1] for v in eden_roles.values()) / n,
        "asksPerTask": mean([r["asks"] for r in rows]),
        "connectorCallsPerTask": {
            "agent": mean([r["agentConn"] for r in rows]),
            "edenOnTask": mean([r["edenConn"] for r in rows]),
            "edenBackground": arm["bgConn"] / n,
        },
        "wallSeconds": {"p50": pct(walls, 0.5), "p90": pct(walls, 0.9), "n": len(walls)},
    }


METRICS = [
    ("hidden raised (pts)", "hidden", lambda r: r["raised"], 100),
    ("control concerns (pts)", "control", lambda r: r["raised"], 100),
    ("neutral concerns (pts)", "neutral", lambda r: r["raised"], 100),
    ("neutral packets (pts)", "neutral", lambda r: r["packet"], 100),
    ("agent tokens/task", None, lambda r: r["tokens"], 1),
    ("agent $/1k", None, lambda r: r["agentUsd"], 1),
    ("connector calls/task (agent+Eden)", None, lambda r: r["agentConn"] + r["edenConn"], 1),
    ("asks/task", None, lambda r: r["asks"], 1),
    ("wall s/task (mean)", None, lambda r: None if r["first"] else r["wall"], 1),
]


def boot(diffs, clusters, draws):
    rnd = random.Random(1)
    g = collections.defaultdict(list)
    for d, c in zip(diffs, clusters):
        g[c].append(d)
    gs = list(g.values())
    lo, hi = int(0.025 * draws), int(0.975 * draws) - 1
    cl = sorted(mean([d for q in rnd.choices(gs, k=len(gs)) for d in q]) for _ in range(draws))
    tk = sorted(mean(rnd.choices(diffs, k=len(diffs))) for _ in range(draws))
    return {"effect": mean(diffs), "clustered": [cl[lo], cl[hi]], "naive": [tk[lo], tk[hi]], "clusters": len(gs)}


def pair(a, b, draws):
    out = {}
    for name, kind, f, scale in METRICS:
        diffs, clusters = [], []
        for tid, ra in a["rows"].items():
            rb = b["rows"].get(tid)
            if rb is None or (kind and ra["kind"] != kind):
                continue
            va, vb = f(ra), f(rb)
            if va is None or vb is None:
                continue
            diffs.append(scale * (va - vb))
            clusters.append(ra["cluster"])
        if diffs:
            out[name] = {**boot(diffs, clusters, draws), "n": len(diffs)}
    return out


def fmt(x, d=2):
    return "—" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{d}f}"


def main():
    o = args()
    ledger = [json.loads(line) for line in open(o["ledger"])] if o["ledger"] else []
    arms = {}
    for spec in o["arm"]:
        name, stem = spec.split("=", 1)
        arms[name] = read_arms(stem.split(","), ledger)
    sums = {k: summary(v) for k, v in arms.items()}
    print("arm      tasks  hidden         control conc.  neutral conc.  neutral packets     tokens/task  agent $/1k"
          "  Eden $/1k  conn/task (agent, Eden, bg)  wall p50  p90")
    for k, s in sums.items():
        h, c, n, p, cc = s["hidden"], s["controlConcerns"], s["neutralConcerns"], s["neutralPackets"], s[
            "connectorCallsPerTask"]
        print(
            f"{k:8} {s['tasks']:5}  {h['raised']:.0f}/{h['n']} {fmt(100 * h['rate'], 1):>5}%  "
            f"{c['concerns']:.0f}/{c['n']} {fmt(100 * c['rate'], 1):>5}%  {n['concerns']:.0f}/{n['n']} "
            f"{fmt(100 * n['rate'], 1):>5}%  {p['withPacket']:.0f}/{p['n']} ({fmt(p['itemsPerTask'])} items)  "
            f"{fmt(s['agentTokensPerTask'], 0):>11}  {fmt(s['agentUsdPer1k']):>10}  {fmt(s['edenUsdPer1k']):>9}  "
            f"{fmt(cc['agent'])}, {fmt(cc['edenOnTask'])}, {fmt(cc['edenBackground'])}  "
            f"{fmt(s['wallSeconds']['p50'], 1):>8}  {fmt(s['wallSeconds']['p90'], 1)}"
        )
    for k, s in sums.items():
        f = s["flags"]
        if f["partial"] or f["stoppedStreams"] or f["errored"] or f["resumed"]:
            print(
                f"NOTE {k}: partial {f['partial']}, stopped streams {f['stoppedStreams']}, errored tasks "
                f"{f['errored']} (left out), resumed {bool(f['resumed'])}"
                + (" BIASED" if any(x.get("biased") for x in f["resumed"] or []) else "")
            )
    for k, s in sums.items():
        roles = ", ".join(
            f"{r} ${v:.3f} ({s['edenCallsPer1kByRole'][r]:.0f} calls)" for r, v in s["edenUsdPer1kByRole"].items()
        )
        print(f"Eden per 1k tasks, {k}: {roles or 'no model calls'}")
    known = ("final:before", "final:raw", "before:raw")
    pairs = o["pair"] or [p for p in known if all(x in arms for x in p.split(":"))]
    effects = {}
    for p in pairs:
        a, b = p.split(":")
        effects[p] = pair(arms[a], arms[b], o["draws"])
        kind = "user-days" if arms[a]["days"] else "templates"
        print(f"\n{a} − {b} (95% intervals; clustered by {kind}, then task-level)")
        for name, e in effects[p].items():
            print(
                f"  {name:36} n {e['n']:4}  {e['effect']:+9.2f}  [{e['clustered'][0]:+.2f}, {e['clustered'][1]:+.2f}]"
                f" ({e['clusters']} clusters)  task [{e['naive'][0]:+.2f}, {e['naive'][1]:+.2f}]"
            )
    if o["json"]:
        with open(o["json"], "w") as f:
            json.dump({"arms": sums, "effects": effects, "stems": {k: v["label"] for k, v in arms.items()}}, f,
                      indent=1)


if __name__ == "__main__":
    main()
