"""A9: the ledger's spend by run label (python3 -I spend.py .local/a9/ledger.jsonl)."""
import json, sys
from collections import defaultdict

by = defaultdict(float)
for line in open(sys.argv[1]):
    r = json.loads(line)
    by[r.get("run", "?")] += r.get("costUsd") or 0
for k, v in sorted(by.items()):
    print(f"{k:28} {v:8.4f}")
print(f"{'TOTAL':28} {sum(by.values()):8.4f}")
