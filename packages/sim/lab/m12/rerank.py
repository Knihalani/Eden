"""M12 H3 (D1000-D1009): the pool's tail seats re-ranked over the engine's wide candidates (`pushWide` pool dumps).

Each dump row: the request, main's pool (15, in order) and `wide` (the ranked rest and the deeper lexical hits, in
order). The model scores the pool's last S items and the wide ones; the S best take the tail seats. Features are
symbolic (positions, idf-weighted overlap, title hits, length, source, automated sender, a constraint lexicon, near
days) plus, with `--expand MODEL`, the teacher-distilled expansion's score. Trained listwise on hidden rows (the
planted fact as the target) of M2 v2 train dumps; screened on M2 val and the sim's fit suites, hidden and control.

  python3 -I rerank.py --train '.local/m12/wide/train-*.jsonl' --val '.local/m12/wide/val-*.jsonl' \
      --fit .local/m12/base/fit-wide-pool.jsonl
"""
import argparse
import glob
import json
import math
import re
import unicodedata
from collections import Counter

import numpy as np
import torch
import torch.nn.functional as F

ap = argparse.ArgumentParser()
ap.add_argument("--train", required=True)
ap.add_argument("--val", required=True)
ap.add_argument("--fit", required=True)
ap.add_argument("--seats", default="3,5,8")
ap.add_argument("--hidden", type=int, default=0, help="MLP width (0: linear)")
ap.add_argument("--epochs", type=int, default=4)
ap.add_argument("--lr", type=float, default=0.01)
ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--wide", type=int, default=60)
ap.add_argument("--save", default="")
args = ap.parse_args()

STOP = set("""a an the and or but if of to in on at by for with from as is are was were be been being it its this that
these those i me my we our you your he she him her his they them their what which who whom when where why how all any
both each few more most other some such no nor not only own same so than too very can will just do does did done
please could would should shall may might must have has had having about into over after before again further then
once here there up down out off am get got let us also via per""".split())
TOK = re.compile(r"[^\W_][\w'\-]*", re.U)
LEX = re.compile(r"\b(must|cannot|can't|don't|do not|only|until|deadline|limit|policy|approval|approve|sign-off|"
                 r"needs?|required|before|no longer|cancel+ed|postponed|moved|on hold|closed|expired?|overdue|"
                 r"not|never|instead|unless|max(imum)?|minimum|cap)\b", re.I)
MON = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
DAYRE = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*", re.I)
SOURCES = ["gmail", "calendar", "slack", "drive", "docs", "crm", "notes", "whatsapp", "sms", "files", "health",
           "bank", "tasks"]


def fold(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))


def terms(s):
    out = []
    for m in TOK.finditer(fold(s)):
        t = re.sub(r"['’]s$", "", m.group(0)).rstrip("'-_")
        if len(t) > 1:
            out.append(t)
    return out


def days(s):
    return {(MON[m.lower()[:3]], int(d)) for d, m in DAYRE.findall(s)}


def rows_of(pattern):
    for path in sorted(glob.glob(pattern)):
        for line in open(path):
            if line.strip():
                yield json.loads(line)


DF = Counter()
NDOC = [0]


def feats(req, cand, where, k):
    """where: 'tail' (k = its pool position) or 'wide' (k = its wide index)."""
    q = [t for t in dict.fromkeys(terms(req)) if t not in STOP]
    title = set(terms(cand.get("title", "")))
    body = set(terms(cand.get("text", ""))) | title
    idf = {t: math.log(1 + NDOC[0] / (1 + DF.get(t, 0))) for t in q}
    tot = sum(idf.values()) or 1.0
    shared = [t for t in q if t in body]
    cov = sum(idf[t] for t in shared) / tot
    tl = sum(idf[t] for t in q if t in title) / tot
    rare = max([idf[t] for t in shared], default=0.0) / 10
    text = cand.get("text", "")
    n = len(text)
    src = cand["id"].split(":")[0]
    rd, cd = days(req), days(cand.get("title", "") + " " + text)
    near = any(abs((a * 31 + b) - (c * 31 + d)) <= 3 for a, b in rd for c, d in cd) if rd else False
    f = [
        1.0 if where == "tail" else 0.0,
        (k - 10) / 5 if where == "tail" else 0.0,
        math.log1p(k) / 4 if where == "wide" else 0.0,
        cov, tl, len(shared) / 5, rare,
        math.log1p(n) / 8, 1.0 if n < 200 else 0.0,
        min(len(LEX.findall(text)), 8) / 8,
        1.0 if re.search(r"noreply|no-reply|newsletter|unsubscribe", text[:400], re.I) else 0.0,
        1.0 if near else 0.0, 1.0 if rd else 0.0,
    ]
    f += [1.0 if src == s else 0.0 for s in SOURCES]
    return f


def groups(pattern, hidden_only, cap):
    out = []
    for r in rows_of(pattern):
        if r["variant"] not in ("hidden", "control") or (hidden_only and r["variant"] != "hidden"):
            continue
        pool = r["pool"]
        wide = r.get("wide", [])[: args.wide]
        cands = [(c, "tail", i) for i, c in enumerate(pool)] + [(c, "wide", i) for i, c in enumerate(wide)]
        out.append({"r": r, "pool": [c["id"] for c in pool], "cands": cands})
        if cap and len(out) >= cap:
            break
    return out


def featurise(gs):
    for g in gs:
        g["X"] = torch.tensor([feats(g["r"]["request"], c, w, k) for c, w, k in g["cands"]], dtype=torch.float32)
        ids = [c["id"] for c, _, _ in g["cands"]]
        g["y"] = ids.index(g["r"]["planted"]) if g["r"]["planted"] in ids else -1


# Document frequencies over the training dumps' candidates (a stand-in for the user's index idf).
train = groups(args.train, True, args.limit)
for g in train:
    for c, _, _ in g["cands"]:
        DF.update(set(terms(c.get("title", "") + " " + c.get("text", ""))))
        NDOC[0] += 1
featurise(train)
nf = train[0]["X"].shape[1]
model = (torch.nn.Sequential(torch.nn.Linear(nf, args.hidden), torch.nn.ReLU(), torch.nn.Linear(args.hidden, 1))
         if args.hidden else torch.nn.Linear(nf, 1))
opt = torch.optim.Adam(model.parameters(), lr=args.lr)
pos = [g for g in train if g["y"] >= 0]
print(f"train groups {len(train)} with the fact among candidates {len(pos)}; features {nf}", flush=True)


def screen(name, gs):
    seats = [int(s) for s in args.seats.split(",")]
    tot = Counter()
    with torch.no_grad():
        for g in gs:
            v = g["r"]["variant"][0]
            tot[v] += 1
            planted = g["r"]["planted"]
            tot[v + "0"] += planted in g["pool"]
            s = model(g["X"]).squeeze(-1).numpy() if len(g["cands"]) else np.zeros(0)
            ids = [c["id"] for c, _, _ in g["cands"]]
            order = [ids[i] for i in np.argsort(-s, kind="stable")]
            for S in seats:
                head = g["pool"][: max(0, min(len(g["pool"]), 15) - S)]
                hs = set(head)
                rest = [x for x in order if x not in hs]
                new = hs | set(rest[: 15 - len(head)])
                tot[f"{v}{S}"] += planted in new
                tot[f"{v}{S}lost"] += planted in g["pool"] and planted not in new
    line = f"[{name}] hidden {tot['h0']}/{tot['h']} decoys {tot['c0']}/{tot['c']}"
    for S in seats:
        line += (f" | S={S}: hidden {tot[f'h{S}']} ({100 * (tot[f'h{S}'] - tot['h0']) / max(tot['h'], 1):+.1f}, lost "
                 f"{tot[f'h{S}lost']}) decoys {tot[f'c{S}']} ({100 * (tot[f'c{S}'] - tot['c0']) / max(tot['c'], 1):+.1f})")
    print(line, flush=True)


val = groups(args.val, False, 0)
featurise(val)
fit = groups(args.fit, False, 0)
featurise(fit)
screen("val, untrained", val)
for ep in range(args.epochs):
    np.random.shuffle(pos)
    tl = 0.0
    for i in range(0, len(pos), 32):
        b = pos[i: i + 32]
        loss = sum(F.cross_entropy(model(g["X"]).squeeze(-1).unsqueeze(0), torch.tensor([g["y"]])) for g in b) / len(b)
        opt.zero_grad()
        loss.backward()
        opt.step()
        tl += float(loss) * len(b)
    print(f"epoch {ep} loss {tl / len(pos):.3f}", flush=True)
    screen(f"val e{ep}", val)
    screen(f"fit e{ep}", fit)
if args.save:
    torch.save({"state": model.state_dict(), "df": dict(DF), "n": NDOC[0], "args": vars(args)}, args.save)
