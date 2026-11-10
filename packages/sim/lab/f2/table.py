# F2: one line per screen on both intent draws: hidden and decoys surfaced, and tasks gained and lost against that
# draw's default (docs/research/f2-quality.md). usage: python3 -I table.py DIR NAME [NAME ...]
#   DIR holds base.json, base2.json (the default on intent-v2 and on draw2) and NAME-d1.json, NAME-d2.json.
import json, sys
def rows(f):
    return {(t["suite"], t["seed"], t["variant"], t["template"]): bool(t["delivered"] or t.get("askCited")) for t in json.load(open(f))["perTask"]}
def cell(base, run, v):
    n = sum(s for k, s in run.items() if k[2] == v)
    up = sum(1 for k in run if k[2] == v and run[k] and not base[k])
    down = sum(1 for k in run if k[2] == v and not run[k] and base[k])
    return f"{n} (+{up} -{down})"
d = sys.argv[1]
b1, b2 = rows(f"{d}/base.json"), rows(f"{d}/base2.json")
print(f"{'screen':14s} | {'draw 1 hidden':16s} | {'draw 1 decoys':16s} | {'draw 2 hidden':16s} | {'draw 2 decoys':16s}")
print(f"{'default':14s} | {sum(s for k, s in b1.items() if k[2] == 'hidden'):<16d} | {sum(s for k, s in b1.items() if k[2] == 'control'):<16d} | {sum(s for k, s in b2.items() if k[2] == 'hidden'):<16d} | {sum(s for k, s in b2.items() if k[2] == 'control'):<16d}")
for name in sys.argv[2:]:
    r1, r2 = rows(f"{d}/{name}-d1.json"), rows(f"{d}/{name}-d2.json")
    print(f"{name:14s} | {cell(b1, r1, 'hidden'):16s} | {cell(b1, r1, 'control'):16s} | {cell(b2, r2, 'hidden'):16s} | {cell(b2, r2, 'control'):16s}")
