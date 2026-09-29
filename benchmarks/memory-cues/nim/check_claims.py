"""Verify two R8 claims: bge_ctx dev FIR at the 5% point; share of nim-para cues on which BM25F_ctx / M0 inject anything."""
import json, os, sys
sys.argv = ["eval.py", "0.05", "x", "y"]
import eval as E
R = {r["name"]: r for r in json.load(open("out/results-fir0.05.json"))}
print("bge_ctx dev", {k: round(v, 3) for k, v in R["M5 bge-small_ctx"]["dev"].items()})
print("bm25_ctx dev", {k: round(v, 3) for k, v in R["M1 BM25F_ctx"]["dev"].items()})
methods = {**E.M(""), **E.M("_ctx")}
para = [q for q in E.C if E.C[q]["c"]["cat"] == "nim-para"]
for name in ["M1 BM25F_ctx", "M5 bge-small_ctx"]:
    pk = {q: E.packet(E.C[q], methods[name], R[name]["params"]) for q in para}
    print(name, "share of nim-para cues with any injection:", round(sum(bool(pk[q]) for q in para) / len(para), 3))
print("M0 share:", round(sum(bool(E.m0[q]["M0"]) for q in para) / len(para), 3))
