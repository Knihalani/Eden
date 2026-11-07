"""A8: spend per run label and in total from the spend ledger. python3 -I spend.py LEDGER"""
import json, sys
from collections import defaultdict
by = defaultdict(float)
for line in open(sys.argv[1]):
    r = json.loads(line)
    by[r.get("run", "?")] += r.get("costUsd") or 0
for k in sorted(by):
    print(f"{k:28} {by[k]:.4f}")
print(f"{'total':28} {sum(by.values()):.4f}")
