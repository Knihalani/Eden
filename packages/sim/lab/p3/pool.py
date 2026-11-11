"""P3 weak point 2: where each hidden (or control) request's planted item was in the push's pool over a user's days,
from `days-calls.ts --pool-diag` rows (o3-pointer.md §3.2's buckets).

    python3 -I pool.py FILE.jsonl [FILE.jsonl ...] [--kind hidden|control] [--by-user]

Buckets, in order: pushed at its request; handed earlier that day (not pushed now); not in the pool; pooled but failed
the constraint test; pooled, passed, below the cut (or the push did not run).
"""
import argparse
import collections
import json


def bucket(r):
    if r["pushed"]:
        return "pushed"
    if r["today"]:
        return "earlier today"
    if not r["pushRan"]:
        return "no push"
    if r["rank"] < 0:
        return "not in pool"
    if not r["like"]:
        return "pooled, fails test"
    return "pooled, below cut"


ORDER = ["pushed", "earlier today", "not in pool", "pooled, fails test", "pooled, below cut", "no push"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--kind", default="hidden")
    ap.add_argument("--by-user", action="store_true")
    a = ap.parse_args()
    for f in a.files:
        rows = [json.loads(x) for x in open(f) if x.strip()]
        rows = [r for r in rows if r["kind"] == a.kind]
        c = collections.Counter(bucket(r) for r in rows)
        got = sum(r["got"] for r in rows)
        print(f"{f}: {a.kind} {len(rows)}; " + ", ".join(f"{k} {c[k]}" for k in ORDER if c[k]) + f"; got (push or ask) {got}")
        if a.by_user:
            by = collections.defaultdict(collections.Counter)
            for r in rows:
                by[r["seed"]][bucket(r)] += 1
            for s in sorted(by):
                print(f"  w{s}: " + ", ".join(f"{k} {by[s][k]}" for k in ORDER if by[s][k]))


main()
