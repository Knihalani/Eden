"""M13: assemble the gate's training, dev and held-out files from every source, each row
`{text, needs, kind, lang, src, group, split}` (kind "" when a source does not say), then add the shipped rule's
reading (rules.ts). Train/dev split by group (a contrastive set, an M2 world, a P2 set), never by row.

    python3 -I packages/sim/lab/m13/build.py   # reads .local/m13/{data,train,held}, writes .local/m13/sets/
"""
import glob, gzip, json, os, subprocess, zlib

L = ".local/m13"
M2_KIND = {"should-i": "qact", "question": "qact", "follow-up": "qact"}
P2_KIND = {"indirect": "act", "imperative": "act", "foreign": "act", "chatter": "chatter", "statement": "statement",
           "question": "ask", "log": "statement", "foreign-neg": ""}
NEEDS = {"act", "qact"}


def dev_of(group, share=10):
    return zlib.crc32(group.encode()) % 100 < share


def m2(path, split_all=None):
    for line in gzip.open(path, "rt"):
        w = json.loads(line)
        for t in w["tasks"]:
            for r in t["requests"]:
                yield {"text": r["text"], "needs": True, "kind": M2_KIND.get(r["style"], "act"), "lang": r["lang"],
                       "src": "m2:" + r["style"], "group": "m2-" + w["id"],
                       "split": split_all or ("dev" if dev_of(w["id"]) else "train")}


def main():
    os.makedirs(f"{L}/sets", exist_ok=True)
    out = {"train": [], "dev": [], "s3": [], "s4": [], "m2t": [], "sim56": []}
    for r in m2(f"{L}/data/train-300.jsonl.gz"):
        out[r["split"]].append(r)
    for r in m2(f"{L}/data/test.jsonl.gz", "m2t"):
        out["m2t"].append(r)
    for path in [f"{L}/train/gen.jsonl", f"{L}/train/logs.jsonl", f"{L}/train/gen-work.jsonl"]:
        if not os.path.exists(path):
            continue
        for line in open(path):
            r = json.loads(line)
            if not r["text"]:
                continue
            r["needs"] = r["kind"] in NEEDS
            r["split"] = "dev" if dev_of(r["group"]) else "train"
            out[r["split"]].append(r)
    # The sim's hand-written families: train1-2 (and their rewordings) train, train3-4 select (dev), train5-6 are held
    # out (SIM56, addendum A): models fit on generated text transfer badly to differently written text (M6, D920).
    for line in open(f"{L}/train/suites.jsonl"):
        r = json.loads(line)
        fam = int(r["src"][5])
        split = "train" if fam <= 2 else "dev" if fam <= 4 else "sim56"
        out[split].append({"text": r["text"], "needs": True, "kind": "act", "lang": "en", "src": "suite:" + r["src"],
                           "group": "suite-" + r["src"], "split": split})
    for f in sorted(glob.glob("packages/eval/scenarios/acting/*.json")):
        for s in json.load(open(f))["sessions"]:
            for t in s["turns"]:
                e = t["event"]
                if e.get("kind") == "user_message":
                    out["train"].append({"text": e["text"], "needs": True, "kind": "act", "lang": "en",
                                         "src": "eval-acting", "group": "eval", "split": "train"})
    # M14's independent generators (G2: Sonnet, five new styles, some non-English worlds; G3: programmatic, OCR
    # noise): every request acts. Dev only, as transfer families for selection (never a gradient step).
    for g in ("g2", "g3"):
        path = f"{L}/m14/{g}.jsonl.gz"
        if os.path.exists(path):
            for line in gzip.open(path, "rt"):
                w = json.loads(line)
                for t in w["tasks"]:
                    for r in t.get("requests", []):
                        out["dev"].append({"text": r["text"], "needs": True, "kind": "act", "lang": r.get("lang", "en"),
                                           "src": f"{g}:" + str(r.get("style")), "group": f"{g}-" + w["id"],
                                           "split": "dev"})
    neg = subprocess.run(["bun", "-e", "import {GATE_NEGATIVES as g} from './packages/sim/src/lab/gate-negatives.ts';"
                          "console.log(JSON.stringify(g))"], capture_output=True, text=True, check=True).stdout
    for r in json.loads(neg):
        out["train"].append({"text": r["text"], "needs": False, "kind": P2_KIND[r["kind"]], "lang": "en",
                             "src": "p2neg:" + r["kind"], "group": "p2neg", "split": "train"})
    # P2's sets 1 and 2 (both fitted and read by P2): set 1, hand-written, trains (round 2); set 2 is dev.
    for i in (1, 2):
        split = "train" if i == 1 else "dev"
        for r in json.load(open(f"packages/sim/lab/p2/blind-gate-{i}.json")):
            out[split].append({"text": r["text"], "needs": P2_KIND[r["kind"]] == "act", "kind": P2_KIND[r["kind"]],
                               "lang": r.get("lang", "en"), "src": f"p2s{i}:" + r["kind"], "group": f"p2s{i}",
                               "split": split})
    for r in json.load(open("packages/sim/lab/p2/blind-gate-3.json")):
        out["s3"].append({"text": r["text"], "needs": P2_KIND[r["kind"]] == "act", "kind": P2_KIND[r["kind"]],
                          "lang": "en", "src": "s3:" + r["kind"], "group": "s3", "split": "s3"})
    if os.path.exists(f"{L}/held/blind-gate-4.json"):
        for r in json.load(open(f"{L}/held/blind-gate-4.json")):
            k = "statement" if r["kind"] in ("intent", "log") else r["kind"]
            out["s4"].append({"text": r["text"], "needs": r["kind"] in NEEDS, "kind": k, "lang": r["lang"],
                              "src": "s4:" + r["kind"], "group": "s4", "split": "s4"})
    for name, rows in out.items():
        tmp = f"{L}/sets/{name}.raw.jsonl"
        with open(tmp, "w") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        subprocess.run(["bun", "packages/sim/lab/m13/rules.ts", tmp, f"{L}/sets/{name}.jsonl"], check=True)
        os.remove(tmp)
        print(name, len(rows))


if __name__ == "__main__":
    main()
