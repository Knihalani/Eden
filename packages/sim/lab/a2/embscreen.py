# A2 $0 screen (docs/research/a2-quality.md section 4): a local embedding model ranks every world item against each
# request (hidden-funnel --corpus-dump); where planted (hidden) and decoy (control) items land, against the push's pool
# (pushPoolAt in the funnel JSON).
# usage: python3 embscreen.py CORPUS.jsonl FUNNEL.json MODEL OUT.json   (sentence-transformers on CPU)
import json, sys, time, collections
import numpy as np
from sentence_transformers import SentenceTransformer
corpus, funnel, model_name = sys.argv[1], sys.argv[2], sys.argv[3]
m = SentenceTransformer(model_name, device="cpu")
pt = {(t['suite'], t['seed'], t['template'], t['variant']): t for t in json.load(open(funnel))['perTask']}
res = collections.Counter(); t0 = time.time(); rows = []
for line in open(corpus):
    w = json.loads(line)
    texts = [f"{x['title']}. {x['text'][:500]}" for x in w['items']]
    E = m.encode(texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    Q = m.encode([t['request'] for t in w['tasks']], normalize_embeddings=True, show_progress_bar=False)
    ids = [x['id'] for x in w['items']]
    for t, q in zip(w['tasks'], Q):
        k = (w['suite'], w['seed'], t['template'], w['variant'])
        f = pt.get(k)
        if not f or not t['planted'] or t['planted'] not in ids: continue
        sims = E @ q
        rank = int((sims > sims[ids.index(t['planted'])]).sum())
        surfaced = f['delivered'] or f.get('askCited', False)
        pool = f.get('pushPoolAt', -1)
        rows.append(dict(k=k, rank=rank, pool=pool, surfaced=surfaced, top=[ids[j] for j in np.argsort(-sims)[:5]], handed=f.get('pushHanded', False)))
for v in ['hidden', 'control']:
    R = [r for r in rows if r['k'][3] == v]
    print(v, 'n', len(R))
    for K in (5, 15, 30):
        print(f'  embed top{K}', sum(r['rank'] < K for r in R))
    print('  push pool (15)', sum(r['pool'] >= 0 for r in R), ' push top5 (pool<5)', sum(0 <= r['pool'] < 5 for r in R))
    miss = [r for r in R if not r['surfaced']]
    print('  never surfaced', len(miss), '| of them embed top5', sum(r['rank'] < 5 for r in miss),
          'top15', sum(r['rank'] < 15 for r in miss))
    nopool = [r for r in R if r['pool'] < 0]
    print('  not in push pool', len(nopool), '| embed top5', sum(r['rank'] < 5 for r in nopool),
          'top15', sum(r['rank'] < 15 for r in nopool))
print('secs', round(time.time() - t0))
json.dump([dict(r, k=list(r['k'])) for r in rows], open(sys.argv[4], 'w'))
