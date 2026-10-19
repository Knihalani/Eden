"""C11-E8: Jev over a wide candidate pool. For dev judge-sample need turns and as many no-need turns (seed 1), the
pool is C11-E2's uncapped channel union (G0@15 ∪ entity ∪ time ∪ action), ordered G0 first, then by how many channels
hold the row, then lexical score, cut at 150; one Jev request per turn with the C10-E2 `list` variant.

    python3 benchmarks/memory-stream/wide_check.py --world code          (runs the calls; resumes)
    python3 benchmarks/memory-stream/wide_check.py --world code --report
→ dream/<world>/wide/out.json: {event: {"need": [...], "pool": [...], "scores": {row: p}, "latency_s": s}}
"""
import argparse, glob, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M
from recall_funnel import Generators, turn_times
from verify_jev import env, call, request, combine

CAP, THR, TOP = 150, 0.7, 4


def turns(g, world):
    import score
    jud = set()
    for p in glob.glob(os.path.join(HERE, "judge", f"{world}-sleep", "in", "*.json")):
        jud |= {c["event"] for c in json.load(open(p))["cases"]}
    evs = [e for e in score.scored_events(g.stream) if e["_split"] == "dev" and e["t"] == "human" and e["id"] in jud]
    need = lambda e: set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))
    yes = [e for e in evs if need(e)]
    no = [e for e in evs if not need(e)]
    no = random.Random(1).sample(no, min(len(yes), len(no)))
    return [(e, need(e)) for e in sorted(yes + no, key=lambda e: e["_order"])]


def pool(g, e, tags, turn_act, thr=0.5):
    now = e["_order"]
    vis = {r["id"] for r in g.lex.visible(now)}
    text, ctx = M.strip_paste(e["text_all"]), g.ctx.get(e["id"], "")
    gens, _ = g.score_all(e)
    g0 = sorted(gens["G0"], key=lambda i: (-gens["G0"][i], i))[:15]
    ment = g.mentioned(text + " " + ctx)
    ent = {i for i in vis if g.ents[i] & ment}
    days, months = turn_times(text, g.day[e["id"]])
    tm = set()
    for i in vis:
        s = " ".join((g.by_id[i].get("when") or {}).get("times") or []).lower()
        if any(x in s or x[:3] + "s" in s for x in days) or any(m in s for m in months):
            tm.add(i)
    want = {k for k, v in (turn_act.get(e["id"]) or {}).items() if v is not None and v >= thr}
    act = {i for i in vis if want & set(tags.get(i, []))}
    lex = g.lex.scores(dict(e, text_all=text), now)
    rest = (ent | tm | act) - set(g0)
    n_ch = lambda i: (i in ent) + (i in tm) + (i in act)
    rest = sorted(rest, key=lambda i: (-n_ch(i), -lex.get(i, 0.0), i))
    return (g0 + rest)[:CAP], set(g0)


def run(world):
    cfg = env()
    if not cfg["TYPESAFE_API_KEY"]:
        sys.exit("TYPESAFE_API_KEY must be set (environment or .env)")
    import judge
    g = Generators(world)
    tags = {}
    for p in sorted(glob.glob(os.path.join(HERE, "dream", world, "out", "tags-*.json"))):
        tags.update(json.load(open(p))["tags"])
    turn_act = json.load(open(os.path.join(HERE, "dream", world, "turn-actions.json")))
    d = os.path.join(HERE, "dream", world, "wide")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "out.json")
    out = json.load(open(path)) if os.path.exists(path) else {}
    for e, need in turns(g, world):
        if e["id"] in out:
            continue
        ids, g0 = pool(g, e, tags, turn_act)
        case = {"text": M.strip_paste(e["text_all"])[:3000], "recent": judge.context(g.stream, e["id"], 4),
                "candidates": [{"id": i, "text": g.by_id[i]["text"]} for i in ids]}
        rec = {"need": sorted(need), "pool": ids, "g0": sorted(g0), "scores": {}, "latency_s": None}
        if ids:
            state, qs = request(case, "list")
            reply, secs, attempts = call(cfg, state, qs, timeout=120)
            ans = reply.get("answers", {})
            rec["scores"] = {i: combine(ans, n, "list") for n, i in enumerate(ids)}
            rec.update(latency_s=round(secs, 3), attempts=attempts, usage=reply.get("usage", {}))
        out[e["id"]] = rec
        json.dump(out, open(path, "w"), indent=1)
    print(world, len(out), "turns checked")


def report(world):
    g = Generators(world)
    out = json.load(open(os.path.join(HERE, "dream", world, "wide", "out.json")))
    lat, tot, hit, tot0, hit0 = [], 0, 0, 0, 0
    fired = {"need": [0, 0], "no-need": [0, 0]}
    picks_n, unanswered = [], 0
    for eid, r in out.items():
        sc = {i: p for i, p in r["scores"].items() if p is not None}
        unanswered += len(r["scores"]) - len(sc)
        picks = sorted((i for i in sc if sc[i] >= THR), key=lambda i: (-sc[i], i))[:TOP]
        picks_n.append(len(picks))
        k = "need" if r["need"] else "no-need"
        fired[k][0] += 1
        fired[k][1] += bool(picks)
        if r["latency_s"] is not None:
            lat.append((len(r["pool"]), r["latency_s"]))
        for item in r["need"]:
            cover = [i for i in r["pool"] if item in g.by_id[i]["covers"]]
            if not cover:
                continue
            tot += 1
            got = any(i in picks for i in cover)
            hit += got
            if any(i in r["g0"] for i in cover):
                tot0 += 1
                hit0 += got
    ls = sorted(s for _, s in lat)
    sizes = sorted(n for n, _ in lat)
    print(world, len(out), "turns; pool size median / max", sizes[len(sizes) // 2], sizes[-1],
          "; unanswered questions", unanswered)
    print(f"   latency p50 {ls[len(ls) // 2]:.3f} s, p90 {ls[int(0.9 * len(ls))]:.3f} s, max {ls[-1]:.3f} s")
    for lo, hi in ((0, 50), (50, 100), (100, 151)):
        b = sorted(s for n, s in lat if lo <= n < hi)
        if b:
            print(f"     pool {lo}-{hi - 1}: n {len(b)}, p50 {b[len(b) // 2]:.3f} s")
    print(f"   recall of needed items with a covering row in the pool: {hit}/{tot} = {hit / tot:.3f}; "
          f"of those also in G0@15: {hit0}/{tot0} = {hit0 / tot0:.3f}")
    print("   turns with any pick:", {k: f"{v[1]}/{v[0]}" for k, v in fired.items()},
          "; picks per turn mean", round(sum(picks_n) / len(picks_n), 2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    report(a.world) if a.report else run(a.world)
