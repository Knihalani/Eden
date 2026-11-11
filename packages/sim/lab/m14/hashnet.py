"""The LOGO screen's reference model (M14, D1022): a small hashed-n-gram network of the micro models' shape.

Word unigrams and bigrams and in-word character 3-5-grams, hashed to 2^18 buckets, mean-pooled by an EmbeddingBag
into 64 numbers per text: the input M10 (cards), M11 (intent), M12 (pool ranking) and M13 (request gate) all read in
some form. Two heads on top: an item head (fact / all-clear / unrelated, from the item alone: the D908 tagger's
question) and a pair head (changes / clear / unrelated, for a request and an item: the D909 ranker's and the push
check's question). CPU, a minute or two per fold.

The transfer recipes are switches on the same model (`recipe`, comma-separated):
- `noise`: token dropout and format noise on training texts (`logo_core.noise`);
- `norm`: typed placeholders for dates, money, names, codes and numbers, at train and test (`logo_core.normalise`);
- `para`: a recorded rewrite of a training text in another style, half the time (`--para FILE`, `paraphrase.py`);
- `dann`: a source classifier on the item encoding behind a gradient-reversal layer (domain-adversarial);
- `balance`: every training source gives the same number of rows an epoch (mixed-generator training);
- `distill`: soft targets for the pair head from a teacher's P(changes) (`--teacher FILE`), mixed with the labels.
"""

from __future__ import annotations

import json
import random
import re
import zlib

import torch
import torch.nn as nn
import torch.nn.functional as F

from logo_core import item_text, noise, normalise

BUCKETS = 1 << 18
_WORD = re.compile(r"\w+|[^\w\s]", re.UNICODE)


def feats(text: str) -> list[int]:
    toks = [t.lower() for t in _WORD.findall(text)][:400]
    out = [zlib.crc32(b"w" + t.encode()) for t in toks]
    out += [zlib.crc32(f"b{a} {b}".encode()) for a, b in zip(toks, toks[1:])]
    for t in toks:
        if len(t) > 2 and t.isalpha():
            w = f"<{t}>"
            for n in (3, 4, 5):
                out += [zlib.crc32(f"c{w[i:i + n]}".encode()) for i in range(len(w) - n + 1)]
    return [x % BUCKETS for x in out] or [0]


class _Reverse(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x, lam):
        ctx.lam = lam
        return x.view_as(x)

    @staticmethod
    def backward(ctx, g):
        return -ctx.lam * g, None


class Net(nn.Module):
    def __init__(self, dim: int = 64, hidden: int = 64, domains: int = 1):
        super().__init__()
        self.emb = nn.EmbeddingBag(BUCKETS, dim, mode="mean", sparse=True)
        nn.init.normal_(self.emb.weight, std=0.05)
        self.item_proj = nn.Linear(dim, hidden)
        self.req_proj = nn.Linear(dim, hidden)
        self.item_head = nn.Linear(hidden, 3)
        self.pair_head = nn.Sequential(nn.Linear(4 * hidden, 64), nn.ReLU(), nn.Linear(64, 3))
        self.dom_head = nn.Sequential(nn.Linear(hidden, 32), nn.ReLU(), nn.Linear(32, max(1, domains)))

    def encode(self, bags: list[list[int]], proj: nn.Linear) -> torch.Tensor:
        flat = torch.tensor([x for b in bags for x in b], dtype=torch.long)
        offs = torch.tensor([0] + [len(b) for b in bags[:-1]], dtype=torch.long).cumsum(0)
        return torch.tanh(proj(self.emb(flat, offs)))

    def pair_logits(self, r: torch.Tensor, i: torch.Tensor) -> torch.Tensor:
        return self.pair_head(torch.cat([r, i, r * i, (r - i).abs()], dim=1))


class HashNet:
    """`fit(rows)` then `score(rows)`: the plugin interface `logo.py` calls for every model."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.recipe = set(filter(None, str(cfg.get("recipe", "")).split(",")))
        self.seed = int(cfg.get("seed", 1))
        self.epochs = int(cfg.get("epochs", 4))
        self.rows_per_source = int(cfg.get("rows_per_source", 2500))
        self.para: dict[str, list[str]] = {}
        if "para" in self.recipe:
            with open(cfg["para"], encoding="utf8") as f:
                for line in f:
                    if line.strip():
                        r = json.loads(line)
                        self.para.setdefault(para_key(r["orig"]), []).append(r["text"])
        self.teacher: dict[str, float] = {}
        if "distill" in self.recipe:
            with open(cfg["teacher"], encoding="utf8") as f:
                for line in f:
                    if line.strip():
                        r = json.loads(line)
                        self.teacher[r["key"]] = float(r["p"])
        self._cache: dict[str, list[int]] = {}

    # Text to features, through the recipe's test-time transform (normalisation is the only one).
    def _f(self, text: str) -> list[int]:
        got = self._cache.get(text)
        if got is None:
            got = feats(normalise(text) if "norm" in self.recipe else text)
            if len(self._cache) < 400_000:
                self._cache[text] = got
        return got

    def _train_text(self, text: str, rng: random.Random) -> list[int]:
        if self.para and rng.random() < 0.5:
            alts = self.para.get(para_key(text))
            if alts:
                text = rng.choice(alts)
        if "noise" in self.recipe and rng.random() < 0.6:
            t = noise(text, rng)
            return feats(normalise(t) if "norm" in self.recipe else t)
        return self._f(text)

    def fit(self, rows: list[dict]) -> "HashNet":
        torch.manual_seed(self.seed)
        rng = random.Random(self.seed)
        srcs = sorted({r["src"] for r in rows})
        dom = {s: i for i, s in enumerate(srcs)}
        self.net = Net(domains=len(srcs))
        dense = [p for n, p in self.net.named_parameters() if not n.startswith("emb.")]
        opt_d = torch.optim.Adam(dense, lr=2e-3)
        opt_s = torch.optim.SparseAdam(list(self.net.emb.parameters()), lr=5e-3)
        by_src = {s: [r for r in rows if r["src"] == s] for s in srcs}
        for ep in range(self.epochs):
            if "balance" in self.recipe:
                n = min(self.rows_per_source, max(len(v) for v in by_src.values()))
                epoch = [r for s in srcs for r in (rng.choices(by_src[s], k=n))]
            else:
                epoch = list(rows)
            rng.shuffle(epoch)
            lam = 0.3 * min(1.0, (ep + 1) / self.epochs)
            for b in range(0, len(epoch), 48):
                loss = self._batch(epoch[b : b + 48], rng, dom, lam)
                opt_d.zero_grad()
                opt_s.zero_grad()
                loss.backward()
                opt_d.step()
                opt_s.step()
        self.net.eval()
        return self

    def _batch(self, batch: list[dict], rng: random.Random, dom: dict, lam: float) -> torch.Tensor:
        items, ilab, idom = [], [], []
        reqs, pitems, plab, psoft = [], [], [], []
        for r in batch:
            others = rng.sample(r["others"], min(4, len(r["others"])))
            own = [(r["fact"], 0), (r["decoy"], 1)] + [(x, 1) for x in r["neutrals"][:2]]
            for it, y in own + [(x, 2) for x in others]:
                items.append(self._train_text(item_text(it), rng))
                ilab.append(y)
                idom.append(dom[r["src"]])
            for q in rng.sample(r["requests"], min(2, len(r["requests"]))):
                for it, y in own + [(x, 2) for x in others[:3]]:
                    reqs.append(self._train_text(q, rng))
                    pitems.append(self._train_text(item_text(it), rng))
                    plab.append(y)
                    t = self.teacher.get(teacher_key(q, it)) if self.teacher else None
                    psoft.append(t)
        n = self.net
        hi = n.encode(items, n.item_proj)
        loss = F.cross_entropy(n.item_head(hi), torch.tensor(ilab))
        hr = n.encode(reqs, n.req_proj)
        hp = n.encode(pitems, n.item_proj)
        logits = n.pair_logits(hr, hp)
        y = torch.tensor(plab)
        loss = loss + F.cross_entropy(logits, y)
        if self.teacher:
            # Soft targets where the teacher scored the pair: its P(changes) against the rest of the mass split as
            # the label splits it (clear or unrelated), weighted as much as the hard labels.
            idx = [k for k, t in enumerate(psoft) if t is not None]
            if idx:
                p = torch.tensor([psoft[k] for k in idx]).clamp(0.01, 0.99)
                rest = torch.where(y[idx] == 2, torch.tensor(2), torch.tensor(1))
                target = torch.zeros(len(idx), 3)
                target[:, 0] = p
                target[torch.arange(len(idx)), rest] = 1 - p
                loss = loss + -(target * F.log_softmax(logits[idx], dim=1)).sum(1).mean()
        if "dann" in self.recipe and len(set(idom)) > 1:
            d = n.dom_head(_Reverse.apply(hi, lam))
            loss = loss + 0.5 * F.cross_entropy(d, torch.tensor(idom))
        return loss

    @torch.no_grad()
    def score(self, rows: list[dict]) -> tuple[list[dict], list[list[dict]]]:
        n = self.net
        item_scores, pair_scores = [], []
        for r in rows:
            own = [r["fact"], r["decoy"]] + r["neutrals"] + r["others"]
            hi = n.encode([self._f(item_text(x)) for x in own], n.item_proj)
            pf = F.softmax(n.item_head(hi), dim=1)[:, 0].tolist()
            k = 2 + len(r["neutrals"])
            item_scores.append({"fact": pf[0], "decoy": pf[1], "neutrals": pf[2:k], "others": pf[k:]})
            hr = n.encode([self._f(q) for q in r["requests"]], n.req_proj)
            ps = []
            for qi in range(hr.shape[0]):
                p = F.softmax(n.pair_logits(hr[qi : qi + 1].expand(hi.shape[0], -1), hi), dim=1)
                c, rel = p[:, 0].tolist(), (1 - p[:, 2]).tolist()
                cr = list(zip(c, rel))
                ps.append({"fact": cr[0], "decoy": cr[1], "neutrals": cr[2:k], "others": cr[k:]})
            pair_scores.append(ps)
        return item_scores, pair_scores


def para_key(text: str) -> str:
    return f"{zlib.crc32(text.encode()):08x}{len(text)}"


def teacher_key(request: str, item: dict) -> str:
    return f"{zlib.crc32(request.encode()):08x}:{para_key(item_text(item))}"


def make(cfg: dict) -> HashNet:
    return HashNet(cfg)
