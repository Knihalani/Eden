"""M10: export a trained sparse tagger (h1_sparse.py's `model.pt`) to the tagger's weights file (lab only; the trial was rejected, D960), and its parity rows.

    python3 packages/sim/lab/m10/export_h1.py --model DIR/model.pt --out .local/m10/micro-cards-v1.bin \
        --parity-rows predict-v1.jsonl.gz --parity-out .local/m10/micro-cards-v1.parity.jsonl [--n 64]

File: "MCV1", u32 LE header length, a JSON header ({version, buckets, heads: [{name, out}]}), then per head in the
header's order: f32 scales [out], f32 bias [out], int8 weights [buckets x out] row-major (bucket-major). A weight is
q * scale[col]. Parity rows: `{row, card}` for `--n` items, the card decoded (evalset.decode) from the forward over the
QUANTISED weights, so the TypeScript forward must reproduce each card exactly.
"""
import argparse, json, os, struct, sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evalset import decode, load
from h1_sparse import item_feats, mention_feats, sent_feats, tok_feats

HEADS = ["kind", "act", "bio", "date", "amt", "stmt"]

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True, help="model.pt, or several comma-separated: their weights averaged")
ap.add_argument("--out", required=True)
ap.add_argument("--parity-rows")
ap.add_argument("--parity-out")
ap.add_argument("--n", type=int, default=64)
ap.add_argument("--t-flag", type=float, default=0.5)
ap.add_argument("--predict-rows")
ap.add_argument("--predict-out")
ap.add_argument("--t-act", type=float, default=0.5)
ap.add_argument("--t-ent", type=float, default=None)
a = ap.parse_args()
# Several seeds' models averaged: for linear heads, the mean of their logits is the model of their mean weights.
ms = [torch.load(p) for p in a.model.split(",")]
m = ms[0]
B = 1 << m["buckets"]
st = {k: sum(x["state"][k].float() for x in ms) / len(ms) for k in m["state"]}
q, header = {}, {"version": 1, "buckets": B, "heads": [], "tFlag": a.t_flag, "tAct": a.t_act, **({"tEnt": a.t_ent} if a.t_ent is not None else {})}
blob = b""
for h in HEADS:
    w = st[f"{h}.e.weight"].float()  # [B, out]
    b = st[f"{h}.b"].float()
    scale = (w.abs().max(0).values / 127.0).clamp(min=1e-12)
    qi = torch.round(w / scale).clamp(-127, 127).to(torch.int8)
    q[h] = (qi.float() * scale, b)
    header["heads"].append({"name": h, "out": int(w.shape[1])})
    blob += scale.numpy().astype("<f4").tobytes() + b.numpy().astype("<f4").tobytes() + qi.numpy().tobytes()
hj = json.dumps(header).encode()
os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
with open(a.out, "wb") as f:
    f.write(b"MCV1" + struct.pack("<I", len(hj)) + hj + blob)
print(a.out, os.path.getsize(a.out), "bytes")


def bag(h, lists):
    w, b = q[h]
    return [w[torch.tensor(l, dtype=torch.long)].sum(0) + b for l in lists]


def outs(r):
    it = item_feats(r, B)
    kind = bag("kind", [it])[0]
    act = bag("act", [it])[0]
    toks = [tok_feats(r["toks"], i, B) for i in range(len(r["toks"]))]
    dates = [mention_feats(r, d, B, "date") for d in r["dates"]]
    amts = [mention_feats(r, d, B, "amt") for d in r["amounts"]]
    sents = [sent_feats(r, s, B) for s in range(max([t[1] for t in r["toks"]], default=0) + 1)]
    return {
        "kind": torch.softmax(kind, 0).tolist(),
        "actions": torch.sigmoid(act).tolist(),
        "bio": [torch.softmax(x, 0).tolist() for x in bag("bio", toks)] if toks else [],
        "roles": [torch.sigmoid(x).tolist() for x in bag("date", dates)] if dates else [],
        "amt": [float(torch.sigmoid(x[0])) for x in bag("amt", amts)] if amts else [],
        "stmt": [float(x[0]) for x in bag("stmt", sents)] if sents else [],
    }


if a.parity_rows and a.parity_out:
    rows = load(a.parity_rows)[: a.n]
    with open(a.parity_out, "w") as f:
        for r in rows:
            keep = {k: r[k] for k in ("h", "title", "own", "dated", "now", "source", "toks", "dates", "amounts")}
            f.write(json.dumps({"row": keep, "card": decode(r, outs(r), a.t_flag, a.t_act, 0.5, 0.5, a.t_ent)}) + "\n")
    print(a.parity_out, len(rows), "rows")

# `--predict-rows F --predict-out G`: the exported (quantised, averaged) model's raw outputs for every row of F, as
# `{h, out}` lines (to_cards.py reads them): the replay arm then measures exactly what the engine would run.
if getattr(a, "predict_rows", None) and a.predict_out:
    with open(a.predict_out, "w") as f:
        for r in load(a.predict_rows):
            f.write(json.dumps({"h": r["h"], "out": outs(r)}) + "\n")
    print(a.predict_out)
