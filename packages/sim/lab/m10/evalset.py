"""M10 shared evaluation (lab only): decode a tagger's outputs into cards and score them against Haiku's.

A trainer gives, per row, its raw outputs:
  {"kind": [10 probs], "actions": [14 probs], "bio": [[pO, pB, pI] per token], "roles": [[p_start, p_end] per date
   mention], "amt": [p per amount], "stmt": [score per sentence]}
`decode(row, out)` turns them into a card with the engine's rules (as `MicroCardNet` will in TypeScript), and
`report(rows, cards)` scores held-out rows as `score.py` does, beside Haiku's self-agreement (`card2`) on the rows
that have one, and the fixture gates.

    python3 -I packages/sim/lab/m10/evalset.py --set set.jsonl.gz --preds preds.jsonl [--fixtures fixtures.jsonl
        --fixture-preds fpreds.jsonl --haiku-fixtures fixtures-a.jsonl,fixtures-b.jsonl]
"""
import argparse, gzip, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import ACTIONS, KINDS
from score import score

MAX_ACTIONS = 3
MAX_ENTITIES = 6


def join_tokens(ws):
    out = ""
    for w in ws:
        if out and not re.match(r"^[.,;:!?)\]'’%]", w) and not out.endswith(("(", "[", "£", "$", "€")):
            out += " "
        out += w
    return out


def decode(row, out, t_flag=0.5, t_act=0.5, t_role=0.5, t_amt=0.5):
    probs = out["kind"]
    k = max(range(len(KINDS)), key=lambda i: probs[i])
    if 1 - probs[0] < t_flag:
        k = 0
    elif k == 0:
        k = max(range(1, len(KINDS)), key=lambda i: probs[i])
    if k == 0:
        return {"kind": "none", "actions": [], "entities": [], "statement": ""}
    ap = out["actions"]
    acts = [ACTIONS[i] for i in sorted(range(len(ACTIONS)), key=lambda i: -ap[i]) if ap[i] >= t_act][:MAX_ACTIONS]
    if not acts:
        acts = [ACTIONS[max(range(len(ACTIONS)), key=lambda i: ap[i])]]
    # In the vocabulary's order: two saturated probabilities tie in one precision and not in another.
    acts = [x for x in ACTIONS if x in acts]
    toks = [t[0] for t in row["toks"]]
    ents, cur = [], []
    for i, p in enumerate(out.get("bio", [])):
        tag = max(range(3), key=lambda j: p[j])
        if tag == 1 or (tag == 2 and not cur):
            if cur:
                ents.append(cur)
            cur = [toks[i]]
        elif tag == 2:
            cur.append(toks[i])
        else:
            if cur:
                ents.append(cur)
            cur = []
    if cur:
        ents.append(cur)
    seen, entities = set(), []
    for e in ents:
        s = join_tokens(e)[:60]
        if s.lower() not in seen:
            seen.add(s.lower())
            entities.append(s)
    card = {"kind": KINDS[k], "actions": acts, "entities": entities[:MAX_ENTITIES], "statement": ""}
    roles = out.get("roles", [])
    if roles:
        si = max(range(len(roles)), key=lambda i: roles[i][0])
        ei = max(range(len(roles)), key=lambda i: roles[i][1])
        if roles[si][0] >= t_role:
            card["start"] = row["dates"][si]["day"]
        if roles[ei][1] >= t_role:
            card["end"] = row["dates"][ei]["day"]
        if "start" in card and "end" in card and card["end"] < card["start"]:
            del card["start"]
    am = out.get("amt", [])
    if am:
        i = max(range(len(am)), key=lambda j: am[j])
        if am[i] >= t_amt:
            card["limit"] = row["amounts"][i]["value"]
            card["unit"] = row["amounts"][i]["unit"]
    st = out.get("stmt", [])
    if st:
        s = max(range(len(st)), key=lambda j: st[j])
        card["statement"] = join_tokens([t[0] for t in row["toks"] if t[1] == s])[:160]
    return card


def report(rows, cards, fixtures=None, fcards=None, haiku_fix=None):
    held = [r for r in rows if r["split"] == "heldout"]
    ref = {r["h"]: r["card"] for r in held}
    out = {"micro_vs_haiku": score(ref, cards, [r["h"] for r in held if r["h"] in cards])}
    both = [r for r in held if "card2" in r and r["h"] in cards]
    if both:
        out["subset_n"] = len(both)
        out["haiku_self"] = score(ref, {r["h"]: r["card2"] for r in both}, [r["h"] for r in both])
        out["micro_on_subset"] = score(ref, cards, [r["h"] for r in both])
    if fixtures and fcards:
        short = [f for f in fixtures if f["suite"] == "fixture-short"]
        out["short_flagged"] = sum(fcards[f["h"]]["kind"] != "none" for f in short)
        if haiku_fix:
            out["short_haiku"] = [sum(h.get(f["h"], {"kind": "none"})["kind"] != "none" for f in short) for h in haiku_fix]
        fails = []
        for f in fixtures:
            if f["suite"] != "fixture-field":
                continue
            e, c = f["expect"], fcards[f["h"]]
            ok = (c["kind"] != "none") == e["flag"]
            if ok and e["flag"]:
                for k in ("start", "end", "limit"):
                    if k in e and c.get(k) != e[k]:
                        ok = False
                if "actions" in e and not set(e["actions"]) & set(c["actions"]):
                    ok = False
                if "entities_any" in e and not any(x.lower() in " | ".join(c["entities"]).lower() for x in e["entities_any"]):
                    ok = False
            if not ok:
                fails.append(f["title"])
        out["field_fails"] = fails
    return out


def load(path):
    op = gzip.open if path.endswith(".gz") else open
    return [json.loads(l) for l in op(path, "rt") if l.strip()]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True)
    ap.add_argument("--preds", required=True, help="{h, out} lines")
    ap.add_argument("--fixtures")
    ap.add_argument("--fixture-preds")
    ap.add_argument("--haiku-fixtures", default="")
    a = ap.parse_args()
    rows = load(a.set)
    by = {r["h"]: r for r in rows}
    cards = {p["h"]: decode(by[p["h"]], p["out"]) for p in load(a.preds) if p["h"] in by}
    fx = fc = hf = None
    if a.fixtures and a.fixture_preds:
        fx = load(a.fixtures)
        fb = {f["h"]: f for f in fx}
        fc = {p["h"]: decode(fb[p["h"]], p["out"]) for p in load(a.fixture_preds)}
        hf = [{d["h"]: d["c"] for d in load(p)} for p in a.haiku_fixtures.split(",") if p]
    print(json.dumps(report(rows, cards, fx, fc, hf), indent=1))
