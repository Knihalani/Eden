"""Fix S1 (docs/research/fix-s1-reader.md): each reader trial arm against `eden` on the same Pi runs.

  python3 -I s1.py OUT.json LEDGER.jsonl run1.json[,run2.json ...]

Reuses RealUse-1's T1 summariser (`../realuse-1/A/t1.py`: rows per task, the 1:1:8 mix, paired bootstrap 95%
intervals over tasks, 4,000 resamples) with the pairs `eden~X - eden` for every trial arm in the files, and with
reader calls and Eden's fetches added to the paired fields.
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("t1", os.path.join(HERE, "..", "realuse-1", "A", "t1.py"))
t1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t1)
t1.DIFF = t1.DIFF + (("readerCalls", 1), ("edenFetch", 1), ("askCalls", 1))


def main():
    out_path, ledger, files = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
    rows, meta = t1.load(files)
    summary = {"mix": t1.MIX, "profiles": {}, "pairs": {}, "meta": {"direct": meta}}
    conds = sorted({c for (c, _) in rows})
    cell = summary["profiles"]["direct"] = {}
    for c in conds:
        by_kind = {k: [row for (cc, _), (kk, row) in rows.items() if cc == c and kk == k] for k in t1.KINDS}
        cell[c] = {k: t1.summarise(v) for k, v in by_kind.items() if v}
        mr = t1.mix_row(by_kind)
        if mr:
            cell[c]["mix"] = mr
    keyed = {c: {(k, t): row for (cc, t), (k, row) in rows.items() if cc == c} for c in conds}
    for c in conds:
        if c != "eden" and "eden" in keyed:
            summary["pairs"][f"{c} - eden"] = t1.paired(keyed[c], keyed["eden"])
    labels = [m["file"][: -len(".json")] for m in meta]
    summary["ledger"] = t1.ledger_by_role(ledger, labels)
    json.dump(summary, open(out_path, "w"), indent=1, sort_keys=True)
    t1.show(summary)
    for pair, kinds in summary["pairs"].items():
        for k, v in kinds.items():
            if k != "mix":
                print(
                    f"{pair:16} {k:7} reader {t1.ci(v['readerCalls'], 2)} fetch {t1.ci(v['edenFetch'], 2)} "
                    f"asks {t1.ci(v['askCalls'], 2)}"
                )


if __name__ == "__main__":
    main()
