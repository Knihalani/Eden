"""E2(a) blind doc2query aliases (<= 8 per row) from a hosted NIM model. Same brief as R1's gen_aliases_phi.py.
Sees ONLY the memory text (never a cue). Usage: python gen_aliases_nim.py <model> <out.json>"""
import json, re, sys, os
from concurrent.futures import ThreadPoolExecutor
from nim import chat, parse_json

model, outp = sys.argv[1], sys.argv[2]
mems = [m for m in json.load(open("fixture/memories.json")) if not m["superseded_by"]]
PROMPT = ("A coding assistant stores this note about a software repository:\n\"{t}\"\n\n"
          "List up to 8 short search keywords or phrases (1-3 words each) that a developer might type when they need this note "
          "but that do NOT already appear in the note: synonyms, abbreviations, informal names, related concepts, error symptoms. "
          'Return JSON only: {{"aliases": [up to 8 strings]}}')


def one(m):
    txt, rec = chat(model, [{"role": "user", "content": PROMPT.format(t=m["text"])}], tag="e2-blind", temperature=0.2, max_tokens=2048)
    js = parse_json(txt)
    al = js.get("aliases", []) if isinstance(js, dict) else (js if isinstance(js, list) else [])
    al = [re.sub(r"^[\s\d.\-*]+|[\s.]+$", "", str(a)).lower() for a in al]
    return m["id"], [a for a in al if a and len(a) <= 40][:8]


with ThreadPoolExecutor(int(os.environ.get("NT", "4"))) as ex:
    out = dict(ex.map(one, mems))
json.dump(out, open(outp, "w"), indent=0)
print(model, len(out), "rows,", sum(map(len, out.values())), "aliases")
