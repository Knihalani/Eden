# CL8 $0 screen: in each hidden task's candidates packet (hidden-funnel --packets), the share of the task's detail
# words (also in the planted item) that the planted item's line holds. usage: python3 -I keep.py PACKETS.jsonl ...
import json,sys,re
TOKEN = r"[a-z0-9£$€][a-z0-9'.£$€-]*"
W=lambda t:set(w for w in re.findall(TOKEN,t.lower()) if len(w)>3 or any(c.isdigit() for c in w))
for f in sys.argv[1:]:
    n=0; share=0; full=0; lb=0
    for l in open(f):
        d=json.loads(l)
        if d['variant']!='hidden': continue
        # the planted item's line in a candidates packet
        line=None
        for p in d['packets']:
            if p['reason'].startswith('candidates') and d['planted'] in p['ids']:
                k=p['ids'].index(d['planted']); items=[x for x in p['text'].split('\n') if x.startswith('- [')]
                if k < len(items): line=items[k]
        if not line: continue
        det=W(d['detail'])&W(d['plantedText'])
        if not det: continue
        n+=1; s=len(det&W(line))/len(det); share+=s; full+= s>=0.999; lb+=len(line.encode())
    print(f.split('/')[-1], 'n',n,'mean share of detail words',round(share/n,3),'all words',full,
          'mean line B',round(lb/n))
