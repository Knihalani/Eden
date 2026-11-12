"""The final benchmark's cost and speed, side by side with quality, per arm [EST; served by subagents (D1101)].

    python3 -I packages/sim/lab/final/cost.py RUN_DIR

Reads RUN_DIR/q/calls.jsonl and q/done/*.json (each call's run label, role and sizes; `batch.ts put` records sizes),
the single-shot arms (raw|before|final.json) and the multi-turn sample (mt-raw|mt-final.json), and the coverage runs
(cov-before|cov-final). The queue books no usage, so every dollar and millisecond here is estimated from sizes, as F7's
price-queue.py does (four characters a token, Haiku 5.5 list prices, the grader on Sonnet; cache hit 0.9 on the cached
prefix; a Haiku call's latency 596 ms + 2.93 ms an output token, H3's fit).

- Quality (single-shot): hidden raised, control and neutral concerns.
- Eden $/1k tasks: Eden's per-request roles (`eden.check`, `eden.reader`, `eden.judge`) in the single-shot arms.
- Agent $/1k tasks: the agent's calls in the MULTI-TURN sample (single-shot is one call by construction).
- Cards: one world's backfill card calls, priced (one-time a user), plus the daily trickle of a heavy user's new items
  (CL3, F7: about $0.0165 a user-month [EST]); the backfill is not a month's spend.
- Push wait a task: `eden.check`'s modelled latency, summed per task (the agent waits for it before its first call).
- Agent wall a task (multi-turn): the agent's calls' modelled latency plus the push wait.
- Connector calls a task: Eden's (its streams' calls less their backfill) plus the agent's own tool calls (multi-turn).
"""

import collections
import json
import os
import sys

HAIKU = {"in": 0.10e-6, "cr": 0.01e-6, "cw": 0.125e-6, "out": 0.50e-6}
SONNET = {"in": 1.00e-6, "cr": 0.10e-6, "cw": 1.25e-6, "out": 5.00e-6}
CPT = 4.0
HIT = 0.9
EDEN_TASK_ROLES = {"eden.check", "eden.reader", "eden.judge"}
# F7 (COST-MODEL §Hosting b): connector fees per 1,000 calls by plan, and CL3's card trickle a heavy user-month.
CONNECTOR_FEES = {"first-party": 0.0, "Composio": 0.30, "Unified.to": 0.75, "Arcade": 10.0, "Pipedream": 12.0,
                  "Zapier": 25.8}
CARD_TRICKLE_MONTH = 0.0165


def price(c, s):
    role = c.get("role") or "agent"
    total_in = (s["system"] + s["messages"] + s["tools"]) / CPT
    prefix = (s["system"] / CPT) if role.startswith("eden.") else total_in - s["last"] / CPT
    p = SONNET if "sonnet" in str(c.get("model", "")) else HAIKU
    out = s["out"] / CPT
    usd = (total_in - prefix) * p["in"] + prefix * (HIT * p["cr"] + (1 - HIT) * p["cw"]) + out * p["out"]
    return usd, 596 + 2.93 * out, total_in + out


def calls(q):
    """The queue's call log less every process an arm restarted from (G4's finding: a restart replays its calls and
    logs them again). An arm is one pi-ab process, so only its last process (by first call) made the results; coverage
    runs (`-cov-`) are one process a world, all kept."""
    rows = [json.loads(line) for line in open(os.path.join(q, "calls.jsonl")) if line.strip()]
    first = {}
    for c in rows:
        first.setdefault((c.get("run"), c.get("pid")), c.get("at", ""))
    last = {}
    for (run, pid), at in first.items():
        if run and "-cov-" not in run and (run not in last or at > first[(run, last[run])]):
            last[run] = pid
    return [c for c in rows if c.get("run") not in last or c.get("pid") == last[c.get("run")]]


def main():
    run = sys.argv[1]
    q = os.path.join(run, "q")
    P = os.path.basename(run.rstrip("/"))
    sizes = {}
    for f in os.listdir(os.path.join(q, "done")):
        try:
            d = json.load(open(os.path.join(q, "done", f)))
        except ValueError:
            continue
        if "size" in d:
            sizes[d["id"]] = d["size"]
    by = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0.0, 0.0, 0.0]))  # run -> role -> n,$,ms,tok
    unsized = collections.Counter()
    for c in calls(q):
        s = sizes.get(c.get("key"))
        if not s:
            unsized[c.get("run")] += 1
            continue
        usd, ms, tok = price(c, s)
        d = by[c.get("run")][c.get("role") or "agent"]
        d[0] += 1
        d[1] += usd
        d[2] += ms
        d[3] += tok

    def results(name):
        f = os.path.join(run, f"{name}.json")
        return json.load(open(f)) if os.path.exists(f) else None

    def quality(r):
        out = {}
        for kind in ("hidden", "control", "neutral"):
            xs = [x for x in r["results"] if (x["task"].split(":")[1].partition("-")[2] or "hidden") == kind]
            g = [x for x in xs if not x.get("error") and x.get("facts") is not None]
            out[kind] = (sum(any(x["facts"].values()) for x in g), len(g))
        return out

    def connector(r):
        """Eden's request-time connector calls a task, its backfill calls a stream, the agent's tool calls a task."""
        bg = r.get("background") or []
        calls = sum((b.get("sourceCalls") or 0) - (b.get("setupSourceCalls") or 0) for b in bg)
        setup = sum(b.get("setupSourceCalls") or 0 for b in bg) / max(1, len(bg))
        tools = sum(x.get("toolCalls", 0) for x in r["results"])
        n = max(1, len(r["results"]))
        return calls / n, setup, tools / n

    print("== quality, cost and speed side by side [EST; served by subagents (D1101)]")
    print("   quality: single-shot arms; agent cost, turns and wall: the multi-turn sample (mt-*); see cost.py's header")
    rows = []
    for arm in ("raw", "before", "final"):
        r = results(arm)
        if not r:
            continue
        n = len(r["results"])
        ql = quality(r)
        roles = by.get(f"{P}-{arm}", {})
        eden_usd = sum(v[1] for k, v in roles.items() if k in EDEN_TASK_ROLES)
        push_ms = roles.get("eden.check", [0, 0, 0.0, 0])[2]
        eden_conn, eden_setup, ss_tools = connector(r)
        cov = by.get(f"{P}-cov-{arm}", by.get(f"{P}-cov-final", {})) if arm != "raw" else {}
        card_calls, card_usd = cov.get("eden.cards", [0, 0.0])[:2] if cov else (0, 0.0)
        worlds = len([f for f in os.listdir(os.path.join(run, f"cov-{arm}.d"))
                      if f.endswith(".json")]) if os.path.isdir(os.path.join(run, f"cov-{arm}.d")) else 0
        mt = results(f"mt-{arm}")
        agent = {}
        if mt:
            m = len(mt["results"])
            mroles = by.get(f"{P}-mt-{arm}", {})
            a = mroles.get("agent", [0, 0.0, 0.0, 0.0])
            mcheck = mroles.get("eden.check", [0, 0.0, 0.0, 0.0])
            mconn, _, mtools = connector(mt)
            mq = quality(mt)
            agent = dict(q=mq, n=m, calls=a[0] / m, tools=mtools, tok=a[3] / m, usd=1000 * a[1] / m,
                         wall=(a[2] + mcheck[2]) / m, conn=mconn + mtools,
                         eden_usd=1000 * sum(v[1] for k, v in mroles.items() if k in EDEN_TASK_ROLES) / m)
        rows.append((arm, n, ql, 1000 * eden_usd / n, push_ms / n, (eden_conn, eden_setup, ss_tools), card_calls,
                     card_usd, worlds, agent))
    for arm, n, ql, eden, push, conn, cc, cu, worlds, ag in rows:
        h, c, ne = ql["hidden"], ql["control"], ql["neutral"]
        print(f"\n  {arm} ({n} single-shot tasks)")
        print(f"    quality: hidden raised {h[0]}/{h[1]} ({100 * h[0] / max(1, h[1]):.1f}%), control concerns "
              f"{c[0]}/{c[1]}, neutral concerns {ne[0]}/{ne[1]}")
        print(f"    cost: Eden ${eden:.4f}/1k tasks [EST]" + (
            f"; cards ${cu / max(1, worlds):.5f} a world's backfill once ({cc / max(1, worlds):.1f} calls) + "
            f"${CARD_TRICKLE_MONTH} a heavy user-month trickle [EST, CL3]" if worlds else "; cards: none (no Eden)"))
        print(f"    speed: push wait {push:.0f} ms a task [EST, H3 fit]; connector calls a task: Eden at request time "
              f"{conn[0]:.2f}, the single-shot tools {conn[2]:.2f}; Eden's backfill {conn[1]:.0f} a stream (once a user)")
        if ag:
            mh, mc, mn = ag["q"]["hidden"], ag["q"]["control"], ag["q"]["neutral"]
            print(f"    multi-turn sample quality: hidden raised {mh[0]}/{mh[1]}, control concerns {mc[0]}/{mc[1]}, "
                  f"neutral concerns {mn[0]}/{mn[1]}")
            print(f"    multi-turn sample ({ag['n']} tasks): agent {ag['calls']:.2f} model calls, {ag['tools']:.2f} tool "
                  f"calls, {ag['tok']:.0f} tokens a task; agent ${ag['usd']:.4f}/1k + Eden ${ag['eden_usd']:.4f}/1k "
                  f"= ${ag['usd'] + ag['eden_usd']:.4f}/1k [EST]; wall {ag['wall']:.0f} ms a task model calls and "
                  f"push only, {ag['wall'] + 450 * ag['tools']:.0f} with 0.45 s a tool round [EST]; connector "
                  f"calls {ag['conn']:.2f} a task (Eden's and the agent's tools)")
            fees = ", ".join(f"{k} ${ag['conn'] * v:.2f}" for k, v in CONNECTOR_FEES.items())
            print(f"    connector fees per 1,000 tasks by plan [EST]: {fees}")
    print("\n  Production connector latency L s a call: walls here assume the direct profile (~0.45 s a call); add")
    print("  0.72 x (L - 0.45) s a task on Pi and 0.78 x (L - 0.45) on Hermes [EST, F7].")
    speculate(run, by, P)
    if unsized:
        print(f"\n  calls with no sized answer (not priced): {dict(unsized)}")


def speculate(run, by, P):
    """[EST] F10's `speculate` proxy option (D1273), modelled from this run: the agent's first call goes out while the
    push check runs and is aborted when a packet arrives. A silent push (the check named nothing, no packet) saves
    the push wait; a speaking one pays for the aborted call. Pi does not go through the proxy, so this is arithmetic
    on the final arm's own silent share and push wait (single-shot) and the multi-turn sample's agent call price,
    not a measurement. F10's own estimate: about -0.41 s a task for +$0.037 per 1,000."""
    tl = os.path.join(run, "final.tl", "tasks.jsonl")
    if not os.path.exists(tl):
        return
    pushed = spoke = 0
    for line in open(tl):
        t = json.loads(line)
        pools = t.get("pushPools") or []
        if not any(p.get("check") for p in pools):
            continue
        pushed += 1
        spoke += any(p.get("handed") for p in pools)
    if not pushed:
        return
    silent = 1 - spoke / pushed
    roles = by.get(f"{P}-final", {})
    check = roles.get("eden.check", [0, 0.0, 0.0, 0.0])
    wait_a_check = check[2] / max(1, check[0])
    agent = by.get(f"{P}-mt-final", {}).get("agent") or roles.get("agent") or [0, 0.0, 0.0, 0.0]
    call_usd = agent[1] / max(1, agent[0])
    print(f"\n== speculate (F10, D1273; proxy only) [EST, modelled]: of {pushed} checked pushes {100 * silent:.1f}% "
          f"were silent; a silent push saves its check's wait ({wait_a_check:.0f} ms), a speaking one aborts a call "
          f"(${call_usd:.6f})")
    print(f"   wall {-silent * wait_a_check / 1000:+.2f} s a checked task; cost {+1000 * (1 - silent) * call_usd:+.4f} $ "
          f"per 1,000 checked tasks (F10's estimate: -0.41 s, +$0.037)")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--dedupe-calls"]:
        # report.sh: the deduplicated call log, for F7's price-queue.py
        for c in calls(sys.argv[2]):
            print(json.dumps(c))
    else:
        main()
