# F9 (D1101): the push check served twice by subagents, first answers in Q/done and second in R*.answers.json.
# python3 -I check-agree.py SCRATCH  (SCRATCH holds q2/done and fid/R*.answers.json)
import json, sys, glob
S = sys.argv[1]
def acts(t):
    try: d = json.loads(t)
    except Exception: return None
    return frozenset(x.get("i") for x in d.get("items", []) if x.get("act"))
first = {}
for f in glob.glob(S + "/q2/done/*.json"):
    d = json.load(open(f)); first[d["id"]] = acts(d["answer"]["text"])
second = {}
for f in glob.glob(S + "/fid/R*.answers.json"):
    for a in json.load(open(f)): second[a["id"]] = acts(a.get("text", ""))
ids = [i for i in first if i in second and first[i] is not None and second[i] is not None]
speak = sum((len(first[i]) > 0) == (len(second[i]) > 0) for i in ids)
same = sum(first[i] == second[i] for i in ids)
silentFirst = [i for i in ids if not first[i]]
keep = sum(not second[i] for i in silentFirst)
print(json.dumps({"pairs": len(ids), "speakSilentAgree": round(speak / len(ids), 3), "sameItems": round(same / len(ids), 3),
  "silentKept": f"{keep}/{len(silentFirst)}", "speakFirst": sum(1 for i in ids if first[i]), "speakSecond": sum(1 for i in ids if second[i])}))
