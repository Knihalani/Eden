"""F11 (D1250–D1252): per-arm turns, connector calls, cost and wait of a multi-turn pi-ab run answered by subagents
(the queue transport, D1101). Lab tooling. Every $ and second here is [EST]: the transport books no usage, so

- the agent's tokens come from each request's size in the timeline (`model.request`'s inChars, lastChars, outChars,
  4 characters a token), priced at Haiku 5.5 list ($0.10 in, $0.01 cache read, $0.125 cache write, $0.50 out per
  million), everything before the last message read from cache on --hit of calls (as f7/price-queue.py);
- a model call waits 596 ms + 2.93 ms an output token (H3's fit; the agent's calls were never fitted);
- the push check is priced per call at F7's real-API figures (D1190: $0.000210 a call, 68 output tokens, so 795 ms
  by H3's fit): the subagents write shorter check replies (45 tokens), which would understate it (`--check-from-queue`
  prices it from the queue's sized answers instead);
- each round of the agent's connector searches (the calls one model turn asks for, run in parallel) waits --conn-s
  (0.3, 0.8, 2.0 s: the stated assumption for a production MCP or API call), and each call costs --conn-usd per
  1,000 calls on a paid connector plan (COST-MODEL.md's CONNECTOR_PLANS list prices);
- ask_context waits what the run measured (a local index);
- cards are background, the same file replayed in every Eden arm, priced at B19's Pi figure ($0.088 per 1,000 tasks).

    python3 -I packages/sim/lab/f11/report.py --queue .local/f11/q --stem .local/f11/lev-41 [--stem …]
        [--base both+ask] [--hit 0.9] [--json OUT]
"""
import collections
import json
import os
import random
import sys

HAIKU = {"in": 0.10e-6, "cr": 0.01e-6, "cw": 0.125e-6, "out": 0.50e-6}
CONN_S = [0.3, 0.8, 2.0]
CONN_USD = {"first-party": 0.0, "Composio": 0.30, "Unified.to": 0.75, "Pipedream": 12.0}
CARDS_USD_1K = 0.088
CPT = 4.0


def args():
    o = {"stem": [], "queue": None, "base": "both+ask", "hit": 0.9, "json": None, "draws": 2000, "fromQueue": False}
    a = sys.argv[1:]
    i = 0
    while i < len(a):
        k = a[i].lstrip("-")
        if k == "check-from-queue":
            o["fromQueue"] = True
            i += 1
            continue
        if k == "stem":
            o["stem"].append(a[i + 1])
        elif k in ("queue", "base", "json"):
            o[k] = a[i + 1]
        elif k in ("hit",):
            o[k] = float(a[i + 1])
        elif k == "draws":
            o[k] = int(a[i + 1])
        else:
            sys.exit(f"report.py: unknown flag {a[i]}")
        i += 2
    return o


def check_call_cost(queue, hit):
    """Mean $ and output tokens of one eden.check call, from the queue's sized answers."""
    usd, out, n = 0.0, 0.0, 0
    done = os.path.join(queue, "done")
    for f in os.listdir(done):
        d = json.load(open(os.path.join(done, f)))
        if d.get("role") != "eden.check" or "size" not in d:
            continue
        s = d["size"]
        total = (s["system"] + s["messages"] + s["tools"]) / CPT
        prefix = s["system"] / CPT
        o = s["out"] / CPT
        usd += (total - prefix) * HAIKU["in"] + prefix * (hit * HAIKU["cr"] + (1 - hit) * HAIKU["cw"]) + o * HAIKU["out"]
        out += o
        n += 1
    return (usd / n, out / n, n) if n else (0.0, 60.0, 0)


def base_suite(s):
    for t in ("-control", "-neutral"):
        if s.endswith(t):
            return s[: -len(t)]
    return s


def rows_of(stem, hit, check_usd, check_out):
    res = json.load(open(stem + ".json"))
    tasks = {t["id"]: t for t in res["tasks"]}
    tl = {}
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        tl[(t["task"], t["condition"])] = t
    out = []
    for r in res["results"]:
        t = tasks.get(r["task"])
        if not t or r.get("error"):
            continue
        ev = sorted(tl.get((r["task"], r["condition"]), {}).get("events", []), key=lambda e: e["t"])
        turns, usd, model_ms, rounds, conn, asks, ask_ms, checks, eden_conn = 0, 0.0, 0.0, 0, 0, 0, 0.0, 0, 0
        searched_this_turn = False
        tool_iv = []
        late = 0
        begins = {}
        sized = 0
        for e in ev:
            d = e.get("data") or {}
            if e["ev"] == "model.request" and e["ph"] == "B":
                turns += 1
                searched_this_turn = False
                begins[e.get("id")] = d
            elif e["ev"] == "model.request" and e["ph"] == "E":
                b = begins.get(e.get("id"), {})
                if "inChars" in b:
                    sized += 1
                    tin = b["inChars"] / CPT
                    prefix = max(0.0, tin - b.get("lastChars", 0) / CPT)
                    o = d.get("outChars", 0) / CPT
                    usd += (tin - prefix) * HAIKU["in"] + prefix * (hit * HAIKU["cr"] + (1 - hit) * HAIKU["cw"])
                    usd += o * HAIKU["out"]
                    model_ms += 596 + 2.93 * o
            elif e["ev"].startswith("tool.search_") and e["ph"] == "E":
                b = begins.get(("tool", e.get("id")))
                if b is not None:
                    tool_iv.append((b, e["t"]))
            elif e["ev"].startswith("tool.search_") and e["ph"] == "B":
                begins[("tool", e.get("id"))] = e["t"]
                conn += 1
                if not searched_this_turn:
                    rounds += 1
                    searched_this_turn = True
            elif e["ev"] == "tool.ask_context" and e["ph"] == "B":
                asks += 1
                begins[("ask", e.get("id"))] = e["t"]
            elif e["ev"] == "tool.ask_context" and e["ph"] == "E":
                ask_ms += e["t"] - begins.get(("ask", e.get("id")), e["t"])
            elif e["ev"] == "eden.check" and e["ph"] == "B":
                checks += 1
            elif e["ev"] == "eden.check" and e["ph"] == "E":
                # A check that ends after the agent's first model call began measured late injection, not the default.
                if turns > 0:
                    late += 1
            elif e["ev"] == "eden.decision":
                eden_conn += d.get("sourceCalls", 0) or 0
        # The agent's measured connector wait: the union of its search spans (parallel calls overlap), at the
        # `direct` market profile's latency (--time-scale 1).
        tool_ms, end = 0.0, -1.0
        for a, b in sorted(tool_iv):
            if b > end:
                tool_ms += b - max(a, end)
                end = b
        graded = r.get("facts") is not None and len(t.get("must") or []) > 0
        hit_fact = (1.0 if any(r["facts"].values()) else 0.0) if graded else None
        out.append(
            {
                "cond": r["condition"],
                "task": r["task"],
                "kind": t["kind"],
                "cluster": f"{base_suite(t.get('suite', ''))}:{t.get('type', '')}",
                "raised": hit_fact if t["kind"] == "hidden" else None,
                "concern": hit_fact if t["kind"] != "hidden" else None,
                "packet": 1.0 if r.get("injectedItems", 0) > 0 else 0.0,
                "turns": float(turns),
                "sized": sized,
                "agentConn": float(conn),
                "edenConn": float(eden_conn),
                "rounds": float(rounds),
                "asks": float(asks),
                "askMs": ask_ms,
                "toolS": tool_ms / 1000,
                "checks": float(checks),
                "lateChecks": late,
                "agentUsd": usd,
                "checkUsd": checks * check_usd,
                "modelS": model_ms / 1000,
                "checkS": checks * (596 + 2.93 * check_out) / 1000,
            }
        )
    return out


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else float("nan")


def bigger_prompt(r, extra_tokens, hit):
    """$ a task with `extra_tokens` more cached prefix on every agent model call (a production agent's longer system
    prompt, tools and history), read from cache on `hit` of calls and written on the rest [EST]."""
    return r["turns"] * extra_tokens * (hit * HAIKU["cr"] + (1 - hit) * HAIKU["cw"])


def derived(r, conn_s, conn_usd_1k):
    """$ a task and seconds a task under one connector assumption (conn_s None: the run's measured search time)."""
    eden = r["cond"] != "tools"
    usd = r["agentUsd"] + r["checkUsd"] + (CARDS_USD_1K / 1000 if eden else 0.0)
    usd += (r["agentConn"] + r["edenConn"]) * conn_usd_1k / 1000
    conn = r["toolS"] if conn_s is None else r["rounds"] * conn_s
    wait = r["modelS"] + r["checkS"] + conn + r["askMs"] / 1000
    return usd, wait


def boot(pairs, draws, seed=1):
    """Mean of A−B over tasks, with a template-clustered 95% interval."""
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
        n = sum(len(p) for p in pick)
        sims.append(sum(sum(p) for p in pick) / n)
    sims.sort()
    return est, sims[int(0.025 * draws)], sims[int(0.975 * draws) - 1]


def main():
    o = args()
    check_usd, check_out, nchk = check_call_cost(o["queue"], o["hit"])
    if not o["fromQueue"]:
        check_usd, check_out = 0.000210, 68.0
    rows = [r for s in o["stem"] for r in rows_of(s, o["hit"], check_usd, check_out)]
    conds = sorted({r["cond"] for r in rows}, key=lambda c: (c != "tools", c != o["base"], c))
    print(f"[EST; served by subagents (D1101)] check call ${check_usd*1000:.3f}/1k calls, {check_out:.0f} out tok "
          f"({nchk} sized); unsized agent calls are left unpriced")
    by = {c: [r for r in rows if r["cond"] == c] for c in conds}
    hdr = ["metric"] + conds
    lines = []

    def row(name, f, fmt="{:.3f}"):
        lines.append([name] + [fmt.format(f(by[c])) for c in conds])

    row("tasks", lambda rs: len(rs), "{}")
    row("hidden raised", lambda rs: sum(r["raised"] or 0 for r in rs), "{:.0f}")
    row("hidden n", lambda rs: sum(1 for r in rs if r["raised"] is not None), "{}")
    row("concerns (control+neutral)", lambda rs: sum(r["concern"] or 0 for r in rs), "{:.0f}")
    row("packet share", lambda rs: mean([r["packet"] for r in rs]))
    row("agent model calls/task", lambda rs: mean([r["turns"] for r in rs]))
    row("agent connector calls/task", lambda rs: mean([r["agentConn"] for r in rs]))
    row("Eden connector calls/task", lambda rs: mean([r["edenConn"] for r in rs]))
    row("connector rounds/task", lambda rs: mean([r["rounds"] for r in rs]))
    row("asks/task", lambda rs: mean([r["asks"] for r in rs]))
    row("ask ms/ask (measured)", lambda rs: sum(r["askMs"] for r in rs) / max(1, sum(r["asks"] for r in rs)), "{:.1f}")
    row("checks landing after the first model call", lambda rs: sum(r["lateChecks"] for r in rs), "{}")
    row("check calls/task", lambda rs: mean([r["checks"] for r in rs]))
    row("agent $/1k [EST]", lambda rs: 1000 * mean([r["agentUsd"] for r in rs]))
    row("check $/1k [EST]", lambda rs: 1000 * mean([r["checkUsd"] for r in rs]))
    row("wait s/task, measured searches (direct) [EST]", lambda rs: mean([derived(r, None, 0)[1] for r in rs]))
    for cs in CONN_S:
        row(f"wait s/task @ {cs}s a connector call [EST]", lambda rs, cs=cs: mean([derived(r, cs, 0)[1] for r in rs]))
    for extra in (10_000, 30_000):
        row(
            f"all-in $/1k first-party, prompt +{extra // 1000}k tok [EST]",
            lambda rs, extra=extra: 1000 * mean([derived(r, 0.8, 0)[0] + bigger_prompt(r, extra, o["hit"]) for r in rs]),
        )
    for plan, pu in CONN_USD.items():
        row(f"all-in $/1k, {plan} plan [EST]", lambda rs, pu=pu: 1000 * mean([derived(r, 0.8, pu)[0] for r in rs]))
    w = max(len(l[0]) for l in lines + [hdr])
    print(" | ".join([hdr[0].ljust(w)] + [c.rjust(24) for c in hdr[1:]]))
    for l in lines:
        print(" | ".join([l[0].ljust(w)] + [v.rjust(24) for v in l[1:]]))
    # Paired differences against the base and against tools.
    key = {(r["cond"], r["task"]): r for r in rows}
    metrics = [
        ("hidden raised (pts)", lambda r: 100 * r["raised"] if r["raised"] is not None else None),
        ("concerns (pts)", lambda r: 100 * r["concern"] if r["concern"] is not None else None),
        ("agent model calls/task", lambda r: r["turns"]),
        ("connector calls/task", lambda r: r["agentConn"] + r["edenConn"]),
        ("agent $/1k", lambda r: 1000 * r["agentUsd"]),
        ("all-in $/1k, first-party", lambda r: 1000 * derived(r, 0.8, 0.0)[0]),
        ("all-in $/1k, Composio", lambda r: 1000 * derived(r, 0.8, 0.30)[0]),
        ("all-in $/1k, first-party, prompt +10k", lambda r: 1000 * (derived(r, 0.8, 0)[0] + bigger_prompt(r, 1e4, o["hit"]))),
        ("all-in $/1k, first-party, prompt +30k", lambda r: 1000 * (derived(r, 0.8, 0)[0] + bigger_prompt(r, 3e4, o["hit"]))),
        ("wait s measured", lambda r: derived(r, None, 0)[1]),
        ("wait s @0.3", lambda r: derived(r, 0.3, 0)[1]),
        ("wait s @0.8", lambda r: derived(r, 0.8, 0)[1]),
        ("wait s @2.0", lambda r: derived(r, 2.0, 0)[1]),
    ]
    out = {"arms": {c: {l[0]: l[1 + i] for l in lines} for i, c in enumerate(conds)}, "pairs": {}}
    for a in conds:
        for b in [o["base"], "tools"]:
            if a == b or b not in by:
                continue
            print(f"\n{a} − {b} (template-clustered 95%, {o['draws']} draws)")
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
                est, lo, hi = boot(pairs, o["draws"])
                pr[name] = [est, lo, hi, len(pairs)]
                print(f"  {name:28s} {est:+8.3f} ({lo:+.3f}..{hi:+.3f}) n={len(pairs)}")
            out["pairs"][f"{a}:{b}"] = pr
    if o["json"]:
        json.dump(out, open(o["json"], "w"), indent=1)


main()
