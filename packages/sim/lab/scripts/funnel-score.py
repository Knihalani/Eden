import json,sys,collections
def score(f):
  d=json.load(open(f)); pt=d['perTask']
  agg=collections.defaultdict(lambda:[0,0,0,0])
  pool=collections.defaultdict(lambda:[0,0,0,0])  # hidden in pool, hidden read, decoy in pool, decoy read
  for t in pt:
    s=t['suite']; v=t['variant']; hit=bool(t['delivered'] or t.get('askCited'))
    a=agg[s]
    if v=='hidden': a[0]+=hit; a[1]+=1
    else: a[2]+=hit; a[3]+=1
    # A run with a reader (stub, oracle, replay or live) records whether the planted item was in the reader's pool.
    if 'poolHas' in t:
      p=pool[s]; i=0 if v=='hidden' else 2
      p[i]+=bool(t['poolHas']); p[i+1]+=1
  tot=[sum(x[i] for x in agg.values()) for i in range(4)]
  ptot=[sum(x[i] for x in pool.values()) for i in range(4)]
  return agg,tot,pool,ptot
for f in sys.argv[1:]:
  agg,tot,pool,ptot=score(f)
  print(f.split('/')[-1], ' '.join(f"{s}:{a[0]}/{a[1]} d{a[2]}" for s,a in sorted(agg.items())), f"| TOTAL hidden {tot[0]}/{tot[1]} decoys {tot[2]}/{tot[3]}")
  if pool:
    print('  pool recall (pool content, not a bound):', ' '.join(f"{s}:{p[0]}/{p[1]} d{p[2]}/{p[3]}" for s,p in sorted(pool.items())), f"| TOTAL hidden in pool {ptot[0]}/{ptot[1]} decoy in pool {ptot[2]}/{ptot[3]}")
