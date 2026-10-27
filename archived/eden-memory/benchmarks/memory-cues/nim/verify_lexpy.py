import json
from lexpy import BM25F, toks, ctx_cue
mems=json.load(open("fixture/memories.json")); cues=json.load(open("fixture/cues.json"))
live=[m for m in mems if not m["superseded_by"]]
ft=json.load(open("../cues/out/features-ts.json")); ctx=json.load(open("../cues/out/ctx.json"))
bm=BM25F(live); idx={m["id"]:i for i,m in enumerate(live)}
mx=0; bad=0
for c in cues:
    assert ctx_cue(c["cue"],c["last_paths"],c["prev_turn"])==ctx[c["id"]], c["id"]
    for tag,text in [("",c["cue"]),("_ctx",ctx[c["id"]])]:
        q=toks(text); r=ft[c["id"]]
        for d,v in zip(r["docs"], r["f"]["bm25"+tag]):
            e=abs(bm.score(q,idx[d])-v); mx=max(mx,e); bad+=e>1e-9
print("max abs diff", mx, "bad", bad)
