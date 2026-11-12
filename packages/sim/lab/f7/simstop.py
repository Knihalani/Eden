"""F7: the lean stop simulated on recorded shipped replies ($0). Per recorded compare-first reply (a `--check-dump`
row), cut at its first entry whose act is not true, as `CHECK_LEAN_STOP` would on a reply in the shipped order:
output characters kept, yes entries lost, planted (hidden) and look-alike (control) named before and after, neutral
rows that still speak. Only a lower bound on the lean prompt's saving and an upper bound on its loss: the lean prompt
also moves the yeses first.

    python3 -I simstop.py DUMP.jsonl [...]
"""
import json
import re
import sys
from collections import Counter

ENTRY = re.compile(r'\{[^{}]*?"i"\s*:\s*"?(\d+)"?[^{}]*?\}')


def main():
    c = Counter()
    for f in sys.argv[1:]:
        for line in open(f):
            r = json.loads(line)
            reply, yes = r.get("reply") or "", r.get("yes")
            if yes is None or not reply:
                continue
            ids = [it["id"] for it in r["items"]]
            m = re.search(r'"act"\s*:\s*false', reply)
            kept = reply[: m.start()] if m else reply
            kept_yes = set()
            for e in ENTRY.finditer(kept):
                said_yes = re.search(r'"act"\s*:\s*(true|"true")', e.group(0))
                if said_yes and not re.search(r'"hits"\s*:\s*"none', e.group(0), re.I):
                    i = int(e.group(1)) - 1
                    if 0 <= i < len(ids):
                        kept_yes.add(ids[i])
            kept_yes &= set(yes)
            v = r["variant"]
            c["rows"] += 1
            c[f"rows_{v}"] += 1
            c["chars"] += len(reply)
            c["chars_kept"] += len(kept)
            c[f"chars_{v}"] += len(reply)
            c[f"kept_{v}"] += len(kept)
            c["yes"] += len(yes)
            c["yes_lost"] += len(set(yes) - kept_yes)
            if v in ("hidden", "control") and r["planted"] in yes:
                c[f"planted_{v}"] += 1
                c[f"planted_{v}_lost"] += r["planted"] not in kept_yes
            if v == "neutral":
                c["neutral_spoke"] += bool(yes)
                c["neutral_spoke_kept"] += bool(kept_yes)
    for k in sorted(c):
        print(k, c[k])
    for v in ("hidden", "control", "neutral"):
        if c[f"chars_{v}"]:
            print(f"{v}: chars kept {c[f'kept_{v}'] / c[f'chars_{v}']:.2f}")
    print(f"all: chars kept {c['chars_kept'] / c['chars']:.2f}")


main()
