import json,random
def load(fs):
  R={};K={}
  for f in fs:
    d=json.load(open(f))
    for t in d['tasks']: K[t['id']]=t['kind']
    for r in d['results']:
      if r.get('facts') is not None: R[(r['task'],r['condition'])]=(any(r['facts'].values()), r['wallMs']/1000, r['injectedItems'])
  return R,K
D,K=load(['.local/ab/s3b-day2-41.json','.local/ab/s3b-day2-42.json'])
S,_=load(['.local/ab/s3b-ask-41.json','.local/ab/s3b-ask-42.json'])
random.seed(2)
for c in ['tools','eden','both+ask']:
  for kind in ['hidden','control','neutral']:
    ids=[t for t,k in K.items() if k==kind and (t,c) in D and (t,c) in S]
    d=[(D[(t,c)][0]-S[(t,c)][0], D[(t,c)][1]-S[(t,c)][1]) for t in ids]
    def ci(i):
      m=sum(x[i] for x in d)/len(d); bs=sorted(sum(random.choice(d)[i] for _ in d)/len(d) for _ in range(4000))
      return f"{m:+.3f} ({bs[99]:+.3f}..{bs[3899]:+.3f})"
    dr=sum(D[(t,c)][0] for t in ids)/len(ids)
    print(f"{c:9s} {kind:8s} n={len(d)} day rate {dr:.3f}  day-single rate {ci(0)} wall s {ci(1)}")
