import json, sys

# Summarise funnel --json files: surfaced, in pool (push's 15), handed; and per-task moves against the first file.
def load(p):
    d = json.load(open(p))
    return {(r["suite"], r["seed"], r["variant"], r["template"]): r for r in d["perTask"]}


def stats(rows):
    out = {}
    for v in ("hidden", "control"):
        rs = [r for k, r in rows.items() if k[2] == v]
        surf = sum(1 for r in rs if r["delivered"] or r.get("askCited"))
        pool = sum(1 for r in rs if (r.get("pushPoolAt") is not None and r["pushPoolAt"] >= 0))
        handed = sum(1 for r in rs if r.get("pushHanded"))
        out[v] = (surf, pool, handed, len(rs))
    return out


base = load(sys.argv[1])
for p in sys.argv[1:]:
    rows = load(p)
    s = stats(rows)
    line = f"{p.split('/')[-1]:28s} hidden surf {s['hidden'][0]} pool {s['hidden'][1]} handed {s['hidden'][2]} | decoy surf {s['control'][0]} pool {s['control'][1]} handed {s['control'][2]}"
    if p != sys.argv[1]:
        moves = []
        for k, r in rows.items():
            b = base[k]
            sb = bool(b["delivered"] or b.get("askCited"))
            sr = bool(r["delivered"] or r.get("askCited"))
            pb = b.get("pushPoolAt") is not None and b["pushPoolAt"] >= 0
            pr = r.get("pushPoolAt") is not None and r["pushPoolAt"] >= 0
            if sb != sr or pb != pr:
                moves.append(f"{k[2][:3]} {k[0]}/{k[1]} {k[3]} surf {int(sb)}->{int(sr)} pool {b.get('pushPoolAt')}->{r.get('pushPoolAt')}")
        line += f"  ({len(moves)} moved)"
        print(line)
        if "-v" in sys.argv[0:1] or len(sys.argv) == 3:
            for m in sorted(moves):
                print("   ", m)
    else:
        print(line)
