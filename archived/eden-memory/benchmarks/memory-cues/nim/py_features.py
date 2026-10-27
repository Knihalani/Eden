# M5 (bge-small-en-v1.5, all-MiniLM-L6-v2) cosines and M8 cross-encoder (ms-marco-MiniLM-L6-v2) scores. Output out/features-py.json
import json, time, torch, os
SFX = os.environ.get("OUT_SFX", "")
from sentence_transformers import SentenceTransformer, CrossEncoder
H = "models/hf/models--"
mems = [m for m in json.load(open("fixture/memories.json")) if not m["superseded_by"]]
cues = json.load(open(os.environ.get("CUES", "fixture/cues.json"))); ctx = json.load(open(f"out/ctx{SFX}.json"))
docs = [f'{m["subject"]}: {m["text"]}' for m in mems]; ids = [m["id"] for m in mems]
def vis(scope): return [i for i, m in enumerate(mems) if m["scope"] in ("", scope)]
out = {c["id"]: {"docs": [ids[i] for i in vis(c["scope"])], "f": {}} for c in cues}
import glob
def snap(name): return glob.glob(H + name + "/snapshots/*")[0]
for tag, name, qp in [("bge", "BAAI--bge-small-en-v1.5", "Represent this sentence for searching relevant passages: "), ("mini", "sentence-transformers--all-MiniLM-L6-v2", "")]:
    m = SentenceTransformer(snap(name), device="cpu")
    D = m.encode(docs, normalize_embeddings=True, convert_to_tensor=True)
    for suf, texts in [("", [c["cue"] for c in cues]), ("_ctx", [ctx[c["id"]] for c in cues])]:
        Q = m.encode([qp + t for t in texts], normalize_embeddings=True, convert_to_tensor=True)
        S = (Q @ D.T).tolist()
        for ci, c in enumerate(cues): out[c["id"]]["f"][f"cos_{tag}{suf}"] = [S[ci][i] for i in vis(c["scope"])]
    print(tag, "done", flush=True)
ce = CrossEncoder(snap("cross-encoder--ms-marco-MiniLM-L6-v2"), device="cpu")
for suf, texts in [("", [c["cue"] for c in cues]), ("_ctx", [ctx[c["id"]] for c in cues])]:
    pairs, where = [], []
    for ci, c in enumerate(cues):
        for i in vis(c["scope"]): pairs.append((texts[ci], docs[i])); where.append(ci)
    t = time.time(); sc = ce.predict(pairs, batch_size=256).tolist(); print("ce pairs", len(pairs), time.time() - t, flush=True)
    k = 0
    for ci, c in enumerate(cues):
        n = len(vis(c["scope"])); out[c["id"]]["f"]["ce" + suf] = sc[k:k + n]; k += n
json.dump(out, open(f"out/features-py{SFX}.json", "w"))
