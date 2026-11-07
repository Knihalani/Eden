import json,sys,random
a,b=sys.argv[1],sys.argv[2]; files=sys.argv[3:]
R={};K={}
for f in files:
  d=json.load(open(f))
  for t in d['tasks']: K[t['id']]=t['kind']
  for r in d['results']:
    if r.get('facts') is None: continue
    R[(r['task'],r['condition'])]=(any(r['facts'].values()), r['wallMs']/1000)
random.seed(1)
for kind in ['hidden','control','neutral']:
  ids=[t for t,k in K.items() if k==kind and (t,a) in R and (t,b) in R]
  d=[(R[(t,a)][0]-R[(t,b)][0], R[(t,a)][1]-R[(t,b)][1]) for t in ids]
  def ci(i):
    m=sum(x[i] for x in d)/len(d); bs=sorted(sum(random.choice(d)[i] for _ in d)/len(d) for _ in range(5000))
    return f"{m:+.3f} ({bs[124]:+.3f}..{bs[4874]:+.3f})"
  print(f"{a} - {b} {kind} n={len(d)} rate {ci(0)} wall s {ci(1)}")
