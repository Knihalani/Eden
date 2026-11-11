"""M11: re-decode a saved CopyGen with other decode settings (no training). python3 -I decode.py NET.pt NAME [--kc ..]"""
import argparse, json, os, sys
import torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data as D, copygen as C  # noqa: E402

ck = torch.load(sys.argv[1], weights_only=False)
name = sys.argv[2]
ap = argparse.ArgumentParser()
for k in ("kc", "kg"):
    ap.add_argument(f"--{k}", type=int)
for k in ("theta-c", "theta-g", "lift"):
    ap.add_argument(f"--{k}", type=float)
o = ap.parse_args(sys.argv[3:])
args = dict(ck["args"])
for k, v in vars(o).items():
    if v is not None:
        args[k] = v
a = argparse.Namespace(**args)
m = C.Net(a, len(ck["vocab"]))
m.load_state_dict(ck["state"])
m.eval()
items, worlds = D.load()
held = [it for it in items.values() if it["split"] == "held"]
exp = C.expand_all(m, a, held, ck["vocab"], ck["prior"])
json.dump(exp, open(f".local/m11/exp/{name}.json", "w"))
a.name = name
C.report(items, worlds, exp, a)
