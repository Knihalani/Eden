"""E3 evaluation: regex (D7/D9) vs LLM extractors on batch A (270), batch B (60, held out from the regex author), both.
Also: raw (unstripped) paste items, latency and tokens per item, and a 'regex + LLM confirm' combination
(a regex extraction is kept only if the LLM extracts the same (slot, op) or (class, polarity)). -> out/e3-results.json"""
import json, os, glob
import numpy as np
from e3_data import ITEMS, ITEMS_B
from e3_regex import extract
from e3_score import score, norm_pred

MODELS = ["gpt-oss-20b", "nemotron-3.5-lightning-30b-a3b", "gemma-4-31b-it", "nemotron-3-super-120b-a12b"]
BATCH = {"A": ITEMS, "B": ITEMS_B}


def load(model):
    p = f"out/e3-{model}.json"
    if not os.path.exists(p):
        return None
    res = json.load(open(p))
    return {(r["batch"], r["i"]): r for r in res}


def confirm(rx, llm):
    keys = set()
    for e in llm:
        n = norm_pred(e)
        if n and n["kind"] == "slot":
            keys.add(("slot", n["slot"], n["op"]))
        elif n:
            keys.add(("rule", n["cls"], n["pol"]))
    out = []
    for e in rx:
        n = norm_pred(e)
        k = ("slot", n["slot"], n["op"]) if n["kind"] == "slot" else ("rule", n["cls"], n["pol"])
        if k in keys:
            out.append(e)
    return out


def union(rx, llm):
    return list(rx) + [e for e in llm if norm_pred(e) and norm_pred(e) not in [norm_pred(x) for x in rx]]


def pct(xs, q):
    xs = [x for x in xs if x is not None]
    return float(np.percentile(xs, q)) if xs else None


if __name__ == "__main__":
    out = {}; lines = []
    rx = {(b, i): extract(t) for b, items in BATCH.items() for i, (t, _, _) in enumerate(items)}
    systems = {"regex (D7+D9)": rx}
    costs = {}
    for m in MODELS:
        L = load(m)
        if not L:
            continue
        systems[f"LLM {m}"] = {k: v["ex"] for k, v in L.items()}
        systems[f"regex + {m} confirm"] = {k: confirm(rx[k], L[k]["ex"]) for k in rx}
        systems[f"regex ∪ {m}"] = {k: union(rx[k], L[k]["ex"]) for k in rx}
        live = [v for v in L.values() if not v.get("skipped") and not v.get("cached_all")]
        lat = [v["latency_s"] for v in live if v.get("latency_s")]
        pt = [v["usage"]["prompt_tokens"] for v in live if v.get("usage")]; ct = [v["usage"]["completion_tokens"] for v in live if v.get("usage")]
        costs[m] = dict(n=len(live), parsed=sum(v["parsed"] for v in L.values()), lat_p50=pct(lat, 50), lat_p95=pct(lat, 95),
                        prompt_tok_mean=float(np.mean(pt)) if pt else None, completion_tok_mean=float(np.mean(ct)) if ct else None)
        R = load(m + "-raw")
        if R:
            items = [(t, c, a) for b, its in BATCH.items() for i, (t, c, a) in enumerate(its) if c == "paste"]
            keys = [(b, i) for b, its in BATCH.items() for i, (t, c, a) in enumerate(its) if c == "paste"]
            mr, _ = score(items, [R[k]["ex"] for k in keys])
            costs[m]["raw_paste_false_durable"] = f"{mr['plain_false_n']}/{mr['plain_n']}"
    for name, P in systems.items():
        row = {}
        for bname, sel in [("A", ["A"]), ("B", ["B"]), ("A+B", ["A", "B"])]:
            items = [it for b in sel for it in BATCH[b]]
            preds = [P[(b, i)] for b in sel for i in range(len(BATCH[b]))]
            m, errs = score(items, preds)
            row[bname] = {k: v for k, v in m.items() if k != "per_cat"}
            row[bname]["per_cat_false"] = {c: v["any_pred"] for c, v in m["per_cat"].items() if c in ("request", "trap", "status", "paste")}
            if bname == "A+B":
                row["errors"] = [(e[0], e[1], e[2] if not isinstance(e[2], tuple) else [str(x) for x in e[2]]) for e in errs]
        out[name] = row
        f = lambda d, k: "-" if d[k] != d[k] else f"{d[k]:.2f}"
        for b in ("A", "B", "A+B"):
            d = row[b]
            lines.append(f"{name} [{b}] | false-durable {d['plain_false_n']}/{d['plain_n']} ({d['plain_false_durable']:.3f}) | detect P {f(d,'detect_P')} R {f(d,'detect_R')} | slot P {f(d,'slot_P')} R {f(d,'slot_R')} | slot-key P {f(d,'slotkey_P')} R {f(d,'slotkey_R')} | rule P {f(d,'rule_P')} R {f(d,'rule_R')} | strict P {f(d,'rule_strict_P')} R {f(d,'rule_strict_R')} | strict(default-obj) P {f(d,'rule_len_P')} R {f(d,'rule_len_R')} | kind {f(d,'kind_acc')} obj {f(d,'obj_acc')} obj-default {f(d,'obj_len_acc')} qual {f(d,'qual_acc')} | false by cat {d['per_cat_false']}")
    print("\n".join(lines)); print(json.dumps(costs, indent=1))
    json.dump(dict(results=out, costs=costs), open("out/e3-results.json", "w"), indent=1, default=str)
    open("out/e3-results.txt", "w").write("\n".join(lines) + "\n" + json.dumps(costs, indent=1))
