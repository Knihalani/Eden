"""Progress of live NIM calls in the last 5 minutes (from out/calls.jsonl)."""
import json, collections, time
L = [json.loads(l) for l in open("out/calls.jsonl")]
now = time.time(); r = [l for l in L if now - l["t"] < 300]
print(collections.Counter((l["tag"], l["model"][:22], l["ok"]) for l in r))
print("gpt-oss blind ok", sum(1 for l in L if l["tag"] == "e2-blind" and "gpt-oss" in l["model"] and l["ok"]))
print("lightning e3 ok", sum(1 for l in L if l["tag"].startswith("e3-") and "lightning" in l["model"] and l["ok"]))
print([l.get("err", "")[:80] for l in r if not l["ok"]][:3])
