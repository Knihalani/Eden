"""M5 (D910-D919, docs/research/m5-ledger.md): the standing-constraint ledger matched against a request with no model.

Reads a ledger (`m5-ledger.ts extract`: per item content hash, typed records), a corpus dump and a pool dump
(`days-calls.ts --corpus-dump --pool-diag`, or the funnel's `--corpus-dump --pool-dump`), and for each request:

  1. the user's live records: effect "blocks", or kind "done" (an action already taken blocks doing it again); a
     blocks record is dropped when a later "clears" record of the same user shares its anchors (supersession);
  2. a record matches when the request names one of its specific anchors (a person, an organisation or place, a
     reference) exactly, as whole words; anchors common across the user's records (the user's own name) do not count;
  3. a dated record whose days the request's explicit dates miss is rejected (another day); a record whose
     organisations include one the request does not name but a sibling anchor it does is kept;
  4. matches are ranked by anchor weight (rarity) and put before the shipped pool, at most `--front` of them, and the
     first five are the packet's candidates (@5).

Simulated data only. Prints facts and decoys @5 for the shipped pool and the ledger arm, by fold.

  python3 -I m5_match.py --ledger L.jsonl --corpus C.jsonl[,C2] --pool P.jsonl[,P2] [--heldout train5,train6]
"""
import argparse, hashlib, json, re, sys, unicodedata
from collections import Counter, defaultdict
from datetime import date

MONTHS = {m: i + 1 for i, m in enumerate(
    "january february march april may june july august september october november december".split())}
for k, v in list(MONTHS.items()):
    MONTHS[k[:3]] = v
MONTHS["sept"] = 9
STOP = set("the a an and of for at in on to my our with ltd limited co inc plc team service services group".split())


def fold(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def toks(s):
    return re.findall(r"[a-z0-9]+(?:[-'][a-z0-9]+)*", fold(s).replace("’", "'"))


def key(title, text):
    return hashlib.sha256(f"{title}\n{text}".encode()).hexdigest()[:20]


def req_dates(text, year):
    """Explicit days a request names (day month, month day, ranges "19-23 November"), as dates in `year`'s frame."""
    t = fold(text).replace("–", "-").replace("—", "-")
    out = []
    mon = "|".join(sorted(MONTHS, key=len, reverse=True))
    for m in re.finditer(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s*(?:-|to)\s*(\d{{1,2}})(?:st|nd|rd|th)?\s+({mon})\b", t):
        a, b, mo = int(m.group(1)), int(m.group(2)), MONTHS[m.group(3)]
        for d in range(a, min(b, 31) + 1):
            out.append((mo, d))
    for m in re.finditer(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({mon})\b", t):
        out.append((MONTHS[m.group(2)], int(m.group(1))))
    for m in re.finditer(rf"\b({mon})\s+(\d{{1,2}})(?:st|nd|rd|th)?\b", t):
        out.append((MONTHS[m.group(1)], int(m.group(2))))
    res = []
    for mo, d in out:
        # The request names no year: the one nearest the user's clock (`year` is the world's).
        for y in (year, year + 1):
            try:
                res.append(date(y, mo, d))
            except ValueError:
                pass
    return res


def pdate(s):
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


class Ledger:
    """One user's records, with each anchor's phrase tokens and weight."""

    def __init__(self, recs, common_share=0.05):
        self.recs = recs  # [(item_id, record)]
        df = Counter()
        for _, r in recs:
            seen = set()
            for a in r.get("who", []) + r.get("org", []) + r.get("ref", []):
                seen.update(t for t in toks(a) if t not in STOP)
            df.update(seen)
        n = max(1, len(recs))
        self.common = {t for t, c in df.items() if c / n > common_share and c >= 5}
        self.df = df
        self.n = n

    def anchors(self, r):
        """(kind, token set, weight) per anchor: a person matches by any distinctive name token (first name or
        surname); an organisation or place by all of its distinctive tokens; a reference by its exact token."""
        out = []
        for a in r.get("who", []):
            ts = [t for t in toks(a) if t not in STOP and t not in self.common and len(t) > 1]
            for t in ts:
                out.append(("who", (t,), 2.0))
        for a in r.get("roles", []):
            ts = tuple(stem(t) for t in toks(a) if t not in STOP and t not in self.common)
            if ts:
                out.append(("role", ts, 2.0))
        for a in r.get("org", []):
            ts = tuple(t for t in toks(a) if t not in STOP and t not in self.common)
            if ts:
                out.append(("org", ts, 2.5))
                # A long name is often said in part ("Glenrigg" for "Glenrigg Distillery"): its rarest token alone.
                if len(ts) > 1:
                    rare = min(ts, key=lambda t: self.df.get(t, 0))
                    if len(rare) > 3:
                        out.append(("org1", (rare,), 2.0))
        for a in r.get("ref", []):
            ts = tuple(toks(a))
            if ts:
                out.append(("ref", ts, 4.0))
        return out


def supersede(recs):
    """Drop a blocks record answered by a later clears record of the same user sharing a specific anchor and a thing."""
    df = Counter(fold(x) for _, r in recs for x in set(r.get("who", []) + r.get("org", []) + r.get("ref", [])))
    common = {x for x, c in df.items() if c / max(1, len(recs)) > 0.05 and c >= 5}
    clears = [(i, r) for i, r in recs if r["effect"] == "clears" and r.get("kind") != "done"]
    out = []
    for i, r in recs:
        if r["effect"] == "clears" and r.get("kind") != "done":
            continue
        a = {fold(x) for x in r.get("who", []) + r.get("org", []) + r.get("ref", [])} - common
        th = {fold(x) for x in r.get("things", [])}
        gone = False
        for j, c in clears:
            if j == i:
                continue
            ca = {fold(x) for x in c.get("who", []) + c.get("org", []) + c.get("ref", [])} - common
            if a & ca and th & {fold(x) for x in c.get("things", [])} and (c.get("said") or "") >= (r.get("said") or ""):
                gone = True
                break
        if not gone:
            out.append((i, r))
    return out


def stem(t):
    """A plural or verb ending off, so "certificates" meets "certificate" and "renewed" meets "renew"."""
    for suf in ("ies", "es", "s", "ed", "ing"):
        if len(t) > len(suf) + 3 and t.endswith(suf):
            return t[: -len(suf)] + ("y" if suf == "ies" else "")
    return t


GENERIC = set("""booking bookings payment payments meeting calendar email data travel access change changes event events
    appointment request requests order orders account accounts plan plans date dates time schedule message note notes
    work team call update reminder approval approvals cancel cancellation renewal delivery money cost""".split())


def thing_hits(r, rstems):
    """The record's plain things the request says (each word of a thing, stemmed; generic words do not count)."""
    hits = []
    for th in r.get("things", []):
        ws = [stem(t) for t in toks(th) if t not in STOP and t not in GENERIC and len(t) > 2]
        if ws and all(w in rstems for w in ws):
            hits.append(th)
    return hits


def match(led, request, year, min_score=2.0, things_w=1.0, general=True, day_w=0.0, loose=False):
    rt = toks(request)
    rset = set(rt)
    rstems = {stem(t) for t in rt}
    rtext = " " + " ".join(rt) + " "
    days = req_dates(request, year)
    scored = defaultdict(float)
    why = {}
    for iid, r in led.recs:
        s = 0.0
        hit = []
        anchors = led.anchors(r)
        for kind, ts, w in anchors:
            if kind == "role":
                ok = all(t in rstems for t in ts)
            elif kind == "who":
                # A short form of a name ("Chris" for "Christopher").
                ok = ts[0] in rset or any(len(t) >= 4 and ts[0].startswith(t) for t in rset)
            else:
                ok = (len(ts) == 1 and ts[0] in rset) or (len(ts) > 1 and f" {' '.join(ts)} " in rtext)
            if ok:
                s += w
                hit.append(" ".join(ts))
        # A record about a specific person, organisation or reference the request does not name is about someone or
        # something else (D526's look-alikes): its plain things alone never match it. A general rule (no specific
        # anchor beyond the user's own) matches on its things.
        if general and (s > 0 or not anchors or loose):
            th = thing_hits(r, rstems)
            s += things_w * len(th)
            hit += th
        # A dated record whose days hold a day the request names (a clash, an absence, a closure on that day).
        if day_w and r.get("dated") and days:
            f, t = pdate(r.get("from")), pdate(r.get("to"))
            if (f or t) and any((f or t) <= d <= (t or f) for d in days):
                s += day_w
                hit.append("day")
        if s < min_score:
            continue
        if r.get("dated") and days:
            f, t = pdate(r.get("from")), pdate(r.get("to"))
            if f or t:
                f, t = f or t, t or f
                if not any(f <= d <= t for d in days):
                    continue
        if s > scored[iid]:
            scored[iid] = s
            why[iid] = hit
    return sorted(scored, key=lambda i: -scored[i]), why


def load_jsonl(paths):
    for p in paths.split(","):
        for l in open(p):
            if l.strip():
                yield json.loads(l)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--ledger", required=True)
    a.add_argument("--corpus", required=True)
    a.add_argument("--pool", required=True)
    a.add_argument("--heldout", default="train5,train6")
    a.add_argument("--front", type=int, default=2)  # frozen (§2)
    a.add_argument("--min-score", type=float, default=2.0)
    a.add_argument("--show", default="")
    a.add_argument("--things-w", type=float, default=2.0)  # frozen (§2)
    a.add_argument("--no-general", action="store_true")
    a.add_argument("--day-w", type=float, default=0.0)
    a.add_argument("--strict", action="store_true", help="things only for records with no foreign anchor")
    a.add_argument("--year", type=int, default=2026)
    a.add_argument("--only", default="fit", help="fit | held | all: the held-out rows are read once per frozen version")
    o = a.parse_args()
    ledger = {}
    for x in load_jsonl(o.ledger):
        ledger[x["k"]] = x["r"]
    worlds = {}
    missing = 0
    for w in load_jsonl(o.corpus):
        wk = (w.get("suite", "days"), w["seed"], w.get("variant", "days"))
        recs = []
        for it in w["items"]:
            rr = ledger.get(key(it["title"], it["text"]))
            if rr is None:
                missing += 1
                continue
            for r in rr:
                recs.append((it["id"], r))
        worlds[wk] = Ledger(supersede(recs))
    agg = defaultdict(Counter)
    for p in load_jsonl(o.pool):
        wk = (p.get("suite", "days"), p["seed"], p.get("variant", "days"))
        if wk not in worlds:
            continue
        kind = p.get("kind") or p.get("variant")
        pool = p["pool"] if p["pool"] and isinstance(p["pool"][0], str) else [x["id"] for x in p["pool"]]
        tmpl = p["template"] if "/" in p["template"] else f"{p['suite']}/{p['template']}"
        fold_ = "held" if tmpl.split("/")[0] in o.heldout.split(",") else "fit"
        if o.only != "all" and fold_ != o.only:
            continue
        m, why = match(worlds[wk], p["request"], o.year, o.min_score, o.things_w, not o.no_general, o.day_w, not o.strict)
        front = [i for i in m[: o.front]]
        arm = front + [i for i in pool if i not in front]
        g = agg[(fold_, kind)]
        g["n"] += 1
        x = p.get("planted") or ""
        g["ship@5"] += x in pool[:5]
        g["led@5"] += x in arm[:5]
        g["ledger_hit"] += x in m
        g["fires"] += bool(front)
        g["fires_new"] += bool(set(front) - set(pool[:5]))
        if o.show and kind in o.show.split(",") and (x in pool[:5]) != (x in arm[:5]):
            print(f"[{kind} {'+' if x in arm[:5] else '-'}] {tmpl} | {p['request'][:100]} | {why.get(x) or [why.get(i) for i in front]}")
    print(f"items without a ledger line: {missing}")
    for k in sorted(agg):
        g = agg[k]
        print(f"{k[0]:4s} {k[1]:8s} n {g['n']:4d}  ship@5 {g['ship@5']:4d}  ledger@5 {g['led@5']:4d}  "
              f"in-matches {g['ledger_hit']:4d}  fires {g['fires']:4d} (new in top5 {g['fires_new']})")


if __name__ == "__main__":
    sys.exit(main())
