import json, os, statistics, random, sys
sys.path.insert(0, 'packages/sim/lab/before-after')
from market import load, eden_sources, raised, asks
runs, _ = load(['.local/s4/pi/s4-41.json', '.local/s4/pi/s4-42.json'])
tasks = {}
for p in ['.local/s4/pi/s4-41.json', '.local/s4/pi/s4-42.json']:
    for t in json.load(open(p))['tasks']: tasks[t['id']] = t
def ops(t):
    c = {'list': 0, 'search': 0, 'fetch': 0}
    for e in t['events']:
        if e.get('ev') == 'eden.source' and e.get('ph') == 'B':
            c[(e.get('data') or {}).get('op', 'search')] = c.get((e.get('data') or {}).get('op', 'search'), 0) + 1
    return c
def boot(d, n=4000):
    rng = random.Random(7); m = sorted(statistics.mean(rng.choices(d, k=len(d))) for _ in range(n))
    return statistics.mean(d), m[int(.025*n)], m[int(.975*n)]
out = {}
for kind in ['hidden', 'control', 'neutral']:
    ids = sorted(tid for (c, tid) in runs if c == 'eden' and tasks[tid]['kind'] == kind)
    for cond in ['eden', 'eden~gmail30', 'eden~coalesce']:
        rs = [runs[(cond, i)] for i in ids if (cond, i) in runs]
        o = [ops(t) for _, t in rs]
        row = dict(n=len(rs), rate=statistics.mean(raised(r) for r, _ in rs),
                   calls=statistics.mean(sum(x.values()) for x in o),
                   list=statistics.mean(x['list'] for x in o), search=statistics.mean(x['search'] for x in o),
                   fetch=statistics.mean(x['fetch'] for x in o),
                   wall=statistics.median(t['wallMs'] / 1000 for _, t in rs),
                   asks=statistics.mean(asks(t) for _, t in rs),
                   edenUsd=1000*statistics.mean(r.get('edenCostUsd', 0) for r, _ in rs))
        out[f'{kind}|{cond}'] = row
        print(f"{kind:8} {cond:14} n={row['n']:3} rate {row['rate']:.3f} calls {row['calls']:.2f} (list {row['list']:.2f} search {row['search']:.2f} fetch {row['fetch']:.2f}) wall p50 {row['wall']:.2f}s asks {row['asks']:.2f} eden$/1k {row['edenUsd']:.3f}")
    for cond in ['eden~gmail30', 'eden~coalesce']:
        both = [i for i in ids if ('eden', i) in runs and (cond, i) in runs]
        dr = [raised(runs[(cond, i)][0]) - raised(runs[('eden', i)][0]) for i in both]
        dc = [sum(ops(runs[(cond, i)][1]).values()) - sum(ops(runs[('eden', i)][1]).values()) for i in both]
        m, lo, hi = boot(dr); mc, lc, hc = boot(dc)
        out[f'{kind}|{cond}-eden'] = dict(rate=[m, lo, hi], calls=[mc, lc, hc])
        print(f"   {cond} - eden: rate {m:+.3f} ({lo:+.3f}..{hi:+.3f})  calls {mc:+.2f} ({lc:+.2f}..{hc:+.2f})")
json.dump(out, open('.local/s4/pi/summary.json', 'w'), indent=1)
