"""M8 (D940-D949, docs/research/m8-router.md): the connector router's full training on Modal, CPU only.

Runs `packages/sim/lab/m8/train_router.py` in a container against the Modal Volume `eden-m8`: the conjunction table
on M2's exported worlds (`/v2x/x-train.jsonl`, every request style and language), then the per-source network on
the route logs of synth-train users (`/logs/<tag>/train`), the temperature and the floor fit on synth-val users
(`/logs/<tag>/val`), and the offline score on synth-test users (`/logs/<tag>/test`, held-out families). Weights go to
`/weights/<run>.npz` and `.bin`, the report to `/weights/<run>.json`. No secret, no model call.

    modal run packages/sim/modal/m8_router.py --run m8-final --tag v3 [--drop size,rate,hours] [--hidden 16]
        [--epochs 4] [--conj-epochs 3] [--recall 0.98]
"""
import json
import os
import subprocess
import tarfile

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
TRAINER = os.path.join(HERE, "..", "lab", "m8", "train_router.py")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("numpy==2.3.3")
    .add_local_file(TRAINER, "/root/train_router.py")
)
vol = modal.Volume.from_name("eden-m8", create_if_missing=True)
app = modal.App("eden-m8-router", image=image)


@app.function(volumes={"/m8": vol}, cpu=4.0, memory=16384, timeout=4 * 3600)
def train(run: str, tag: str, drop: str, hidden: int, epochs: int, conj_epochs: int, recall: float) -> dict:
    work = "/tmp/m8"
    os.makedirs(f"{work}/logs", exist_ok=True)
    with tarfile.open(f"/m8/logs/{tag}.tgz") as t:
        t.extractall(f"{work}/logs")
    model = f"{work}/{run}.npz"
    tr = ["python3", "-I", "/root/train_router.py"]
    flags = ["--drop", drop] if drop else []
    out = {}

    def call(args):
        r = subprocess.run(tr + args, capture_output=True, text=True, check=True)
        print(r.stderr[-4000:], flush=True)
        return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""

    os.makedirs(f"{work}/v2", exist_ok=True)
    os.symlink("/m8/v2x/x-train.jsonl", f"{work}/v2/x-train.jsonl")
    call(["conj", f"{work}/v2", f"{work}/logs/val", model, "--epochs", str(conj_epochs)])
    out["val"] = json.loads(
        call(
            ["mlp", model, f"{work}/logs/train/*.jsonl", f"{work}/logs/val/*.jsonl", "--hidden", str(hidden),
             "--epochs", str(epochs), "--recall", str(recall), "--int8", *flags]
        )
    )
    out["test"] = json.loads(call(["eval", model, f"{work}/logs/test/*.jsonl", *flags]))
    call(["export", model, f"{work}/{run}.bin"])
    os.makedirs("/m8/weights", exist_ok=True)
    for ext in ("npz", "bin"):
        with open(f"{work}/{run}.{ext}", "rb") as a, open(f"/m8/weights/{run}.{ext}", "wb") as b:
            b.write(a.read())
    out["args"] = {"tag": tag, "drop": drop, "hidden": hidden, "epochs": epochs, "conj_epochs": conj_epochs,
                   "recall": recall}
    with open(f"/m8/weights/{run}.json", "w") as f:
        json.dump(out, f)
    vol.commit()
    return out


@app.local_entrypoint()
def main(run: str, tag: str = "v3", drop: str = "size,rate,hours", hidden: int = 16, epochs: int = 4,
         conj_epochs: int = 3, recall: float = 0.98):
    print(json.dumps(train.remote(run, tag, drop, hidden, epochs, conj_epochs, recall)))
