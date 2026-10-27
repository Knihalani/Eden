# M3 "sleep" doc2query-style expansion: <=8 aliases per memory from Phi-3.5-mini-instruct (a different model family than the cue author).
# Sees ONLY the memory text (never cues). Output fixture/aliases.json
import json, torch, re, glob, time
from transformers import AutoTokenizer, AutoModelForCausalLM
P = glob.glob("models/hf/models--microsoft--Phi-3.5-mini-instruct/snapshots/*")[0]
tok = AutoTokenizer.from_pretrained(P); model = AutoModelForCausalLM.from_pretrained(P, torch_dtype=torch.float16).to("mps").eval()
mems = json.load(open("fixture/memories.json"))
PROMPT = ("A coding assistant stores this note about a software repository:\n\"{t}\"\n\n"
 "List up to 8 short search keywords or phrases (1-3 words each) that a developer might type when they need this note "
 "but that do NOT already appear in the note: synonyms, abbreviations, informal names, related concepts, error symptoms. "
 "Output only a comma-separated list.")
import os
out = json.load(open("fixture/aliases.json")) if os.path.exists("fixture/aliases.json") else {}; t0 = time.time()
for m in mems:
    if m["id"] in out: continue
    enc = tok.apply_chat_template([{"role": "user", "content": PROMPT.format(t=m["text"])}], add_generation_prompt=True, return_tensors="pt", return_dict=True).to("mps")
    with torch.no_grad(): g = model.generate(**enc, max_new_tokens=64, do_sample=False)
    s = tok.decode(g[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip().split("\n")[0]
    al = [re.sub(r"^[\s\d.\-*]+|[\s.]+$", "", a).lower() for a in s.split(",")]
    out[m["id"]] = [a for a in al if a and len(a) <= 40][:8]
    print(m["id"], out[m["id"]], flush=True)
json.dump(out, open("fixture/aliases.json", "w"), indent=0)
print("secs", time.time() - t0)
