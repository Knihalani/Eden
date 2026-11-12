# F9 (D1101): cards-distill score of subagent answers against Haiku's recorded cards, on their rows only.
# python3 -I cards-fidelity.py DIR NAME ANSWERS.json…  (DIR/cd/heldout.jsonl from `cards-distill.ts export --out DIR/cd`;
# run from the repository root)
import json, os, subprocess, sys

D, name, files = sys.argv[1], sys.argv[2], sys.argv[3:]
ans = {}
for f in files:
    for a in json.load(open(f)): ans[str(a["id"])] = a.get("text", "")
rows = [l for l in open(f"{D}/cd/heldout.jsonl") if str(json.loads(l)["id"]) in ans]
open(f"{D}/h-{name}.jsonl", "w").writelines(rows)
with open(f"{D}/o-{name}.jsonl", "w") as o:
    for k, t in ans.items(): o.write(json.dumps({"id": k, "text": t}) + "\n")
env = {k: v for k, v in os.environ.items() if k not in ("OPENROUTER_API_KEY", "EDEN_LAB_QUEUE")}
r = subprocess.run(["bun", "packages/sim/src/lab/cards-distill.ts", "score", "--data", f"{D}/h-{name}.jsonl",
    "--outputs", f"{D}/o-{name}.jsonl", "--json", f"{D}/s-{name}.json"], env=env,
    capture_output=True, text=True)
s = json.load(open(f"{D}/s-{name}.json"))
chars = sum(len(t) for t in ans.values()) / max(1, len(ans))
print(name, json.dumps({k: s.get(k) for k in ["batches", "items", "constraintRef", "constraintOut", "flagAgreement",
    "flagPrecision", "flagRecall", "kindAgreement", "requestsJaccard"]}), "keptPrec", s["kept"]["flagPrecision"],
    "chars/batch", round(chars))
