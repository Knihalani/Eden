# CL8 $0 screen: tasks with an item in two packets of the same request, from hidden-funnel --packets.
# usage: python3 -I dups.py PACKETS.jsonl ...
import json,sys,collections
for f in sys.argv[1:]:
    by=collections.defaultdict(lambda:[0,0,0,0,0,0])  # tasks, tasksWithDup, dupItems, packets, candTasks, leadBytes
    order=collections.Counter()
    for l in open(f):
        d=json.loads(l); v=d['variant']; s=by[v]; s[0]+=1
        seen=set(); dup=0
        ps=d['packets']; s[3]+=len(ps)
        for p in ps:
            for i in p['ids']:
                if i in seen: dup+=1
                seen.add(i)
        if dup: s[1]+=1
        s[2]+=dup
        reasons=[p['reason'].split(':')[0] for p in ps]
        if 'candidates' in reasons: s[4]+=1
        order[tuple(reasons)]+=1
    for v,s in by.items(): print(f, v, "tasks",s[0],"withDup",s[1],"dupItems",s[2],"packets",s[3],"candTasks",s[4])
    print(order.most_common(8))
