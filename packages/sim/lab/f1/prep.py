# Build .local/f1/screen.json: per world, items with shipped requests (f3 preferred) and card kind; tasks.
import json,subprocess
items={}
for l in open('.local/f1/x/items.jsonl'):
    o=json.loads(l); items[o['h']]=o
ship={};ship3={}
for l in open('.local/f1/shipped.jsonl'):
    o=json.loads(l)
    if 'r' not in o and 'c' not in o: continue
    (ship3 if o['h'].endswith(':f3') else ship)[o['h'].split(':')[0]]=o
worlds=[json.loads(l) for l in open('.local/f1/x/worlds.jsonl')]
req={}  # h -> (requests, kind)
for h in items:
    o=ship3.get(h) or ship.get(h)
    if o and o.get('r'): req[h]=(o['r'],(o.get('c') or {}).get('kind','none') if o.get('c') else None)
strs=sorted({r for rs,_ in req.values() for r in rs}|{t['request'] for w in worlds for t in w['tasks']})
terms=json.loads(subprocess.run(['bun','.local/f1/terms.ts'],input=json.dumps(strs),capture_output=True,text=True,check=True).stdout)
json.dump({'strs':strs,'terms':terms,'req':req,'worlds':[{k:w[k] for k in ['suite','seed','variant','hashes','tasks']} for w in worlds]},open('.local/f1/screen.json','w'))
print(len(strs),'strings',len(req),'items with requests', sum(1 for h in items if h in ship3),'f3')
