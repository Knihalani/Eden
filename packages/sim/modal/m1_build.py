"""M1: the student's rows file (no Modal). Train-suite pairs (`i1-label.ts pairs`, train only) and, optionally, M2's
synthetic groups, each with an optional teacher's labels (`i2-label.ts label` rows: group, key, y 0-100).

    python3 -I packages/sim/modal/m1_build.py --pairs .local/m1/pairs.jsonl [--labels L.jsonl] \
        [--synth S.jsonl [--synth-labels SL.jsonl] [--synth-share 0.15]] --out .local/m1/data/NAME.jsonl
"""
import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m1_data as d  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--labels", default="")
    ap.add_argument("--synth", default="", help="comma-separated synthetic group files")
    ap.add_argument("--synth-labels", default="")
    ap.add_argument("--synth-share", type=float, default=0.15)
    ap.add_argument("--dev-share", type=float, default=0.15, help="train templates moved to the tuning split")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    labels = d.read_jsonl(a.labels) if a.labels else None
    rows = d.rows_from_train_groups(d.read_jsonl(a.pairs), labels, a.dev_share)
    if a.synth:
        slabels = d.read_jsonl(a.synth_labels) if a.synth_labels else None
        groups = [g for p in a.synth.split(",") for g in d.read_jsonl(p)]
        rows += d.rows_from_synth_groups(groups, a.synth_share, slabels)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    c = collections.Counter((r["src"], r["split"], r["truth"]) for r in rows)
    fams = collections.Counter((r["src"], r["split"]) for r in {(r["src"], r["split"], r["family"]): r
                                                               for r in rows}.values())
    print(json.dumps({"rows": len(rows), "by": {"/".join(k): v for k, v in sorted(c.items())},
                      "families": {"/".join(k): v for k, v in sorted(fams.items())},
                      "labelled": sum(r["y"] is not None for r in rows)}, indent=1))


if __name__ == "__main__":
    main()
