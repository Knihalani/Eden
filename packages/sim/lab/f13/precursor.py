"""F13: would a plan-driven anticipation pass have predicted the request? A $0 proxy from a funnel --corpus-dump.

    python3 -I precursor.py CORPUS.jsonl

A request is "foreseen" when some item other than the planted fact (and other than every task's planted item) in a
plan-like place (a calendar event, a task, a trip, a note, a shared doc) shares at least two of the request's
anchors (capitalised names, numbers, ids). The baseline pairs each world with another world's requests (same suite
group, next seed's world), which says how often the anchors meet by chance. LAB measurement only (word overlap is
how the proxy reads plans, never a product rule).
"""
import json
import re
import sys
from collections import defaultdict

PLAN = ("calendar:", "tasks:", "trips:", "notes:", "drive:", "school:", "residents:")
STOP = set("""I The This That Please Can Could Would Should Book Send Set Pay Move Renew Cancel Ask Switch Accept
Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August
September October November December Oct Nov Dec Sep Mon Tue Wed Thu Fri Sat Sun My Our We You It Let Get Make
Find Add Put Tell Reply Order Help Check Draft Email Message Text Schedule Arrange Plan Organise Organize Do""".split())


def anchors(text):
    words = re.findall(r"[A-Z][\w'’-]{2,}|[A-Z]{2,}-?\d+|\d[\d,.:]*", text)
    return {w.lower() for w in words if w not in STOP and not re.fullmatch(r"\d{1,2}", w)}


def group(suite):
    return "dev20" if suite.startswith("dev20") else "longtail" if suite == "longtail" else (
        "reworded" if suite.endswith("r") else "train")


def main():
    worlds = [json.loads(l) for l in open(sys.argv[1])]
    worlds = [w for w in worlds if w["variant"] == "hidden"]
    by = {(w["suite"], w["seed"]): w for w in worlds}
    hit = defaultdict(lambda: [0, 0, 0])
    for w in worlds:
        other = by.get((w["suite"], 42 if w["seed"] == 41 else 41))
        skip = {t["planted"] for t in w["tasks"]}
        plans = [anchors(it["title"] + " " + it["text"]) for it in w["items"]
                 if it["id"].startswith(PLAN) and it["id"] not in skip]
        g = group(w["suite"])
        for i, t in enumerate(w["tasks"]):
            a = anchors(t["request"])
            hit[g][0] += 1
            hit[g][1] += any(len(a & p) >= 2 for p in plans)
            if other:
                b = anchors(other["tasks"][i % len(other["tasks"])]["request"])
                hit[g][2] += any(len(b & p) >= 2 for p in plans)
    print("group: requests foreseen by a plan item (>=2 shared anchors) / baseline (another world's requests)")
    for g, (n, f, b) in sorted(hit.items()):
        print(f"  {g:9} {f}/{n} ({100*f/n:.1f}%)  baseline {b}/{n} ({100*b/n:.1f}%)")


main()
