import json,collections
T={t['id']:t for t in json.load(open('templates.json'))}
rows={(r['seed'],r['template'],r['variant']):r for r in json.load(open('funnel.json'))['perTask']}
cand={};ask={}
for l in open('funnel-cand.jsonl'):
    o=json.loads(l); cand[(o['seed'],o['template'],o['variant'])]=o
for l in open('funnel-ask.jsonl'):
    o=json.loads(l); ask[(o['seed'],o['template'],o['variant'])]=o
def stage(k):
    r=rows[k];c=cand[k];a=ask[k];p=c['planted']
    incand=any(p in [x['id'] for x in d['candidates']] for d in c['dumps'])
    if not r['cached']: return 'A not indexed'
    if r['delivered'] or a['askCited']: return 'D reached agent'
    if incand or a['rank']>=0: return 'C retrieved, not chosen'
    return 'B indexed, never retrieved'
H=[k for k in rows if k[2]=='hidden']; C=[k for k in rows if k[2]=='control']
print('hidden stages:',collections.Counter(stage(k) for k in H))
print('control (decoy) reached agent:',sum(rows[k]['delivered'] or ask[k]['askCited'] for k in C),'/',len(C))
def split(key,f=lambda t,k:t[k]):
    g=collections.defaultdict(list)
    for k in H: g[f(T[k[1]],key)].append(stage(k))
    gd=collections.defaultdict(list)
    for k in C: gd[f(T[k[1]],key)].append(rows[k]['delivered'] or ask[k]['askCited'])
    print(f'\n== {key}')
    for v in sorted(g,key=str):
        s=g[v];n=len(s);cn=collections.Counter(s)
        print(f'  {str(v):22} n={n:3}  reached {cn["D reached agent"]/n:5.0%}  notIndexed {cn["A not indexed"]/n:4.0%}  neverRetrieved {cn["B indexed, never retrieved"]/n:4.0%}  retrievedNotChosen {cn["C retrieved, not chosen"]/n:4.0%} | decoy reached {sum(gd[v])/len(gd[v]):4.0%}')
for key in ['phrasing','lang','anchored','silent','rare','source','overlap','decoy','area','notice']: split(key)
split('nonEnglish',lambda t,k:t['lang']!='English')

print('\n== coverage of the planted item, by stage (hidden)')
g=collections.defaultdict(collections.Counter)
for k in H:
    cv=ask[k]['coverage']; s=stage(k)
    g[s]['n']+=1
    g[s]['carded']+= bool(cv.get('cardRead') and cv.get('cardKind'))
    g[s]['intent']+= bool(cv.get('intent'))
    g[s]['heldReq>0']+= (cv.get('heldRequests') or 0)>0
    g[s]['prefilterReject']+= bool(cv.get('notSentPrefilterRejects'))
for s,c in sorted(g.items()): print(' ',s,dict(c))
print('\nsample coverage objects:'); 
for k in H[:3]: print(ask[k]['coverage'])
