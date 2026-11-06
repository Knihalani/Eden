"""RealUse-1 part B: the T1 metrics per arm, per suite and pooled, with paired bootstrap 95% intervals.

  python3 -I analyze.py OUT.json RUN.json [RUN.json ...]

Reads pi-ab.ts results files and their timelines (`<run>.timeline/tasks.jsonl`). An arm is
`<profile>:<condition>` (profile from the results header: `direct` or `hosted`, by the gmail median latency).
Tasks are paired across arms (and across files) by task id, which carries the seed. Every per-task figure:
- rate: share of the task's must-facts the grader found raised (hidden: the planted fact; control: the decoy,
  a false concern);
- wall ms; Eden's ms on the critical path (the union of Eden's path-lane spans, as pi-ab-report.ts counts it);
- agent tokens (input, cache read, cache write, output) from the agent's requests; agent $, Eden's per-task $
  (reader), Eden's background $ (cards, spread over the stream's tasks as pi-ab-report's bkfill);
- the agent's connector calls (search tools) and Eden's source calls by op (search, list, fetch);
- reader calls, packets injected and their bytes, ask_context calls and their answer bytes.
"""

import json
import os
import random
import statistics
import sys

B = 2000


def profile_of(head):
    sp = head.get("sourceProfile") or {}
    med = ((sp.get("gmail") or {}).get("latency") or {}).get("medianMs")
    return {600: "direct"}.get(med, "hosted" if med else "realistic")


def spans(events):
    open_, out = {}, []
    for e in events:
        if e.get("ph") == "B":
            open_[e.get("id")] = e
        elif e.get("ph") == "E" and e.get("id") in open_:
            b = open_.pop(e["id"])
            out.append((b.get("cat"), b.get("lane"), b["ev"], b["t"], e["t"], b.get("data") or {}))
    return out


def union(ivs):
    n, cur = 0.0, None
    for a, b in sorted(ivs):
        if cur and a <= cur[1]:
            cur[1] = max(cur[1], b)
        else:
            if cur:
                n += cur[1] - cur[0]
            cur = [a, b]
    return n + (cur[1] - cur[0] if cur else 0.0)


def load(paths):
    rows = []
    for p in paths:
        head = json.load(open(p))
        prof = profile_of(head)
        tasks = {t["id"]: t for t in head["tasks"]}
        bg = {}
        for b in head.get("background") or []:
            per = (b.get("cardsUsd", 0) + b.get("bridgeUsd", 0)) / max(1, len(b["tasks"]))
            for t in b["tasks"]:
                bg[(t, b["condition"])] = bg.get((t, b["condition"]), 0) + per
        tl = {}
        tlp = os.path.join(p[: -len(".json")] + ".timeline", "tasks.jsonl")
        for line in open(tlp):
            d = json.loads(line)
            tl[(d["task"], d["condition"])] = d
        for r in head["results"]:
            t = tasks[r["task"]]
            if t["kind"] not in ("hidden", "control") or r.get("error"):
                continue
            must = t.get("must") or []
            facts = r.get("facts")
            if facts is None:
                continue
            d = tl.get((r["task"], r["condition"]), {"events": [], "requests": []})
            sp = spans(d["events"])
            wall = r["wallMs"]
            eden_path = union([(max(0, a), min(b, wall)) for c, l, _, a, b, _ in sp if c == "eden" and l == "path" and a < wall])
            src = [x for c, l, ev, a, b, x in sp if ev == "eden.source"]
            reqs = d.get("requests") or []
            packets = d.get("packets") or ""
            asks = d.get("asks") or []
            rows.append(
                dict(
                    arm=f"{prof}:{r['condition']}",
                    task=r["task"],
                    suite=t["suite"],
                    kind=t["kind"],
                    seed=d.get("seed"),
                    rate=sum(1 for m in must if facts.get(m["id"])) / max(1, len(must)),
                    wall=wall,
                    eden_path=eden_path,
                    tok_in=sum(q.get("in", 0) for q in reqs),
                    tok_cache_read=sum(q.get("cached", 0) for q in reqs),
                    tok_cache_write=sum(q.get("cacheWrite", 0) for q in reqs),
                    tok_out=sum(q.get("out", 0) for q in reqs),
                    agent_usd=r["costUsd"],
                    eden_usd=r["edenCostUsd"],
                    eden_bg_usd=bg.get((r["task"], r["condition"]), 0.0),
                    agent_calls=sum(1 for c, l, ev, *_ in sp if c == "tool" and ev != "tool.ask_context"),
                    eden_search=sum(1 for x in src if x.get("op") == "search"),
                    eden_list=sum(1 for x in src if x.get("op") == "list"),
                    eden_fetch=sum(1 for x in src if x.get("op") == "fetch"),
                    reader_calls=sum(1 for c, l, ev, *_ in sp if ev == "eden.reader"),
                    packets=packets.count("<context "),
                    packet_bytes=len(packets.encode()),
                    asks=len(asks),
                    ask_bytes=sum(a.get("bytes", 0) for a in asks),
                )
            )
    return rows


METRICS = [
    "rate", "wall", "eden_path", "tok_in", "tok_cache_read", "tok_cache_write", "tok_out", "agent_usd", "eden_usd",
    "eden_bg_usd", "agent_calls", "eden_search", "eden_list", "eden_fetch", "reader_calls", "packets", "packet_bytes",
    "asks", "ask_bytes",
]


def q(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    i = int(k)
    return xs[i] + (xs[min(i + 1, len(xs) - 1)] - xs[i]) * (k - i)


def summary(rs):
    out = {"n": len(rs)}
    for m in METRICS:
        out[m] = statistics.fmean(r[m] for r in rs) if rs else None
    w = [r["wall"] for r in rs]
    out["wall_p50"], out["wall_p90"] = q(w, 0.5), q(w, 0.9)
    out["eden_path_share"] = (sum(r["eden_path"] for r in rs) / sum(w)) if rs else None
    out["usd_per_1k_all_in"] = 1000 * statistics.fmean(r["agent_usd"] + r["eden_usd"] + r["eden_bg_usd"] for r in rs) if rs else None
    return out


def paired(a_rows, b_rows, metric, seed=7):
    a = {r["task"]: r[metric] for r in a_rows}
    b = {r["task"]: r[metric] for r in b_rows}
    keys = sorted(set(a) & set(b))
    if not keys:
        return None
    d = [a[k] - b[k] for k in keys]
    rng = random.Random(seed)
    boots = sorted(statistics.fmean(rng.choice(d) for _ in d) for _ in range(B))
    lo, hi = boots[int(0.025 * B)], boots[int(0.975 * B) - 1]
    return {"n": len(keys), "diff": statistics.fmean(d), "lo": lo, "hi": hi, "sig": lo > 0 or hi < 0}


DIFF_METRICS = ["rate", "wall", "eden_path", "agent_usd", "eden_usd", "agent_calls", "tok_in", "tok_out"]
COMPARISONS = [
    ("direct:eden", "direct:tools"),
    ("direct:both", "direct:tools"),
    ("direct:both", "direct:eden"),
] + [(f"direct:eden~minus-{p}", "direct:eden") for p in ["reader", "intent", "sync", "grounds", "graph"]] + [
    ("hosted:tools", "direct:tools"),
    ("hosted:eden", "direct:eden"),
]


def main():
    out_path, paths = sys.argv[1], sys.argv[2:]
    rows = load(paths)
    arms = sorted({r["arm"] for r in rows})
    suites = sorted({r["suite"] for r in rows})
    res = {"arms": {}, "diffs": {}}
    for scope in suites + ["pooled"]:
        sr = [r for r in rows if scope == "pooled" or r["suite"] == scope]
        for kind in ["hidden", "control"]:
            kr = [r for r in sr if r["kind"] == kind]
            for arm in arms:
                ar = [r for r in kr if r["arm"] == arm]
                if ar:
                    res["arms"][f"{scope}|{kind}|{arm}"] = summary(ar)
            for a, b in COMPARISONS:
                ar, br = [r for r in kr if r["arm"] == a], [r for r in kr if r["arm"] == b]
                if ar and br:
                    res["diffs"][f"{scope}|{kind}|{a} - {b}"] = {m: paired(ar, br, m) for m in DIFF_METRICS}
    json.dump(res, open(out_path, "w"), indent=1)


if __name__ == "__main__":
    main()
