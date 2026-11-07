import json,collections,sys
for f in sys.argv[1:]:
  agg=collections.defaultdict(lambda: collections.defaultdict(list))
  for l in open(f):
    t=json.loads(l); c=t['condition']; k=t['kind']
    ev=t['events']; op={}
    asks=[];fetch=[];reads=[];srch=[]
    for e in ev:
      if e['ph']=='B': op[e['id']]=e
      elif e['ph']=='E':
        b=op.get(e['id'])
        if not b: continue
        if b['ev']=='tool.ask_context': asks.append((b['t'],e['t']))
        d=(b.get('data') or {})
        if b['ev']=='eden.source' and d.get('op')=='fetch': fetch.append((b['t'],e['t']))
        if b['ev']=='eden.source' and d.get('op') in ('search','list'): srch.append((b['t'],e['t']))
        if b['ev']=='eden.reader': reads.append((b['t'],e['t']))
    for a0,a1 in asks:
      agg[(c,k)]['ask'].append(a1-a0)
      fs=[(f0,f1) for f0,f1 in fetch if f0>=a0-1 and f1<=a1+1]
      ss=[(f0,f1) for f0,f1 in srch if f0>=a0-1 and f1<=a1+1]
      rs=[r1-r0 for r0,r1 in reads if r0>=a0-1 and r1<=a1+1]
      agg[(c,k)]['fetchtail'].append(max([x[1] for x in fs])-a0 if fs else 0)
      agg[(c,k)]['srchtail'].append(max([x[1] for x in ss])-a0 if ss else 0)
      agg[(c,k)]['nfetch'].append(len(fs)); agg[(c,k)]['reader'].append(sum(rs))
      agg[(c,k)]['nofetch'].append(1 if not fs else 0)
    agg[(c,k)]['asks/task'].append(len(asks))
    agg[(c,k)]['fetch_total'].append(len(fetch))
  for c,d in sorted(agg.items()):
    print(f.split('/')[-2][:12],c,' '.join(f"{k}={sum(v)/max(1,len(v)):.2f}" for k,v in d.items()))
