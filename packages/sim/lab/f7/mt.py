"""F7: a multi-turn pi-ab run served by subagents (D1101), read per arm for target 3+4 ([EST] wall).

    python3 -I mt.py --agent-out 120 --check-out 80 ARM=RESULTS.json:TIMELINE_DIR [...]

Per arm: tasks, agent model calls and tool calls a task (the agent's own searches, `ask_context` included), items
Eden handed, hidden facts raised and concerns on control and neutral (the run's grader: any required fact true), and
a modelled wall a task: the timeline's path spans with every model call and push check replaced by H3's fit (596 ms +
2.93 ms an output token, at the given mean output tokens: from `price-queue.py`), tool and Eden's own path time
(less the check's subagent wait) as measured. The measured walls are the subagents' and are not read.
"""
import argparse
import json
import os
import statistics


def spans(events):
    open_, out = {}, []
    for e in events:
        if e.get("ph") == "B":
            open_[e.get("id")] = e
        elif e.get("ph") == "E" and e.get("id") in open_:
            b = open_.pop(e["id"])
            out.append((b.get("ev", ""), b.get("cat"), b.get("lane"), e["t"] - b["t"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent-out", type=float, required=True)
    ap.add_argument("--check-out", type=float, required=True)
    ap.add_argument("arms", nargs="+")
    a = ap.parse_args()
    fit = lambda out: 596 + 2.93 * out
    for spec in a.arms:
        name, rest = spec.split("=", 1)
        res, tl = rest.split(":", 1)
        j = json.load(open(res))
        kinds = {t["id"]: t["kind"] for t in j["tasks"]}
        rows = [r for r in j["results"] if not r.get("error")]
        lines = {}
        p = os.path.join(tl, "tasks.jsonl")
        if os.path.exists(p):
            for l in open(p):
                d = json.loads(l)
                lines[d.get("task") or d.get("id")] = d
        walls = []
        for r in rows:
            d = lines.get(r["task"])
            if not d:
                continue
            w = 0.0
            for ev, cat, lane, dur in spans(d.get("events", [])):
                if lane != "path":
                    continue
                if cat == "model":
                    w += fit(a.agent_out)
                elif ev == "eden.check":
                    w += fit(a.check_out) - dur  # the observe span holds it; swap the queue's wait for the fit
                elif cat in ("tool", "eden"):
                    w += dur
            walls.append(w)
        n = len(rows)
        by = lambda k: [r for r in rows if kinds.get(r["task"]) == k]
        hid = by("hidden")
        raised = sum(1 for r in hid if r.get("facts") and all(r["facts"].values()))
        concerns = sum(1 for r in by("control") + by("neutral") if r.get("facts") and any(r["facts"].values()))
        mean = lambda k: sum(r[k] for r in rows) / max(n, 1)
        print(
            f"{name}: {n} tasks; agent model calls {mean('modelCalls'):.2f} a task, "
            f"tool calls {mean('toolCalls'):.2f}, "
            f"Eden items handed {mean('injectedItems'):.2f}; hidden raised {raised}/{len(hid)}, concerns "
            f"{concerns}/{len(by('control')) + len(by('neutral'))}; modelled wall [EST] mean "
            f"{(statistics.mean(walls) / 1000 if walls else 0):.2f} s, "
            f"p50 {(statistics.median(walls) / 1000 if walls else 0):.2f} s "
            f"({len(walls)} timelines)"
        )


main()
