"""M11: where the generation head ranks the bridge terms each validation fact needs (Haiku's request terms the item
lacks that the task's request holds). python3 -I bridges.py NET.pt"""
import argparse, sys, os
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D, copygen as C  # noqa: E402

ck = torch.load(sys.argv[1], weights_only=False)
a = argparse.Namespace(**ck["args"])
vocab = ck["vocab"]
vid = {t: i for i, t in enumerate(vocab)}
m = C.Net(a, len(vocab))
m.load_state_dict(ck["state"])
m.eval()
items, worlds = D.load()
ranks, tot = [], 0
for w in worlds:
    if w["variant"] != "hidden" or w["suite"] not in D.VAL_SUITES or w["seed"] not in D.SCREEN_SEEDS:
        continue
    for t in w["tasks"]:
        it = items.get(t["planted"])
        if not it or not it.get("fullTerms"):
            continue
        need = {x for r in it["fullTerms"] for x in r} - set(it["terms"]) & set(t["terms"])
        if not need:
            continue
        x, _ = C.batch([{"text": D.item_text(it), "terms": it["terms"], "title": it.get("titleTerms") or [], "tw": None}], a)
        with torch.no_grad():
            g, _ = m(*x)
        pos = {i: r for r, i in enumerate(torch.argsort(g[0], descending=True).tolist())}
        for n in need:
            tot += 1
            if n in vid:
                ranks.append(pos[vid[n]])
print(f"needed {tot}, in vocab {len(ranks)}; in top 5/10/20/50: " + "/".join(str(sum(r < k for r in ranks)) for k in (5, 10, 20, 50)))
