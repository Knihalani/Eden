"""M2 (D880-D884): the synthetic-world dataset on the Modal Volume `eden-synth`: upload, validate in a container,
and download. Lab tooling, not product code. No key is used or needed here: generation runs locally on the Anthropic
API (packages/sim/src/lab/synth/gen.ts); Modal stores and checks the result.

    modal run packages/sim/modal/synth_store.py::upload --src .local/m2/synth --tag v1
    modal run packages/sim/modal/synth_store.py::validate --tag v1        # writes v1/manifest.json on the volume
    modal volume get eden-synth v1/worlds/val.jsonl .local/m2/synth/worlds/val.jsonl

Volume layout (`<tag>/`): `worlds/{train,val,test}.jsonl`, `families.jsonl`, `stats.json`, `families-qc.json`,
`critic/*.jsonl`, `datasheet.md`, `pairgroups/{split}.jsonl` (M1's I1-shaped groups, written by validate), and
`manifest.json` (validate's counts, checks and sha256 of every file).
"""
import hashlib
import json
import os
import sys

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

image = modal.Image.debian_slim(python_version="3.12").add_local_python_source("synth_data")
vol = modal.Volume.from_name("eden-synth", create_if_missing=True)
app = modal.App("eden-synth", image=image)

FILES = ["families.jsonl", "families-qc.json", "stats.json", "datasheet.md"]


@app.function(volumes={"/data": vol}, timeout=3600, cpu=4, memory=8192)
def validate_remote(tag: str) -> dict:
    import synth_data as sd

    root = f"/data/{tag}"
    by_split = {}
    problems = {}
    for split in sd.SPLITS:
        path = f"{root}/worlds/{split}.jsonl"
        ws = sd.load_worlds(path) if os.path.exists(path) else []
        by_split[split] = ws
        for w in ws:
            p = sd.check_world(w)
            if w["split"] != split:
                p.append(f"in {split}.jsonl but split {w['split']}")
            if p:
                problems[w["id"]] = p[:5]
    families = sd.load_worlds(f"{root}/families.jsonl") if os.path.exists(f"{root}/families.jsonl") else []
    fam_split = {f["id"]: f["split"] for f in families}
    wrong_split = sorted(
        {t["family"] for s, ws in by_split.items() for w in ws for t in w["tasks"] if fam_split.get(t["family"], s) != s}
    )
    sha = {}
    for dirpath, _, names in os.walk(root):
        for n in names:
            if n == "manifest.json":
                continue
            full = os.path.join(dirpath, n)
            with open(full, "rb") as f:
                sha[os.path.relpath(full, root)] = hashlib.sha256(f.read()).hexdigest()
    manifest = {
        "tag": tag,
        "splits": {s: sd.summary(ws) for s, ws in by_split.items()},
        "families": {s: len({t["family"] for w in ws for t in w["tasks"]}) for s, ws in by_split.items()},
        "invalidWorlds": len(problems),
        "problems": dict(list(problems.items())[:20]),
        "familiesInWrongSplit": wrong_split[:20],
        "clustersAcrossSplits": sd.split_leaks(by_split, families)[:20],
        "requestTextsAcrossSplits": sd.duplicate_requests(by_split),
        "sha256": sha,
    }
    # M1's input (I1's PairGroup shape, synth_data.pair_groups): one group per request, written beside the worlds.
    os.makedirs(f"{root}/pairgroups", exist_ok=True)
    for split, ws in by_split.items():
        gs = sd.pair_groups(ws)
        with open(f"{root}/pairgroups/{split}.jsonl", "w") as f:
            for g in gs:
                f.write(json.dumps(g) + "\n")
        manifest.setdefault("pairGroups", {})[split] = len(gs)
    with open(f"{root}/manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)
    vol.commit()
    return manifest


@app.local_entrypoint()
def upload(src: str = ".local/m2/synth", tag: str = "v1", suffix: str = ""):
    """Puts the local dataset on the volume under `<tag>/` (worlds named without the run suffix)."""
    with vol.batch_upload(force=True) as b:
        for split in ("train", "val", "test"):
            p = os.path.join(src, "worlds", f"{split}{suffix}.jsonl")
            if os.path.exists(p):
                b.put_file(p, f"/{tag}/worlds/{split}.jsonl")
        for n in FILES:
            p = os.path.join(src, n.replace(".json", f"{suffix}.json") if n == "stats.json" else n)
            if os.path.exists(p):
                b.put_file(p, f"/{tag}/{n}")
        critic = os.path.join(src, "critic")
        if os.path.isdir(critic):
            for n in os.listdir(critic):
                b.put_file(os.path.join(critic, n), f"/{tag}/critic/{n}")
    print(f"uploaded {src} to eden-synth:/{tag}")


@app.local_entrypoint()
def validate(tag: str = "v1"):
    m = validate_remote.remote(tag)
    print(json.dumps({k: v for k, v in m.items() if k != "sha256"}, indent=2))
