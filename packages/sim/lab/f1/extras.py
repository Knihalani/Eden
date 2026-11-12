# Per task: the encoder's top-k item hashes (item text) for the request; written for the pilot's prompt builder.
import json,sys,numpy as np
xdir,name,k=sys.argv[1],sys.argv[2],int(sys.argv[3])
z=np.load(f'{xdir}/emb-{name}.npz',allow_pickle=True); I,Q=z['I'],z['Q']; hidx={h:i for i,h in enumerate(z['h'])}; ridx={r:i for i,r in enumerate(z['r'])}
out={}
for l in open(f'{xdir}/worlds.jsonl'):
    w=json.loads(l); hs=list(dict.fromkeys(w['hashes'])); M=I[[hidx[h] for h in hs]]
    for t in w['tasks']:
        s=M@Q[ridx[t['request']]]; o=np.argsort(-s)[:k]
        out[f"{w['suite']}|{w['seed']}|{w['variant']}|{t['template']}"]={'top':[hs[i] for i in o],'score':[round(float(s[i]),4) for i in o],'planted':t['planted']}
json.dump(out,open(f'{xdir}/extras-{name}-k{k}.json','w')); print(len(out))
