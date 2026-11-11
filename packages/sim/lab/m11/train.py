"""M11 (D970-D979): intent micro-expansion models. Item in (hashed n-grams), weighted request terms out (hashed
buckets). No text generation, no pretrained weights, no embedding tables from pretrained models.

Architectures (--arch; docs/research/m11-intent.md §2 has the hypotheses):
  pmi       H1  no training loop: a word -> request-term lift table from co-occurrence, summed over the item's words
  linear    H2  hashed grams -> mean of a learned table (d) -> ReLU layer -> sigmoid over output buckets (multi-label)
  bin       H3  H2 with M3's kernel: a ternary table into a sign code (bits), a binary hidden layer, int8 head
  splade    H4  per word: its hashed word and char-gram rows summed -> a shared head over buckets -> log(1+relu),
                max-pooled over the item's words (each term comes from a word of the item)
  codes     H5  item -> one of K learned codes (straight-through argmax); each code holds a term-weight vector
  contrast  H6  H2's network trained to rank: each of the item's own requests (multi-hot over buckets) against the
                batch's other items by the dot with the item's expansion (InfoNCE), with a sparsity penalty
Options shared by all: --delex (H7: names, numbers, dates and emails replaced by class tokens before hashing),
--lenaug (H8: each training item also as its title alone and title + first sentence, same target), --twin-neg
(look-alike twins of training templates as negatives in contrast mode).

  python3 -I packages/sim/lab/m11/train.py --arch linear --epochs 20 --out .local/m11/exp/linear.json
Writes the held-out items' expansions {h: {term: tf}} for screen.py, and prints the screen's lines.
"""
import argparse, json, math, os, random, re, sys, time
from collections import Counter, defaultdict

import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D  # noqa: E402

torch.set_num_threads(int(os.environ.get("M11_THREADS", "2")))

DELEX = [
    (re.compile(r"\S+@\S+"), " xemail "),
    (re.compile(r"\b\d{1,2}:\d{2}\b"), " xtime "),
    (re.compile(r"[£$€]\s?\d[\d,.]*k?"), " xmoney "),
    (re.compile(r"\b\d+(?:st|nd|rd|th)?\b"), " xnum "),
    (re.compile(r"\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b", re.I), " xday "),
    (re.compile(r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", re.I), " xmonth "),
]
CAP_NAME = re.compile(r"(?<![.!?]\s)(?<!^)\b[A-Z][a-z]+\b")


def delex(text):
    for r, s in DELEX:
        text = r.sub(s, text)
    return CAP_NAME.sub(" xname ", text)


def prep(text, a):
    return delex(text) if a.delex else text


def short_terms(text, it):
    """An augmented crop's own terms: the item's terms whose word occurs in the crop (stems approximate)."""
    low = text.lower()
    return [t for t in it["terms"] if t[:4] in low]


def lenaug(it):
    title, body = it["title"], it["text"]
    first = re.split(r"(?<=[.!?])\s+|\n", body.strip())
    first = next((s for s in first if len(s) > 20 and ":" not in s[:12]), first[0] if first else "")
    return [title, f"{title}\n{first}"]


# ---------------------------------------------------------------------------------------------------------------
class Linear(nn.Module):
    def __init__(self, a):
        super().__init__()
        self.emb = nn.EmbeddingBag(a.buckets, a.dim, mode="mean")
        self.hid = nn.Linear(a.dim, a.hidden)
        self.out = nn.Linear(a.hidden, a.out)
        nn.init.normal_(self.emb.weight, 0, 0.1)

    def forward(self, ids, offs, words=None):
        return self.out(F.relu(self.hid(self.emb(ids, offs))))


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


class Bin(nn.Module):
    """M3's kernel: ternary table summed into a sign code, a binary hidden layer into signs, an int8-able head."""

    def __init__(self, a):
        super().__init__()
        self.w = nn.Parameter(torch.randn(a.buckets, a.bits) * 0.01)
        self.bn0 = nn.BatchNorm1d(a.bits)
        self.l1 = nn.Parameter(torch.randn(a.hidden, a.bits) * (1 / math.sqrt(a.bits)))
        self.bn1 = nn.BatchNorm1d(a.hidden)
        self.out = nn.Linear(a.hidden, a.out)

    def forward(self, ids, offs, words=None):
        x = F.embedding_bag(ids, ternary(self.w), offs, mode="sum")
        x = Sign.apply(self.bn0(x))
        x = Sign.apply(self.bn1(F.linear(x, binary(self.l1))))
        return self.out(x)


class Splade(nn.Module):
    """Per word (its word id and char-gram ids summed), a shared head over the buckets, max-pooled over words."""

    def __init__(self, a):
        super().__init__()
        self.emb = nn.EmbeddingBag(a.buckets, a.dim, mode="sum")
        self.ctx = nn.EmbeddingBag(a.buckets, a.dim, mode="mean")
        self.hid = nn.Linear(2 * a.dim, a.hidden)
        self.out = nn.Linear(a.hidden, a.out)
        nn.init.normal_(self.emb.weight, 0, 0.05)
        nn.init.normal_(self.ctx.weight, 0, 0.05)

    def forward(self, ids, offs, words):
        wids, woffs, wseg, nitems = words  # per-word gram bags; wseg: item index of each word
        tok = self.emb(wids, woffs)  # (W, d)
        ctx = self.ctx(ids, offs)[wseg]  # the item's context at each of its words
        h = F.relu(self.hid(torch.cat([tok, ctx], 1)))
        z = torch.log1p(F.relu(self.out(h)))  # (W, out)
        outp = torch.full((nitems, z.shape[1]), 0.0)
        outp = outp.index_reduce_(0, wseg, z, "amax", include_self=True)
        return outp  # already >= 0; read as a weight, trained through a logit of it below


class Codes(nn.Module):
    def __init__(self, a):
        super().__init__()
        self.emb = nn.EmbeddingBag(a.buckets, a.dim, mode="mean")
        self.hid = nn.Linear(a.dim, a.hidden)
        self.pick = nn.Linear(a.hidden, a.codes)
        self.book = nn.Parameter(torch.randn(a.codes, a.out) * 0.01 - 3)

    def forward(self, ids, offs, words=None):
        logits = self.pick(F.relu(self.hid(self.emb(ids, offs))))
        soft = F.softmax(logits, -1)
        hard = F.one_hot(soft.argmax(-1), soft.shape[-1]).float()
        sel = hard + soft - soft.detach()
        return sel @ self.book


# ---------------------------------------------------------------------------------------------------------------
def featurize(texts, a):
    ids, offs = [], []
    for t in texts:
        offs.append(len(ids))
        ids += D.grams(prep(t, a), a.buckets, cap=a.cap)
    return torch.tensor(ids, dtype=torch.long), torch.tensor(offs, dtype=torch.long)


def word_bags(texts, a):
    """Per word of each text (first 120): its word id and char grams; the item index of each word."""
    wids, woffs, wseg = [], [], []
    for n, t in enumerate(texts):
        ws = list(dict.fromkeys(D.WORD.findall(prep(t, a).lower())))[:120]
        if not ws:
            ws = ["x"]
        for w in ws:
            woffs.append(len(wids))
            wseg.append(n)
            g = {D.zlib.crc32(b"w" + w.encode()) % a.buckets}
            p = f"<{w}>"
            for k in (3, 4):
                for j in range(len(p) - k + 1):
                    g.add(D.zlib.crc32(b"c" + p[j : j + k].encode()) % a.buckets)
            wids += sorted(g)
    return (torch.tensor(wids), torch.tensor(woffs), torch.tensor(wseg), len(texts))


def targets(rows, a):
    y = torch.zeros(len(rows), a.out)
    for i, (_, tw) in enumerate(rows):
        for t, w in tw.items():
            b = D.term_bucket(t, a.out)
            y[i, b] = max(y[i, b], w)
    return y


def batch_inputs(texts, a):
    ids, offs = featurize(texts, a)
    words = word_bags(texts, a) if a.arch == "splade" else None
    return ids, offs, words


def logits_of(model, a, ids, offs, words):
    z = model(ids, offs, words)
    if a.arch == "splade":
        return torch.log(torch.expm1(z).clamp_min(1e-6)) if False else z * 4 - 4  # weight -> pseudo-logit
    return z


def pmi_model(rows, a):
    """H1: lift of each request term given each input word, smoothed; an item's score sums its words' lifts."""
    wf, tf, co = Counter(), Counter(), defaultdict(Counter)
    for text, tw in rows:
        ws = set(D.WORD.findall(prep(text, a).lower()))
        wf.update(ws)
        tf.update(tw.keys())
        for w in ws:
            for t in tw:
                co[w][t] += 1
    n = len(rows)
    table = {}
    for w, c in co.items():
        if wf[w] < 2:
            continue
        row = {}
        for t, k in c.items():
            if k < 2:
                continue
            lift = (k / wf[w]) / (tf[t] / n)
            if lift > 2:
                row[t] = math.log(lift) * k / (k + 2)
        if row:
            table[w] = row
    return table


def expand_pmi(table, text, a):
    s = Counter()
    for w in set(D.WORD.findall(prep(text, a).lower())):
        for t, v in table.get(w, {}).items():
            s[t] += v
    top = s.most_common(a.k)
    if not top:
        return {}
    m = top[0][1]
    return {t: (3 if v > 0.66 * m else 2 if v > 0.33 * m else 1) for t, v in top if v > a.theta * m}


def decode(p, a, inv, own):
    """Top-k buckets with probability >= theta, as terms with tf 1-3 by probability band."""
    k = min(a.k, max(a.kmin, int(a.growth * max(1, len(own)))))
    vals, idx = torch.topk(p, k)
    out = {}
    for v, i in zip(vals.tolist(), idx.tolist()):
        if v < a.theta:
            break
        t = inv.get(i)
        if t is None or (a.new_only and t in own):
            continue
        out[t] = 3 if v >= 0.8 else 2 if v >= 0.55 else 1
    return out



# ---------------------------------------------------------------------------------------------------------------
# H3 CopyGen: a copy head over the item's own (engine-stemmed) terms and a generation head over output buckets for
# terms the item does not hold. Copy says which of the item's words a request would use; generation bridges.
def term_grams(t, buckets):
    g = {D.zlib.crc32(b"s" + t.encode()) % buckets}
    p = f"<{t}>"
    for k in (3, 4):
        for j in range(len(p) - k + 1):
            g.add(D.zlib.crc32(b"c" + p[j : j + k].encode()) % buckets)
    return sorted(g)


NSCAL = 6


def term_scalars(it_terms, title_terms, cap=150):
    """Each distinct own term (first `cap` by first position): count, first position, in title, digit, length."""
    first, cnt = {}, Counter(it_terms)
    for i, t in enumerate(it_terms):
        first.setdefault(t, i)
    n = max(1, len(it_terms))
    tt = set(title_terms)
    out = []
    for t in sorted(first, key=first.get)[:cap]:
        out.append((t, [math.log1p(cnt[t]), first[t] / n, float(t in tt), float(any(c.isdigit() for c in t)),
                        min(len(t), 12) / 12, math.log1p(n) / 6]))
    return out


class CopyGen(nn.Module):
    def __init__(self, a):
        super().__init__()
        self.ctx = nn.EmbeddingBag(a.buckets, a.dim, mode="mean")
        self.temb = nn.EmbeddingBag(a.buckets, a.dim, mode="sum")
        self.gh = nn.Linear(a.dim, a.hidden)
        self.go = nn.Linear(a.hidden, a.out)
        self.ch = nn.Linear(2 * a.dim + NSCAL, a.hidden)
        self.co = nn.Linear(a.hidden, 1)
        nn.init.normal_(self.ctx.weight, 0, 0.1)
        nn.init.normal_(self.temb.weight, 0, 0.05)

    def forward(self, ids, offs, tids, toffs, tseg, tscal):
        c = self.ctx(ids, offs)
        gen = self.go(F.relu(self.gh(c)))
        te = self.temb(tids, toffs)
        cp = self.co(F.relu(self.ch(torch.cat([te, c[tseg], tscal], 1)))).squeeze(1)
        return gen, cp


def cg_batch(b, a):
    """b: list of (text, terms, titleTerms, tw). Inputs and, when tw is given, labels."""
    ids, offs = featurize([x[0] for x in b], a)
    tids, toffs, tseg, tscal, tlist = [], [], [], [], []
    for n, (_, terms, title, _) in enumerate(b):
        for t, sc in term_scalars(terms, title):
            toffs.append(len(tids))
            tids += term_grams(t, a.buckets)
            tseg.append(n)
            tscal.append(sc)
            tlist.append((n, t))
    return (ids, offs, torch.tensor(tids), torch.tensor(toffs), torch.tensor(tseg),
            torch.tensor(tscal, dtype=torch.float32)), tlist


def train_copygen(a, items, worlds, rows, held, inv):
    model = CopyGen(a)
    opt = torch.optim.Adam(model.parameters(), lr=a.lr)
    t0 = time.time()
    for ep in range(a.epochs):
        random.shuffle(rows)
        tot = 0.0
        for s in range(0, len(rows), a.bs):
            b = rows[s : s + a.bs]
            x, tlist = cg_batch(b, a)
            gen, cp = model(*x)
            own = [set(r[1]) for r in b]
            yg = torch.zeros_like(gen)
            for i, r in enumerate(b):
                for t, w in r[3].items():
                    if t not in own[i]:
                        k = D.term_bucket(t, a.out)
                        yg[i, k] = max(yg[i, k], w)
            yc = torch.tensor([b[n][3].get(t, 0.0) for n, t in tlist])
            loss = a.cw * F.binary_cross_entropy_with_logits(cp, yc) + a.gw * F.binary_cross_entropy_with_logits(
                gen, yg, pos_weight=torch.tensor(a.posw))
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(b)
        print(f"epoch {ep} loss {tot / len(rows):.4f} ({time.time() - t0:.0f}s)", flush=True)
    model.eval()
    exp = {}
    prior = torch.full((a.out,), 1e-3)
    for r in rows:
        for t, w in r[3].items():
            if t not in r[1]:
                prior[D.term_bucket(t, a.out)] += 1 / len(rows)
    with torch.no_grad():
        for s in range(0, len(held), 256):
            b = held[s : s + 256]
            bb = [(D.item_text(it), it["terms"], it.get("titleTerms") or [], None) for it in b]
            x, tlist = cg_batch(bb, a)
            gen, cp = model(*x)
            pc, pg = torch.sigmoid(cp), torch.sigmoid(gen)
            per = defaultdict(list)
            for (n, t), p in zip(tlist, pc.tolist()):
                per[n].append((p, t))
            for n, it in enumerate(b):
                out = {}
                if not a.no_copy:
                    for p, t in sorted(per[n], reverse=True)[: a.kc]:
                        if p >= a.theta_c:
                            out[t] = 3 if p >= 0.8 else 2 if p >= 0.55 else 1
                if not a.no_gen:
                    own = set(it["terms"])
                    score = pg[n] / prior if a.lift > 0 else pg[n]
                    vals, idx = torch.topk(score, a.kg + 10)
                    g = 0
                    for v, i in zip(vals.tolist(), idx.tolist()):
                        t = inv.get(i)
                        if (v < a.lift if a.lift > 0 else v < a.theta) or g >= a.kg or pg[n][i] < a.theta:
                            break
                        if t and t not in own and t not in out:
                            out[t] = 3 if v >= 0.8 else 2 if v >= 0.55 else 1
                            g += 1
                exp[it["h"]] = out
    if a.save:
        torch.save({"state": model.state_dict(), "args": vars(a), "inv": inv}, a.save)
    return exp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="linear")
    ap.add_argument("--buckets", type=int, default=1 << 16)
    ap.add_argument("--out", type=int, default=1 << 14, dest="out")
    ap.add_argument("--dim", type=int, default=64)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--bits", type=int, default=256)
    ap.add_argument("--codes", type=int, default=256)
    ap.add_argument("--cap", type=int, default=400)
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--bs", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--k", type=int, default=24)
    ap.add_argument("--kmin", type=int, default=8)
    ap.add_argument("--growth", type=float, default=1.0)
    ap.add_argument("--theta", type=float, default=0.3)
    ap.add_argument("--new-only", action="store_true")
    ap.add_argument("--delex", action="store_true")
    ap.add_argument("--lenaug", action="store_true")
    ap.add_argument("--flops", type=float, default=1e-3)
    ap.add_argument("--extra", default="", help="extra training rows: jsonl of {title,text,targetTerms}")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--kc", type=int, default=12)
    ap.add_argument("--kg", type=int, default=8)
    ap.add_argument("--theta-c", type=float, default=0.4)
    ap.add_argument("--cw", type=float, default=1.0)
    ap.add_argument("--gw", type=float, default=1.0)
    ap.add_argument("--posw", type=float, default=4.0)
    ap.add_argument("--no-copy", action="store_true")
    ap.add_argument("--lift", type=float, default=0.0)
    ap.add_argument("--no-gen", action="store_true")
    ap.add_argument("--save", default="")
    ap.add_argument("--exp-out", default="")
    a = ap.parse_args()
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    items, worlds = D.load()
    rows = []
    for it in items.values():
        if it["split"] != "train" or not it["target"]:
            continue
        tw = D.target_weights(it)
        rows.append((D.item_text(it), tw))
        if a.lenaug:
            rows += [(t, tw) for t in lenaug(it)]
    if a.extra:
        for x in D.read_jsonl(a.extra):
            reqs = x["targetTerms"]
            c = Counter(t for r in reqs for t in set(r))
            rows.append((f"{x['title']}\n{x['text']}", {t: v / len(reqs) for t, v in c.items()}))
    vocab = Counter(t for _, tw in rows for t in tw)
    inv = {}
    for t, _ in vocab.most_common():
        inv.setdefault(D.term_bucket(t, a.out), t)
    held = [it for it in items.values() if it["split"] == "held"]
    t0 = time.time()
    if a.arch == "copygen":
        rows4 = []
        for it in items.values():
            if it["split"] != "train" or not it["target"]:
                continue
            tw = D.target_weights(it)
            rows4.append((D.item_text(it), it["terms"], it.get("titleTerms") or [], tw))
            if a.lenaug:
                for t in lenaug(it):
                    from_terms = [x for x in it["terms"] if x in set(t.lower().split()) or True][:0]
                    rows4.append((t, short_terms(t, it), [], tw))
        exp = train_copygen(a, items, worlds, rows4, held, inv)
    elif a.arch == "pmi":
        table = pmi_model(rows, a)
        exp = {it["h"]: expand_pmi(table, D.item_text(it), a) for it in held}
    else:
        model = {"linear": Linear, "contrast": Linear, "bin": Bin, "splade": Splade, "codes": Codes}[a.arch](a)
        opt = torch.optim.Adam(model.parameters(), lr=a.lr)
        for ep in range(a.epochs):
            random.shuffle(rows)
            tot = 0.0
            model.train()
            for s in range(0, len(rows), a.bs):
                b = rows[s : s + a.bs]
                ids, offs, words = batch_inputs([r[0] for r in b], a)
                y = targets(b, a)
                z = logits_of(model, a, ids, offs, words)
                if a.arch == "contrast":
                    w = F.softplus(z)  # nonnegative term weights
                    q = (y > 0).float()
                    sim = q @ w.T  # each item's own request terms against every item's expansion
                    loss = F.cross_entropy(sim, torch.arange(len(b))) + a.flops * (w.mean(0) ** 2).sum()
                    loss = loss + 0.2 * F.binary_cross_entropy_with_logits(z, (y > 0).float())
                else:
                    loss = F.binary_cross_entropy_with_logits(z, y, pos_weight=torch.tensor(4.0))
                opt.zero_grad()
                loss.backward()
                opt.step()
                tot += loss.item() * len(b)
            print(f"epoch {ep} loss {tot / len(rows):.4f} ({time.time() - t0:.0f}s)", flush=True)
        model.eval()
        exp = {}
        with torch.no_grad():
            for s in range(0, len(held), 256):
                b = held[s : s + 256]
                ids, offs, words = batch_inputs([D.item_text(it) for it in b], a)
                p = torch.sigmoid(logits_of(model, a, ids, offs, words))
                for it, pi in zip(b, p):
                    exp[it["h"]] = decode(pi, a, inv, set(it["terms"]))
        if a.save:
            torch.save({"state": model.state_dict(), "args": vars(a), "inv": inv}, a.save)
    print(f"trained on {len(rows)} rows, vocab {len(vocab)}, {time.time() - t0:.0f}s")
    path = a.exp_out or f".local/m11/exp/{a.arch}.json"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(exp, open(path, "w"))
    import screen as S

    res = S.screen(items, worlds, exp, ["micro", "micro+shipped"], D.HELD_SUITES)
    for arm, r in res.items():
        print(f"{arm:14s} fact@5 {r['fact@5']:4d} @15 {r['fact@15']:4d} pool {r['fact_pool']:4d} intent12 {r['fact_intent12']:4d}"
              f" | decoy@5 {r['decoy@5']:4d} @15 {r['decoy@15']:4d} pool {r['decoy_pool']:4d} intent12 {r['decoy_intent12']:4d}")
    bad, n = S.twin_gate(items, worlds, exp, D.HELD_SUITES)
    g = S.growth(items, exp, [it["h"] for it in held])
    print(f"twin gate {bad}/{n}; growth {g[0]:.2f}x mean {g[1]:.2f}x max, {g[2]:.1f} terms/item")


if __name__ == "__main__":
    main()
