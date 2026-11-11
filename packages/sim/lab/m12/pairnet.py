"""M12 H8 (D1000-D1009): a request x item scorer distilled from M1's 8B teacher, as the pool's tail-seat selector.

Text as hashed word, character 3/4-gram and word-bigram ids over the engine's terms (no pretrained weights); M3's
kernel (packages/sim/lab/m3r/binnet.py): a ternary table into sign codes for the request and the item, then binary
layers over [q*i, q, i] (`--float` keeps real weights and tanh codes). Trained listwise on M2 v2 train: each request's
teacher-scored group (ten items) plus cross-world and sim negatives, against the teacher's softmax mixed with the
planted fact. Screened (1) on M2 val groups: AUC fact against its decoy and against the rest, and (2) as the selector
of the pool's last S seats over the engine's own wide candidates (pushWide pool dumps): sim fit suites and M2 val.

  python3 -I pairnet.py --train strain.terms.jsonl --teacher train.t8b.jsonl.gz --val sval.terms.jsonl \
      --val-teacher val.t8b.jsonl.gz --distract fit.terms.jsonl --fit-wide fit-wide-pool.jsonl --out W
"""
import argparse
import glob
import json
import re
import os
import random
import sys
import time
import zlib

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--train", required=True)
ap.add_argument("--teacher", required=True)
ap.add_argument("--val", required=True)
ap.add_argument("--val-teacher", default="")
ap.add_argument("--distract", required=True)
ap.add_argument("--fit-wide", default="", help="pushWide pool dumps of the sim's fit suites (glob)")
ap.add_argument("--val-wide", default="", help="pushWide pool dumps of M2 val (glob)")
ap.add_argument("--worlds", type=int, default=0)
ap.add_argument("--bits", type=int, default=256)
ap.add_argument("--width", type=int, default=256)
ap.add_argument("--buckets", type=int, default=1 << 18)
ap.add_argument("--float", action="store_true")
ap.add_argument("--teacher-mix", type=float, default=0.7)
ap.add_argument("--tau", type=float, default=1.5)
ap.add_argument("--neg", type=int, default=24, help="cross-world and sim negatives a request")
ap.add_argument("--epochs", type=int, default=1)
ap.add_argument("--batch", type=int, default=32)
ap.add_argument("--lr", type=float, default=2e-3)
ap.add_argument("--seats", default="3,5,8")
ap.add_argument("--wide", type=int, default=60)
ap.add_argument("--eval-every", type=int, default=0)
ap.add_argument("--threads", type=int, default=0)
ap.add_argument("--out", default="")
ap.add_argument("--load", default="")
ap.add_argument("--dot-weight", type=float, default=0.0, help="also train the codes' agreement q.i as a scan score")
ap.add_argument("--fit-terms", default="", help="sim fit worlds (m12-export --corpus): the code scan's screen")
ap.add_argument("--scan", type=int, default=30, help="items the code scan adds to the candidates")
ap.add_argument("--wide-train", default="", help="engine-drawn candidates (pushWide pool dumps of synth-train, glob)")
ap.add_argument("--synth-raw", default="", help="M2 train worlds (raw), to map dump items and requests to teacher keys")
ap.add_argument("--wide-rows", type=int, default=8000, help="engine-drawn rows kept (a random sample)")
ap.add_argument("--wide-weight", type=float, default=1.0, help="share of steps on engine-drawn rows (with --wide-train)")
ap.add_argument("--seed", type=int, default=1)
args = ap.parse_args()
if args.threads:
    torch.set_num_threads(args.threads)
random.seed(args.seed)
torch.manual_seed(args.seed)
NB = args.buckets
t0 = time.time()


def grams(terms, cap=400):
    out = set()
    for t in terms[:200]:
        out.add(zlib.crc32(b"w" + t.encode()) % NB)
        p = f"<{t}>"
        for n in (3, 4):
            for k in range(len(p) - n + 1):
                out.add(zlib.crc32(b"c" + p[k: k + n].encode()) % NB)
    for a, b in zip(terms, terms[1:200]):
        out.add(zlib.crc32(f"b{a} {b}".encode()) % NB)
    return sorted(out)[:cap] or [0]


def item_terms(it):
    """An item's terms for the scorer: its title's, then its text's (as stored by load_synth: tf has both)."""
    return it["terms"]


def load_terms(path, limit=0):
    worlds = []
    for i, w in enumerate(D.read_jsonl(path)):
        if limit and i >= limit:
            break
        items = [{"id": it["id"], "g": grams(it["title"] + it["text"])} for it in w["items"]]
        reqs = []
        for t in w["tasks"]:
            for r in t["requests"]:
                reqs.append({"gid": f"{t['family']}/{w['world']}/{t['id']}/{r['id']}", "g": grams(r["q"]),
                             "fact": t["fact"], "decoy": t["decoy"]})
        worlds.append({"items": items, "reqs": reqs})
    return worlds


def ternary(w):
    a = w.abs().mean()
    q = torch.where(w > 0.7 * a, a, torch.where(w < -0.7 * a, -a, torch.zeros_like(w)))
    return w + (q - w).detach()


def binary(w):
    a = w.abs().mean(dim=1, keepdim=True)
    return w + (a * torch.sign(w) - w).detach()


class Sign(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        ctx.save_for_backward(x)
        return torch.where(x >= 0, 1.0, -1.0)

    @staticmethod
    def backward(ctx, g):
        (x,) = ctx.saved_tensors
        return g * (x.abs() <= 1).float()


class Enc(nn.Module):
    def __init__(self, real):
        super().__init__()
        self.real = real
        self.w = nn.Parameter(torch.randn(NB, args.bits) * 0.01)
        self.norm = nn.BatchNorm1d(args.bits)

    def forward(self, glists):
        ids, offs = [], []
        for g in glists:
            offs.append(len(ids))
            ids += g
        W = self.w if self.real else ternary(self.w)
        h = F.embedding_bag(torch.tensor(ids), W, torch.tensor(offs), mode="sum")
        h = self.norm(h)
        return torch.tanh(h) if self.real else Sign.apply(h)


class Lin(nn.Module):
    def __init__(self, real, i, o):
        super().__init__()
        self.real = real
        self.w = nn.Parameter(torch.randn(o, i) * (1 / i) ** 0.5)
        self.norm = nn.BatchNorm1d(o)

    def forward(self, x):
        return self.norm(x @ (self.w if self.real else binary(self.w)).T)


class PairNet(nn.Module):
    def __init__(self, real):
        super().__init__()
        self.real = real
        self.qenc, self.ienc = Enc(real), Enc(real)
        self.l1 = Lin(real, 3 * args.bits, args.width)
        self.l2 = Lin(real, args.width, 32)
        self.head = nn.Linear(32, 1)
        self.dscale = nn.Parameter(torch.tensor(4.0 / args.bits))

    def act(self, x):
        return torch.tanh(x) if self.real else Sign.apply(x)

    def dot(self, qc, ic):
        """The codes' agreement (a Hamming similarity for sign codes), scaled: the scan's score."""
        return (ic @ qc.unsqueeze(-1)).squeeze(-1) * self.dscale

    def score(self, qc, ic):
        """qc (R, B), ic (R, K, B) -> (R, K)."""
        R, K, B = ic.shape
        qq = qc.unsqueeze(1).expand(R, K, B)
        h = torch.cat([qq * ic, qq, ic], -1).reshape(R * K, 3 * B)
        h = self.act(self.l1(h))
        h = self.act(self.l2(h))
        return self.head(h).view(R, K)


teacher = D.load_teacher(args.teacher)
train = load_terms(args.train, args.worlds)
val = load_terms(args.val)
vteacher = D.load_teacher(args.val_teacher) if args.val_teacher else {}
dist = [{"g": grams(it["title"] + it["text"])} for it in next(D.read_jsonl(args.distract))["items"]]
allitems = [it for w in train for it in w["items"]] + dist
print(f"loaded {len(train)} train worlds ({len(allitems)} items), {len(val)} val ({time.time() - t0:.0f}s)", flush=True)
net = PairNet(args.float)
opt = torch.optim.Adam(net.parameters(), lr=args.lr)


def step(batch):
    qg, cands, tgts = [], [], []
    for wi, r in batch:
        w = train[wi]
        byid = {it["id"]: it for it in w["items"]}
        tch = teacher.get(r["gid"], {})
        keys = [k for k in tch if k in byid]
        if r["fact"] not in keys and r["fact"] in byid:
            keys.append(r["fact"])
        lg = [tch.get(k, max(tch.values()) if tch else 0.0) for k in keys]
        c = [byid[k]["g"] for k in keys] + [random.choice(allitems)["g"] for _ in range(args.neg)]
        floor = min(lg) - 3.0 if lg else -10.0
        p = torch.softmax(torch.tensor(lg + [floor] * args.neg) / args.tau, 0)
        one = torch.zeros(len(c))
        if r["fact"] in keys:
            one[keys.index(r["fact"])] = 1.0
        tgts.append(args.teacher_mix * p + (1 - args.teacher_mix) * one)
        qg.append(r["g"])
        cands.append(c)
    K = max(len(c) for c in cands)
    flat, mask = [], torch.zeros(len(batch), K, dtype=torch.bool)
    for i, c in enumerate(cands):
        flat += c + [[0]] * (K - len(c))
        mask[i, : len(c)] = True
    qc = net.qenc(qg)
    ic = net.ienc(flat).view(len(batch), K, -1)
    s = net.score(qc, ic).masked_fill(~mask, -1e9)
    T = torch.zeros(len(batch), K)
    for i, t in enumerate(tgts):
        T[i, : len(t)] = t
    loss = -(T * F.log_softmax(s, 1)).sum(1).mean()
    if args.dot_weight:
        d = (net.dot(qc, ic)).masked_fill(~mask, -1e9)
        loss = loss - args.dot_weight * (T * F.log_softmax(d, 1)).sum(1).mean()
    opt.zero_grad()
    loss.backward()
    opt.step()
    return float(loss)


def auc(pos, neg):
    if not pos or not neg:
        return float("nan")
    pos, neg = np.array(pos), np.array(neg)
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


@torch.no_grad()
def eval_groups(tag):
    net.eval()
    fd, fo = [], []  # per request: fact > decoy, fact > other (pairwise wins)
    for w in val[:120]:
        byid = {it["id"]: it for it in w["items"]}
        ids = list(byid)
        ic = net.ienc([byid[k]["g"] for k in ids])
        for r in w["reqs"]:
            if r["fact"] not in byid or r["decoy"] not in byid:
                continue
            s = net.score(net.qenc([r["g"]]), ic.unsqueeze(0))[0].numpy()
            f = s[ids.index(r["fact"])]
            fd.append(float(f > s[ids.index(r["decoy"])]))
            others = [s[j] for j, k in enumerate(ids) if k not in (r["fact"], r["decoy"])]
            fo.append(float(np.mean([f > o for o in others])))
    print(f"[{tag}] M2 val: fact over its decoy {np.mean(fd):.3f}, fact over the world's other items {np.mean(fo):.3f}"
          f" ({len(fd)} requests)", flush=True)
    net.train()


def wide_rows(pattern, keep_text=False, sample=0):
    import re
    import unicodedata

    TOK = re.compile(r"[^\W_][\w'\-]*", re.U)

    def terms(s):
        s = "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))
        return [t for t in (re.sub(r"['’]s$", "", m.group(0)).rstrip("'-_") for m in TOK.finditer(s)) if len(t) > 1]

    out = []
    rng = random.Random(7)
    for path in sorted(glob.glob(pattern)):
        for r in D.read_jsonl(path):
            if r["variant"] not in ("hidden", "control"):
                continue
            if sample and rng.random() > sample / 30000:
                continue
            c = r["pool"] + r.get("wide", [])[: args.wide]
            out.append({"v": r["variant"][0], "planted": r["planted"], "pool": [x["id"] for x in r["pool"]],
                        "template": r["template"], "seed": r["seed"],
                        **({"titles": [x.get("title", "") for x in c]} if keep_text else {}),
                        "ids": [x["id"] for x in c], "q": grams(terms(r["request"])),
                        "g": [grams(terms(x.get("title", "")) + terms(x.get("text", ""))) for x in c]})
    return out


@torch.no_grad()
def eval_wide(tag, rows):
    if not rows:
        return
    net.eval()
    seats = [int(s) for s in args.seats.split(",")]
    tot = {}
    for r in rows:
        v = r["v"]
        tot[v] = tot.get(v, 0) + 1
        tot[v + "0"] = tot.get(v + "0", 0) + (r["planted"] in r["pool"])
        if not r["ids"]:
            continue
        s = net.score(net.qenc([r["q"]]), net.ienc(r["g"]).unsqueeze(0))[0].numpy()
        order = [r["ids"][i] for i in np.argsort(-s, kind="stable")]
        for S in seats:
            head = r["pool"][: max(0, min(len(r["pool"]), 15) - S)]
            hs = set(head)
            new = hs | set([x for x in order if x not in hs][: 15 - len(head)])
            tot[f"{v}{S}"] = tot.get(f"{v}{S}", 0) + (r["planted"] in new)
    line = f"[{tag}] hidden {tot.get('h0')}/{tot.get('h')} decoys {tot.get('c0')}/{tot.get('c')}"
    for S in seats:
        line += f" | S={S}: hidden {tot.get(f'h{S}')} decoys {tot.get(f'c{S}')}"
    print(line, flush=True)
    net.train()


def tokset(s):
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def wide_train_rows(pattern, raw_path):
    """Engine-drawn rows (hidden and control) with the teacher's logits mapped onto the candidates M2 items became."""
    raw = {}
    for w in D.read_jsonl(raw_path):
        raw[w["id"]] = w
    rows = wide_rows(pattern, keep_text=True, sample=args.wide_rows)
    out = []
    for r in rows:
        wid, tid = r["template"].rsplit("-", 1)
        w = raw.get(wid)
        if not w:
            continue
        ti = next((i for i, t in enumerate(w["tasks"]) if t["id"] == tid), None)
        if ti is None:
            continue
        t = w["tasks"][ti]
        english = [q for q in t["requests"] if q["lang"] == "en" and q["style"] != "follow-up"]
        req = english[(r["seed"] + ti) % len(english)]
        tch = teacher.get(f"{t['family']}/{wid}/{tid}/{req['id']}", {})
        titles = [(it["id"], tokset(it["title"])) for it in w["items"]]
        lg = []
        for title in r["titles"]:
            ts = tokset(title)
            best, key = 0.0, None
            for k, tt in titles:
                j = len(ts & tt) / max(1, len(ts | tt))
                if j > best:
                    best, key = j, k
            lg.append(tch.get(key) if best >= 0.6 and key in tch else None)
        known = [x for x in lg if x is not None]
        floor = (min(known) - 3.0) if known else -10.0
        logits = [x if x is not None else floor for x in lg]
        y = r["ids"].index(r["planted"]) if r["planted"] in r["ids"] else -1
        if r["v"] == "h" and y < 0:
            continue
        out.append({**r, "logits": logits, "y": y if r["v"] == "h" else -1})
    return out


def wide_step(batch):
    K = max(len(r["g"]) for r in batch)
    flat, mask = [], torch.zeros(len(batch), K, dtype=torch.bool)
    T = torch.zeros(len(batch), K)
    for i, r in enumerate(batch):
        n = len(r["g"])
        flat += r["g"] + [[0]] * (K - n)
        mask[i, :n] = True
        p = torch.softmax(torch.tensor(r["logits"]) / args.tau, 0)
        if r["y"] >= 0:
            one = torch.zeros(n)
            one[r["y"]] = 1.0
            p = args.teacher_mix * p + (1 - args.teacher_mix) * one
        T[i, :n] = p
    qc = net.qenc([r["q"] for r in batch])
    ic = net.ienc(flat).view(len(batch), K, -1)
    s = net.score(qc, ic).masked_fill(~mask, -1e9)
    loss = -(T * F.log_softmax(s, 1)).sum(1).mean()
    opt.zero_grad()
    loss.backward()
    opt.step()
    return float(loss)


@torch.no_grad()
def eval_scan(tag):
    """The sim's fit worlds: candidates = main's pool, the pushWide rest and the code scan's first `--scan` new items;
    the pair score picks the S tail seats."""
    if not args.fit_terms or not args.fit_wide:
        return
    net.eval()
    wide = {}
    for path in sorted(glob.glob(args.fit_wide)):
        for line in open(path):
            r = json.loads(line)
            wide[(r["suite"], r["seed"], r["variant"], r["template"])] = r
    seats = [int(x) for x in args.seats.split(",")]
    tot = {}
    for w in D.read_jsonl(args.fit_terms):
        var = w["variant"]
        if var not in ("hidden", "control"):
            continue
        v = var[0]
        ids = [it["id"] for it in w["items"]]
        gi = [grams(it["title"] + it["text"]) for it in w["items"]]
        codes = torch.cat([net.ienc(gi[i: i + 512]) for i in range(0, len(gi), 512)])
        pos = {k: i for i, k in enumerate(ids)}
        for t in w["tasks"]:
            r = wide.get((w["suite"], w["seed"], var, t["template"]))
            if not r:
                continue
            pool = [x["id"] for x in r["pool"]]
            tot[v] = tot.get(v, 0) + 1
            tot[v + "0"] = tot.get(v + "0", 0) + (t["planted"] in pool)
            qc = net.qenc([grams(t["q"])])
            d = net.dot(qc, codes.unsqueeze(0))[0]
            seen = set(pool) | {x["id"] for x in r.get("wide", [])[: args.wide]}
            scan = [ids[i] for i in torch.argsort(-d).tolist() if ids[i] not in seen][: args.scan]
            tot[v + "scan"] = tot.get(v + "scan", 0) + (t["planted"] in scan)
            cand = [x for x in pool + [x["id"] for x in r.get("wide", [])[: args.wide]] + scan if x in pos]
            if not cand:
                continue
            s = net.score(qc, codes[[pos[x] for x in cand]].unsqueeze(0))[0].numpy()
            order = [cand[i] for i in np.argsort(-s, kind="stable")]
            for S in seats:
                head = pool[: max(0, min(len(pool), 15) - S)]
                hs = set(head)
                new = hs | set([x for x in order if x not in hs][: 15 - len(head)])
                tot[f"{v}{S}"] = tot.get(f"{v}{S}", 0) + (t["planted"] in new)
    line = (f"[{tag} scan] hidden {tot.get('h0')}/{tot.get('h')} decoys {tot.get('c0')}/{tot.get('c')}; scan holds "
            f"{tot.get('hscan', 0)} missed facts, {tot.get('cscan', 0)} missed decoys")
    for S in seats:
        line += f" | S={S}: hidden {tot.get(f'h{S}')} decoys {tot.get(f'c{S}')}"
    print(line, flush=True)
    net.train()


fit_rows = wide_rows(args.fit_wide) if args.fit_wide else []
val_rows = wide_rows(args.val_wide) if args.val_wide else []
if args.load:
    net.load_state_dict(torch.load(args.load, weights_only=False)["state"])
    eval_groups("loaded")
    eval_wide("loaded fit", fit_rows)
    eval_wide("loaded val-wide", val_rows)
    eval_scan("loaded")
    sys.exit(0)
wtrain = wide_train_rows(args.wide_train, args.synth_raw) if args.wide_train else []
if wtrain:
    print(f"engine-drawn rows {len(wtrain)} (teacher-mapped candidates "
          f"{sum(1 for r in wtrain for x in r['logits'] if x > min(r['logits']))})", flush=True)
n = 0
for ep in range(args.epochs):
    if wtrain:
        random.shuffle(wtrain)
        wi = 0
    reqs = [(wi, r) for wi, w in enumerate(train) for r in w["reqs"]]
    random.shuffle(reqs)
    tl = 0.0
    for i in range(0, len(reqs), args.batch):
        if len(reqs[i: i + args.batch]) < 2:
            continue
        tl += step(reqs[i: i + args.batch])
        if wtrain and random.random() < args.wide_weight:
            b = wtrain[wi: wi + args.batch]
            wi = (wi + args.batch) % max(1, len(wtrain) - args.batch)
            if len(b) >= 2:
                tl += wide_step(b)
        n += 1
        if n % 100 == 0:
            print(f"ep {ep} step {n} loss {tl / 100:.3f} ({time.time() - t0:.0f}s)", flush=True)
            tl = 0.0
        if args.eval_every and n % args.eval_every == 0:
            eval_groups(f"step {n}")
            eval_wide(f"step {n} fit", fit_rows)
    eval_groups(f"epoch {ep}")
    eval_wide(f"epoch {ep} fit", fit_rows)
    eval_wide(f"epoch {ep} val-wide", val_rows)
    eval_scan(f"epoch {ep}")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        torch.save({"state": net.state_dict(), "args": vars(args)}, os.path.join(args.out, "model.pt"))
