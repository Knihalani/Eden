import json,glob,re,collections
P={p['id']:p for p in json.load(open('.local/f1/pilot/prompts.json'))['prompts']}
A={}
for f in glob.glob('.local/f1/pilot/ans-*.jsonl'):
    for l in open(f):
        try: o=json.loads(l)
        except Exception: continue
        A[str(o.get('id'))]=o.get('reply')
NOHIT=re.compile(r'^\s*(?:(?:none|n/a)(?![\w]).*|(?:nothing|no)?\s*\.?\s*)$',re.I|re.S)
def named(p,reply):
    out=set()
    if not isinstance(reply,dict): return None
    for e in reply.get('items',[]) or []:
        try:
            i=int(e.get('i'))-1; hits=str(e.get('hits','')); act=e.get('act') is True
        except Exception: continue
        if act and not NOHIT.match(hits) and 0<=i<len(p['ids']): out.add(p['ids'][i])
    return out
c=collections.Counter(); pair={}
for i,p in P.items():
    if i not in A: c['missing']+=1; continue
    n=named(p,A[i]); k=(p['variant'],p['arm'])
    if n is None: c['unreadable']+=1; continue
    c[k+('n',)]+=1; c[k+('planted',)]+= p['planted'] in n; c[k+('any',)]+= len(n)>0
    if p['variant']=='neutral': pair.setdefault((p['seed'],p['template']),{})[p['arm']]=len(n)>0
for k in sorted(c, key=str): print(k,c[k])
both=[v for v in pair.values() if len(v)==2]
print('neutral paired n',len(both),'base any',sum(v['base'] for v in both),'ext any',sum(v['ext'] for v in both),'ext-only',sum(v['ext'] and not v['base'] for v in both),'base-only',sum(v['base'] and not v['ext'] for v in both))
