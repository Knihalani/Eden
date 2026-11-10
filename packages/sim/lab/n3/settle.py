"""N3 (H1, docs/research/n3-long.md): `takeSettleMs` on Pi. Per arm: tasks, asks, the waits before a request that
follows a tool result (`eden.settle` spans: count, tasks with one, total and mean ms), packets first seen by a request
after the task's first (taken in the same turn after a tool result), `ask-behind` follow-up packets seen, and Eden's
time on the agent's path a task (observe, ask_context and settle spans on the path lane).
usage: python3 -I settle.py STEM [STEM ...]   (STEM.tl/tasks.jsonl)"""
import collections, json, sys

A = collections.defaultdict(collections.Counter)
for stem in sys.argv[1:]:
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        a = A[t["condition"]]
        a["tasks"] += 1
        a["asks"] += len(t.get("asks") or [])
        open_, waits, path, requests, injects_after = {}, [], 0.0, 0, 0
        for e in t["events"]:
            ev, ph = e.get("ev"), e.get("ph")
            if ev == "model.request" and ph == "B":
                requests += 1
            if ev == "eden.inject" and requests >= 1:
                injects_after += 1
            if ph == "B" and e.get("lane") == "path" and (e.get("cat") == "eden"):
                open_[e["id"]] = (ev, e["t"])
            elif ph == "E" and e.get("id") in open_:
                name, t0 = open_.pop(e["id"])
                path += e["t"] - t0
                if name == "eden.settle":
                    waits.append(e["t"] - t0)
        a["waits"] += len(waits)
        a["waited_tasks"] += bool(waits)
        a["wait_ms"] += sum(waits)
        a["path_ms"] += path
        a["late_packets"] += injects_after
        a["late_packet_tasks"] += bool(injects_after)
        a["ask_behind"] += (t.get("packets") or "").count("found after your last ask_context answer")
for c in sorted(A):
    a = A[c]
    n = a["tasks"]
    print(f"{c:14} tasks {n:4}  asks {a['asks']:4}  settle waits {a['waits']:4} in {a['waited_tasks']:4} tasks, "
          f"{a['wait_ms'] / max(1, a['waits']):7.1f} ms each, {a['wait_ms'] / n:6.1f} ms a task | packets taken after "
          f"the first request {a['late_packets']:3} in {a['late_packet_tasks']:3} tasks, ask-behind {a['ask_behind']:3} | "
          f"Eden on the path {a['path_ms'] / n:7.1f} ms a task")
