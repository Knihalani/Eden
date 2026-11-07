# Encodes each world's items and requests (hidden-funnel --corpus-dump) with a small local model, for run_screen.py.
# usage: VENV/python embed.py CORPUS.jsonl OUT_DIR [MODEL]
import json, sys, os
import numpy as np
from sentence_transformers import SentenceTransformer
corpus, out = sys.argv[1], sys.argv[2]
m = SentenceTransformer(sys.argv[3] if len(sys.argv) > 3 else 'sentence-transformers/all-MiniLM-L6-v2', device='cpu')
os.makedirs(out, exist_ok=True)
cache = {}
for line in open(corpus):
    w = json.loads(line)
    if w['variant'] not in ('hidden', 'control'):
        continue
    texts = [f"{x['title']}. {x['text'][:500]}" for x in w['items']]
    todo = [t for t in set(texts) if t not in cache]
    if todo:
        for t, e in zip(todo, m.encode(todo, batch_size=64, normalize_embeddings=True)):
            cache[t] = e
    E = np.stack([cache[t] for t in texts])
    Q = m.encode([t['request'] for t in w['tasks']], normalize_embeddings=True)
    np.savez(f"{out}/{w['suite']}-{w['seed']}-{w['variant']}.npz", E=E, Q=Q)
    print(w['suite'], w['seed'], w['variant'], flush=True)
