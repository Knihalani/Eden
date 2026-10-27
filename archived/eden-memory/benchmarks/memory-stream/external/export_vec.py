import glob, json, re, sys
import numpy as np, spacy
root = "/home/user/Eden/benchmarks/memory-stream"
tok = re.compile(r"[A-Za-z][A-Za-z'-]+")
vocab = set()
for p in glob.glob(root + "/worlds/*/stream.json"):
    if "locomo" in p: continue
    s = json.load(open(p))
    for ss in s["sessions"]:
        for e in ss["events"]:
            vocab |= {w.lower() for w in tok.findall(e.get("text_all", ""))}
for p in glob.glob(root + "/sleep/*/out/*.json") + glob.glob(root + "/selfplay/*/out/*.json"):
    vocab |= {w.lower() for w in tok.findall(open(p).read())}
nlp = spacy.load("en_core_web_md", exclude=["parser", "ner", "tagger", "lemmatizer", "attribute_ruler", "senter", "tok2vec"])
words, vecs = [], []
for w in sorted(vocab):
    lex = nlp.vocab[w]
    if lex.has_vector:
        words.append(w); vecs.append(lex.vector)
np.savez_compressed(sys.argv[1], words=np.array(words), vecs=np.array(vecs, dtype=np.float32))
print(len(vocab), "vocab", len(words), "with vectors")
