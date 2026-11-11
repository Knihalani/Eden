"""P2: the push check's calls by run label from a spend ledger, and a stop sequence simulated on recorded replies.

    python3 -I calls.py LEDGER [--log RUN=checklog.jsonl ...]

Per run: calls, $ a call, input (cached) and output tokens a call, p50 and p90 seconds, p50 time to first token.
With `--log`, per recorded compare-first reply: the share of its characters before its first `"hits":"none"` entry
(what a stop sequence there would keep) and the yes entries after that point (what it would lose).
"""
import argparse
import json
import re
import statistics
from collections import defaultdict


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ledger")
    ap.add_argument("--log", action="append", default=[])
    ap.add_argument("--role", default="eden.check")
    a = ap.parse_args()
    runs = defaultdict(list)
    for line in open(a.ledger):
        d = json.loads(line)
        if d.get("role") == a.role:
            runs[d["run"]].append(d)
    print(f"{'run':18} {'calls':>5} {'$/call':>9} {'in':>6} {'cached':>6} {'out':>5} {'p50 s':>6} {'p90 s':>6} {'ttft50':>6}")
    for run, ds in sorted(runs.items()):
        u = [d["usage"] for d in ds]
        print(
            f"{run:18} {len(ds):5d} {statistics.mean(d['costUsd'] for d in ds):9.6f}"
            f" {statistics.mean(x['inputTokens'] for x in u):6.0f} {statistics.mean(x['cachedInputTokens'] for x in u):6.0f}"
            f" {statistics.mean(x['outputTokens'] for x in u):5.0f} {pct([d['latencyMs'] for d in ds], .5) / 1000:6.2f}"
            f" {pct([d['latencyMs'] for d in ds], .9) / 1000:6.2f} {pct([d.get('ttftMs') or 0 for d in ds], .5) / 1000:6.2f}"
        )
    for spec in a.log:
        run, path = spec.split("=", 1)
        kept, lost, n, cut = [], 0, 0, 0
        for line in open(path):
            reply = json.loads(line)["reply"]
            n += 1
            m = re.search(r'"hits"\s*:\s*"none"', reply)
            if not m:
                kept.append(1.0)
                continue
            cut += 1
            kept.append(m.end() / max(1, len(reply)))
            after = reply[m.end():]
            lost += len(re.findall(r'"act"\s*:\s*true', after))
        print(f"{run}: {n} replies, {cut} with a none entry; kept {statistics.mean(kept):.2f} of the characters;"
              f" yes entries after the first none {lost}")


if __name__ == "__main__":
    main()
