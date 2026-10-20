"""C11-E8: Jev over a wide candidate pool. For dev judge-sample need turns and as many no-need turns (seed 1), the
pool is C11-E2's uncapped channel union (G0@15 ∪ entity ∪ time ∪ action), ordered G0 first, then by how many channels
hold the row, then lexical score, cut at 150; one Jev request per turn with the C10-E2 `list` variant.

    python3 benchmarks/memory-stream/wide_check.py --world code          (runs the calls; resumes)
    python3 benchmarks/memory-stream/wide_check.py --world code --report
    python3 benchmarks/memory-stream/wide_check.py --world code --second [--report]   (C11-E9: narrow second pass)
    python3 benchmarks/memory-stream/wide_check.py --world code --implied [--report]  (C11-E10: implied steps)
    python3 benchmarks/memory-stream/wide_check.py --world code --applies [--report]  (C11-E11: applies-when)
    python3 benchmarks/memory-stream/wide_check.py --world code --repeat [--report]   (C11-E12: average two calls)
    python3 benchmarks/memory-stream/wide_check.py --world code --bank [--report]     (C11-E13: self-play examples)
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


def second(world, keep=15, thr1=0.5, rep=False):
    """C11-E9: re-ask the `list` question over the wide pass's top `keep` at p ≥ thr1; picks at p ≥ 0.7, top 8."""
    import judge
    g = Generators(world)
    d = os.path.join(HERE, "dream", world, "wide")
    wide = json.load(open(os.path.join(d, "out.json")))
    path = os.path.join(d, "second.json")
    out = json.load(open(path)) if os.path.exists(path) else {}
    if not rep:
        cfg = env()
        if not cfg["TYPESAFE_API_KEY"]:
            sys.exit("TYPESAFE_API_KEY must be set (environment or .env)")
        ev = {e["id"]: e for s in g.stream["sessions"] for e in s["events"]}
        for eid, r in wide.items():
            if eid in out:
                continue
            sc = {i: p for i, p in r["scores"].items() if p is not None}
            ids = sorted((i for i in sc if sc[i] >= thr1), key=lambda i: (-sc[i], i))[:keep]
            rec = {"pool": ids, "scores": {}, "latency_s": None}
            if ids:
                case = {"text": M.strip_paste(ev[eid]["text_all"])[:3000], "recent": judge.context(g.stream, eid, 4),
                        "candidates": [{"id": i, "text": g.by_id[i]["text"]} for i in ids]}
                state, qs = request(case, "list")
                reply, secs, attempts = call(cfg, state, qs)
                ans = reply.get("answers", {})
                rec["scores"] = {i: combine(ans, n, "list") for n, i in enumerate(ids)}
                rec.update(latency_s=round(secs, 3), attempts=attempts)
            out[eid] = rec
            json.dump(out, open(path, "w"), indent=1)
    tot = hit = fired_no = 0
    fired = {"need": [0, 0], "no-need": [0, 0]}
    npk, lat = [], []
    for eid, r in wide.items():
        sc = {i: p for i, p in out[eid]["scores"].items() if p is not None}
        picks = sorted((i for i in sc if sc[i] >= THR), key=lambda i: (-sc[i], i))[:8]
        npk.append(len(picks))
        if out[eid]["latency_s"] is not None:
            lat.append(out[eid]["latency_s"])
        k = "need" if r["need"] else "no-need"
        fired[k][0] += 1
        fired[k][1] += bool(picks)
        for item in r["need"]:
            cover = [i for i in r["pool"] if item in g.by_id[i]["covers"]]
            if cover:
                tot += 1
                hit += any(i in picks for i in cover)
    lat.sort()
    print(world, len(out), "turns; second pass recall", f"{hit}/{tot} = {hit / tot:.3f};",
          "turns with any pick", {k: f"{v[1]}/{v[0]}" for k, v in fired.items()},
          "; picks per turn mean", round(sum(npk) / len(npk), 2),
          f"; second call p50 {lat[len(lat) // 2]:.3f} s, p90 {lat[int(0.9 * len(lat))]:.3f} s")


IMPLIED_Q = ("`turn` is the user's newest message to their assistant; `recent` is the conversation just before it. "
             "`row` is one note from the assistant's long-term memory about this user. Question: does `row` state a "
             "rule, convention, setup fact or past fix that applies to a step the assistant would likely take to "
             "carry out `turn`, including steps the user did not name (committing, branching, testing, deploying, "
             "editing a file the row governs)?")
IMPLIED_C = {
    "true": "Yes when doing the work the turn asks for would, in the normal course, involve a step that `row` "
            "constrains or informs, even if the turn does not mention that step.",
    "false": "No when no likely step of the work touches what `row` is about, or when the turn needs no work (small "
             "talk, a thank-you, a question `row` does not bear on).",
}


def implied(world, rep=False):
    """C11-E10: one implied-step question per wide-pool row, in its own request; a row is picked if needed p ≥ 0.7
    or implied p ≥ 0.7, top 8 by the larger."""
    import judge
    g = Generators(world)
    d = os.path.join(HERE, "dream", world, "wide")
    wide = json.load(open(os.path.join(d, "out.json")))
    path = os.path.join(d, "implied.json")
    out = json.load(open(path)) if os.path.exists(path) else {}
    if not rep:
        cfg = env()
        if not cfg["TYPESAFE_API_KEY"]:
            sys.exit("TYPESAFE_API_KEY must be set (environment or .env)")
        ev = {e["id"]: e for s in g.stream["sessions"] for e in s["events"]}
        for eid, r in wide.items():
            if eid in out:
                continue
            rec = {"scores": {}, "latency_s": None}
            if r["pool"]:
                state = {"turn": M.strip_paste(ev[eid]["text_all"])[:3000], "recent": judge.context(g.stream, eid, 4)}
                qs = {f"q{n}": {"type": "noul", "instructions": {"row": g.by_id[i]["text"], "question": IMPLIED_Q},
                                "criteria": IMPLIED_C} for n, i in enumerate(r["pool"])}
                reply, secs, attempts = call(cfg, state, qs, timeout=120)
                ans = reply.get("answers", {})
                rec["scores"] = {i: combine(ans, n, "list") for n, i in enumerate(r["pool"])}
                rec.update(latency_s=round(secs, 3), attempts=attempts)
            out[eid] = rec
            json.dump(out, open(path, "w"), indent=1)
    tot = hit = 0
    fired = {"need": [0, 0], "no-need": [0, 0]}
    npk, lat = [], []
    for eid, r in wide.items():
        a = {i: p for i, p in r["scores"].items() if p is not None}
        b = {i: p for i, p in out[eid]["scores"].items() if p is not None}
        top = {i: max(a.get(i, 0.0), b.get(i, 0.0)) for i in set(a) | set(b)}
        picks = sorted((i for i in top if top[i] >= THR), key=lambda i: (-top[i], i))[:8]
        npk.append(len(picks))
        if out[eid]["latency_s"] is not None:
            lat.append(out[eid]["latency_s"])
        k = "need" if r["need"] else "no-need"
        fired[k][0] += 1
        fired[k][1] += bool(picks)
        for item in r["need"]:
            cover = [i for i in r["pool"] if item in g.by_id[i]["covers"]]
            if cover:
                tot += 1
                hit += any(i in picks for i in cover)
    lat.sort()
    print(world, len(out), "turns; needed or implied recall", f"{hit}/{tot} = {hit / tot:.3f};",
          "turns with any pick", {k: f"{v[1]}/{v[0]}" for k, v in fired.items()},
          "; picks per turn mean", round(sum(npk) / len(npk), 2),
          f"; implied call p50 {lat[len(lat) // 2]:.3f} s, p90 {lat[int(0.9 * len(lat))]:.3f} s")


def chunks(state, qs, limit=200_000):
    """Split the questions so each request (state + its questions) stays under `limit` JSON characters (≈ 50k
    tokens at 4 characters a token; a 270k-character body was refused as over 64k tokens)."""
    base = len(json.dumps(state)) + 200
    out, cur, size = [], {}, base
    for k, q in qs.items():
        n = len(json.dumps({k: q}))
        if cur and size + n > limit:
            out.append(cur)
            cur, size = {}, base
        cur[k] = q
        size += n
    return out + [cur] if cur else out


def with_when(row):
    acts = [a for a in (row.get("when") or {}).get("activities") or [] if a]
    return row["text"] + (f" (Applies when: {'; '.join(acts)}.)" if acts else "")


def with_bank(ex):
    def f(row):
        e = ex.get(row["id"])
        if not e:
            return row["text"]
        return (row["text"] + " Requests this helps with: " + "; ".join(e.get("pos", [])[:3]) + ". Not for: "
                + "; ".join(e.get("neg", [])[:2]) + ".")
    return f


def applies(world, rep=False, variant="applies"):
    """C11-E11: C11-E8's request with each row's `when.activities` appended to its text. C11-E13 (`bank`): the
    row's first three self-play `pos` requests and first two `neg` appended in the questions only."""
    import judge, selfplay
    g = Generators(world)
    d = os.path.join(HERE, "dream", world, "wide")
    wide = json.load(open(os.path.join(d, "out.json")))
    path = os.path.join(d, f"{variant}.json")
    bank = with_bank(selfplay.exemplars(world)) if variant == "bank" else None
    out = json.load(open(path)) if os.path.exists(path) else {}
    if not rep:
        cfg = env()
        if not cfg["TYPESAFE_API_KEY"]:
            sys.exit("TYPESAFE_API_KEY must be set (environment or .env)")
        ev = {e["id"]: e for s in g.stream["sessions"] for e in s["events"]}
        for eid, r in wide.items():
            if eid in out:
                continue
            rec = {"scores": {}, "latency_s": None}
            if r["pool"]:
                text = bank if bank else with_when
                case = {"text": M.strip_paste(ev[eid]["text_all"])[:3000], "recent": judge.context(g.stream, eid, 4),
                        "candidates": [{"id": i, "text": text(g.by_id[i])} for i in r["pool"]]}
                state, qs = request(case, "list")
                if bank:
                    state["memory_candidates"] = [g.by_id[i]["text"] for i in r["pool"]]
                ans, secs, attempts = {}, 0.0, 0
                for part in chunks(state, qs):  # over Jev's 64k-token limit: same state, questions split
                    reply, t, n_try = call(cfg, state, part, timeout=120)
                    ans.update(reply.get("answers", {}))
                    secs, attempts = max(secs, t), attempts + n_try  # parallel in production: the slowest part
                rec["scores"] = {i: combine(ans, n, "list") for n, i in enumerate(r["pool"])}
                rec.update(latency_s=round(secs, 3), attempts=attempts, parts=len(chunks(state, qs)))
            out[eid] = rec
            json.dump(out, open(path, "w"), indent=1)
    for top_n in (4, 8):
        tot = hit = 0
        fired = {"need": [0, 0], "no-need": [0, 0]}
        npk, lat = [], []
        for eid, r in wide.items():
            sc = {i: p for i, p in out[eid]["scores"].items() if p is not None}
            picks = sorted((i for i in sc if sc[i] >= THR), key=lambda i: (-sc[i], i))[:top_n]
            npk.append(len(picks))
            if out[eid]["latency_s"] is not None:
                lat.append(out[eid]["latency_s"])
            k = "need" if r["need"] else "no-need"
            fired[k][0] += 1
            fired[k][1] += bool(picks)
            for item in r["need"]:
                cover = [i for i in r["pool"] if item in g.by_id[i]["covers"]]
                if cover:
                    tot += 1
                    hit += any(i in picks for i in cover)
        lat.sort()
        print(world, len(out), f"turns; top {top_n}: recall {hit}/{tot} = {hit / tot:.3f};",
              "turns with any pick", {k: f"{v[1]}/{v[0]}" for k, v in fired.items()},
              "; picks per turn mean", round(sum(npk) / len(npk), 2),
              f"; call p50 {lat[len(lat) // 2]:.3f} s, p90 {lat[int(0.9 * len(lat))]:.3f} s")


def repeat(world, rep=False):
    """C11-E12: C11-E8's requests sent again; reports run 2 alone and the per-row average of runs 1 and 2."""
    import judge
    g = Generators(world)
    d = os.path.join(HERE, "dream", world, "wide")
    wide = json.load(open(os.path.join(d, "out.json")))
    path = os.path.join(d, "repeat.json")
    out = json.load(open(path)) if os.path.exists(path) else {}
    if not rep:
        cfg = env()
        if not cfg["TYPESAFE_API_KEY"]:
            sys.exit("TYPESAFE_API_KEY must be set (environment or .env)")
        ev = {e["id"]: e for s in g.stream["sessions"] for e in s["events"]}
        for eid, r in wide.items():
            if eid in out:
                continue
            rec = {"scores": {}, "latency_s": None}
            if r["pool"]:
                case = {"text": M.strip_paste(ev[eid]["text_all"])[:3000], "recent": judge.context(g.stream, eid, 4),
                        "candidates": [{"id": i, "text": g.by_id[i]["text"]} for i in r["pool"]]}
                state, qs = request(case, "list")
                reply, secs, attempts = call(cfg, state, qs, timeout=120)
                ans = reply.get("answers", {})
                rec["scores"] = {i: combine(ans, n, "list") for n, i in enumerate(r["pool"])}
                rec.update(latency_s=round(secs, 3), attempts=attempts)
            out[eid] = rec
            json.dump(out, open(path, "w"), indent=1)
    differ = pairs = 0
    for eid, r in wide.items():
        for i in r["pool"]:
            a, b = r["scores"].get(i), out[eid]["scores"].get(i)
            if a is not None and b is not None:
                pairs += 1
                differ += (a >= THR) != (b >= THR)
    print(world, len(out), f"turns; (turn, row) pairs whose p ≥ {THR} decision differs: {differ}/{pairs} = "
          f"{differ / pairs:.4f}")
    for name in ("run 1", "run 2", "average"):
        for top_n in (4, 8):
            tot = hit = 0
            fired = {"need": [0, 0], "no-need": [0, 0]}
            npk = []
            for eid, r in wide.items():
                a = {i: p for i, p in r["scores"].items() if p is not None}
                b = {i: p for i, p in out[eid]["scores"].items() if p is not None}
                sc = a if name == "run 1" else b if name == "run 2" else {
                    i: (a[i] + b[i]) / 2 if i in a and i in b else a.get(i, b.get(i)) for i in set(a) | set(b)}
                picks = sorted((i for i in sc if sc[i] >= THR), key=lambda i: (-sc[i], i))[:top_n]
                npk.append(len(picks))
                k = "need" if r["need"] else "no-need"
                fired[k][0] += 1
                fired[k][1] += bool(picks)
                for item in r["need"]:
                    cover = [i for i in r["pool"] if item in g.by_id[i]["covers"]]
                    if cover:
                        tot += 1
                        hit += any(i in picks for i in cover)
            print(f"   {name:7s} top {top_n}: recall {hit}/{tot} = {hit / tot:.3f}; turns with any pick",
                  {k: f"{v[1]}/{v[0]}" for k, v in fired.items()}, "; picks per turn mean",
                  round(sum(npk) / len(npk), 2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--second", action="store_true", help="C11-E9 narrow second pass")
    ap.add_argument("--implied", action="store_true", help="C11-E10 implied-step question")
    ap.add_argument("--applies", action="store_true", help="C11-E11 applies-when in the rows")
    ap.add_argument("--repeat", action="store_true", help="C11-E12 average two calls")
    ap.add_argument("--bank", action="store_true", help="C11-E13 self-play examples in the rows")
    a = ap.parse_args()
    if a.bank:
        applies(a.world, rep=a.report, variant="bank")
    elif a.repeat:
        repeat(a.world, rep=a.report)
    elif a.applies:
        applies(a.world, rep=a.report)
    elif a.implied:
        implied(a.world, rep=a.report)
    elif a.second:
        second(a.world, rep=a.report)
    else:
        report(a.world) if a.report else run(a.world)
