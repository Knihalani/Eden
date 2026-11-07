# A2 (docs/research/a2-quality.md), $0: re-rank rules simulated on the push's pool dump (hidden-funnel --pool-dump
# .local/a2/pool.jsonl, train seeds 41-42): planted (hidden) and decoy (control) in the first five handed.
import json,re,sys,collections
rows=[json.loads(l) for l in open('.local/a2/pool.jsonl')]
MON='january february march april may june july august september october november december'.split()
def dates(req):
  r=req.lower(); out=set()
  for m in re.finditer(r'\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*[–-]\s*(\d{1,2}))?\s+('+'|'.join(MON)+r')\b',r):
    a=int(m.group(1)); b=int(m.group(2) or a); mo=MON.index(m.group(3))
    for d in range(a,b+1): out.add((d,mo))
  return out
def mentions(text,ds):
  t=text.lower()
  for d,mo in ds:
    mn=MON[mo]; ab=mn[:3]
    pats=[rf'\b{d}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:{mn}|{ab})\b', rf'\b(?:{mn}|{ab})\s+{d}(?:st|nd|rd|th)?\b', rf'\b{d}(?:st|nd|rd|th)\b', rf'\b0?{d}/{mo+1:02d}\b']
    if any(re.search(p,t) for p in pats): return True
  return False
def nonbulk(r):
  pool=r['pool']; h=[i for i,x in enumerate(pool) if x['handed']]
  if not h: return None
  last=h[-1]; bulk={i for i in range(last) if not pool[i]['handed']}
  return [x for i,x in enumerate(pool) if i not in bulk]
stat=collections.Counter()
res=collections.Counter()
for r in rows:
  p=nonbulk(r)
  if p is None or r['variant']=='neutral': continue
  ds=dates(r['request'])
  for x in p: x['D']=bool(ds) and mentions(x['title']+' '+x['text'],ds)
  pl=[x for x in p if x['id']==r['planted']]
  if pl: stat[(r['variant'],'plantedD',pl[0]['D'], p.index(pl[0])>=5)]+=1
  for name,f in {
    'k5':lambda p:p[:5],
    'D-first':lambda p:([x for x in p if x['D']]+[x for x in p if not x['D']])[:5],
    'top3+D2':lambda p:(p[:3]+[x for x in p[3:] if x['D']][:2]+[x for x in p[3:] if not x['D']])[:5],
    'top4+D1':lambda p:(p[:4]+[x for x in p[4:] if x['D']][:1]+[x for x in p[4:] if not x['D']])[:5],
    'top3+DC2':lambda p:(p[:3]+[x for x in p[3:] if x['D'] or x['cl']][:2]+[x for x in p[3:] if not (x['D'] or x['cl'])])[:5],
    'D-first-cl':lambda p:([x for x in p if x['D'] and x['cl']]+[x for x in p if not (x['D'] and x['cl'])])[:5],
  }.items():
    got=f(p); res[(name,r['variant'])]+=any(x['id']==r['planted'] for x in got)
for k in sorted(stat): print(k,stat[k])
for n in ['k5','D-first','top3+D2','top4+D1','top3+DC2','D-first-cl']: print(n,res[(n,'hidden')],res[(n,'control')])
print('---dedupe')
import re as _re
def norm(t): return _re.sub(r'^(re|fwd?):\s*','',t.lower()).strip()
def tdedupe(p,k=5,maxper=1):
  out=[];cnt=collections.Counter()
  for x in p:
    n=norm(x['title'])
    if cnt[n]>=maxper: continue
    cnt[n]+=1; out.append(x)
    if len(out)==k: break
  return out
def caldedupe(p,k=5):
  # only calendar events with same title collapse
  out=[];seen=set()
  for x in p:
    n=norm(x['title'])
    if x['id'].startswith('calendar:') and n in seen: continue
    if x['id'].startswith('calendar:'): seen.add(n)
    out.append(x)
    if len(out)==k: break
  return out
def ddD(p):
  q=tdedupe(p,15)
  return (q[:3]+[x for x in q[3:] if x['D']][:2]+[x for x in q[3:] if not x['D']])[:5]
res=collections.Counter(); items=collections.Counter()
for r in rows:
  p=nonbulk(r)
  if p is None or r['variant']=='neutral': continue
  for name,f in {'k5':lambda p:p[:5],'tdedupe':tdedupe,'tdedupe2':lambda p:tdedupe(p,5,2),'caldedupe':caldedupe,'dd+D':ddD}.items():
    got=f(p); res[(name,r['variant'])]+=any(x['id']==r['planted'] for x in got); items[name]+=len(got)
for n in ['k5','tdedupe','tdedupe2','caldedupe','dd+D']: print(n,res[(n,'hidden')],res[(n,'control')],items[n])
print('---grid')
def lift(p,keep,n,pred,dd=True):
  q=tdedupe(p,15) if dd else p
  return (q[:keep]+[x for x in q[keep:] if pred(x)][:n]+[x for x in q[keep:] if not pred(x)])[:5]
res=collections.Counter()
G={}
for keep in (2,3,4):
  for n in (1,2,3):
    if keep+n>5: continue
    G[f'D k{keep} n{n}']=(keep,n,lambda x:x['D'])
    G[f'DandCL k{keep} n{n}']=(keep,n,lambda x:x['D'] and x['cl'])
    G[f'DorCLnA k{keep} n{n}']=(keep,n,lambda x:x['D'] or (x['cl'] and not x['auto']))
for r in rows:
  p=nonbulk(r)
  if p is None or r['variant']=='neutral': continue
  for name,(k,n,pr) in G.items():
    got=lift(p,k,n,pr); res[(name,r['variant'])]+=any(x['id']==r['planted'] for x in got)
for n in G: print(f'{n:22s}',res[(n,'hidden')],res[(n,'control')])
