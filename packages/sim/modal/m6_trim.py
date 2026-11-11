"""M6 (D920-D929, docs/research/m6-trimmer.md): the packet trimmer's candidates trained on Modal CPU containers.

Runs `packages/sim/lab/m6/cands.py` against the part dataset on the Volume `eden-m6` (`data/items.jsonl`, built by
`prep.py` from `--packets --packet-parts` dumps and label.ts's labels; simulated and synthetic worlds only) and keeps
the run's report and weights under `runs/<run>/`.

    modal volume put eden-m6 .local/m6/full/items.jsonl data/items.jsonl
    modal run packages/sim/modal/m6_trim.py --run h1-full --args "--arch h1 --epochs 4"
"""

import os
import shlex
import subprocess

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "numpy==2.3.3", "lightgbm==4.6.0", extra_index_url="https://download.pytorch.org/whl/cpu")
    .add_local_dir(os.path.join(HERE, "..", "lab", "m6"), "/m6")
)
vol = modal.Volume.from_name("eden-m6", create_if_missing=True)
app = modal.App("eden-m6-trim", image=image)


@app.function(cpu=8, memory=32768, timeout=6 * 3600, volumes={"/vol": vol})
def train(run: str, args: str, items: str = "data/items.jsonl") -> str:
    out = f"/vol/runs/{run}"
    os.makedirs(out, exist_ok=True)
    cmd = ["python", "/m6/cands.py", "--items", f"/vol/{items}", "--out", out, *shlex.split(args)]
    with open(f"{out}/log.txt", "w") as log:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        log.write(p.stdout)
    vol.commit()
    return p.stdout[-6000:]


@app.local_entrypoint()
def main(run: str, args: str = "--arch h1", items: str = "data/items.jsonl"):
    print(train.remote(run, args, items))
