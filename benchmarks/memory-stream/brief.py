"""Writes the authoring briefs of a world's plan: one JSON per batch of sessions, for one stream author each.

    python3 benchmarks/memory-stream/brief.py --world code [--batch 10]

A brief holds its sessions with every beat's items written out, the items stated before the batch (continuity),
the output path and the author id. Briefs are derived from plan.json and are not committed (`briefs/` is ignored).
"""
import argparse, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--batch", type=int, default=10)
    a = ap.parse_args()
    plan = json.load(open(os.path.join(HERE, "worlds", a.world, "plan.json")))
    items = {x["id"]: x for x in json.load(open(os.path.join(ROOT, plan["config"]["items"])))}
    text = lambda ids: [{"id": i, "text": items[i]["text"]} for i in ids]
    out_dir = os.path.join(HERE, "briefs", a.world)
    os.makedirs(out_dir, exist_ok=True)
    ss = plan["sessions"]
    for b in range(0, len(ss), a.batch):
        name = f"{a.world}-b{b // a.batch:02d}"
        before = sorted((i for i, s in plan["intro"].items() if s < b and i not in plan["files"]),
                        key=lambda i: plan["intro"][i])
        sessions = []
        for s in ss[b:b + a.batch]:
            turns = []
            for t in s["turns"]:
                beats = []
                for x in t["beats"]:
                    y = {k: v for k, v in x.items() if k not in ("items", "corrects", "forbidden")}
                    if x.get("items"):
                        y["items"] = text(x["items"])
                    if x.get("corrects"):
                        y["corrects"] = text(x["corrects"])
                    if x.get("forbidden"):
                        y["forbidden"] = text(x["forbidden"])
                    beats.append(y)
                turns.append({"k": t["k"], "beats": beats})
            trig = [{"after": t["after"], **({k: v for k, v in t["beat"].items() if k != "items"}),
                     "items": text(t["beat"]["items"])} for t in s["triggers"]]
            sessions.append({k: v for k, v in s.items() if k not in ("turns", "triggers")} | {
                "turns": turns, "triggers": trig})
        brief = {
            "batch": name,
            "author": f"claude-subagent:stream-author-{name}",
            "output": f"benchmarks/memory-stream/worlds/{a.world}/authored/{name}.json",
            "world_bible": f"benchmarks/memory-stream/worlds/{a.world}/WORLD.md",
            "spec": "benchmarks/memory-stream/AUTHORING.md",
            "always_in_context": text(plan["files"]),
            "stated_before_this_batch": text(before),
            "sessions": sessions,
        }
        json.dump(brief, open(os.path.join(out_dir, f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(sessions), "sessions", sum(len(s["turns"]) for s in sessions), "human turns")


if __name__ == "__main__":
    main()
