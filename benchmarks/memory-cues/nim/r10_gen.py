"""R10: compile each memory into a cue bank at sleep time (a strong model, offline, never on a hook path).

For every live fixture memory the model sees ONLY the memory (text, kind, folder) and the repo's one-line description,
never a benchmark cue, and writes:
  - needs: 12 prompts a developer in this repo might send where this note changes the answer (direct questions,
    tasks that depend on it, symptoms and errors, terse and casual phrasings, mostly in other words than the note's);
  - near: 8 prompts on the same topic or with the same words where the note is NOT needed (general knowledge, other
    projects, a different aspect of the same component).
It also writes a repo-agnostic background bank: generic prompts a developer sends that need no repo memory.

Usage (from benchmarks/memory-cues): python nim/r10_gen.py [model]   -> nim/out/r10-bank-<model>.json
"""
import json, os, re, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(__file__))
from nim import chat, parse_json

MODEL = sys.argv[1] if len(sys.argv) > 1 else "google/gemma-4-31b-it"
MEMS = [m for m in json.load(open("fixture/memories.json")) if not m["superseded_by"]]
REPO = "a TypeScript monorepo (apps/web, apps/api, services/worker, packages/cli, infra)"

PROMPT = """A coding assistant keeps this note about {repo}:
NOTE ({kind}, folder: {scope}): "{text}"

Write prompts a developer might send to the coding assistant while working in this repo.

1. "needs": 12 prompts where knowing this note would change the assistant's answer or action. Vary them: direct
questions, tasks that depend on the note, symptoms or error messages it explains, terse commands, casual phrasings.
Write most of them in words a user would use, not the note's own wording; at most 3 may reuse the note's key terms.

2. "near": 8 prompts that share the note's topic or words but where the note is NOT needed: general-knowledge
questions about the same technology, the same task in a different project, or a different aspect of the same part
of the repo.

Return JSON only: {{"needs": [12 strings], "near": [8 strings]}}"""

BACKGROUND = """Write 30 varied messages a software developer might send to an AI coding assistant that do NOT depend on
any particular repository's conventions, settings or history. Theme for this batch: {theme}.
Mix lengths and tones (terse, casual, detailed). Return JSON only: {{"prompts": [30 strings]}}"""

THEMES = [
    "general programming-language questions (JavaScript, TypeScript, Python, Go, Rust)",
    "computer-science concepts and algorithms explained",
    "writing small standalone functions or snippets",
    "general tool usage: git, docker, npm, pnpm, bash, kubernetes, cloud CLIs",
    "databases and SQL in general, not a specific schema",
    "web frameworks and libraries in general (React, Next.js, Express, Django)",
    "career, chat, jokes, poems, motivation, small talk",
    "math, estimation and unit conversions",
    "devops and infrastructure concepts in general (CI, queues, caching, monitoring)",
    "security and auth concepts in general (OAuth, JWT, hashing, CORS)",
]


def gen_memory(m):
    text, _ = chat(MODEL, [{"role": "user", "content": PROMPT.format(repo=REPO, kind=m["kind"], scope=m["scope"] or "(root)",
                                                                       text=m["text"])}],
                   tag="r10-bank", temperature=0.6, max_tokens=3000)
    js = parse_json(text)
    clean = lambda xs: [re.sub(r"\s+", " ", str(x)).strip() for x in (xs or []) if str(x).strip()]
    js = js if isinstance(js, dict) else {}
    return m["id"], {"needs": clean(js.get("needs"))[:12], "near": clean(js.get("near"))[:8]}


def gen_background(theme):
    text, _ = chat(MODEL, [{"role": "user", "content": BACKGROUND.format(theme=theme)}], tag="r10-background",
                   temperature=0.8, max_tokens=3000)
    js = parse_json(text)
    return [re.sub(r"\s+", " ", str(x)).strip() for x in (js.get("prompts", []) if isinstance(js, dict) else []) if str(x).strip()]


if __name__ == "__main__":
    with ThreadPoolExecutor(int(os.environ.get("NT", "6"))) as ex:
        bank = dict(ex.map(gen_memory, MEMS))
        background = [p for batch in ex.map(gen_background, THEMES) for p in batch]
    out = {"model": MODEL, "bank": bank, "background": background}
    path = f"nim/out/r10-bank-{MODEL.split('/')[-1]}.json"
    json.dump(out, open(path, "w"), indent=1)
    print(MODEL, len(bank), "memories;", sum(len(v["needs"]) for v in bank.values()), "needs;",
          sum(len(v["near"]) for v in bank.values()), "near;", len(background), "background ->", path)
    short = [k for k, v in bank.items() if len(v["needs"]) < 12 or len(v["near"]) < 8]
    print("short banks:", len(short), short[:10])
