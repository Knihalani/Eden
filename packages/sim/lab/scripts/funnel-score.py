import json,sys,collections
def score(f):
  d=json.load(open(f)); pt=d['perTask']
  agg=collections.defaultdict(lambda:[0,0,0,0])
  for t in pt:
    s=t['suite']; v=t['variant']; hit=bool(t['delivered'] or t['askCited'])
    a=agg[s]
    if v=='hidden': a[0]+=hit; a[1]+=1
    else: a[2]+=hit; a[3]+=1
  tot=[sum(x[i] for x in agg.values()) for i in range(4)]
  return agg,tot
for f in sys.argv[1:]:
  agg,tot=score(f)
  print(f.split('/')[-1], ' '.join(f"{s}:{a[0]}/{a[1]} d{a[2]}" for s,a in sorted(agg.items())), f"| TOTAL hidden {tot[0]}/{tot[1]} decoys {tot[2]}/{tot[3]}")
