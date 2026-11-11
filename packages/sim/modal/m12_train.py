"""M12 (D1000-D1009): full trainings of the pool models (packages/sim/lab/m12/) on Modal CPU containers, the same
code as the local runs. Data on the Volume `eden-m12` under /vol/r1/ (simulated data only); weights and logs go back
to the Volume under /vol/runs/<run>/. Lab tooling.

    modal run packages/sim/modal/m12_train.py --run P1 --script pairnet.py --args "--worlds 0 --epochs 2"

The data flags (--train, --teacher, --val, --val-teacher, --distract, --fit-wide, --val-wide) point at /vol/r1.
"""
import os
import shlex
import subprocess
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.join(HERE, "..", "lab", "m12")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install("numpy==2.3.3", "scipy==1.16.2")
    .add_local_dir(LAB, "/app")
)
vol = modal.Volume.from_name("eden-m12", create_if_missing=True)
app = modal.App("eden-m12-train", image=image)
DATA = {
    "--train": "strain.terms.jsonl.gz",
    "--teacher": "train.t8b.jsonl.gz",
    "--val": "sval.terms.jsonl.gz",
    "--val-teacher": "val.t8b.jsonl.gz",
    "--distract": "fit.terms.jsonl.gz",
}


@app.function(cpu=8.0, memory=32768, volumes={"/vol": vol}, timeout=8 * 3600)
def run_remote(run: str, script: str, args: str, wide: bool) -> dict:
    t0 = time.time()
    out = f"/vol/runs/{run}"
    os.makedirs(out, exist_ok=True)
    cmd = ["python", "-u", f"/app/{script}", *shlex.split(args), "--threads", "8", "--out", out]
    for k, v in DATA.items():
        if k == "--val-teacher" and script != "pairnet.py":
            continue
        cmd += [k, f"/vol/r1/{v}"]
    if wide:
        cmd += ["--fit-wide", "/vol/r1/fit-wide-pool.jsonl", "--val-wide", "/vol/r1/val-wide/*.jsonl"]
        if script == "pairnet.py":
            cmd += ["--fit-terms", "/vol/r1/fit.terms.jsonl.gz"]
    with open(f"{out}/log.txt", "w") as log:
        p = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, text=True)
    vol.commit()
    return {"code": p.returncode, "seconds": round(time.time() - t0), "log": open(f"{out}/log.txt").read()[-8000:]}


@app.local_entrypoint()
def main(run: str, script: str = "pairnet.py", args: str = "", wide: bool = True):
    got = run_remote.remote(run, script, args, wide)
    root = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
    dest = os.path.join(root, ".local", "m12", "runs", run)
    os.makedirs(dest, exist_ok=True)
    open(os.path.join(dest, "log.txt"), "w").write(got["log"])
    print(f"{run}: exit {got['code']} in {got['seconds']} s\n{got['log'][-3000:]}")
