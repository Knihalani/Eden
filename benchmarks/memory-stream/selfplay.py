"""Sleep-time self-play (family F4): per compiled memory, a model writes situations that need it and near misses
that do not; the hot path matches a turn against those exemplars (prompt to prompt), with a near-miss margin.

    python3 benchmarks/memory-stream/selfplay.py prep --world code [--per 40]
    score.py ... --store sleep --systems "bank:tau=0.3,margin=0.05"

Inputs `selfplay/<world>/in/<batch>.json`: rows of the sleep-compiled store (id, text, kind) and the world bible.
The generator (a different model from the stream authors, recorded in the output) writes
`selfplay/<world>/out/<batch>.json`: {"rows": {row id: {"pos": [...], "neg": [...]}}}.
It never sees the stream, so exemplars cannot copy test prompts.
"""
import argparse, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def prep(world, per):
    import sleep
    stream = json.load(open(os.path.join(HERE, "worlds", world, "stream.json")))
    rows = sleep.rows(stream, world)
    d = os.path.join(HERE, "selfplay", world, "in")
    os.makedirs(d, exist_ok=True)
    os.makedirs(os.path.join(HERE, "selfplay", world, "out"), exist_ok=True)
    for b in range(0, len(rows), per):
        part = [{"id": r["id"], "text": r["text"], "kind": r.get("kind")} for r in rows[b:b + per]]
        name = f"{world}-sp-b{b // per:02d}"
        json.dump({"batch": name, "world_bible": f"benchmarks/memory-stream/worlds/{world}/WORLD.md", "rows": part,
                   "output": f"benchmarks/memory-stream/selfplay/{world}/out/{name}.json"},
                  open(os.path.join(d, f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(part))


def exemplars(world):
    out = {}
    for p in glob.glob(os.path.join(HERE, "selfplay", world, "out", "*.json")):
        out.update(json.load(open(p)).get("rows", {}))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--per", type=int, default=40)
    a = ap.parse_args()
    prep(a.world, a.per)
