"""A6 (docs/research/a6-moonshots.md §1): the pilot's figures from a pi-ab timeline (eden arm).
python3 -I pilot.py RUN.tl/tasks.jsonl"""
import json, sys, collections

L = [json.loads(l) for l in open(sys.argv[1]) if json.loads(l)["condition"] == "eden"]
out = sum(q["out"] for x in L for q in x["requests"])
cost = sum(q["cost"] for x in L for q in x["requests"])
print(f"tasks {len(L)}; output share of agent $ {out * 0.5e-6 / cost:.3f} (Haiku 5.5 output $0.5/M)")
asks = lambda x: sum(1 for e in x["events"] if e["ev"] == "eden.ask" and e["ph"] == "I")
asked = [x for x in L if asks(x)]
quiet = [x for x in L if not asks(x)]
mean = lambda v: sum(v) / len(v)
print(f"tasks asking {len(asked)}; wall mean {mean([x['wallMs'] for x in asked]) / 1000:.2f} s asking, "
      f"{mean([x['wallMs'] for x in quiet]) / 1000:.2f} s not (unpaired)")
by = collections.defaultdict(lambda: [0, 0])
for x in L:
    by[x["kind"]][0] += 1
    by[x["kind"]][1] += asks(x)
print("asks a task: " + ", ".join(f"{k} {a / n:.2f}" for k, (n, a) in sorted(by.items())))
items = sum(len(set(x.get("askCited") or [])) for x in asked)
inpk = sum(len(set(x.get("askCited") or []) & set(x.get("cited") or [])) for x in asked)
print(f"ask citations {items}, already in a packet {inpk}")
