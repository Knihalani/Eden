"""StreamBench v1.1: length-calibrated human prompts (critic C1, fix 3).

Real typed prompts (R6 §3) have a p50 of 12 words and a p90 of 42, and 24.2% are ≤ 3 words. Authored v1 prompts run at
about twice that length. A rewriter (a different model from the authors) shortens every human prompt to that
distribution while keeping the beats:
  - a `state` (user channel) prompt keeps every token in `keep`;
  - a `need` prompt still must not contain the needed values (`avoid`);
  - pastes keep their pasted body and shorten only the ask.

    python3 benchmarks/memory-stream/rewrite.py prep --world code          # rewrite/<world>/in/*.json
    python3 benchmarks/memory-stream/rewrite.py apply --world code         # worlds/<world>-short/{plan.json,authored/}

`apply` copies the plan and the authored batches into a new world `<world>-short`, with the human texts replaced.
assemble.py and replay.ts then run on it as on any world.
"""
import argparse, glob, json, os, shutil
from text import content

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def prep(world, per):
    plan = json.load(open(os.path.join(HERE, "worlds", world, "plan.json")))
    items = {x["id"]: x for x in json.load(open(os.path.join(ROOT, plan["config"]["items"])))}
    beats = {(s["id"], t["k"]): t["beats"] for s in plan["sessions"] for t in s["turns"]}
    cases = []
    for p in sorted(glob.glob(os.path.join(HERE, "worlds", world, "authored", "*.json"))):
        for s in json.load(open(p))["sessions"]:
            for n, e in enumerate(s["events"]):
                if e["t"] != "human":
                    continue
                bs = beats.get((s["id"], e.get("k")), [])
                keep, avoid, kinds = set(), set(), []
                for b in bs:
                    kinds.append(b.get("need_type") or b.get("neg") or f"state:{b.get('channel')}")
                    if b["type"] == "state" and b["channel"] == "user":
                        for i in b["items"]:
                            keep |= {t for t in content(items[i]["text"]) if len(t) > 3 or any(c.isdigit() for c in t)}
                    if b["type"] == "need":
                        for i in b["items"]:
                            avoid |= content(items[i]["text"]) - content(items[i].get("subject") or "")
                cases.append({"session": s["id"], "index": n, "kind": kinds, "text": e["text"],
                              "keep": sorted(keep), "avoid": sorted(avoid)})
    d = os.path.join(HERE, "rewrite", world, "in")
    os.makedirs(d, exist_ok=True)
    os.makedirs(os.path.join(HERE, "rewrite", world, "out"), exist_ok=True)
    for b in range(0, len(cases), per):
        name = f"{world}-rw-b{b // per:02d}"
        json.dump({"batch": name, "cases": cases[b:b + per],
                   "output": f"benchmarks/memory-stream/rewrite/{world}/out/{name}.json"},
                  open(os.path.join(d, f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(cases[b:b + per]))


def apply(world):
    new = {}
    for p in glob.glob(os.path.join(HERE, "rewrite", world, "out", "*.json")):
        for c in json.load(open(p))["cases"]:
            new[(c["session"], c["index"])] = c["text"]
    dst = os.path.join(HERE, "worlds", f"{world}-short")
    os.makedirs(os.path.join(dst, "authored"), exist_ok=True)
    plan = json.load(open(os.path.join(HERE, "worlds", world, "plan.json")))
    plan["world"] = f"{world}-short"
    json.dump(plan, open(os.path.join(dst, "plan.json"), "w"), indent=1)
    shutil.copy(os.path.join(HERE, "worlds", world, "WORLD.md"), os.path.join(dst, "WORLD.md"))
    changed = 0
    for p in sorted(glob.glob(os.path.join(HERE, "worlds", world, "authored", "*.json"))):
        d = json.load(open(p))
        for s in d["sessions"]:
            for n, e in enumerate(s["events"]):
                if (s["id"], n) in new:
                    e["text"] = new[(s["id"], n)]
                    changed += 1
        d["author"] = d.get("author", "") + " + rewriter (rewrite.py)"
        json.dump(d, open(os.path.join(dst, "authored", os.path.basename(p)), "w"), indent=1, ensure_ascii=False)
    print("rewritten prompts:", changed)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep", "apply"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--per", type=int, default=250)
    a = ap.parse_args()
    prep(a.world, a.per) if a.cmd == "prep" else apply(a.world)
