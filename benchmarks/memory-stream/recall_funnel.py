"""C11-E1: where needed memories rank under model-free candidate generators built from dream-written row fields.

For each dev human need turn in the judge sample and each needed item, the best rank of a visible row covering the
item under each generator; recall@k and the share at rank ≤ 3 (a scale proxy).

    python3 benchmarks/memory-stream/recall_funnel.py [--worlds code life]             (C11-E1 generator table)
    python3 benchmarks/memory-stream/recall_funnel.py --channels                      (C11-E1 channel table)
    python3 benchmarks/memory-stream/recall_funnel.py --missing                       (C11-E3: what dreaming left out)
    python3 benchmarks/memory-stream/recall_funnel.py --actions                       (C11-E2: action registry, caps)
    python3 benchmarks/memory-stream/recall_funnel.py --cards                         (C11-E4: dream action cards)
    python3 benchmarks/memory-stream/recall_funnel.py --worlds life --episodes        (C11-E5: episodic layer)
    python3 benchmarks/memory-stream/recall_funnel.py --growth                        (C11-E6: channel growth)
"""
import argparse, datetime, glob, json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M

MONTHS = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                          "september", "october", "november", "december"])}
DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def rrf(*rankings, k=60):
    """Reciprocal rank fusion of score dicts: {row: Σ 1 / (k + rank)}."""
    out = {}
    for sc in rankings:
        for r, i in enumerate(sorted(sc, key=lambda i: (-sc[i], i))):
            out[i] = out.get(i, 0.0) + 1.0 / (k + r + 1)
    return out


def row_dates(times, year):
    """Calendar dates a row's `when.times` names (ISO, MM-DD, "Month D"); weekdays as names."""
    dates, days = set(), set()
    for t in times or []:
        s = t.lower()
        for y, m, d in re.findall(r"(\d{4})-(\d{2})-(\d{2})", s):
            dates.add(datetime.date(int(y), int(m), int(d)))
        for m, d in re.findall(r"(?<![\d-])(\d{2})-(\d{2})(?![\d-])", s):
            if 1 <= int(m) <= 12 and 1 <= int(d) <= 31:
                try:
                    dates.add(datetime.date(year, int(m), int(d)))
                except ValueError:
                    pass
        for name, d in re.findall(r"(" + "|".join(MONTHS) + r")\s+(\d{1,2})\b", s):
            try:
                dates.add(datetime.date(year, MONTHS[name], int(d)))
            except ValueError:
                pass
        days |= {d for d in DAYS if d in s or d[:3] + "s" in s}
    return dates, days


class Generators:
    def __init__(self, world):
        import score, sleep
        self.stream, self.items = score.load_stream(world)
        self.cov = score.Coverage(self.items)
        self.rows = sleep.rows(self.stream, world, strict=True)
        self.lex = M.make("lex:when=1", self.rows, self.stream, self.items, self.cov)
        self.bank = M.make("bank:tau=0.0,when=1", self.rows, self.stream, self.items, self.cov)
        self.by_id = self.lex.by_id
        self.ents = {}
        df = {}
        for r in self.rows:
            w = r.get("when") or {}
            es = {e.lower().strip() for e in (r.get("entities") or []) + (w.get("entities") or [])
                  if len(e.strip()) >= 3}
            self.ents[r["id"]] = es
            for e in es:
                df[e] = df.get(e, 0) + 1
        self.eidf = {e: math.log(len(self.rows) / d) for e, d in df.items()}
        self.vocab = sorted(df, key=len, reverse=True)
        self.day, self.ctx = {}, {}
        for sess in self.stream["sessions"]:
            hist, last = [], ""
            for ev in sess["events"]:
                self.day[ev["id"]] = datetime.date.fromisoformat(sess["ts"][:10])
                self.ctx[ev["id"]] = " ".join(hist[-2:] + [last])
                if ev["t"] == "human":
                    hist.append(M.strip_paste(ev["text_all"]))
                elif ev["t"] == "assistant":
                    last = ev.get("text") or ""

    def mentioned(self, text):
        t = text.lower()
        return {e for e in self.vocab if e in t and re.search(r"(?<![a-z0-9])" + re.escape(e) + r"(?![a-z0-9])", t)}

    def score_all(self, e):
        now = e["_order"]
        vis = {r["id"] for r in self.lex.visible(now)}
        q = dict(e, text_all=M.strip_paste(e["text_all"]))
        lex = self.lex.scores(q, now)
        bank = self.bank.scores(q, now)
        g0 = rrf(lex, bank)
        lctx = self.lex.scores(dict(e, text_all=q["text_all"] + " " + self.ctx.get(e["id"], "")), now)
        # entity index: rows holding a rare entity the turn (or its session context) mentions
        ment = self.mentioned(q["text_all"] + " " + self.ctx.get(e["id"], ""))
        ent = {i: sum(self.eidf[x] for x in self.ents[i] & ment) for i in vis if self.ents[i] & ment}
        # entity graph: rows sharing rare entities with the top-5 fused rows
        seeds = sorted(g0, key=lambda i: -g0[i])[:5]
        seed_e = set().union(*(self.ents[i] for i in seeds)) if seeds else set()
        graph = {i: sum(self.eidf[x] for x in self.ents[i] & seed_e) for i in vis
                 if i not in seeds and self.ents[i] & seed_e}
        # time index: rows whose times name a date in the next 14 days, or the turn's weekday
        d = self.day[e["id"]]
        tm = {}
        for i in vis:
            dates, days = row_dates((self.by_id[i].get("when") or {}).get("times"), d.year)
            hit = sum(1 for x in dates if 0 <= (x - d).days <= 14) + (DAYS[d.weekday()] in days)
            if hit:
                tm[i] = float(hit)
        return {"G0": g0, "G1": rrf(lex, bank, lctx), "G2": rrf(lex, bank, ent, graph),
                "G3": rrf(lex, bank, tm), "G4": rrf(lex, bank, lctx, ent, graph, tm)}, vis


def turn_times(text, d):
    """Weekdays and months a turn names ("sunday", "weekend", "tomorrow", "july", "next week")."""
    t = text.lower()
    days, months = set(), set()
    for n in DAYS:
        if re.search(r"\b" + n[:3] + r"(day|s|\b)", t):
            days.add(n)
    if "weekend" in t:
        days |= {"saturday", "sunday"}
    if "tomorrow" in t:
        days.add(DAYS[(d.weekday() + 1) % 7])
    if "tonight" in t or "today" in t:
        days.add(DAYS[d.weekday()])
    if "next week" in t or "this week" in t:
        days |= set(DAYS)
    for m in MONTHS:
        if re.search(r"\b" + m[:3] + r"\w*\b", t):
            months.add(m)
    return days, months


def need_turns(g, world):
    import score
    jud = set()
    for p in glob.glob(os.path.join(HERE, "judge", f"{world}-sleep", "in", "*.json")):
        jud |= {c["event"] for c in json.load(open(p))["cases"]}
    for e in score.scored_events(g.stream):
        if e["_split"] == "dev" and e["t"] == "human" and e["id"] in jud:
            need = set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))
            if need:
                yield e, need


def channels(world):
    """C11-E1 channel table: G0's top 15, the entity channel (rows holding an entity the turn or its session names),
    the time channel (rows whose times share a weekday or month the turn names) and their union, as sets."""
    g = Generators(world)
    hits = {"G0@15": 0, "entity": 0, "time": 0, "union": 0}
    tot, pools = 0, []
    for e, need in need_turns(g, world):
        vis = {r["id"] for r in g.lex.visible(e["_order"])}
        text, ctx = M.strip_paste(e["text_all"]), g.ctx.get(e["id"], "")
        gens, _ = g.score_all(e)
        g0 = set(sorted(gens["G0"], key=lambda i: -gens["G0"][i])[:15])
        ment = g.mentioned(text + " " + ctx)
        ent = {i for i in vis if g.ents[i] & ment}
        days, months = turn_times(text, g.day[e["id"]])
        tm = set()
        for i in vis:
            s = " ".join((g.by_id[i].get("when") or {}).get("times") or []).lower()
            if any(x in s or x[:3] + "s" in s for x in days) or any(m in s for m in months):
                tm.add(i)
        pool = g0 | ent | tm
        pools.append(len(pool))
        for item in need:
            cover = [i for i in vis if item in g.by_id[i]["covers"]]
            if not cover:
                continue
            tot += 1
            for name, S in (("G0@15", g0), ("entity", ent), ("time", tm), ("union", pool)):
                hits[name] += any(i in S for i in cover)
    pools.sort()
    print(world, "needed items with a covering row", tot, {k: round(v / tot, 2) for k, v in hits.items()},
          "union pool median", pools[len(pools) // 2], "p90", pools[int(0.9 * len(pools))])


def actions(world, thr=0.5, caps=(15, 20, 10, 20)):
    """C11-E2: the action channel (rows the dreaming step tagged with an action type Jev says the turn involves,
    p ≥ thr), its union with C11-E1's channels, and the same union with each channel capped (G0, entity, time, action;
    entity and action ranked by lexical score with cues, then recency; time by recency) so the candidate set stays
    bounded however large the store grows."""
    g = Generators(world)
    tags = {}
    for p in sorted(glob.glob(os.path.join(HERE, "dream", world, "out", "tags-*.json"))):
        tags.update(json.load(open(p))["tags"])
    turn_act = json.load(open(os.path.join(HERE, "dream", world, "turn-actions.json")))
    names = ("G0@15", "entity", "time", "action", "union", "capped union")
    hits = dict.fromkeys(names, 0)
    tot, pools, capped = 0, [], []
    for e, need in need_turns(g, world):
        now = e["_order"]
        vis = {r["id"] for r in g.lex.visible(now)}
        text, ctx = M.strip_paste(e["text_all"]), g.ctx.get(e["id"], "")
        gens, _ = g.score_all(e)
        g0r = sorted(gens["G0"], key=lambda i: (-gens["G0"][i], i))
        g0 = set(g0r[:caps[0]])
        lex = g.lex.scores(dict(e, text_all=text), now)
        key = lambda i: (-lex.get(i, 0.0), -g.by_id[i]["t"], i)
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
        pool = g0 | ent | tm | act
        cap = (g0 | set(sorted(ent, key=key)[:caps[1]]) | set(sorted(tm, key=lambda i: -g.by_id[i]["t"])[:caps[2]])
               | set(sorted(act, key=key)[:caps[3]]))
        pools.append(len(pool))
        capped.append(len(cap))
        for item in need:
            cover = [i for i in vis if item in g.by_id[i]["covers"]]
            if not cover:
                continue
            tot += 1
            for name, S in zip(names, (g0, ent, tm, act, pool, cap)):
                hits[name] += any(i in S for i in cover)
    pools.sort()
    capped.sort()
    print(world, f"thr {thr}, caps {caps}; needed items with a covering row", tot,
          {k: round(v / tot, 2) for k, v in hits.items()})
    print("   union pool median / p90", pools[len(pools) // 2], pools[int(0.9 * len(pools))],
          "| capped median / max", capped[len(capped) // 2], capped[-1])


def cards(world, thr=0.5):
    """C11-E4: action cards as the bounded action channel. A turn sees the cards written after the last batch whose
    rows are visible to it; a needed item is covered when a line of a card for one of the turn's action types (Jev
    p ≥ thr) cites a row covering it. Union with G0@15, entity (cap 20, lexical order) and time (cap 10, recency)."""
    g = Generators(world)
    turn_act = json.load(open(os.path.join(HERE, "dream", world, "turn-actions.json")))
    snaps = []
    for p in sorted(glob.glob(os.path.join(HERE, "dream", world, "cards", "*.json"))):
        c = json.load(open(p))
        ts = [g.by_id[i]["t"] for i in g.by_id if i.startswith(c["batch"] + ":")]
        snaps.append((max(ts), c["cards"]))
    names = ("cards", "G0+entity+time capped", "union with cards")
    hits = dict.fromkeys(names, 0)
    tot, pools, lines = 0, [], []
    for e, need in need_turns(g, world):
        now = e["_order"]
        vis = {r["id"] for r in g.lex.visible(now)}
        text, ctx = M.strip_paste(e["text_all"]), g.ctx.get(e["id"], "")
        gens, _ = g.score_all(e)
        g0 = set(sorted(gens["G0"], key=lambda i: (-gens["G0"][i], i))[:15])
        lex = g.lex.scores(dict(e, text_all=text), now)
        ment = g.mentioned(text + " " + ctx)
        ent = sorted((i for i in vis if g.ents[i] & ment), key=lambda i: (-lex.get(i, 0.0), -g.by_id[i]["t"], i))[:20]
        days, months = turn_times(text, g.day[e["id"]])
        tm = []
        for i in vis:
            s = " ".join((g.by_id[i].get("when") or {}).get("times") or []).lower()
            if any(x in s or x[:3] + "s" in s for x in days) or any(m in s for m in months):
                tm.append(i)
        tm = sorted(tm, key=lambda i: -g.by_id[i]["t"])[:10]
        base = g0 | set(ent) | set(tm)
        cur = None
        for t, c in snaps:
            if t < now:
                cur = c
        want = {k for k, v in (turn_act.get(e["id"]) or {}).items() if v is not None and v >= thr}
        card_lines = [ln for k in want for ln in (cur or {}).get(k, [])]
        cited = {i for ln in card_lines for i in ln.get("rows", []) if i in g.by_id}
        pools.append(len(base) + len(card_lines))
        lines.append(len(card_lines))
        for item in need:
            cover = {i for i in vis if item in g.by_id[i]["covers"]}
            if not cover:
                continue
            tot += 1
            in_cards = bool(cover & cited) or any(item in g.by_id[i]["covers"] for i in cited)
            hits["cards"] += in_cards
            hits["G0+entity+time capped"] += bool(cover & base)
            hits["union with cards"] += in_cards or bool(cover & base)
    pools.sort()
    lines.sort()
    print(world, "needed items with a covering row", tot, {k: round(v / tot, 2) for k, v in hits.items()})
    print("   card lines per turn median / max", lines[len(lines) // 2], lines[-1],
          "| pool (rows + card lines) median / max", pools[len(pools) // 2], pools[-1])


def episodes(world):
    """C11-E5: dream-written episode records as a second store. Each record is visible after its batch's last
    session (as `--strict` rows). Reports needed items covered by visible rows, by episodes, by either (by item kind),
    and for items only episodes cover, whether a lexical or entity lookup over the episodes finds them."""
    g = Generators(world)
    end = {}
    order = 0
    for s in g.stream["sessions"]:
        for ev in s["events"]:
            order += 1
        end[s["id"]] = order
    eps = []
    for p in sorted(glob.glob(os.path.join(HERE, "dream", world, "episodes", "*.json"))):
        d = json.load(open(p))
        last = max(end.get(x["id"], 0) for x in d["sessions"])
        for x in d["sessions"]:
            for n, ep in enumerate(x.get("episodes", [])):
                eps.append({"id": f"{x['id']}:e{n}", "text": ep["text"], "kind": "episode", "t": last + 0.5,
                            "invalid_at": None, "entities": ep.get("entities") or [], "when": {}})
    elex = M.make("lex", eps, g.stream, g.items, g.cov)
    kind = {x["id"]: x["kind"] for x in g.items} if isinstance(g.items, list) else {k: v["kind"] for k, v in
                                                                                    g.items.items()}
    stat = {}
    found = {"lexical top 10": 0, "entity": 0, "either": 0}
    only = 0
    for e, need in need_turns(g, world):
        now = e["_order"]
        rows_have = {i for r in g.lex.visible(now) for i in r["covers"]}
        vis_eps = elex.visible(now)
        text = M.strip_paste(e["text_all"])
        sc = elex.scores(dict(e, text_all=text + " " + g.ctx.get(e["id"], "")), now)
        top = set(sorted(sc, key=lambda i: (-sc[i], i))[:10])
        ment = g.mentioned(text + " " + g.ctx.get(e["id"], ""))
        for item in need:
            k = kind[item]
            st = stat.setdefault(k, [0, 0, 0, 0])
            st[0] += 1
            r_ok = item in rows_have
            cover = [x["id"] for x in vis_eps if item in elex.by_id[x["id"]]["covers"]]
            st[1] += r_ok
            st[2] += bool(cover)
            st[3] += r_ok or bool(cover)
            if cover and not r_ok:
                only += 1
                lx = any(i in top for i in cover)
                en = any({z.lower() for z in elex.by_id[i]["entities"]} & ment for i in cover)
                found["lexical top 10"] += lx
                found["entity"] += en
                found["either"] += lx or en
    print(world, len(eps), "episode records")
    print("   needed items by kind: total / in rows / in episodes / in either")
    for k, (n, a, b, c) in sorted(stat.items()):
        print(f"     {k:12s} {n:3d} / {a:3d} / {b:3d} / {c:3d}")
    tot = [sum(v[i] for v in stat.values()) for i in range(4)]
    print("   all", tot, "store ceiling rows", round(tot[1] / tot[0], 3), "→ rows + episodes",
          round(tot[3] / tot[0], 3))
    print("   items only episodes cover:", only, {k: v for k, v in found.items()})


def missing(world):
    """C11-E3: needed items no visible row covers even in the session-end store (rows visible after their own
    session, `strict=False`), by item kind; and the share of every world item the compiler ever stored."""
    import score, sleep
    g = Generators(world)
    rows = sleep.rows(g.stream, world, strict=False)
    o = M.make("lex", rows, g.stream, g.items, g.cov)
    kind = {x["id"]: x["kind"] for x in g.items} if isinstance(g.items, list) else {k: v["kind"] for k, v in
                                                                                    g.items.items()}
    need_k, miss_k = {}, {}
    for e, need in need_turns(g, world):
        have = {i for r in o.visible(e["_order"]) for i in r["covers"]}
        for n in need:
            need_k[kind[n]] = need_k.get(kind[n], 0) + 1
            miss_k[kind[n]] = miss_k.get(kind[n], 0) + (n not in have)
    print(world, "needed, absent from the session-end store:", {k: f"{miss_k[k]}/{need_k[k]}" for k in need_k})
    stored = {i for r in o.rows for i in r["covers"]}
    tot, got = {}, {}
    for n, k in kind.items():
        tot[k] = tot.get(k, 0) + 1
        got[k] = got.get(k, 0) + (n in stored)
    print("   every world item, share ever stored:", {k: f"{got[k]}/{tot[k]}" for k in tot})


def run(world):
    import score
    g = Generators(world)
    jud = set()
    for p in glob.glob(os.path.join(HERE, "judge", f"{world}-sleep", "in", "*.json")):
        jud |= {c["event"] for c in json.load(open(p))["cases"]}
    evs = [e for e in score.scored_events(g.stream) if e["_split"] == "dev" and e["t"] == "human" and e["id"] in jud]
    ranks = {}
    n_store = 0
    for e in evs:
        need = set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))
        if not need:
            continue
        gens, vis = g.score_all(e)
        for item in need:
            cover = [i for i in vis if item in g.by_id[i]["covers"]]
            n_store += bool(cover)
            for name, sc in gens.items():
                order = {i: r + 1 for r, i in enumerate(sorted(sc, key=lambda i: (-sc[i], i)))}
                best = min((order.get(i, 10 ** 9) for i in cover), default=None)
                ranks.setdefault(name, []).append(best)
    n = len(ranks["G0"])
    print(world, f"needed items {n}; in store {n_store} ({n_store / n:.2f})")
    for name, rs in ranks.items():
        row = {f"@{k}": round(sum(1 for r in rs if r is not None and r <= k) / n, 3) for k in (3, 5, 15, 50)}
        print(f"  {name}", row)


def growth(world, thr=0.5):
    """C11-E6: how each channel's set grows with the visible store N. Per channel, the least-squares slope of
    log(set size) on log(N) over turns with N ≥ 20 and a non-empty set, and the share of empty sets; G0@15 recall
    below and above the median N."""
    g = Generators(world)
    tags = {}
    for p in sorted(glob.glob(os.path.join(HERE, "dream", world, "out", "tags-*.json"))):
        tags.update(json.load(open(p))["tags"])
    turn_act = json.load(open(os.path.join(HERE, "dream", world, "turn-actions.json")))
    pts = {"entity": [], "time": [], "action": []}
    turns, g0hits = 0, []
    for e, need in need_turns(g, world):
        vis = {r["id"] for r in g.lex.visible(e["_order"])}
        n = len(vis)
        text, ctx = M.strip_paste(e["text_all"]), g.ctx.get(e["id"], "")
        gens, _ = g.score_all(e)
        g0 = set(sorted(gens["G0"], key=lambda i: (-gens["G0"][i], i))[:15])
        ment = g.mentioned(text + " " + ctx)
        days, months = turn_times(text, g.day[e["id"]])
        tm = set()
        for i in vis:
            s = " ".join((g.by_id[i].get("when") or {}).get("times") or []).lower()
            if any(x in s or x[:3] + "s" in s for x in days) or any(m in s for m in months):
                tm.add(i)
        want = {k for k, v in (turn_act.get(e["id"]) or {}).items() if v is not None and v >= thr}
        sets = {"entity": {i for i in vis if g.ents[i] & ment}, "time": tm,
                "action": {i for i in vis if want & set(tags.get(i, []))}}
        if n >= 20:
            turns += 1
            for k, S in sets.items():
                pts[k].append((n, len(S)))
        for item in need:
            cover = [i for i in vis if item in g.by_id[i]["covers"]]
            if cover:
                g0hits.append((n, any(i in g0 for i in cover)))
    print(world, turns, "turns with N >= 20")
    for k, v in pts.items():
        xy = [(math.log(n), math.log(m)) for n, m in v if m]
        if len(xy) < 3:
            print(f"   {k:7s} too few non-empty sets ({len(xy)} of {len(v)})")
            continue
        mx, my = sum(x for x, _ in xy) / len(xy), sum(y for _, y in xy) / len(xy)
        b = sum((x - mx) * (y - my) for x, y in xy) / sum((x - mx) ** 2 for x, _ in xy)
        a = my - b * mx
        proj = {f"1e{p}": round(math.exp(a + b * p * math.log(10))) for p in (4, 5, 6)}
        frac = sorted(m / n for n, m in v)
        print(f"   {k:7s} slope b {b:.3f}  empty {sum(1 for _, m in v if not m)}/{len(v)}  share of N median "
              f"{frac[len(frac) // 2]:.3f}  projected set size {proj}")
    med = sorted(n for n, _ in g0hits)[len(g0hits) // 2]
    lo = [h for n, h in g0hits if n < med]
    hi = [h for n, h in g0hits if n >= med]
    print(f"   G0@15 recall: N < {med}: {sum(lo)}/{len(lo)} = {sum(lo) / len(lo):.3f}; "
          f"N >= {med}: {sum(hi)}/{len(hi)} = {sum(hi) / len(hi):.3f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worlds", nargs="*", default=["code", "life"])
    ap.add_argument("--channels", action="store_true", help="C11-E1 channel table")
    ap.add_argument("--missing", action="store_true", help="C11-E3 dreaming omissions")
    ap.add_argument("--actions", action="store_true", help="C11-E2 action registry and per-channel caps")
    ap.add_argument("--cards", action="store_true", help="C11-E4 dream action cards")
    ap.add_argument("--episodes", action="store_true", help="C11-E5 episodic layer")
    ap.add_argument("--growth", action="store_true", help="C11-E6 channel growth with store size")
    ap.add_argument("--thr", type=float, default=0.5, help="--actions: Jev threshold for a turn's action types")
    a = ap.parse_args()
    for w in a.worlds:
        if a.actions:
            actions(w, a.thr)
        elif a.cards:
            cards(w, a.thr)
        elif a.episodes:
            episodes(w)
        elif a.growth:
            growth(w)
        else:
            (channels if a.channels else missing if a.missing else run)(w)
