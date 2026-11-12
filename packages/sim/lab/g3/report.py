"""G3 (target 3): agent + Eden against the agent alone, per arm of `g3/run.sh` [EST; served by subagents (D1101)].

    python3 -I packages/sim/lab/g3/report.py RUN_DIR [--queue Q] [--base D] [--arms raw,D,LK] [--json OUT]

Reads RUN_DIR/<arm>.json and <arm>.tl/tasks.jsonl (one pi-ab process an arm) and the queue's sized answers. The
queue books no usage, so every dollar and second is estimated from sizes, as final/cost.py and f11/report.py do:
four characters a token, Haiku 5.5 list prices ($0.10 in, $0.01 cache read, $0.125 cache write, $0.50 out per
million), an agent call's prompt before its last message read from cache on 90% of calls, the check's fixed
instructions likewise; a call waits 596 ms + 2.93 ms an output token (H3's fit).

- The agent's bill is split into its cached prefix, its uncached last message (the request with Eden's packet, or
  the tools' results) and its output, so a lever's effect on each is visible.
- The push check is priced from the queue's sizes (the subagents' short replies) with its rule sheet (D1180) read
  from cache on 90% of calls, the bar's figure; again with the sheet written on every call (a user whose requests
  are more than the cache's five minutes apart); and at F7's real-API figure before the sheet (D1190: $0.000210).
- Three pricings, the bar's: first-party connectors at the lab's short prompt; Composio ($0.30 per 1,000 connector
  calls, the agent's and Eden's request-time calls); a production prompt (`--prod` more cached tokens on every agent
  call, default 10,000 and 30,000). `break-even` is the extra prompt at which the arm's total equals the raw arm's.
- Handed: the planted item (a hidden task's fact, a control task's look-alike) among the items Eden's packets cited,
  split by the packet's lead (a `pushLookup` reference packet says "for reference").
- Paired differences are template-clustered bootstrap 95% intervals.
"""
import collections
import json
import os
import random
import sys

HAIKU = {"in": 0.10e-6, "cr": 0.01e-6, "cw": 0.125e-6, "out": 0.50e-6}
CPT = 4.0
HIT = 0.9
CACHED = HIT * HAIKU["cr"] + (1 - HIT) * HAIKU["cw"]
REAL_CHECK_USD = 0.000210
COMPOSIO = 0.30 / 1000


def args():
    o = {"run": None, "queue": None, "base": "D", "arms": None, "json": None, "prod": "10000,30000", "draws": 2000}
    a = sys.argv[1:]
    i = 0
    while i < len(a):
        if not a[i].startswith("--"):
            o["run"] = a[i]
            i += 1
            continue
        o[a[i][2:]] = a[i + 1]
        i += 2
    if not o["run"]:
        sys.exit(__doc__)
    o["queue"] = o["queue"] or os.path.join(os.path.dirname(o["run"].rstrip("/")), "q")
    return o


def check_costs(queue, prefix):
    """Per run label: the push check's calls and $ from the queue's sized answers."""
    sizes = {}
    done = os.path.join(queue, "done")
    for f in os.listdir(done):
        try:
            d = json.load(open(os.path.join(done, f)))
        except ValueError:
            continue
        if "size" in d and d.get("role") == "eden.check":
            sizes[d["id"]] = d["size"]
    by = collections.defaultdict(lambda: [0, 0.0, 0.0, 0.0, 0])
    for line in open(os.path.join(queue, "calls.jsonl")):
        c = json.loads(line)
        if c.get("role") != "eden.check" or not str(c.get("run", "")).startswith(prefix):
            continue
        d = by[c["run"]]
        s = sizes.get(c.get("key"))
        if not s:
            d[4] += 1
            continue
        # The rule sheet (D1180) is its own cached block; `size.sheet` keeps it apart (answers put before that
        # field existed: whatever a sheeted message holds past a sheetless check's 3,300 characters, an estimate).
        sheet = s.get("sheet", max(0, s["messages"] - 3300) if s["messages"] > 6000 else 0) / CPT
        sysT, userT, out = s["system"] / CPT, (s["messages"] + s["tools"]) / CPT - sheet, s["out"] / CPT
        d[0] += 1
        d[1] += userT * HAIKU["in"] + (sysT + sheet) * CACHED + out * HAIKU["out"]
        d[2] += 596 + 2.93 * out
        d[3] += sheet * (HAIKU["cw"] - CACHED)
    return by


def base_suite(s):
    for t in ("-control", "-neutral"):
        if s.endswith(t):
            return s[: -len(t)]
    return s


def rows_of(stem):
    res = json.load(open(stem + ".json"))
    tasks = {t["id"]: t for t in res["tasks"]}
    tl = {}
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        tl[t["task"]] = t
    out = []
    for r in res["results"]:
        t = tasks.get(r["task"])
        if not t or r.get("error"):
            continue
        rec = tl.get(r["task"], {})
        ev = sorted(rec.get("events", []), key=lambda e: e["t"])
        turns = conn = rounds = asks = checks = eden_conn = late = 0
        pre = last = outp = model_ms = ask_ms = 0.0
        begins, tool_iv, searched = {}, [], False
        for e in ev:
            d = e.get("data") or {}
            k, ph = e["ev"], e["ph"]
            if k == "model.request" and ph == "B":
                turns += 1
                searched = False
                begins[e.get("id")] = d
            elif k == "model.request" and ph == "E":
                b = begins.get(e.get("id"), {})
                if "inChars" in b:
                    tin = b["inChars"] / CPT
                    la = min(tin, b.get("lastChars", 0) / CPT)
                    o = d.get("outChars", 0) / CPT
                    pre += tin - la
                    last += la
                    outp += o
                    model_ms += 596 + 2.93 * o
            elif k.startswith("tool.search_") and ph == "B":
                begins[("tool", e.get("id"))] = e["t"]
                conn += 1
                if not searched:
                    rounds += 1
                    searched = True
            elif k.startswith("tool.search_") and ph == "E":
                b = begins.get(("tool", e.get("id")))
                if b is not None:
                    tool_iv.append((b, e["t"]))
            elif k == "tool.ask_context" and ph == "B":
                asks += 1
                begins[("ask", e.get("id"))] = e["t"]
            elif k == "tool.ask_context" and ph == "E":
                ask_ms += e["t"] - begins.get(("ask", e.get("id")), e["t"])
            elif k == "eden.check" and ph == "B":
                checks += 1
            elif k == "eden.check" and ph == "E":
                late += 1 if turns > 0 else 0
            elif k == "eden.decision":
                eden_conn += d.get("sourceCalls", 0) or 0
        tool_ms, end = 0.0, -1.0
        for a, b in sorted(tool_iv):
            if b > end:
                tool_ms += b - max(a, end)
                end = b
        graded = r.get("facts") is not None and len(t.get("must") or []) > 0
        fact = (1.0 if any(r["facts"].values()) else 0.0) if graded else None
        planted = rec.get("planted")
        cited = planted is not None and planted in (rec.get("cited") or [])
        packets = rec.get("packets") or ""
        lookup = ", for reference; " in packets
        out.append(
            {
                "task": r["task"],
                "kind": t["kind"],
                "cluster": f"{base_suite(t.get('suite', ''))}:{t.get('type', '')}",
                "raised": fact if t["kind"] == "hidden" else None,
                "concern": fact if t["kind"] != "hidden" else None,
                "handed": (1.0 if cited else 0.0) if t["kind"] != "neutral" else None,
                "handedLookup": (1.0 if cited and lookup else 0.0) if t["kind"] != "neutral" else None,
                "packet": 1.0 if r.get("injectedItems", 0) > 0 else 0.0,
                "packetChars": float(len(packets)),
                "turns": float(turns),
                "agentConn": float(conn),
                "edenConn": float(eden_conn),
                "rounds": float(rounds),
                "asks": float(asks),
                "checks": float(checks),
                "late": late,
                "preUsd": pre * CACHED,
                "lastUsd": last * HAIKU["in"],
                "outUsd": outp * HAIKU["out"],
                "outTok": outp,
                "wait": (model_ms + tool_ms + ask_ms) / 1000,
            }
        )
    return out


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else float("nan")


def boot(pairs, draws, seed=1):
    by = collections.defaultdict(list)
    for c, d in pairs:
        by[c].append(d)
    keys = list(by)
    if not keys:
        return (float("nan"),) * 3
    rnd = random.Random(seed)
    est = sum(sum(v) for v in by.values()) / sum(len(v) for v in by.values())
    sims = []
    for _ in range(draws):
        pick = [by[rnd.choice(keys)] for _ in keys]
        sims.append(sum(sum(p) for p in pick) / sum(len(p) for p in pick))
    sims.sort()
    return est, sims[int(0.025 * draws)], sims[int(0.975 * draws) - 1]


def main():
    o = args()
    run = o["run"].rstrip("/")
    P = os.path.basename(run)
    arms = o["arms"].split(",") if o["arms"] else sorted(
        (f[:-5] for f in os.listdir(run) if f.endswith(".json") and os.path.isdir(os.path.join(run, f[:-5] + ".tl"))),
        key=lambda a: (a != "raw", a != o["base"], a),
    )
    chk = check_costs(o["queue"], P + "-")
    prods = [int(x) for x in o["prod"].split(",")]
    by = {}
    for a in arms:
        rows = rows_of(os.path.join(run, a))
        c = chk.get(f"{P}-{a}", [0, 0.0, 0.0, 0.0, 0])
        per_call = (c[1] / c[0], c[2] / c[0]) if c[0] else (0.0, 0.0)
        for r in rows:
            r["agentUsd"] = r["preUsd"] + r["lastUsd"] + r["outUsd"]
            r["checkUsd"] = r["checks"] * per_call[0]
            r["checkReal"] = r["checks"] * REAL_CHECK_USD
            r["checkCold"] = r["checks"] * (c[1] + c[3]) / c[0] if c[0] else 0.0
            r["wait"] += r["checks"] * per_call[1] / 1000
            r["total"] = r["agentUsd"] + r["checkUsd"]
            r["composio"] = r["total"] + (r["agentConn"] + r["edenConn"]) * COMPOSIO
        by[a] = rows
    print(f"== {run}: agent + Eden against the agent alone [EST; served by subagents (D1101), multi-turn Pi]")
    lines = []

    def row(name, f, fmt="{:.3f}"):
        lines.append([name] + [fmt.format(f(by[a])) for a in arms])

    k = lambda kind: lambda rs: [r for r in rs if r["kind"] == kind]
    row("tasks", len, "{}")
    row(
        "hidden raised",
        lambda rs: f"{sum(r['raised'] or 0 for r in rs):.0f}/{sum(r['raised'] is not None for r in rs)}",
        "{}",
    )
    row("hidden raised %", lambda rs: 100 * mean([r["raised"] for r in rs]), "{:.1f}")
    for kind in ("control", "neutral"):
        row(f"{kind} concerns", lambda rs, kind=kind: f"{sum(r['concern'] or 0 for r in k(kind)(rs)):.0f}/"
            f"{sum(r['concern'] is not None for r in k(kind)(rs))}", "{}")
    handed = lambda kind: lambda rs: f"{sum(r['handed'] for r in k(kind)(rs)):.0f}/{len(k(kind)(rs))}"
    row("fact handed (hidden)", handed("hidden"), "{}")
    row("  of which in a lookup packet", lambda rs: sum(r["handedLookup"] for r in k("hidden")(rs)), "{:.0f}")
    row("decoy handed (control)", handed("control"), "{}")
    row("  of which in a lookup packet", lambda rs: sum(r["handedLookup"] for r in k("control")(rs)), "{:.0f}")
    row("packet share", lambda rs: mean([r["packet"] for r in rs]))
    row("packet chars/task", lambda rs: mean([r["packetChars"] for r in rs]), "{:.0f}")
    row("agent model calls/task", lambda rs: mean([r["turns"] for r in rs]))
    for kind in ("hidden", "control", "neutral"):
        row(f"  {kind}", lambda rs, kind=kind: mean([r["turns"] for r in k(kind)(rs)]))
    row("agent connector calls/task", lambda rs: mean([r["agentConn"] for r in rs]))
    row("Eden connector calls/task", lambda rs: mean([r["edenConn"] for r in rs]))
    row("asks/task", lambda rs: mean([r["asks"] for r in rs]))
    row("check calls/task", lambda rs: mean([r["checks"] for r in rs]))
    row("checks after the first model call", lambda rs: sum(r["late"] for r in rs), "{}")
    row("agent output tokens/task", lambda rs: mean([r["outTok"] for r in rs]), "{:.0f}")
    row("agent $/1k: cached prefix", lambda rs: 1000 * mean([r["preUsd"] for r in rs]))
    row("agent $/1k: last message", lambda rs: 1000 * mean([r["lastUsd"] for r in rs]))
    row("agent $/1k: output", lambda rs: 1000 * mean([r["outUsd"] for r in rs]))
    row("agent $/1k", lambda rs: 1000 * mean([r["agentUsd"] for r in rs]))
    row("check $/1k (queue sizes)", lambda rs: 1000 * mean([r["checkUsd"] for r in rs]))
    row("check $/1k, sheet written each call (cold user)", lambda rs: 1000 * mean([r["checkCold"] for r in rs]))
    row("check $/1k (real-API $0.21/1k calls)", lambda rs: 1000 * mean([r["checkReal"] for r in rs]))
    row("TOTAL $/1k first-party, short prompt", lambda rs: 1000 * mean([r["total"] for r in rs]))
    row("TOTAL $/1k Composio", lambda rs: 1000 * mean([r["composio"] for r in rs]))
    for x in prods:
        row(f"TOTAL $/1k first-party, prompt +{x // 1000}k tok", lambda rs, x=x: 1000 * mean(
            [r["total"] + r["turns"] * x * CACHED for r in rs]))
    raw = by.get("raw")
    if raw:
        rt, rc = mean([r["total"] for r in raw]), mean([r["turns"] for r in raw])

        def breakeven(rs):
            t, c = mean([r["total"] for r in rs]), mean([r["turns"] for r in rs])
            if rs is raw:
                return float("nan")
            if t <= rt:
                return 0.0
            return (t - rt) / ((rc - c) * CACHED) if rc > c else float("inf")

        row("break-even extra prompt tokens vs raw", breakeven, "{:.0f}")
    row("wait s/task (model + check + measured tools)", lambda rs: mean([r["wait"] for r in rs]))
    w = max(len(l[0]) for l in lines)
    print(" | ".join(["metric".ljust(w)] + [a.rjust(12) for a in arms]))
    for l in lines:
        print(" | ".join([l[0].ljust(w)] + [str(v).rjust(12) for v in l[1:]]))
    for a in arms:
        unsized = chk.get(f"{P}-{a}", [0, 0, 0, 0, 0])[4]
        if unsized:
            print(f"  {a}: {unsized} check calls with no sized answer (priced at the arm's mean)")
    key = {(a, r["task"]): r for a in arms for r in by[a]}
    metrics = [
        ("hidden raised (pts)", lambda r: 100 * r["raised"] if r["raised"] is not None else None),
        ("concerns (pts)", lambda r: 100 * r["concern"] if r["concern"] is not None else None),
        ("planted handed (pts, hidden)", lambda r: 100 * r["handed"] if r["kind"] == "hidden" else None),
        ("decoy handed (pts, control)", lambda r: 100 * r["handed"] if r["kind"] == "control" else None),
        ("agent model calls/task", lambda r: r["turns"]),
        ("connector calls/task", lambda r: r["agentConn"] + r["edenConn"]),
        ("agent $/1k", lambda r: 1000 * r["agentUsd"]),
        ("TOTAL $/1k first-party short", lambda r: 1000 * r["total"]),
        ("TOTAL $/1k Composio", lambda r: 1000 * r["composio"]),
    ]
    for x in prods:
        metrics.append((f"TOTAL $/1k prompt +{x // 1000}k", lambda r, x=x: 1000 * (r["total"] + r["turns"] * x * CACHED)))
    metrics.append(("wait s", lambda r: r["wait"]))
    out = {"arms": {a: {l[0]: l[1 + i] for l in lines} for i, a in enumerate(arms)}, "pairs": {}}
    for a in arms:
        for b in dict.fromkeys(["raw", o["base"]]):
            if a == b or b not in by or a == "raw":
                continue
            print(f"\n{a} - {b} (paired, template-clustered 95%)")
            pr = {}
            for name, f in metrics:
                pairs = []
                for r in by[a]:
                    rb = key.get((b, r["task"]))
                    if rb is None:
                        continue
                    x, y = f(r), f(rb)
                    if x is None or y is None:
                        continue
                    pairs.append((r["cluster"], x - y))
                est, lo, hi = boot(pairs, int(o["draws"]))
                pr[name] = [est, lo, hi, len(pairs)]
                print(f"  {name:32s} {est:+8.3f} ({lo:+.3f}..{hi:+.3f}) n={len(pairs)}")
            out["pairs"][f"{a}:{b}"] = pr
    if o["json"]:
        json.dump(out, open(o["json"], "w"), indent=1)


main()
