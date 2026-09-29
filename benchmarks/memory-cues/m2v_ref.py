import json, sys
from model2vec import StaticModel
texts = [l.rstrip("\n").split("|")[4] for l in open("fixture/memories.psv") if l.strip() and not l.startswith("#")]
texts += [l.rstrip("\n").split("|")[3] for l in open("fixture/cues-hand.psv") if l.strip() and not l.startswith("#")]
texts += ["Café naïve résumé — ÜBER straße 東京 test", "ERR_REQUIRE_ESM @acme/cli ~/.acme/config.json pk_test_ x-request-id", "a"*150, ""]
out = {"texts": texts}
for name, d in [("base8m","models/hf/models--minishlab--potion-base-8M/snapshots/bf8b056651a2c21b8d2565580b8569da283cab23"),("ret32m","models/hf/models--minishlab--potion-retrieval-32M/snapshots/6fc8051fab2a1e0ee76689cf08c853792ac285e7")]:
    m = StaticModel.from_pretrained(d)
    out[name] = {"emb": m.encode(texts).tolist(), "ids": [m.tokenize([t])[0] for t in texts]}
json.dump(out, open("m2v_ref.json","w"))
print(len(texts))
