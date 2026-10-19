"""C11-E8 post hoc: recall and firing of the wide Jev check at other thresholds and pick caps."""
import json,sys
sys.path.insert(0,'.')
from recall_funnel import Generators
for w in ('code','life'):
    g=Generators(w); out=json.load(open(f'dream/{w}/wide/out.json'))
    for thr,top in ((0.7,4),(0.7,8),(0.7,999),(0.5,4),(0.5,8)):
        tot=hit=fn=0; npk=[]
        for r in out.values():
            sc={i:p for i,p in r['scores'].items() if p is not None}
            pk=sorted((i for i in sc if sc[i]>=thr),key=lambda i:(-sc[i],i))[:top]
            npk.append(len(pk)); fn+= (not r['need']) and bool(pk)
            for it in r['need']:
                cov=[i for i in r['pool'] if it in g.by_id[i]['covers']]
                if cov: tot+=1; hit+=any(i in pk for i in cov)
        print(w,f'p>={thr} top{top}: recall {hit}/{tot} = {hit/tot:.3f}, no-need turns firing {fn}, mean picks {sum(npk)/len(npk):.2f}')
