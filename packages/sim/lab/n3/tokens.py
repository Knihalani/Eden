"""N3 (docs/research/n3-long.md): each arm's agent bill by Anthropic token class over `pi-ab --days` runs, and the
paired difference against a base arm by task. Classes: cache read (0.1x), cache write (1.25x), plain input, output;
Haiku 5.5 at $0.10/M in, $0.50/M out. Pairs are (stem, task); the interval is a bootstrap over tasks (5,000 draws,
seed 1). usage: python3 -I tokens.py BASE STEM [STEM ...]   (STEM.tl/tasks.jsonl)"""
import collections, json, random, sys

base, stems = sys.argv[1], sys.argv[2:]
IN, OUT = 0.1e-6, 0.5e-6
PRICE = {"read": IN * 0.1, "write": IN * 1.25, "plain": IN, "out": OUT}
T = collections.defaultdict(dict)  # cond -> (stem, task) -> class -> $
for stem in stems:
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        if not t.get("requests") or t.get("kind") is None:
            continue
        c = collections.Counter()
        for q in t["requests"]:
            read, write = q.get("cached", 0), q.get("cacheWrite", 0)
            c["read"] += read * PRICE["read"]
            c["write"] += write * PRICE["write"]
            c["plain"] += max(0, q.get("in", 0) - read - write) * PRICE["plain"]
            c["out"] += q.get("out", 0) * PRICE["out"]
            c["requests"] += 1
        c["total"] = c["read"] + c["write"] + c["plain"] + c["out"]
        T[t["condition"]][(stem, t["task"])] = c


def boot(d, n=5000):
    if not d:
        return 0.0, 0.0, 0.0
    rnd, m = random.Random(1), sum(d) / len(d)
    bs = sorted(sum(rnd.choices(d, k=len(d))) / len(d) for _ in range(n))
    return m, bs[int(0.025 * n)], bs[int(0.975 * n)]


COLS = ["read", "write", "plain", "out", "total"]
print(f"{'arm':20} {'n':>5} " + " ".join(f"{c:>8}" for c in COLS) + "  req/task   ($ per 1,000 tasks)")
for cond in sorted(T):
    rows = list(T[cond].values())
    print(f"{cond:20} {len(rows):5} " + " ".join(f"{1000 * sum(r[c] for r in rows) / len(rows):8.4f}" for c in COLS)
          + f"  {sum(r['requests'] for r in rows) / len(rows):8.2f}")
for cond in sorted(T):
    if cond == base or base not in T:
        continue
    keys = [k for k in T[cond] if k in T[base]]
    print(f"{cond} - {base} (n {len(keys)} tasks)")
    for c in COLS:
        m, lo, hi = boot([1000 * (T[cond][k][c] - T[base][k][c]) for k in keys])
        print(f"  {c:6} {m:+.4f} ({lo:+.4f}..{hi:+.4f})")
