"""F7 §9: hold-and-abort priced on a measured final arm ([EST]; served by subagents, D1101, or the API).

    python3 -I holdabort.py RESULTS.json TIMELINE_DIR --check-out 80 --agent-in 2600 --agent-cached 2000 \
        --agent-out 120 [--hit 0.9]

The agent's first model request goes upstream at once and its reply is held while the push check runs. A task whose
check ends with no packet (no items handed, or no check at all) is released early: its wall falls by the part of the
check's wait the first call overlapped, min(check, first call). A task whose check hands a packet aborts the first
call when the check lands and sends it again with the packet, as today: no wall change, and the aborted call's input
and the output written until the abort are paid for nothing. The agent sees exactly the default's context either way,
so facts and concerns are the default's by construction. Model time: H3's fit (596 ms + 2.93 ms an output token,
first token at about 450 ms); prices: Haiku 5.5 list.
"""
import argparse
import json
import os

P_IN, P_CR, P_CW, P_OUT = 0.10e-6, 0.01e-6, 0.125e-6, 0.50e-6
W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("timeline")
    ap.add_argument("--check-out", type=float, required=True)
    ap.add_argument("--agent-in", type=float, required=True)
    ap.add_argument("--agent-cached", type=float, required=True)
    ap.add_argument("--agent-out", type=float, required=True)
    ap.add_argument("--hit", type=float, default=0.9)
    a = ap.parse_args()
    fit = lambda out: 596 + 2.93 * out
    check_ms, first_ms = fit(a.check_out), fit(a.agent_out)
    j = json.load(open(a.results))
    kinds = {t["id"]: t["kind"] for t in j["tasks"]}
    checked = set()
    for l in open(os.path.join(a.timeline, "tasks.jsonl")):
        d = json.loads(l)
        if any(e.get("ev") == "eden.check" for e in d.get("events", [])):
            checked.add(d["task"])
    by = {k: {"n": 0, "save": 0.0, "waste": 0.0, "aborts": 0} for k in W}
    # The aborted call: its input billed (prefix read at the hit rate, the rest uncached), its output until the abort.
    out_until = max(0.0, min(a.agent_out, (check_ms - 450) / 2.93))
    abort_usd = (
        (a.agent_in - a.agent_cached) * P_IN
        + a.agent_cached * (a.hit * P_CR + (1 - a.hit) * P_CW)
        + out_until * P_OUT
    )
    for r in j["results"]:
        k = kinds.get(r["task"])
        if k not in W or r.get("error"):
            continue
        b = by[k]
        b["n"] += 1
        if r["task"] not in checked:
            continue  # no check on the path: nothing to overlap, nothing to abort
        if r["injectedItems"] > 0:
            b["aborts"] += 1
            b["waste"] += abort_usd
        else:
            b["save"] += min(check_ms, first_ms)
    mix = lambda f: sum(W[k] * f(by[k]) / by[k]["n"] for k in W if by[k]["n"])
    print(
        f"hold-and-abort [EST]: check {check_ms:.0f} ms, first agent call {first_ms:.0f} ms, "
        f"an abort ${abort_usd:.6f}; "
        f"on the 1:1:8 mix: wall {-mix(lambda b: b['save']) / 1000:+.3f} s a task, "
        f"${1000 * mix(lambda b: b['waste']):+.4f} per 1,000 tasks, aborts {mix(lambda b: b['aborts']):.2f} a task"
    )
    for k in W:
        b = by[k]
        if b["n"]:
            print(f"  {k}: {b['n']} tasks, aborts {b['aborts']}, wall saved {b['save'] / b['n'] / 1000:.3f} s a task")


main()
