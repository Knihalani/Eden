# A17 (docs/research/a17-long-quality.md): pi-ab `--days` runs by position in the day.
# usage: python3 -I days.py [--buckets 0,4,8,12] [--pair A,B ...] STEM [STEM ...]
#   STEM.json and STEM.tl/tasks.jsonl of pi-ab (records are in stream order per condition; recaps are not tasks).
# Per condition and position bucket: hidden raised, how the planted item reached the agent (in this turn's packet,
# an ask answer, or only earlier in the day), control/neutral concerns, asks a task, agent $/1k, wall p50.
# Pairs: per task (same set, seed and task id), B - A, bootstrap 95% over tasks.
import json, re, sys, random, statistics as st, collections

args = sys.argv[1:]
buckets = [0, 4, 8, 12]
pairs = []
while args and args[0].startswith("--"):
    f = args.pop(0)
    if f == "--buckets": buckets = [int(x) for x in args.pop(0).split(",")]
    elif f == "--pair": pairs.append(tuple(args.pop(0).split(",")))
stems = args

def bucket(pos):
    b = [x for x in buckets if pos >= x][-1]
    nxt = [x for x in buckets if x > b]
    return f"{b}-{nxt[0]-1}" if nxt else f"{b}+"

rows = []  # one per task run
recaps = []
for stem in stems:
    res = json.load(open(stem + ".json"))
    R = {(r["task"], r["condition"]): r for r in res["results"]}
    sizes = {w["seed"]: w["daySizes"] for w in res["user"]["worlds"]}
    by_cond = collections.defaultdict(list)
    for l in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(l)
        by_cond[t["condition"]].append(t)
    for cond, ts in by_cond.items():
        per_seed = collections.defaultdict(list)
        for t in ts: per_seed[t["seed"]].append(t)
        for seed, ts in per_seed.items():
            ds = sizes[seed]
            i = 0
            for d, n in enumerate(ds):
                seen = set()  # items cited earlier this day (packets or asks)
                pk_seen = set()
                for pos in range(n):
                    if i >= len(ts): break
                    t = ts[i]; i += 1
                    r = R.get((t["task"], cond))
                    if not r or r.get("error") or r.get("facts") is None: continue
                    pl = t.get("planted")
                    cited = t.get("cited") or []; ac = t.get("askCited") or []
                    rows.append(dict(
                        stem=stem.split("/")[-1], group=re.sub(r"^a17-[^-]+-", "", stem.split("/")[-1]), cond=cond, seed=seed, task=t["task"], day=d, pos=pos, n=n,
                        kind=t["kind"], hit=any(r["facts"].values()),
                        pk=bool(pl and pl in cited), ask=bool(pl and pl in ac),
                        earlier=bool(pl and pl in seen), earlier_pk=bool(pl and pl in pk_seen),
                        asks=len(t.get("asks") or []), usd=r["costUsd"], eden=r.get("edenCostUsd", 0),
                        wall=r["wallMs"], chars=r.get("injectedChars", 0), tools=r["toolCalls"],
                        tin=r["promptTokens"]))
                    seen.update(cited); seen.update(ac); pk_seen.update(cited)
    for dd in res.get("days", []):
        recaps.append(dict(dd, stem=stem.split("/")[-1]))

def rate(xs):
    return f"{sum(xs)}/{len(xs)} ({(sum(xs)/len(xs) if xs else 0):.2f})"

conds = sorted({r["cond"] for r in rows})
print("== by position in the day (pos 0 = the day's first request)")
for c in conds:
    print(f"-- {c}")
    print(f"{'bucket':>7} {'hidden raised':>15} {'pk now':>8} {'ask':>6} {'earlier only':>13} {'ctl concern':>13} {'neu concern':>13} {'asks/t':>7} {'agent $/1k':>10} {'in tok':>7} {'wall p50':>8}")
    for b in [bucket(x) for x in buckets]:
        rs = [r for r in rows if r["cond"] == c and bucket(r["pos"]) == b]
        if not rs: continue
        h = [r for r in rs if r["kind"] == "hidden"]
        print(f"{b:>7} {rate([r['hit'] for r in h]):>15} {sum(r['pk'] for r in h):>8} {sum(r['ask'] and not r['pk'] for r in h):>6} "
              f"{sum(r['earlier'] and not r['pk'] and not r['ask'] for r in h):>13} "
              f"{rate([r['hit'] for r in rs if r['kind']=='control']):>13} {rate([r['hit'] for r in rs if r['kind']=='neutral']):>13} "
              f"{st.mean(r['asks'] for r in rs):7.2f} {1000*st.mean(r['usd'] for r in rs):10.3f} {st.mean(r['tin'] for r in rs):7.0f} {st.median(r['wall'] for r in rs)/1000:8.2f}")
    h = [r for r in rows if r["cond"] == c and r["kind"] == "hidden"]
    if h:
        print("   hidden by way: " + " ".join(
            f"{w} {rate([r['hit'] for r in h if f(r)])}" for w, f in [
                ("packet-now", lambda r: r["pk"]), ("ask-only", lambda r: r["ask"] and not r["pk"]),
                ("earlier-only", lambda r: r["earlier"] and not r["pk"] and not r["ask"]),
                ("never", lambda r: not (r["pk"] or r["ask"] or r["earlier"]))]))

def boot(diffs, n=4000):
    if not diffs: return (0, 0, 0)
    rnd = random.Random(7); m = st.mean(diffs)
    bs = sorted(st.mean(rnd.choices(diffs, k=len(diffs))) for _ in range(n))
    return m, bs[int(0.025*n)], bs[int(0.975*n)]

# Runs of one set (a17-<arm>-<set>-<seed>: the same user's days) pair task by task; sets never mix.
key = lambda r: (re.sub(r"-\d+$", "", r["group"]), r["seed"], r["task"])
for a, b in pairs:
    A = {key(r): r for r in rows if r["cond"] == a}; B = {key(r): r for r in rows if r["cond"] == b}
    ks = [k for k in A if k in B]
    print(f"== pair {b} - {a} (n {len(ks)} tasks)")
    for kind in ["hidden", "control", "neutral"]:
        kk = [k for k in ks if A[k]["kind"] == kind]
        for lab, sel in [("all", kk), ("early(<4)", [k for k in kk if A[k]["pos"] < 4]), ("late(>=4)", [k for k in kk if A[k]["pos"] >= 4])]:
            m, lo, hi = boot([B[k]["hit"] - A[k]["hit"] for k in sel])
            print(f"  {kind:8} {lab:10} n {len(sel):4}  rate {m:+.3f} ({lo:+.3f}..{hi:+.3f})")
    for lab, f in [("agent $/1k", lambda r: 1000*r["usd"]), ("eden $/1k", lambda r: 1000*r["eden"]), ("wall s", lambda r: r["wall"]/1000), ("asks", lambda r: r["asks"]), ("in tok", lambda r: r["tin"])]:
        m, lo, hi = boot([f(B[k]) - f(A[k]) for k in ks])
        print(f"  {lab:12} {m:+.4f} ({lo:+.4f}..{hi:+.4f})")

if recaps:
    print("== recaps (sums over days)")
    agg = collections.defaultdict(collections.Counter)
    for d in recaps:
        for k in ["delivered", "repeatDelivered", "repeatChanged", "updatePackets", "changed", "staleDeliveries", "staleRecap", "freshRecap"]:
            agg[d["condition"]][k] += d.get(k, 0)
        agg[d["condition"]]["days"] += 1
        agg[d["condition"]]["recapUsd"] += d.get("recapUsd") or 0
    for c, v in sorted(agg.items()):
        print(f"  {c}: " + " ".join(f"{k} {round(x, 4) if isinstance(x, float) else x}" for k, x in v.items()))
