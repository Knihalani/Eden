"""A6 (D287): dressed − undressed worlds per arm, paired by task id across runs (same seeds, tasks and wording; run at
different times). Per kind and on the 1:1:8 mix: rate, wall s, agent $/1k (billed), model turns, asks.
python3 -I dress-pairs.py ARM UNDRESSED_STEM... -- DRESSED_STEM...   (STEM.json and STEM.tl/tasks.jsonl)"""
import json, random, sys

args = sys.argv[1:]
arm = args[0]
cut = args.index("--")
plain, dressed = args[1:cut], args[cut + 1 :]


def load(stems):
    out = {}
    for st in stems:
        res = {r["task"]: r for r in json.load(open(st + ".json"))["results"] if r["condition"] == arm}
        for l in open(st + ".tl/tasks.jsonl"):
            t = json.loads(l)
            if t["condition"] != arm:
                continue
            r = res[t["task"]]
            asks = sum(1 for e in t["events"] if e["ev"] == "eden.ask" and e["ph"] == "I")
            out[t["task"]] = dict(
                kind=t["kind"],
                rate=float(any(r["facts"].values())),
                wall=r["wallMs"] / 1000,
                usd=1000 * r["costUsd"],
                turns=len(t["requests"]),
                asks=asks,
                tools=r["toolCalls"],
            )
    return out


A, B = load(plain), load(dressed)
ids = sorted(set(A) & set(B))
KEYS = ["rate", "wall", "usd", "turns", "asks", "tools"]
W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}
rng = random.Random(1)


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


by = {k: [i for i in ids if A[i]["kind"] == k] for k in W}
print(f"{arm}: {len(ids)} tasks paired (dressed − undressed), bootstrap 95% (5,000 draws)")
for k, xs in by.items():
    line = f"  {k:8} n {len(xs):4}"
    for key in KEYS:
        d = [B[i][key] - A[i][key] for i in xs]
        boots = sorted(mean([rng.choice(d) for _ in d]) for _ in range(5000))
        line += f"  {key} {mean([A[i][key] for i in xs]):.3f}->{mean([B[i][key] for i in xs]):.3f} ({mean(d):+.3f}, {boots[125]:+.3f}..{boots[4874]:+.3f})"
    print(line)
line = "  mix 1:1:8"
for key in KEYS:
    ds = {k: [B[i][key] - A[i][key] for i in xs] for k, xs in by.items()}
    m = sum(W[k] * mean(ds[k]) for k in W)
    boots = sorted(sum(W[k] * mean([rng.choice(ds[k]) for _ in ds[k]]) for k in W) for _ in range(5000))
    line += f"  {key} {m:+.3f} ({boots[125]:+.3f}..{boots[4874]:+.3f})"
print(line)
