# A2 (docs/research/a2-quality.md), $0: re-rank rules simulated on the push's pool dump (hidden-funnel --pool-dump
# .local/a2/pool.jsonl, train seeds 41-42): planted (hidden) and decoy (control) in the first five handed.
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
def base(pool,k=5): return [x for x in pool if x['handed']] if k==5 else None
def elig(pool): return [x for x in pool if x['handed'] or True]
# The handed set is the first five non-bulk items: items before the last handed one that were not handed are taken
# as bulk mail and left out of every rule's pool (an approximation).
def nonbulk(r):
  pool=r['pool']; h=[i for i,x in enumerate(pool) if x['handed']]
  if not h: return None
  last=h[-1]; bulk={i for i in range(last) if not pool[i]['handed']}
  return [x for i,x in enumerate(pool) if i not in bulk]
rules={}
rules['k5']=lambda p:p[:5]
for k in (6,7,8,10): rules[f'k{k}']=(lambda k: lambda p:p[:k])(k)
def plus_cl(n,extra):
  def f(p):
    out=p[:n]; rest=[x for x in p[n:] if x['cl']]
    return out+rest[:extra]
  return f
for n,e in [(5,1),(5,2),(5,3),(4,1),(4,2),(3,2),(5,5),(3,3)]: rules[f'top{n}+cl{e}']=plus_cl(n,e)
def clfirst(p):
  return ([x for x in p if x['cl']]+[x for x in p if not x['cl']])[:5]
rules['clfirst5']=clfirst
def nonauto_cl(n,e):
  def f(p):
    out=p[:n]; rest=[x for x in p[n:] if x['cl'] and not x['auto']]
    return out+rest[:e]
  return f
rules['top5+clNA2']=nonauto_cl(5,2); rules['top4+clNA1']=nonauto_cl(4,1); rules['top5+clNA3']=nonauto_cl(5,3)
def carded(n,e):
  def f(p):
    out=p[:n]; rest=[x for x in p[n:] if x.get('card')]
    return out+rest[:e]
  return f
rules['top5+card2']=carded(5,2); rules['top4+card1']=carded(4,1); rules['top3+card2']=carded(3,2)
for name,f in rules.items():
  H=C=items=0
  for r in rows:
    p=nonbulk(r)
    if p is None: continue
    got=f(p); items+=len(got)
    hit=any(x['id']==r['planted'] for x in got)
    if r['variant']=='hidden': H+=hit
    elif r['variant']=='control': C+=hit
  print(f'{name:14s} planted {H:4d}  decoy {C:4d}  items/task {items/len(rows):.2f}')
