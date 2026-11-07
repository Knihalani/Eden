# CL8 $0 screen: packet and ask bytes, items, planted delivered and ask-cited per variant, from a funnel --json
# (perTask, and the neutral block). usage: python3 -I bytes.py RUN.json ...
import json,sys
for f in sys.argv[1:]:
    d=json.load(open(f))
    rows={"hidden":[], "control":[]}
    for r in d.get("perTask",[]): rows.setdefault(r["variant"],[]).append(r)
    rows["neutral"]=d.get("neutral",{}).get("perTask",[])
    out=[]
    for v,rs in rows.items():
        if not rs: continue
        n=len(rs); pb=sum(r.get("packetBytes",0) for r in rs)/n; ab=sum(r.get("askBytes",0) for r in rs)/n
        it=sum(r.get("injected",0) for r in rs)/n; ai=sum(r.get("askItems",0) for r in rs)/n
        dl=sum(1 for r in rs if r.get("delivered")); ac=sum(1 for r in rs if r.get("askCited"))
        out.append(f"{v} n{n} packetB {pb:.0f} items {it:.2f} askB {ab:.0f} askItems {ai:.2f} "
                   f"delivered {dl} askCited {ac}")
    print(f.split('/')[-1], " | ".join(out))
