#!/usr/bin/env python3
"""Score an ab_run.py run directory against the corpus's gold facts.

Reads <run>/ab/{eden,ctl}-qNN.json plus <corpus>/questions.json and writes <run>/ab_scored.json:
per-question fact hits per arm, and per-arm totals — fully/partial/miss, API calls, tokens, cost
(where the usage file reports it), and wall time. Fact scoring is substring-based after
normalisation, the same rule drive_eval.py uses; review 'partial' and 'miss' rows by hand — the
absence questions in particular are scored on refusal phrasing, not on correctness of substance.

Usage: python3 score_ab.py --corpus corpus --run runs/2026-11
"""
import argparse
import json
import os
import re
import statistics

ap = argparse.ArgumentParser()
ap.add_argument("--corpus", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus"))
ap.add_argument("--run", required=True, help="ab_run.py --out directory")
ap.add_argument("--out", default=None, help="scores JSON (default: <run>/ab_scored.json)")
args = ap.parse_args()

QS = {q["id"]: q for q in json.load(open(f"{args.corpus}/questions.json"))}


def norm(s):
    return re.sub(r"[,\s£$]+", " ", s.lower()).strip()


def score(facts, text):
    t = norm(text)
    return sum(1 for f in facts if norm(f) in t)


def usage_totals(recs):
    calls = [r.get("usage", {}).get("api_calls") or r.get("usage", {}).get("apiCalls") for r in recs]
    calls = [c for c in calls if isinstance(c, (int, float))]
    toks = []
    cost = 0.0
    for r in recs:
        u = r.get("usage", {})
        for key in ("total_tokens", "totalTokens", "tokens"):
            if isinstance(u.get(key), (int, float)):
                toks.append(u[key])
                break
        for key in ("cost_usd", "cost", "total_cost"):
            if isinstance(u.get(key), (int, float)):
                cost += u[key]
                break
    return {"api_calls": int(sum(calls)) if calls else None,
            "median_calls": statistics.median(calls) if calls else None,
            "tokens": int(sum(toks)) if toks else None,
            "cost_usd": round(cost, 3) if cost else None,
            "median_secs": statistics.median(r["secs"] for r in recs) if recs else None}


scored = {"questions": [], "arms": {}}
for arm in ("eden", "ctl"):
    recs = []
    for qid, q in QS.items():
        path = f"{args.run}/ab/{arm}-{qid}.json"
        if not os.path.exists(path):
            continue
        rec = json.load(open(path))
        hit = score(q["facts"], rec.get("answer", ""))
        verdict = ("timeout" if rec["rc"] == 124 else
                   "full" if hit == len(q["facts"]) else
                   "partial" if hit else "miss")
        scored["questions"].append({"id": qid, "cat": q["cat"], "arm": arm, "verdict": verdict,
                                    "facts_hit": hit, "facts_total": len(q["facts"]),
                                    "secs": rec["secs"], "rc": rec["rc"]})
        recs.append(rec)
    if recs:
        qs = [s for s in scored["questions"] if s["arm"] == arm]
        scored["arms"][arm] = {
            "n": len(qs),
            "full": sum(s["verdict"] == "full" for s in qs),
            "partial": sum(s["verdict"] == "partial" for s in qs),
            "miss": sum(s["verdict"] == "miss" for s in qs),
            "timeout": sum(s["verdict"] == "timeout" for s in qs),
            "by_cat": {c: f"{sum(s['verdict'] == 'full' for s in qs if s['cat'] == c)}/"
                          f"{sum(s['cat'] == c for s in qs)}"
                       for c in sorted({s["cat"] for s in qs})},
            **usage_totals(recs),
        }

out = args.out or f"{args.run}/ab_scored.json"
json.dump(scored, open(out, "w"), indent=1)
for arm, s in scored["arms"].items():
    print(f"{arm}: {s['full']}/{s['n']} full, {s['partial']} partial, {s['miss']} miss, "
          f"{s['timeout']} timeout | calls {s['api_calls']} (med {s['median_calls']}) | "
          f"tokens {s['tokens']} | ${s['cost_usd']} | median {s['median_secs']}s")
    print("   ", s["by_cat"])
print("wrote", out)
