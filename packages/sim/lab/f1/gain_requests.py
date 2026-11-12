# Encoder top-k (with tau) reach on tasks whose planted item is NOT in the push pool's first 15 (what the check reads).
import json,sys,re,collections,numpy as np
S=json.load(open('.local/f1/screen.json')); idx={s:i for i,s in enumerate(S['strs'])}; req=S['req']
name=sys.argv[1]; E=np.load(f'.local/f1/emb-{name}.npy')
lang={}
src=open('packages/sim/src/lab/reworded.ts').read()
for m in re.finditer(r'"([a-z0-9-]+)": \{\s*re:[^\n]*\n\s*to:[^\n]*\n(\s*lang: "(\w+)")?',src): lang[m.group(1)]=m.group(3) or 'en'
head={}
for s in ['train','reworded','longtail']:
    for l in open(f'.local/f1/pool-{s}.jsonl'):
        r=json.loads(l); ids=[p['id'] for p in r['pool']]
        head[(r['suite'],r['seed'],r['variant'],r['template'])]=(r['planted'] in ids[:15], len(ids))
KS=[int(x) for x in sys.argv[2].split(',')]; TAUS=[float(x) for x in sys.argv[3].split(',')]
st=collections.defaultdict(collections.Counter)
for w in S['worlds']:
    hs=list(dict.fromkeys(h for h in w['hashes'] if h in req))
    if not hs: continue
    R=[E[[idx[r] for r in req[h][0]]] for h in hs]
    for t in w['tasks']:
        s=w['suite']; g='longtail' if s=='longtail' else ('rw-'+('en' if lang.get(t['template'],'en')=='en' else 'xx') if s.endswith('r') else 'train')
        key=(g,w['variant']); c=st[key]; c['n']+=1
        k=(s,w['seed'],w['variant'],t['template']); inh,plen=head.get(k,(False,0))
        c['inhead']+=inh; c['poolsz']+=min(plen,15)
        q=E[idx[t['request']]]; sims=np.array([float((r@q).max()) for r in R]); order=np.argsort(-sims)
        p=t['planted']; pi=hs.index(p) if p in hs else -1
        for kk in KS:
            for tau in TAUS:
                top=[i for i in order[:kk] if sims[i]>=tau]
                a=f'k{kk}t{tau}'
                c[a+' gain']+= (pi in top) and not inh
                c[a+' items']+=len(top)
for key in sorted(st):
    c=st[key]; print(key,'n',c['n'],'inhead',c['inhead'],'meanpool %.1f'%(c['poolsz']/c['n']),' '.join(f"{a[:-5]}:{c[a]}/{c[a[:-5]+' items']/c['n']:.1f}" for a in c if a.endswith('gain')))
