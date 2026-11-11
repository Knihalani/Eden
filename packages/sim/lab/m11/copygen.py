"""M11 (D970-D979): CopyGen and its variants (H3-H10 of docs/research/m11-intent.md §2), lab only, CPU.

An item's expansion = copied terms (a copy head scores each of the item's own engine stems) + generated terms (a
generation head over a closed request vocabulary, for terms the item does not hold). No text generation, no
pretrained weights.

  --ctx mean|bin      the item's context: mean of a float table over hashed grams (H3), or M3's kernel: a ternary
                      table summed into a sign code, a binary layer (H10)
  --gen mlp|codes|none generation: an MLP over the vocabulary (H3), K discrete codes each holding vocabulary weights
                      (H5), or none (H9: copy only)
  --loss bce|rank     reconstruct the item's requests (BCE), or also rank its own requests over the batch's other items
                      and its look-alike twin by the expansion's dot product (H6)
  --delex             generation reads a delexicalised text (H7); --lenaug adds title and title+sentence crops (H8)
  --extra FILE        more training items, jsonl {title, text, terms, titleTerms, target: [[stems]...], twin?: {...}}

  python3 -I packages/sim/lab/m11/copygen.py --name cg1 [flags]   # writes .local/m11/exp/cg1.json, prints the screen
"""
import argparse, json, math, os, random, re, sys, time
from collections import Counter, defaultdict

import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D  # noqa: E402

torch.set_num_threads(int(os.environ.get("M11_THREADS", "2")))
NSCAL = 6

DELEX = [
    (re.compile(r"\S+@\S+"), " xemail "),
    (re.compile(r"\b\d{1,2}:\d{2}\b"), " xtime "),
    (re.compile(r"[£$€]\s?\d[\d,.]*k?"), " xmoney "),
    (re.compile(r"\b\d+(?:st|nd|rd|th)?\b"), " xnum "),
]
CAP = re.compile(r"\b[A-Z][a-z]+\b")


def delex(text):
    for r, s in DELEX:
        text = r.sub(s, text)
    return CAP.sub(" xname ", text)


def term_grams(t, buckets):
    g = {D.zlib.crc32(b"s" + t.encode()) % buckets}
    p = f"<{t}>"
    for k in (3, 4):
        for j in range(len(p) - k + 1):
            g.add(D.zlib.crc32(b"c" + p[j : j + k].encode()) % buckets)
    return sorted(g)


def term_scalars(terms, title_terms, cap=150):
    """Each distinct own term (first `cap` by first position): count, first position, title, digit, length, item size."""
    first, cnt = {}, Counter(terms)
    for i, t in enumerate(terms):
        first.setdefault(t, i)
    n = max(1, len(terms))
    tt = set(title_terms)
    return [
        (t, [math.log1p(cnt[t]), first[t] / n, float(t in tt), float(any(c.isdigit() for c in t)),
             min(len(t), 12) / 12, math.log1p(n) / 6])
        for t in sorted(first, key=first.get)[:cap]
    ]


class Sign(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        ctx.save_for_backward(x)
        return torch.where(x >= 0, 1.0, -1.0)

    @staticmethod
    def backward(ctx, g):
        (x,) = ctx.saved_tensors
        return g * (x.abs() <= 1).float()


def ternary(w):
    s = w.abs().mean()
    q = torch.where(w > 0.7 * s, s, torch.where(w < -0.7 * s, -s, torch.zeros_like(w)))
    return w + (q - w).detach()


def binary(w):
    s = w.abs().mean(dim=1, keepdim=True)
    return w + (s * torch.sign(w) - w).detach()


class Net(nn.Module):
    def __init__(self, a, V):
        super().__init__()
        self.a = a
        d = a.bits if a.ctx == "bin" else a.dim
        if a.ctx == "bin":
            self.w = nn.Parameter(torch.randn(a.buckets, a.bits) * 0.01)
            self.bn0 = nn.BatchNorm1d(a.bits)
            self.l1 = nn.Parameter(torch.randn(a.bits, a.bits) / math.sqrt(a.bits))
            self.bn1 = nn.BatchNorm1d(a.bits)
        else:
            self.ctx = nn.EmbeddingBag(a.buckets, a.dim, mode="mean")
            nn.init.normal_(self.ctx.weight, 0, 0.1)
        if a.gen == "mlp":
            self.gh = nn.Linear(d, a.hidden)
            self.go = nn.Linear(a.hidden, V)
        elif a.gen == "codes":
            self.pick = nn.Linear(d, a.codes)
            self.book = nn.Parameter(torch.randn(a.codes, V) * 0.01 - 3)
        self.temb = nn.EmbeddingBag(a.tbuckets, a.tdim, mode="sum")
        nn.init.normal_(self.temb.weight, 0, 0.05)
        self.ch = nn.Linear(a.tdim + d + NSCAL, a.hidden)
        self.co = nn.Linear(a.hidden, 1)

    def context(self, ids, offs):
        if self.a.ctx == "bin":
            x = F.embedding_bag(ids, ternary(self.w), offs, mode="sum")
            x = Sign.apply(self.bn0(x))
            return Sign.apply(self.bn1(F.linear(x, binary(self.l1))))
        return self.ctx(ids, offs)

    def forward(self, ids, offs, gids, goffs, tids, toffs, tseg, tscal):
        c = self.context(ids, offs)
        cg = self.context(gids, goffs) if gids is not None else c
        if self.a.gen == "mlp":
            gen = self.go(F.relu(self.gh(cg)))
        elif self.a.gen == "codes":
            soft = F.softmax(self.pick(cg), -1)
            hard = F.one_hot(soft.argmax(-1), soft.shape[-1]).float()
            gen = (hard + soft - soft.detach()) @ self.book
        else:
            gen = None
        te = self.temb(tids, toffs)
        cp = self.co(F.relu(self.ch(torch.cat([te, c[tseg], tscal], 1)))).squeeze(1)
        return gen, cp


def batch(rows, a):
    """rows: dicts with text, terms, title (own terms), tw (target weights or None)."""
    ids, offs, gids, goffs = [], [], [], []
    tids, toffs, tseg, tscal, tlist = [], [], [], [], []
    for n, r in enumerate(rows):
        offs.append(len(ids))
        ids += D.grams(r["text"], a.buckets, cap=a.cap)
        if a.delex:
            goffs.append(len(gids))
            gids += D.grams(delex(r["text"]), a.buckets, cap=a.cap)
        for t, sc in term_scalars(r["terms"], r["title"]):
            toffs.append(len(tids))
            tids += term_grams(t, a.tbuckets)
            tseg.append(n)
            tscal.append(sc)
            tlist.append((n, t))
    T = lambda x: torch.tensor(x, dtype=torch.long)
    return (T(ids), T(offs), T(gids) if a.delex else None, T(goffs) if a.delex else None, T(tids), T(toffs),
            T(tseg), torch.tensor(tscal, dtype=torch.float32)), tlist


def rank_loss(rows, gen, cp, tlist, vid):
    """H6: each row's own request terms (multi-hot) against every row's expansion (copy probs on own terms, gen probs
    on vocabulary terms the item lacks), cross-entropy to its own row. Rows with `twin_of` k are negatives only."""
    terms = {}
    for r in rows:
        for t in r["tw"] or {}:
            terms.setdefault(t, len(terms))
    if not terms:
        return torch.tensor(0.0)
    B, T = len(rows), len(terms)
    W = torch.zeros(B, T)
    pc = torch.sigmoid(cp)
    idx_n, idx_t, vals = [], [], []
    for (n, t), j in zip(tlist, range(len(tlist))):
        if t in terms:
            idx_n.append(n)
            idx_t.append(terms[t])
            vals.append(pc[j])
    if vals:
        W = W.index_put((torch.tensor(idx_n), torch.tensor(idx_t)), torch.stack(vals), accumulate=True)
    if gen is not None:
        pg = torch.sigmoid(gen)
        cols = [(terms[t], vid[t]) for t in terms if t in vid]
        if cols:
            ti = torch.tensor([c[0] for c in cols])
            vi = torch.tensor([c[1] for c in cols])
            own = torch.zeros(B, T)
            for n, t in tlist:
                if t in terms:
                    own[n, terms[t]] = 1
            Wg = torch.zeros(B, T)
            Wg[:, ti] = pg[:, vi]
            W = W + Wg * (1 - own)
    Q = torch.zeros(B, T)
    anchors = []
    for i, r in enumerate(rows):
        if r.get("twin_of") is not None or not r["tw"]:
            continue
        for t in r["tw"]:
            Q[i, terms[t]] = 1
        anchors.append(i)
    if not anchors:
        return torch.tensor(0.0)
    a_ = torch.tensor(anchors)
    sim = (Q[a_] @ W.T) * 4.0
    return F.cross_entropy(sim, a_)


def rows_of(items, a):
    out = []
    for it in items.values():
        if it["split"] != "train" or not it["target"]:
            continue
        tw = D.target_weights(it)
        r = {"h": it["h"], "text": D.item_text(it), "terms": it["terms"], "title": it.get("titleTerms") or [], "tw": tw}
        out.append(r)
        if a.lenaug:
            body = re.split(r"(?<=[.!?])\s+|\n", it["text"].strip())
            sent = next((s for s in body if len(s) > 20 and ":" not in s[:12]), "")
            for txt in (it["title"], f"{it['title']}\n{sent}"):
                low = txt.lower()
                own = [t for t in it["terms"] if t[:4] in low]
                if own:
                    out.append({"h": None, "text": txt, "terms": own, "title": it.get("titleTerms") or [], "tw": tw})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--ctx", default="mean")
    ap.add_argument("--gen", default="mlp")
    ap.add_argument("--loss", default="bce")
    ap.add_argument("--rank-w", type=float, default=1.0)
    ap.add_argument("--buckets", type=int, default=1 << 16)
    ap.add_argument("--tbuckets", type=int, default=1 << 15)
    ap.add_argument("--dim", type=int, default=64)
    ap.add_argument("--tdim", type=int, default=32)
    ap.add_argument("--bits", type=int, default=256)
    ap.add_argument("--hidden", type=int, default=128)
    ap.add_argument("--codes", type=int, default=256)
    ap.add_argument("--vocab", type=int, default=4096)
    ap.add_argument("--cap", type=int, default=400)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--bs", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--posw", type=float, default=4.0)
    ap.add_argument("--kc", type=int, default=12)
    ap.add_argument("--kg", type=int, default=6)
    ap.add_argument("--theta-c", type=float, default=0.25)
    ap.add_argument("--theta-g", type=float, default=0.15)
    ap.add_argument("--lift", type=float, default=0.0, help="generated term kept only at p/prior >= lift")
    ap.add_argument("--delex", action="store_true")
    ap.add_argument("--lenaug", action="store_true")
    ap.add_argument("--twins", action="store_true", help="look-alike twins of training templates as rank negatives")
    ap.add_argument("--extra", default="")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--save", default="")
    a = ap.parse_args()
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    items, worlds = D.load()
    rows = rows_of(items, a)
    if a.extra:
        for x in D.read_jsonl(a.extra):
            reqs = x["target"]
            c = Counter(t for r in reqs for t in set(r))
            rows.append({"h": None, "text": f"{x['title']}\n{x['text']}", "terms": x["terms"],
                         "title": x.get("titleTerms") or [], "tw": {t: v / len(reqs) for t, v in c.items()}})
    twin_of = {}
    if a.twins:
        for f, c, q, suite, seed, _ in D.twins(worlds):
            if items[f]["split"] == "train" and items[c]["split"] == "train":
                twin_of[f] = c
    df = Counter(t for r in rows for t in r["tw"] if t not in set(r["terms"]))
    vocab = [t for t, v in df.most_common(a.vocab) if v >= 2]
    vid = {t: i for i, t in enumerate(vocab)}
    prior = torch.full((len(vocab),), 1e-3)
    for t, i in vid.items():
        prior[i] += df[t] / len(rows)
    model = Net(a, len(vocab))
    opt = torch.optim.Adam(model.parameters(), lr=a.lr)
    byh = {r["h"]: r for r in rows if r["h"]}
    t0 = time.time()
    for ep in range(a.epochs):
        random.shuffle(rows)
        tot = 0.0
        model.train()
        for s in range(0, len(rows), a.bs):
            b = list(rows[s : s + a.bs])
            if a.twins:
                for r in list(b):
                    c = twin_of.get(r["h"])
                    if c and c in byh:
                        b.append({**byh[c], "twin_of": r["h"]})
            x, tlist = batch(b, a)
            gen, cp = model(*x)
            yc = torch.tensor([(b[n]["tw"] or {}).get(t, 0.0) if b[n].get("twin_of") is None else 0.0 for n, t in tlist])
            loss = F.binary_cross_entropy_with_logits(cp, yc)
            if gen is not None:
                yg = torch.zeros_like(gen)
                for i, r in enumerate(b):
                    if r.get("twin_of") is not None:
                        continue
                    own = set(r["terms"])
                    for t, w in r["tw"].items():
                        if t not in own and t in vid:
                            yg[i, vid[t]] = w
                keep = torch.tensor([r.get("twin_of") is None for r in b])
                loss = loss + F.binary_cross_entropy_with_logits(gen[keep], yg[keep], pos_weight=torch.tensor(a.posw))
            if a.loss == "rank":
                loss = loss + a.rank_w * rank_loss(b, gen, cp, tlist, vid)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(b)
        print(f"epoch {ep} loss {tot / len(rows):.4f} ({time.time() - t0:.0f}s)", flush=True)
    model.eval()
    held = [it for it in items.values() if it["split"] == "held"]
    exp = expand_all(model, a, held, vocab, prior)
    path = f".local/m11/exp/{a.name}.json"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(exp, open(path, "w"))
    if a.save:
        torch.save({"state": model.state_dict(), "args": vars(a), "vocab": vocab, "prior": prior}, a.save)
    report(items, worlds, exp, a)


def expand_all(model, a, held, vocab, prior):
    exp = {}
    with torch.no_grad():
        for s in range(0, len(held), 256):
            b = held[s : s + 256]
            rr = [{"text": D.item_text(it), "terms": it["terms"], "title": it.get("titleTerms") or [], "tw": None}
                  for it in b]
            x, tlist = batch(rr, a)
            gen, cp = model(*x)
            pc = torch.sigmoid(cp).tolist()
            per = defaultdict(list)
            for (n, t), p in zip(tlist, pc):
                per[n].append((p, t))
            pg = torch.sigmoid(gen) if gen is not None else None
            for n, it in enumerate(b):
                exp[it["h"]] = decode(per[n], pg[n] if pg is not None else None, set(it["terms"]), a, vocab, prior)
    return exp


def band(p):
    return 3 if p >= 0.8 else 2 if p >= 0.55 else 1


def decode(copied, pg, own, a, vocab, prior):
    out = {}
    for p, t in sorted(copied, reverse=True)[: a.kc]:
        if p >= a.theta_c:
            out[t] = band(p)
    if pg is not None and a.kg > 0:
        score = pg / prior if a.lift > 0 else pg
        vals, idx = torch.topk(score, min(len(vocab), a.kg + 20))
        g = 0
        for v, i in zip(vals.tolist(), idx.tolist()):
            if g >= a.kg:
                break
            if pg[i] < a.theta_g or (a.lift > 0 and v < a.lift):
                continue
            t = vocab[i]
            if t not in own and t not in out:
                out[t] = band(float(pg[i]))
                g += 1
    return out


def report(items, worlds, exp, a):
    import screen as S

    res = S.screen(items, worlds, exp, ["micro", "micro+shipped"], D.HELD_SUITES)
    for arm, r in res.items():
        print(f"{a.name} {arm:14s} fact@5 {r['fact@5']:4d} @15 {r['fact@15']:4d} pool {r['fact_pool']:4d} "
              f"intent12 {r['fact_intent12']:4d} | decoy@5 {r['decoy@5']:4d} @15 {r['decoy@15']:4d} "
              f"pool {r['decoy_pool']:4d} intent12 {r['decoy_intent12']:4d}")
    bad, n = S.twin_gate(items, worlds, exp, D.HELD_SUITES)
    held = [h for h, it in items.items() if it["split"] == "held"]
    g = S.growth(items, exp, held)
    print(f"{a.name} twin gate {bad}/{n}; growth {g[0]:.2f}x mean, {g[2]:.1f} terms/item")


if __name__ == "__main__":
    main()
