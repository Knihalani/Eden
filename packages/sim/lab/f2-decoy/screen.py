"""F2-decoy: candidate rules over what the filter read (`cardReads`, a `pushDecoyFilter` 8 run's pool dump), scored on
the planted item: facts (hidden) and decoys (control) the rule would take out, among those the push handed, with the
labelled decoy kind. No model; the pools are the base's (bit 8 removes nothing).

    python3 -I screen.py POOL.jsonl...
"""
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from labels import labels  # noqa: E402

KINDS = labels()
SPAN = {"freeze", "absence", "prohibition", "status-change"}

RULES = {
    # The card's span ended before the request's first day (today when it names none): it no longer holds.
    "expired": lambda c: c["kind"] in SPAN and c.get("end") and c["end"] < c["first"],
    # Only when the request names its days.
    "expired-named": lambda c: c["kind"] in SPAN and c.get("end") and c["end"] < c["first"] and c["named"],
    # A span that starts after the request's last day (not yet in force), named days.
    "not-yet": lambda c: c["kind"] in {"freeze", "absence"} and c.get("start") and c["start"] > c["last"] and c["named"],
    # A party card (absence, diet) with no tie to the request at all, on a shared action.
    "party-untied": lambda c: c["kind"] in {"absence", "preference"} and c["shared"] and c["tied"] is None,
    # A freeze or absence whose span misses every named day, on a shared action.
    "span-miss": lambda c: (c["kind"] in {"freeze", "absence"} and c["shared"] and c["named"]
                            and (c.get("start") or c.get("end"))
                            and ((c.get("end") and c["end"] < c["first"]) or (c.get("start") and c["start"] > c["last"]))),
}


def main():
    hits = collections.Counter()
    base = collections.Counter()
    for f in sys.argv[1:]:
        for line in open(f):
            p = json.loads(line)
            v = p["variant"]
            if v not in ("hidden", "control"):
                continue
            handed = {x["id"] for x in p["pool"] if x.get("handed")}
            if p["planted"] not in handed:
                continue
            base[v] += 1
            kind = KINDS.get(p["template"])
            if v == "control" and kind:
                base["control " + kind] += 1
            read = next((c for c in p.get("cardReads") or [] if c["id"] == p["planted"]), None)
            if not read:
                continue
            for name, rule in RULES.items():
                if rule(read):
                    hits[(name, v)] += 1
                    if v == "control" and kind:
                        hits[(name, "control " + kind)] += 1
    print("handed base:", dict(base))
    for name in RULES:
        cols = ", ".join(f"{k} -{hits[(name, k)]}" for k in ["hidden", "control", "control a", "control b", "control c"])
        print(f"  {name:14} {cols}")


if __name__ == "__main__":
    main()
