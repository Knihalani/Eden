# M5 (docs/research/m5-nudge-narrow.md): the $0 trigger screen. Per task of a funnel --pool-dump (hidden-funnel.ts,
# its rows carry the nudge's unsettled flag and each pool item's anchored flag), how often each candidate trigger
# fires and where the planted item sits (handed, deep: 6th-15th, notpool). usage: python3 -I screen.py POOL.jsonl
import json,sys,collections
tt=set(open('packages/sim/lab/a2/targeted-templates.txt').read().strip().split(','))
rows=[json.loads(l) for l in open(sys.argv[1])]
def pos(r):
    a=r['at']
    if not r['pool']: return 'nopush'
    if a<0: return 'notpool'
    return 'handed' if r['pool'][a]['handed'] else ('deep' if a>=5 else 'cut')
def deep(r): return [x for x in r['pool'] if not x['handed']]
T={
 'current': lambda r: r.get('unsettled') is True,
 'deepAnch': lambda r: r.get('unsettled') is True and any(x.get('anchored') and not x['auto'] for x in deep(r)),
 'deepAnchCl': lambda r: r.get('unsettled') is True and any(x.get('anchored') and x['cl'] and not x['auto'] for x in deep(r)),
 'deepCl': lambda r: r.get('unsettled') is True and any(x['cl'] and not x['auto'] for x in deep(r)),
 'day': lambda r: r.get('unsettled') is True and r.get('anchorKinds',{}).get('day'),
 'noDay': lambda r: r.get('unsettled') is True and not r.get('anchorKinds',{}).get('day'),
}
print('trigger    | hidden fires (handed/deep/cut/notpool) [deep planted anchored] | targeted fires | control fires | targ ctl')
for n,f in T.items():
    c=collections.Counter(); pa=0; tg=0; ctl=0; tctl=0
    for r in rows:
        if not f(r): continue
        t=r['template'] in tt
        if r['variant']=='hidden':
            p=pos(r); c[p]+=1; tg+=t
            if p=='deep' and r['pool'][r['at']].get('anchored'): pa+=1
        else: ctl+=1; tctl+=t
    print(f"{n:10} | {sum(c.values()):3} ({c['handed']}/{c['deep']}/{c['cut']}/{c['notpool']}) [{pa}] | {tg} | {ctl} | {tctl}")
# The current trigger's fires by template group: where the planted item sits, targeted (A12's 91) against the rest.
print("\ncurrent trigger, hidden fires by planted place: targeted | other")
for p in ("handed", "deep", "notpool"):
    n = [sum(1 for r in rows if r["variant"] == "hidden" and r.get("unsettled") is True and pos(r) == p
             and (r["template"] in tt) == t) for t in (True, False)]
    print(f"  {p:8} {n[0]:4} | {n[1]:4}")
