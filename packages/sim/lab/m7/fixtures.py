"""M7 (D930, D932): fixtures.json -> check-dump rows (one pool a case), for m7.py --fixtures.

Each pool: the five background items with the case's short real constraint at rank 3, that item gated and named.
Run tag-dump.ts on the output before m7.py reads it.

  python3 -I packages/sim/lab/m7/fixtures.py OUT.jsonl
"""

import json
import os
import sys

fx = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures.json")))
with open(sys.argv[1], "w") as out:
    for k, c in enumerate(fx["cases"]):
        items = [dict(id=f"bg:{j}", **b, full=f"{b['title']}\n{b['text']}") for j, b in enumerate(fx["background"])]
        it = dict(id=f"fx:{k}", **c["item"])
        it["full"] = f"{it['title']}\n{it['text']}"
        items.insert(2, it)
        row = dict(suite="fixture", seed=0, variant="hidden", template=f"fx{k}", planted=it["id"],
                   request=c["request"], today="2026-10-27", like=[i == 2 for i in range(len(items))],
                   items=items, yes=[it["id"]], reply=None)
        out.write(json.dumps(row) + "\n")
print(f"{len(fx['cases'])} fixture pools")
