"""M13: export a trained bag or mil gate (gate.py) to the engine's flat file (`turn-gate.bin`), with the PyTorch
scores of 64 parity inputs for the TypeScript check (64/64: the same decision and the logit within 1e-4).

Layout: "EDG1", u32 header length, the header (JSON, UTF-8, padded to 4), then each array at its header offset:
`emb` int8 [2^bits × dim] with `scale` float32 [dim] (per column, as the int8 fake quantisation trained it), or
`emb` float32; `hidW` float32 [hidden × dim], `hidB`; `needsW` [d], `needsB` [1]; `kindW` [5 × d], `kindB` [5].

    .venv-m3/bin/python -I packages/sim/lab/m13/export.py RUN.pt OUT.bin PARITY.json
"""
import argparse, json, os, struct, sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate as G  # noqa: E402
import score as S  # noqa: E402

PARITY = ["cancel it", "book it", "Ich brauche ein neues Bett", "I need a new bed", "thanks!", "Yes",
          "The boiler's making that noise again, can you book Ferguson's for Tuesday?",
          "Kannst du den Zahnarzttermin auf Freitag verschieben?", "annule-le", "cancélalo",
          "What time is my dentist appointment on Thursday?", "We should go to Iceland one day",
          "कृपया कल सुबह 10 बजे डॉक्टर का अपॉइंटमेंट बुक कर दो", "İstanbul'a uçak bileti al lütfen", "明天下午三点帮我订餐厅",
          "Traceback (most recent call last): File app.py, line 42", "", "a", "ok so anyway the weather is nice today",
          "Morning! Long week. Anyway, could you confirm the tasting room booking for Saturday?"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("out")
    ap.add_argument("parity")
    o = ap.parse_args()
    m, a, thr, skel = S.model_of(o.model)
    assert a.arch in ("bag", "mil"), "export covers the bag and mil gates"
    st = {k: v.detach().numpy() for k, v in m.state_dict().items()}
    arrays = []
    w = m.emb.detach()
    if a.quant == "int8":
        s = (w.abs().amax(dim=0).clamp_min(1e-8) / 127).numpy().astype(np.float32)
        q = np.clip(np.round(w.numpy() / s), -127, 127).astype(np.int8)
        arrays += [("emb", q), ("scale", s)]
    else:
        arrays += [("emb", w.numpy().astype(np.float32))]
    if a.hidden:
        arrays += [("hidW", st["hid.weight"]), ("hidB", st["hid.bias"])]
    arrays += [("needsW", st["needs.weight"].reshape(-1)), ("needsB", st["needs.bias"]),
               ("kindW", st["kind.weight"]), ("kindB", st["kind.bias"])]
    head = {"v": 1, "arch": a.arch, "bits": a.bits, "dim": a.dim, "hidden": a.hidden, "quant": a.quant,
            "groups": a.groups, "rule": bool(a.rule), "threshold": thr,
            "logit": float(np.log(thr / (1 - thr))), "kinds": G.KINDS, "skel": skel or [], "arrays": []}
    off = 0
    blobs = []
    for name, arr in arrays:
        arr = np.ascontiguousarray(arr.astype(np.int8 if arr.dtype == np.int8 else np.float32))
        head["arrays"].append({"name": name, "dtype": str(arr.dtype), "shape": list(arr.shape), "offset": off})
        b = arr.tobytes()
        b += b"\0" * (-len(b) % 4)
        blobs.append(b)
        off += len(b)
    hj = json.dumps(head, ensure_ascii=False).encode()
    hj += b" " * (-len(hj) % 4)
    with open(o.out, "wb") as f:
        f.write(b"EDG1" + struct.pack("<I", len(hj)) + hj + b"".join(blobs))
    # Parity: 20 hand-picked inputs and 44 rows of the dev set (the shipped rule's reading included for H7).
    dev = G.load("dev")
    rows = [{"text": t, "rule": "none", "rest": False} for t in PARITY] + [
        {"text": r["text"], "rule": r["rule"], "rest": r["rest"]} for r in dev[:: max(1, len(dev) // 44)][:44]]
    G.prep(rows, a, skel)
    m.eval()
    with torch.no_grad():
        n, k = m(G.batchify(rows, a))
    json.dump([{"text": r["text"], "rule": r["rule"], "rest": r["rest"], "logit": float(x), "kind": int(y)}
               for r, x, y in zip(rows, n.tolist(), k.argmax(-1).tolist())], open(o.parity, "w"), ensure_ascii=False)
    print(o.out, os.path.getsize(o.out), "bytes;", len(rows), "parity rows")


if __name__ == "__main__":
    main()
