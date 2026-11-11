"""M10 H1: hashed sparse linear heads (lab only). The baseline every other hypothesis is measured against.

Item heads (kind softmax, actions sigmoid) over hashed word, bigram and character n-grams of the title and own text;
token BIO over hashed window features; date roles and amount flags over hashed window features of each mention;
the statement as a softmax over sentences. One EmbeddingBag (sum) per head is a sparse linear layer.

    python3 packages/sim/lab/m10/h1_sparse.py --set set.jsonl.gz --fixtures fixtures.jsonl --out DIR [--buckets 18]
Writes DIR/preds.jsonl, DIR/fixture-preds.jsonl and DIR/metrics.json (evalset.report).
"""
import argparse, gzip, json, math, os, random, re, sys, zlib

import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import ACTIONS, KINDS
from evalset import decode, load, report

torch.set_num_threads(int(os.environ.get("M10_THREADS", "4")))


def H(s, B):
    return zlib.crc32(s.encode()) % B


def shape(w):
    s = re.sub(r"[A-Z]", "A", w)
    s = re.sub(r"[a-z]", "a", s)
    s = re.sub(r"\d", "9", s)
    return re.sub(r"(.)\1+", r"\1\1", s)[:6]


def item_feats(r, B):
    f = []
    toks = r["toks"]
    for i, (w, s) in enumerate(toks):
        l = w.lower()
        z = "T" if s == 0 else "B"
        f.append(f"w:{l}")
        f.append(f"{z}w:{l}")
        if i + 1 < len(toks):
            f.append(f"bg:{l} {toks[i+1][0].lower()}")
        p = f"<{l}>"
        for n in (3, 4):
            for k in range(len(p) - n + 1):
                f.append(f"c{n}:{p[k:k+n]}")
    f.append(f"src:{r['source']}")
    f.append(f"nd:{min(len(r['dates']), 5)}")
    f.append(f"na:{min(len(r['amounts']), 3)}")
    return [H(x, B) for x in f] or [0]


def tok_feats(toks, i, B):
    w, s = toks[i]
    l = w.lower()
    g = lambda k: toks[k][0].lower() if 0 <= k < len(toks) else "<pad>"
    f = [f"w:{l}", f"sh:{shape(w)}", f"p3:{l[:3]}", f"s3:{l[-3:]}", f"t:{s == 0}", f"w-1:{g(i-1)}", f"w+1:{g(i+1)}",
         f"w-2:{g(i-2)}", f"w+2:{g(i+2)}", f"sh-1:{shape(toks[i-1][0]) if i else '<'}", f"cap:{w[:1].isupper()}",
         f"cap-1:{toks[i-1][0][:1].isupper() if i else 'x'}", f"cap+1:{toks[i+1][0][:1].isupper() if i + 1 < len(toks) else 'x'}"]
    return [H(x, B) for x in f]


def mention_feats(r, m, B, kind):
    toks = r["toks"]
    a, b = m["from"], m["to"]
    f = [f"{kind}"]
    if a < 0:
        f.append("anchor")
    else:
        for d in range(1, 5):
            if a - d >= 0:
                f.append(f"L{d}:{toks[a-d][0].lower()}")
                f.append(f"Lb:{toks[a-d][0].lower()}")
            if b - 1 + d < len(toks):
                f.append(f"R{d}:{toks[b-1+d][0].lower()}")
                f.append(f"Rb:{toks[b-1+d][0].lower()}")
        f.append(f"sent:{min(toks[a][1], 4)}")
        f.append(f"title:{toks[a][1] == 0}")
    if kind == "date":
        f += [f"form:{m['form']}", f"range:{m['range']}"]
        dated = r["dated"] or r["now"]
        try:
            from datetime import date
            delta = (date.fromisoformat(m["day"]) - date.fromisoformat(dated)).days
        except Exception:
            delta = 0
        f.append(f"delta:{max(-3, min(3, int(math.copysign(math.log1p(abs(delta)), delta))))}")
        f.append(f"same:{sum(1 for x in r['dates'] if x['day'] == m['day'])}")
    else:
        f += [f"unit:{m['unit']}", f"mag:{int(math.log10(max(1, m['value'])))}"]
    return [H(x, B) for x in f]


def sent_feats(r, s, B):
    ws = [w.lower() for w, ss in r["toks"] if ss == s]
    f = [f"w:{w}" for w in ws] + [f"pos:{min(s, 5)}", f"len:{min(len(ws) // 5, 6)}"]
    return [H(x, B) for x in f] or [0]


class Bag(nn.Module):
    def __init__(self, B, n):
        super().__init__()
        self.e = nn.EmbeddingBag(B, n, mode="sum")
        nn.init.zeros_(self.e.weight)
        self.b = nn.Parameter(torch.zeros(n))

    def forward(self, lists):
        flat = torch.tensor([x for l in lists for x in l], dtype=torch.long)
        offs = torch.tensor([0] + [len(l) for l in lists[:-1]], dtype=torch.long).cumsum(0)
        return self.e(flat, offs) + self.b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True)
    ap.add_argument("--fixtures")
    ap.add_argument("--haiku-fixtures", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--buckets", type=int, default=18)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--predict", default="", help="rows to write raw outputs for (predict.jsonl in --out)")
    a = ap.parse_args()
    B = 1 << a.buckets
    rows = load(a.set)
    train = [r for r in rows if r["split"] == "train"]
    random.seed(1)
    torch.manual_seed(1)
    heads = nn.ModuleDict({"kind": Bag(B, len(KINDS)), "act": Bag(B, len(ACTIONS)), "bio": Bag(B, 3),
                           "date": Bag(B, 2), "amt": Bag(B, 1), "stmt": Bag(B, 1)})
    opt = torch.optim.Adam(heads.parameters(), lr=0.05)
    cache = {}

    def feats(r):
        if r["h"] not in cache:
            cache[r["h"]] = {
                "item": item_feats(r, B),
                "tok": [tok_feats(r["toks"], i, B) for i in range(len(r["toks"]))],
                "date": [mention_feats(r, m, B, "date") for m in r["dates"]],
                "amt": [mention_feats(r, m, B, "amt") for m in r["amounts"]],
                "sent": [sent_feats(r, s, B) for s in range(max([t[1] for t in r["toks"]], default=0) + 1)],
            }
        return cache[r["h"]]

    def forward(r):
        f = feats(r)
        o = {"kind": heads["kind"]([f["item"]])[0], "act": heads["act"]([f["item"]])[0]}
        o["bio"] = heads["bio"](f["tok"]) if f["tok"] else torch.zeros(0, 3)
        o["date"] = heads["date"](f["date"]) if f["date"] else torch.zeros(0, 2)
        o["amt"] = heads["amt"](f["amt"])[:, 0] if f["amt"] else torch.zeros(0)
        o["stmt"] = heads["stmt"](f["sent"])[:, 0] if f["sent"] else torch.zeros(0)
        return o

    bce = nn.BCEWithLogitsLoss()
    for ep in range(a.epochs):
        random.shuffle(train)
        tot = 0.0
        for i in range(0, len(train), 32):
            loss = 0
            for r in train[i : i + 32]:
                o, c, t = forward(r), r["card"], r["target"]
                k = KINDS.index(c["kind"])
                loss = loss + nn.functional.cross_entropy(o["kind"][None], torch.tensor([k]))
                if k:
                    y = torch.tensor([1.0 if x in c["actions"] else 0.0 for x in ACTIONS])
                    loss = loss + bce(o["act"], y)
                    if len(t["bio"]):
                        loss = loss + 0.5 * nn.functional.cross_entropy(o["bio"], torch.tensor(t["bio"]))
                    if len(t["roles"]):
                        y = torch.tensor([[float(x & 1), float(x >> 1 & 1)] for x in t["roles"]])
                        loss = loss + bce(o["date"], y)
                    if len(t["amt"]):
                        loss = loss + bce(o["amt"], torch.tensor([float(x) for x in t["amt"]]))
                    if t["stmt"] >= 0 and t["stmt"] < len(o["stmt"]):
                        loss = loss + 0.3 * nn.functional.cross_entropy(o["stmt"][None], torch.tensor([t["stmt"]]))
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += float(loss)
        print(f"epoch {ep} loss {tot / len(train):.4f}", flush=True)

    def outs(r):
        with torch.no_grad():
            o = forward(r)
        return {"kind": torch.softmax(o["kind"], 0).tolist(), "actions": torch.sigmoid(o["act"]).tolist(),
                "bio": torch.softmax(o["bio"], 1).tolist(), "roles": torch.sigmoid(o["date"]).tolist(),
                "amt": torch.sigmoid(o["amt"]).tolist(), "stmt": o["stmt"].tolist()}

    os.makedirs(a.out, exist_ok=True)
    torch.save({"buckets": a.buckets, "state": heads.state_dict()}, f"{a.out}/model.pt")
    held = [r for r in rows if r["split"] == "heldout"]
    preds = {r["h"]: outs(r) for r in held}
    with open(f"{a.out}/preds.jsonl", "w") as f:
        for h, o in preds.items():
            f.write(json.dumps({"h": h, "out": o}) + "\n")
    cards = {r["h"]: decode(r, preds[r["h"]]) for r in held}
    fx = fc = hf = None
    if a.fixtures:
        fx = load(a.fixtures)
        fc = {f["h"]: decode(f, outs(f)) for f in fx}
        hf = [{d["h"]: d["c"] for d in load(p)} for p in a.haiku_fixtures.split(",") if p]
    if a.predict:
        with open(f"{a.out}/predict.jsonl", "w") as f:
            for r in load(a.predict):
                f.write(json.dumps({"h": r["h"], "out": outs(r)}) + "\n")
    m = report(rows, cards, fx, fc, hf)
    m["nonzero_weights"] = int(sum((p.abs() > 1e-4).sum() for p in heads.parameters()))
    json.dump(m, open(f"{a.out}/metrics.json", "w"), indent=1)
    print(json.dumps(m, indent=1))


if __name__ == "__main__":
    main()
