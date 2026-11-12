import json,glob,collections,ast
T={t['id']:t for t in json.load(open('templates.json'))}
R={};TL={}
for f in glob.glob('runs/ps-*.json'):
    d=json.load(open(f))
    for r in d['results']: R[(r['task'],r['condition'])]=r
for f in glob.glob('runs/ps-*.tl/tasks.jsonl'):
    for l in open(f):
        t=json.loads(l); TL[(t['task'],t['condition'])]=t
def parse(t):
    w,suite,tmpl=t.split(':'); v='hidden' if suite=='heldout19' else suite.split('-')[1]
    return int(w[1:]),v,tmpl
rows=[]
for (task,cond),r in R.items():
    s,v,tm=parse(task); tl=TL.get((task,cond),{})
    p=tl.get('planted'); cited=tl.get('cited') or []; ac=tl.get('askCited') or []
    if isinstance(cited,str): cited=ast.literal_eval(cited)
    if isinstance(ac,str): ac=ast.literal_eval(ac)
    rows.append(dict(seed=s,v=v,t=tm,cond=cond,flag=any(r['facts'].values()),pushed=p in cited,asked=p in ac,
      tools=r['toolCalls'],eden=r['edenCostUsd'],wall=r['wallMs'],inj=r['injectedItems'],ans=r['answer']))
json.dump(rows,open('live-rows.json','w'))
def rate(xs,f): return f'{sum(map(f,xs))}/{len(xs)} ({sum(map(f,xs))/max(1,len(xs)):.0%})'
for cond in ['tools','both+ask']:
    for v in ['hidden','control','neutral']:
        xs=[r for r in rows if r['cond']==cond and r['v']==v]
        print(cond,v,'flag/raised',rate(xs,lambda r:r['flag']))
E=[r for r in rows if r['cond']=='both+ask' and r['v']=='hidden']
To={(r['seed'],r['t']):r['flag'] for r in rows if r['cond']=='tools' and r['v']=='hidden'}
def st(r):
    if r['flag']: return 'raised'
    if r['pushed'] or r['asked']: return 'reached agent, not raised'
    return 'never reached agent'
print('\nEden hidden outcome:',collections.Counter(map(st,E)))
print('raised | pushed:',rate([r for r in E if r['pushed']],lambda r:r['flag']),' raised | asked only:',rate([r for r in E if r['asked'] and not r['pushed']],lambda r:r['flag']),' raised | neither:',rate([r for r in E if not(r['pushed'] or r['asked'])],lambda r:r['flag']))
def split(key,f=None):
    f=f or (lambda t:t[key]); g=collections.defaultdict(list)
    for r in E: g[f(T[r['t']])].append(r)
    print(f'\n== {key}  (Eden raised | agent-alone raised | reached agent | reached-but-not-raised)')
    for k in sorted(g,key=str):
        xs=g[k];n=len(xs)
        print(f"  {str(k):24} n={n:3} eden {sum(r['flag'] for r in xs)/n:4.0%}  alone {sum(To[(r['seed'],r['t'])] for r in xs)/n:4.0%}  reached {sum(r['pushed'] or r['asked'] for r in xs)/n:4.0%}  reachedNotRaised {sum((r['pushed'] or r['asked']) and not r['flag'] for r in xs)/n:4.0%}")
for k in ['phrasing','overlap','decoy','area','source','anchored','silent','rare']: split(k)
split('nonEnglish',lambda t:t['lang']!='English')
