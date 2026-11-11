"""H2 (D1050-D1059): the pre-registered no-model skip rule for the push check, read on `--check-dump` rows ($0).

    python3 -I skip.py DUMP.jsonl [DUMP.jsonl ...]

Rule (docs/research/h2-haiku-lean.md §1a): a pool is settled silent with no call when no item the check reads
shares a content word (four letters or more, not a stopword) or a number with the request's head. Prints the calls it
would save and the planted (hidden) and look-alike (control) items the check named in the pools it would silence.
Also prints where in the pool the check's yes items and the planted items sit (positions 1-15), for the lean pool.
"""
import json
import re
import sys
from collections import Counter

STOP = set(
    "about above after again against also because been before being below between both could does doing down during "
    "each from further have having here into itself just more most much need only other ought over same should some "
    "such than that their theirs them then there these they this those through under until very want what when where "
    "which while will with would your yours please make sure send book move pay can't don't next week today tomorrow "
    "thanks".split()
)
WORD = re.compile(r"[a-z][a-z'’]{3,}|\d+(?:[.,]\d+)?")


def terms(text):
    return {w.strip("'’") for w in WORD.findall(text.lower()) if w not in STOP}


def main():
    rows = [json.loads(l) for f in sys.argv[1:] for l in open(f) if l.strip()]
    rows = [r for r in rows if r.get("called")]
    skip = lost = Counter()
    skip, lost = Counter(), Counter()
    yes_pos, plant_pos, plant_yes_pos = Counter(), Counter(), Counter()
    for r in rows:
        req = terms(r["request"])
        shares = any(req & terms(f"{it['title']} {it['text']}") for it in r["items"])
        yes = set(r["yes"] or [])
        for i, it in enumerate(r["items"]):
            if it["id"] in yes:
                yes_pos[i + 1] += 1
            if it["id"] == r.get("planted"):
                plant_pos[(r["variant"], i + 1)] += 1
                if it["id"] in yes:
                    plant_yes_pos[(r["variant"], i + 1)] += 1
        if not shares:
            skip[r["variant"]] += 1
            if r.get("planted") in yes:
                lost[r["variant"]] += 1
            if yes:
                lost[("any-yes", r["variant"])] += 1
    print(f"calls {len(rows)}; the rule settles {sum(skip.values())} silent ({100 * sum(skip.values()) / len(rows):.1f}%)"
          f" by variant {dict(skip)}")
    print(f"  of those the check named the planted item: hidden {lost['hidden']}, control (look-alike) {lost['control']};"
          f" pools with any yes: { {k[1]: v for k, v in lost.items() if isinstance(k, tuple)} }")
    print("yes items by pool position:", [yes_pos[i] for i in range(1, 16)])
    for v in ("hidden", "control"):
        print(f"{v}: planted item at position 1-15:", [plant_pos[(v, i)] for i in range(1, 16)],
              "named yes:", [plant_yes_pos[(v, i)] for i in range(1, 16)])


main()
