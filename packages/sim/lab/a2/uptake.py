# A2: per arm, hidden tasks by where the planted item reached the agent (packet, ask only, neither) and how many
# were graded raised. usage: python3 uptake.py STEM [STEM ...]   (STEM.json and STEM.tl/tasks.jsonl of pi-ab)
import json,sys,collections
# per arm, kind: planted in packet, in ask, raised|packet, raised|ask-only, raised|neither
for stem in sys.argv[1:]:
  res=json.load(open(stem+'.json'))
  R={(r['task'],r['condition']):r for r in res['results']}
  T={}
  for l in open(stem+'.tl/tasks.jsonl'):
    t=json.loads(l); T[(t['task'],t['condition'])]=t
  c=collections.defaultdict(collections.Counter)
  for k,r in R.items():
    t=T.get(k); 
    if not t or 'planted' not in t: continue
    kind=t['kind']
    if kind!='hidden': continue
    pk=t['planted'] in (t.get('cited') or []); ak=t['planted'] in (t.get('askCited') or [])
    raised=any(r.get('facts',{}).values())
    w='packet' if pk else ('ask' if ak else 'none')
    c[k[1]][w]+=1; c[k[1]][w+'+raised']+=raised
  for arm,v in sorted(c.items()):
    print(stem.split('/')[-1],arm, ' '.join(f"{w} {v[w+'+raised']}/{v[w]}" for w in ['packet','ask','none']))
