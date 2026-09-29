# Held-out cue author: Qwen2.5-3B-Instruct (local, MPS). Writes fixture/cues-llm.psv
import random, torch, re, json
from transformers import AutoTokenizer, AutoModelForCausalLM
P = "models/hf/models--Qwen--Qwen2.5-3B-Instruct/snapshots/aa8e72537993ba99e69dfaafa59ed015b17504d1"
tok = AutoTokenizer.from_pretrained(P); model = AutoModelForCausalLM.from_pretrained(P, torch_dtype=torch.float16).to("mps").eval()
mems = [l.rstrip("\n").split("|") for l in open("fixture/memories.psv") if l.strip() and not l.startswith("#")]
live = [m for m in mems if not m[5]]
random.seed(7); pick = random.sample(live, 95)
PROMPTS = {
 "para": "A developer's project memory contains this note:\n\"{t}\"\n\nWrite ONE short question (under 18 words) that a developer working in this repository might type to their coding assistant at a moment when this note is exactly the answer they need. Do NOT reuse distinctive words from the note: no tool or product names, no file names, no numbers, no identifiers, no key nouns from the note. Describe the need in different everyday words. Output only the question.",
 "llm-natural": "A developer's project memory contains this note:\n\"{t}\"\n\nWrite ONE short, natural message (under 18 words) that a developer working in this repository might type to their coding assistant when they need the information in this note. Do not state the answer. Output only the message.",
}
def gen(prompt):
    msgs = [{"role": "user", "content": prompt}]
    enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True).to("mps"); ids = enc["input_ids"]
    with torch.no_grad(): out = model.generate(**enc, max_new_tokens=48, do_sample=True, temperature=0.7, top_p=0.9)
    s = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip().split("\n")[0].strip().strip('"')
    return re.sub(r"\s+", " ", s).replace("|", "/")
torch.manual_seed(7)
with open("fixture/cues-llm.psv", "w") as f:
    f.write("# cat|scope|gold|cue|last_paths|prev_turn   (author=qwen2.5-3b-instruct)\n")
    for m in pick:
        for cat, p in PROMPTS.items():
            q = gen(p.format(t=m[4])); f.write(f"{cat}|{m[1]}|{m[0]}|{q}||\n"); f.flush(); print(cat, m[0], q, flush=True)
