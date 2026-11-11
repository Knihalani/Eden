"""M6 (D920-D929): the trimmer's part dataset from `--packets --packet-parts` dumps and label.ts's labels.

    python3 -I packages/sim/lab/m6/prep.py --labels L.jsonl [--labels L2.jsonl] --out DIR DUMP.jsonl [DUMP ...]

Writes DIR/items.jsonl: one row per delivered item a task's packets held (the same item in two tasks is two rows),

    {set, suite, variant, request, src, title, role, parts: [[text, flags]], key: [part idx] | null,
     words: [token] | null, shipped: text pick kept}

`role` is fact (the planted item on a hidden task), decoy (the planted look-alike on a control task) or other. `key`
and `words` come from the labels (null when the planted item has none, or for other items). `set` is the split:

    train   synth-train worlds; train1-4 and their P7 / train-rw / longtail versions
    val     synth-val (thresholds are tuned here)
    test    synth-test (held out; dumped with --blind; measurement only)
    sim     train5, train6 and their reworded versions (held out from tuning; measurement only)
"""

import argparse
import hashlib
import json
import re


def unit_key(role, detail, title, parts):
    # label.ts's key: sha256 of JSON.stringify([role, detail, title, parts]), first 20 hex characters.
    body = json.dumps([role, detail, title, parts], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()[:20]


SIM_HELD = re.compile(r"^train[56]")


def set_of(suite):
    if suite.startswith("synth-train"):
        return "train"
    if suite.startswith("synth-val"):
        return "val"
    if suite.startswith("synth-test"):
        return "test"
    if SIM_HELD.match(suite):
        return "sim"
    return "train"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", action="append", default=[])
    ap.add_argument("--out", required=True)
    ap.add_argument("dumps", nargs="+")
    a = ap.parse_args()
    labels = {}
    for f in a.labels:
        for line in open(f):
            if line.strip():
                r = json.loads(line)
                labels[r["key"]] = r
    n = {"rows": 0, "planted": 0, "labelled": 0}
    import os

    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "items.jsonl"), "w") as out:
        for f in a.dumps:
            for line in open(f):
                if not line.strip():
                    continue
                r = json.loads(line)
                s = set_of(r["suite"])
                for packet in r.get("parts", []):
                    for it in packet:
                        if not it["parts"]:
                            continue
                        role = "other"
                        if it["id"] == r["planted"] and r["variant"] in ("hidden", "control"):
                            role = "fact" if r["variant"] == "hidden" else "decoy"
                        lab = None
                        if role != "other":
                            n["planted"] += 1
                            texts = [p[0] for p in it["parts"]]
                            lab = labels.get(unit_key(role, r.get("detail", ""), it["title"], texts))
                            if lab:
                                n["labelled"] += 1
                        row = {
                            "set": s,
                            "suite": r["suite"],
                            "seed": r["seed"],
                            "template": r["template"],
                            "variant": r["variant"],
                            "request": r["request"],
                            "src": it["source"],
                            "title": it["title"],
                            "role": role,
                            "parts": it["parts"],
                            "key": lab["parts"] if lab else None,
                            "words": lab["words"] if lab else None,
                            "shipped": it["kept"],
                        }
                        out.write(json.dumps(row, ensure_ascii=False) + "\n")
                        n["rows"] += 1
    print(json.dumps(n))


if __name__ == "__main__":
    main()
