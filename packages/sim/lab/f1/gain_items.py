# Encoder (item text) top-k added to the push check's view: facts and look-alikes newly in view, items added on neutral.
import json,sys,collections,numpy as np
xdir,name,pools=sys.argv[1],sys.argv[2],sys.argv[3].split(',')
z=np.load(f'{xdir}/emb-{name}.npz',allow_pickle=True); I,Q=z['I'],z['Q']; hidx={h:i for i,h in enumerate(z['h'])}; ridx={r:i for i,r in enumerate(z['r'])}
items={json.loads(l)['h']:None for l in open(f'{xdir}/items.jsonl')}
head={}
for f in pools:
    for l in open(f):
        r=json.loads(l); head[(r['suite'],r['seed'],r['variant'],r['template'])]=(r['planted'] in [p['id'] for p in r['pool'][:15]], set(p['id'] for p in r['pool'][:15]))
KS=[int(x) for x in sys.argv[4].split(',')]; TAU=[float(x) for x in sys.argv[5].split(',')]
st=collections.defaultdict(collections.Counter)
for l in open(f'{xdir}/worlds.jsonl'):
    w=json.loads(l); hs=[h for h in dict.fromkeys(w['hashes'])]; M=I[[hidx[h] for h in hs]]
    for t in w['tasks']:
        k=(w['suite'],w['seed'],w['variant'],t['template'])
        if k not in head: continue
        inh,_=head[k]; c=st[w['variant']]; c['n']+=1; c['inhead']+=inh
        sims=M@Q[ridx[t['request']]]; order=np.argsort(-sims)
        p=t['planted']; pi=hs.index(p) if p in hs else -1
        for kk in KS:
            for tau in TAU:
                top=[i for i in order[:kk] if sims[i]>=tau]; a=f'k{kk}t{tau}'
                c[a]+= (pi in top) and not inh; c[a+'#']+=len(top)
for v in ['hidden','control','neutral']:
    c=st[v]; print(v,'n',c['n'],'in view',c['inhead'],' '.join(f"{a}:+{c[a]}({c[a+'#']/max(1,c['n']):.1f}/task)" for a in c if a.startswith('k') and not a.endswith('#')))
