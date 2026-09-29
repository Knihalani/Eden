"""E1: strong held-out paraphrase cues (+ policy-need cues + hard negatives) from moonshotai/kimi-k3 via NIM.

Every cue is filtered: rejected if it shares any content token with its gold row (lex.ts tokens, light stemming,
shared >=4-char prefix; overlap.py). A rejected slot is regenerated up to 3 more times with feedback.
Output: fixture/cues-nim.json (split = test_nim) and out/e1-gen-log.json.
"""
import json, sys, collections
from concurrent.futures import ThreadPoolExecutor
from nim import chat, parse_json
from overlap import shared, atoms, row_text

MODEL = "moonshotai/kimi-k3"
REPO = ("a TypeScript monorepo called acme: apps/web (Next.js), apps/api (Fastify + Postgres), packages/cli (a Node CLI), "
        "services/worker (BullMQ worker), infra (Terraform / EKS)")
mems = {m["id"]: m for m in json.load(open("fixture/memories.json"))}
cues = json.load(open("fixture/cues.json"))
gold_mems = sorted({g for c in cues if c["gold"] for g in c["gold"]})
POLICY = sorted({g for c in cues if c["cat"] == "policy" for g in c["gold"]})
orig_split = {}
for c in cues:
    for g in c["gold"]:
        orig_split[g] = c["split"]

SYS = "You write evaluation data for a memory-retrieval benchmark for coding agents. Reply with JSON only."


def prompt_para(m, n, banned, rejected):
    s = (f"The project is {REPO}.\nA note stored in the agent's memory (scope: {m['scope'] or 'repo root'}):\n"
         f"  subject: {m['subject']}\n  note: {m['text']}\n\n"
         f"Write {n} different short messages (5-25 words each) that a developer would type to their coding agent in a situation "
         "where recalling this note would clearly help the agent answer or act correctly. Make them natural: a question, a request or a "
         "complaint as typed in a terminal, possibly terse or informal. They must NOT quote or restate the note.\n"
         f"HARD RULE: do not use any of these words, nor any inflection, abbreviation-expansion or compound containing them: {', '.join(sorted(banned))}.\n"
         "Describe the situation or symptom with different words instead.\n")
    if rejected:
        s += "These earlier attempts were rejected for reusing banned words: " + "; ".join(f'"{r}" (used: {", ".join(w)})' for r, w in rejected) + "\n"
    return s + f'Return exactly: {{"cues": [{n} strings]}}'


def prompt_policy(m, n, banned, rejected):
    s = (f"The project is {REPO}.\nThe user has a standing rule for the coding agent:\n  \"{m['text']}\"\n\n"
         f"Write {n} different short task prompts (5-25 words each) that a developer would type to the agent where carrying out the "
         "task would naturally lead the agent to take an action this rule governs, so the rule must be recalled at that moment. "
         "Just ask for the work; do not mention the rule, do not ask about the rule, and do not tell the agent what to do or not do about it.\n"
         f"HARD RULE: do not use any of these words, nor any inflection or compound containing them: {', '.join(sorted(banned))}.\n")
    if rejected:
        s += "These earlier attempts were rejected for reusing banned words: " + "; ".join(f'"{r}" (used: {", ".join(w)})' for r, w in rejected) + "\n"
    return s + f'Return exactly: {{"cues": [{n} strings]}}'


def gen(mid, kind):
    m = mems[mid]; rt = row_text(m); banned = atoms(rt)
    kept, rejected, attempts, calls = [], [], 0, []
    for attempt in range(4):  # first try + up to 3 regenerations
        need = 2 - len(kept)
        if need <= 0:
            break
        attempts += 1
        p = (prompt_para if kind == "para" else prompt_policy)(m, need, banned, rejected)
        try:
            txt, rec = chat(MODEL, [{"role": "system", "content": SYS}, {"role": "user", "content": p}], tag=f"e1-{kind}",
                            temperature=0.7, max_tokens=4096, seed=attempt)
        except Exception as ex:
            calls.append({"err": str(ex)[:200]}); continue
        calls.append({"latency_s": rec["latency_s"], "usage": rec["resp"].get("usage"), "cached": rec["cached"]})
        js = parse_json(txt) or {}
        for cue in (js.get("cues") or [])[:need]:
            if not isinstance(cue, str) or not cue.strip():
                continue
            cue = cue.strip()
            w = shared(cue, rt)
            if w:
                rejected.append((cue, w))
            elif cue.lower() not in {k.lower() for k in kept}:
                kept.append(cue)
    return dict(mid=mid, kind=kind, kept=kept, rejected=rejected, attempts=attempts, calls=calls)


NEG_THEMES = [
    "general-knowledge questions about the technologies (history, trivia, definitions), e.g. about Redis, Docker, Postgres, Next.js, Terraform, Kubernetes, JWT, pnpm",
    "generic coding exercises unrelated to this repo that mention common tools or languages (algorithms, a toy script, a regex)",
    "requests about a different, unrelated personal project or a different language ecosystem (Python, Go, Rust, Java) that happen to mention databases, queues, auth or deployment",
    "jokes, poems, opinions, career or learning questions that mention developer tools, CI, git or cloud providers",
    "conceptual explanations that mention the same words as a typical monorepo (monorepo, migrations, workers, queues, retries, caching, rate limits) but ask only for textbook knowledge",
]


def gen_negs(i, theme):
    p = (f"The project is {REPO}. Write 20 different short messages (5-25 words) a developer might send to their coding agent that "
         f"need NO knowledge of this project, its configuration, conventions or history. Theme: {theme}. "
         "They should share vocabulary with a TypeScript/Node/devops monorepo so that a naive keyword search would be tempted, "
         "but answering them correctly needs only general knowledge. Do not ask about 'this repo', 'our', 'we' or 'here'. "
         'Return exactly: {"cues": [20 strings]}')
    txt, rec = chat(MODEL, [{"role": "system", "content": SYS}, {"role": "user", "content": p}], tag="e1-neg", temperature=0.8, max_tokens=4096, seed=i)
    return (parse_json(txt) or {}).get("cues", []), rec


if __name__ == "__main__":
    jobs = [(g, "para") for g in gold_mems] + [(p, "policy") for p in POLICY]
    if len(sys.argv) > 1:
        jobs = jobs[: int(sys.argv[1])]
    with ThreadPoolExecutor(int(__import__("os").environ.get("NT", "6"))) as ex:
        res = list(ex.map(lambda j: gen(*j), jobs))
        negs = list(ex.map(lambda a: gen_negs(*a), list(enumerate(NEG_THEMES)))) if len(sys.argv) == 1 else []
    out, n = [], 0
    for r in res:
        m = mems[r["mid"]]
        for cue in r["kept"]:
            out.append(dict(id=f"n{n:03d}", cat="nim-para" if r["kind"] == "para" else "nim-policy", scope=m["scope"], gold=[r["mid"]],
                            cue=cue, last_paths=[], prev_turn="", author=MODEL, split="test_nim", gold_orig_split=orig_split[r["mid"]]))
            n += 1
    seen = set()
    for cs, _ in negs:
        for cue in cs:
            if isinstance(cue, str) and cue.strip() and cue.lower() not in seen:
                seen.add(cue.lower())
                out.append(dict(id=f"n{n:03d}", cat="nim-neg", scope="", gold=[], cue=cue.strip(), last_paths=[], prev_turn="", author=MODEL, split="test_nim"))
                n += 1
    json.dump(out, open("fixture/cues-nim.raw.json", "w"), indent=1)
    json.dump(res, open("out/e1-gen-log.json", "w"), indent=1)
    st = collections.Counter()
    for r in res:
        st[r["kind"] + "_mems"] += 1; st[r["kind"] + "_kept"] += len(r["kept"]); st[r["kind"] + "_rejected"] += len(r["rejected"])
        st[r["kind"] + "_full2"] += len(r["kept"]) == 2; st[r["kind"] + "_calls"] += r["attempts"]
    print(dict(st), "negs", sum(1 for o in out if o["cat"] == "nim-neg"))
