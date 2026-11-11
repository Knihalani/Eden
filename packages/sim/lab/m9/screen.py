"""M9 hypotheses screen ($0, no model): each hypothesis is a per-user link structure (links.py) that turns a request
into a small set of linked items; the first `--front` of them go before the shipped push pool, as M5 measured.

  python3 -I screen.py --corpus C.jsonl --pool P.jsonl --hyp nick,porg,role --only fit [--show hidden]

Prints facts @5 (hidden), decoys @5 (control) and neutral additions (new items in the first five; and requests whose
shipped pool handed nothing that would now get an item) against the shipped pool, by fold. Simulated data only.
"""
import argparse
import re
import sys
import time
from collections import Counter, defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import data  # noqa: E402
import links  # noqa: E402
from links import ROLES, DIMINUTIVE, fold, toks, content  # noqa: E402

CAP = re.compile(r"\b[A-Z][a-zà-ÿ'’-]+\b")


def resolve_people(u, request):
    """Persons the request names: a full name, a unique first name, or a nickname/prefix of one person's first name.
    Returns (person keys, how) where how is 'name' or 'nick'."""
    out = {}
    low = f" {fold(request)} "
    for k in u.people:
        if f" {k} " in low:
            out[k] = "name"
    caps = [fold(c) for c in CAP.findall(request)]
    firsts = defaultdict(list)
    for k, p in u.people.items():
        firsts[p["first"]].append(k)
    for c in caps:
        if any(c == fold(p["name"]).split()[0] for p in (u.people[k] for k in out)):
            continue
        if c in firsts and len(firsts[c]) <= 2:
            for k in firsts[c]:
                out.setdefault(k, "first")
        elif c not in firsts:
            full = set(DIMINUTIVE.get(c, []))
            cands = [k for f, ks in firsts.items() for k in ks
                     if f in full or (len(c) >= 3 and f.startswith(c) and len(f) > len(c))]
            if 0 < len(cands) <= 2:
                for k in cands:
                    out.setdefault(k, "nick")
    return out


def resolve_orgs(u, request):
    low = f" {fold(request)} "
    return [o for o in u.org_people if len(o) > 3 and f" {o} " in low]


def resolve_roles(u, request, min_count=2, share=0.5):
    out = {}
    st = set(toks(request))
    for r in st & ROLES:
        c = u.role_person.get(r)
        if not c:
            continue
        tot = sum(c.values())
        (k, n), = c.most_common(1)
        if n >= min_count and n / tot >= share:
            out[k] = r
    return out


def rank_within(u, ids, request, rule_bonus=0.5):
    q = Counter(content(request))
    sc = u.bm25(q) if q else {}
    res = []
    for i in ids:
        s = sc.get(i, 0.0) + (rule_bonus if i in u.rule_items else 0.0)
        res.append((s, i))
    res.sort(reverse=True)
    return res


def candidates(u, request, hyps, o):
    """Linked items for one request, best first, with a reason each."""
    cand = {}
    ppl = resolve_people(u, request) if ({"nick", "porg", "pivot"} & hyps) else {}
    if "nick" in hyps:
        for k, how in ppl.items():
            if how == "nick":
                for s, i in rank_within(u, u.person_items[k], request)[: o.per_link]:
                    cand.setdefault(i, (s + o.bias, f"nick:{k}"))
    if "pivot" in hyps:
        for k, how in ppl.items():
            if how in ("name", "first"):
                for s, i in rank_within(u, u.person_items[k], request)[: o.per_link]:
                    cand.setdefault(i, (s, f"pivot:{k}"))
    if "porg" in hyps:
        for k in ppl:
            for org in u.people[k]["orgs"]:
                q = {w: 1.0 for w in content(org)}
                ids = [i for i, _ in sorted(u.bm25(q).items(), key=lambda x: -x[1])[:50]]
                for s, i in rank_within(u, ids, request)[: o.per_link]:
                    cand.setdefault(i, (s, f"porg:{k}>{org}"))
        for org in resolve_orgs(u, request):
            for k in u.org_people[org]:
                for s, i in rank_within(u, u.person_items[k], request)[: o.per_link]:
                    cand.setdefault(i, (s, f"orgp:{org}>{k}"))
    if "role" in hyps:
        for k, r in resolve_roles(u, request).items():
            for s, i in rank_within(u, u.person_items[k], request)[: o.per_link]:
                cand.setdefault(i, (s + o.bias, f"role:{r}>{k}"))
    if "hop" in hyps:
        for i, v in hop_candidates(u, request, o):
            cand.setdefault(i, v)
    return sorted(cand.items(), key=lambda x: -x[1][0])


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--corpus", required=True)
    a.add_argument("--pool", required=True)
    a.add_argument("--hyp", default="nick,porg,role")
    a.add_argument("--only", default="fit")
    a.add_argument("--front", type=int, default=1)
    a.add_argument("--per-link", type=int, default=2)
    a.add_argument("--bias", type=float, default=0.0)
    a.add_argument("--min-score", type=float, default=0.0)
    a.add_argument("--show", default="")
    a.add_argument("--rare", type=int, default=15)
    a.add_argument("--seeds", type=int, default=5)
    a.add_argument("--bridges", type=int, default=8)
    o = a.parse_args()
    hyps = set(o.hyp.split(","))
    worlds, reqs = data.load(o.corpus, o.pool)
    users = {}
    agg = defaultdict(Counter)
    t_ing = t_req = 0.0
    nreq = 0
    for r in reqs:
        if o.only != "all" and r["fold"] != o.only:
            continue
        if r["w"] not in users:
            t0 = time.perf_counter()
            u = links.User(worlds[r["w"]])
            u.link_domains()
            users[r["w"]] = u
            t_ing += time.perf_counter() - t0
        u = users[r["w"]]
        t0 = time.perf_counter()
        c = [(i, s, why) for i, (s, why) in candidates(u, r["request"], hyps, o) if s >= o.min_score]
        t_req += time.perf_counter() - t0
        nreq += 1
        pool = r["pool"]
        front = [i for i, _, _ in c if i not in pool[:5]][: o.front]
        arm = front + [i for i in pool if i not in front]
        g = agg[(r["fold"], r["kind"])]
        x = r["planted"]
        g["n"] += 1
        g["ship"] += x in pool[:5]
        g["arm"] += x in arm[:5]
        g["reach"] += x in [i for i, _, _ in c]
        g["fires"] += bool(front)
        if r["handed"] is not None and not r["handed"] and front:
            g["newpkt"] += 1
        if o.show and r["kind"] in o.show.split(",") and (x in pool[:5]) != (x in arm[:5]):
            why = [w for i, _, w in c if i in front]
            print(f"[{r['kind']} {'+' if x in arm[:5] else '-'}] {r['template']} | {r['request'][:90]} | {why}")
    for k in sorted(agg):
        g = agg[k]
        print(f"{k[0]:4s} {k[1]:8s} n {g['n']:4d} ship@5 {g['ship']:4d} arm@5 {g['arm']:4d} ({g['arm'] - g['ship']:+d})"
              f" reach {g['reach']:4d} fires {g['fires']:4d} newpkt {g['newpkt']}")
    for f in ("fit", "held"):
        h, c = agg.get((f, "hidden")), agg.get((f, "control"))
        if h and c and h["ship"] and c["ship"]:
            print(f"{f}: facts {h['ship']}->{h['arm']} ({100 * (h['arm'] - h['ship']) / h['n']:+.1f} pts, ratio "
                  f"{h['arm'] / h['ship']:.3f}); decoys {c['ship']}->{c['arm']} (ratio {c['arm'] / c['ship']:.3f})")
    print(f"ingest {1000 * t_ing / max(1, sum(len(u.items) for u in users.values())):.3f} ms/item, "
          f"request {1000 * t_req / max(1, nreq):.3f} ms (python)")



def hop_candidates(u, request, o):
    """C2: spreading activation over the user's item-term graph through rare terms only. Request rare terms -> items
    that hold them (seeds) -> their rare terms not in the request (bridges, weighted by idf and by how many seed items
    hold them) -> items holding bridges. Seeds themselves are not returned (the shipped pool already reaches them)."""
    q = set(content(request))
    lim = o.rare
    qr = [w for w in q if 0 < u.df[w] <= lim]
    if not qr:
        return []
    seeds = Counter()
    for w in qr:
        for i in u.inv[w]:
            seeds[i] += u.idf(w)
    bridge = Counter()
    for i, s in seeds.most_common(o.seeds):
        for w in u.tf[i][0]:
            if w in q or not (1 < u.df[w] <= lim):
                continue
            bridge[w] += s * u.idf(w)
    sc = Counter()
    for w, b in bridge.most_common(o.bridges):
        for i in u.inv[w]:
            if i in seeds:
                continue
            sc[i] += b / u.df[w]
    return [(i, (s, "hop")) for i, s in sc.most_common(10)]


if __name__ == "__main__":
    main()
