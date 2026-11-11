"""M12: a lowrank expansion model (train.py --model lowrank) as the engine's EM12 table (pool-expand.ts).

  python3 -I export_table.py W/model.pt OUT.em12 [--topk 16] [--min 0.0]
Prints the file's size, the table's mean row length, and a few rows."""
import argparse
import struct

import torch
import torch.nn.functional as F

ap = argparse.ArgumentParser()
ap.add_argument("model")
ap.add_argument("out")
ap.add_argument("--topk", type=int, default=16)
ap.add_argument("--min", type=float, default=0.0, help="drop weights below this share of the table's maximum")
ap.add_argument("--show", default="expenses,car,delivery,key,dinner,school,transfer,book")
a = ap.parse_args()
ck = torch.load(a.model, weights_only=False)
st = ck["state"]
iv, rv = ck["iv"], ck["rv"]
assert len(iv) < 65536
u, g, v, b = st["u.weight"], st["g.weight"], st["v"], st["b"]
rows = []
with torch.no_grad():
    for t0 in range(0, len(rv), 2048):
        sl = slice(t0, min(len(rv), t0 + 2048))
        per = F.relu(u[sl] @ v.T + b) * F.softplus(g[sl])
        vals, idx = per.topk(a.topk, 1)
        for k in range(vals.shape[0]):
            keep = vals[k] > 0
            rows.append((idx[k][keep].tolist(), vals[k][keep].tolist()))
top = max((max(w) for _, w in rows if w), default=1.0)
floor = a.min * top
item_b = "\n".join(iv).encode()
req_b = "\n".join(rv).encode()
body = bytearray()
for ii, ww in rows:
    pairs = [(i, w) for i, w in zip(ii, ww) if w > floor]
    body.append(len(pairs))
    body += struct.pack(f"<{len(pairs)}H", *[i for i, _ in pairs])
    body += bytes(max(1, min(255, round(w / top * 255))) for _, w in pairs)
head = b"EM12" + struct.pack("<IfIIII", 1, top, len(iv), len(rv), len(item_b), len(req_b))
with open(a.out, "wb") as f:
    f.write(head + item_b + req_b + bytes(body))
n = sum(len(r[0]) for r in rows)
print(f"{a.out}: {len(head) + len(item_b) + len(req_b) + len(body)} bytes, {len(rv)} request terms, {n / len(rv):.1f} a row")
rid = {t: i for i, t in enumerate(rv)}
for t in a.show.split(","):
    if t in rid:
        ii, ww = rows[rid[t]]
        print(t, "→", ", ".join(f"{iv[i]} {w:.2f}" for i, w in sorted(zip(ii, ww), key=lambda x: -x[1])[:10]))
