# Paired bootstrap of arm A - arm B over pi-ab results files: rate (any must fact true), wall s, $/1k (agent+Eden).
import json, random, sys
files=[a for a in sys.argv[1:] if a.endswith('.json')]
A,B=[a for a in sys.argv[1:] if not a.endswith('.json')][:2]
rows={}
kinds={}
for f in files:
    d=json.load(open(f))
    for t in d['tasks']: kinds[t['id']]=t['kind']
    for r in d['results']:
        if 'facts' in r: rows[(r['condition'],r['task'])]=r
def val(r):
    return (1 if any(r['facts'].values()) else 0, r['wallMs']/1000, (r['costUsd']+r.get('edenCostUsd',0))*1000)
random.seed(7)
for kind in ('hidden','control','neutral'):
    ids=[t for (c,t) in rows if c==A and kinds.get(t)==kind and (B,t) in rows]
    if not ids: continue
    diffs=[[a-b for a,b in zip(val(rows[(A,t)]),val(rows[(B,t)]))] for t in ids]
    n=len(diffs); out=[]
    for j,name in enumerate(('rate','wall s','$/1k')):
        m=sum(d[j] for d in diffs)/n
        bs=sorted(sum(diffs[random.randrange(n)][j] for _ in range(n))/n for _ in range(2000))
        out.append(f"{name} {m:+.3f} ({bs[50]:+.3f}..{bs[1949]:+.3f})")
    print(f"{A} - {B} {kind:8s} n={n}: "+"  ".join(out))
