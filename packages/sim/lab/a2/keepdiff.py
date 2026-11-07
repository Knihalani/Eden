# A2: per hidden task, the share of the detail words the planted item's candidate line keeps, run A against run B
# (hidden-funnel --packets files), listing the tasks that moved. usage: python3 keepdiff.py A.jsonl B.jsonl [show]
import json,re,sys
TOKEN = r"[a-z0-9£$€][a-z0-9'.£$€-]*"
W=lambda t:set(w for w in re.findall(TOKEN,t.lower()) if len(w)>3 or any(c.isdigit() for c in w))
def load(f):
  out={}
  for l in open(f):
    d=json.loads(l)
    if d['variant']!='hidden': continue
    for p in d['packets']:
      if p['reason'].startswith('candidates') and d['planted'] in p['ids']:
        k=p['ids'].index(d['planted']); items=[x for x in p['text'].split('\n') if x.startswith('- [')]
        line=items[k] if k<len(items) else ''
        det=W(d['detail'])&W(d['plantedText'])
        if det: out[(d['suite'],d['seed'],d['template'])]=(len(det&W(line))/len(det),line,d['detail'])
  return out
a=load(sys.argv[1]); b=load(sys.argv[2])
up=dn=0
for k in a:
  if k in b and abs(a[k][0]-b[k][0])>0.01:
    if b[k][0]>a[k][0]: up+=1
    else: dn+=1
    print(round(a[k][0],2),'->',round(b[k][0],2),k[2])
    if len(sys.argv)>3: print('  A',a[k][1][:300],'\n  B',b[k][1][:300])
print('up',up,'down',dn)
