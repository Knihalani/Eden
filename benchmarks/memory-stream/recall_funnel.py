"""C11-E1: where needed memories rank under model-free candidate generators built from dream-written row fields.

For each dev human need turn in the judge sample and each needed item, the best rank of a visible row covering the
item under each generator; recall@k and the share at rank ≤ 3 (a scale proxy).

    python3 benchmarks/memory-stream/recall_funnel.py [--worlds code life]
"""
import argparse, datetime, glob, json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import methods as M
from text import content

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
            es = {e.lower().strip() for e in (r.get("entities") or []) + (w.get("entities") or []) if len(e.strip()) >= 3}
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
        self.year = {r["id"]: None for r in self.rows}

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


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worlds", nargs="*", default=["code", "life"])
    for w in ap.parse_args().worlds:
        run(w)
