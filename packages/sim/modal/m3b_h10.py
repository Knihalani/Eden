"""M3b (D914): full trainings of H10's compressed students (packages/sim/lab/m3r/h10.py) on Modal CPU containers, the
same code as the local and Haiku test runs. Data on the Volume `eden-retriever` under /data/g/ (M2 v2's core and dev
split, its val worlds, and the engine-drawn pool pairs: m3b-core.jsonl, m3b-dev.jsonl, m2v2-worlds-val.jsonl,
m3b-pool-train.jsonl.gz, m3b-pool-calib.jsonl.gz); weights to /models/m3b-<run>.pt. Lab tooling.

    modal run packages/sim/modal/m3b_h10.py --run final-r32-d128 --args "--r 32 --d 128 --table int8 --code int8 \
        --extra-weight 0.3 --extra-reverse --epochs 4"

Results come back to `.local/m3b/modal/<run>/` (result.json, log.txt).
"""
import os
import shlex
import subprocess
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
M3R = os.path.join(HERE, "..", "lab", "m3r")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install("numpy==2.3.3")
    .add_local_file(os.path.join(M3R, "binnet.py"), "/app/binnet.py")
    .add_local_file(os.path.join(M3R, "h10.py"), "/app/h10.py")
)
vol = modal.Volume.from_name("eden-retriever", create_if_missing=True)
app = modal.App("eden-m3b-h10", image=image)


@app.function(cpu=8.0, memory=32768, volumes={"/vol": vol}, timeout=6 * 3600)
def run_remote(run: str, args: str) -> dict:
    t0 = time.time()
    out = f"/tmp/{run}"
    os.makedirs(out, exist_ok=True)
    g = "/vol/data/g"
    cmd = ["python", "-u", "/app/h10.py", "train", "--name", run, "--train", f"{g}/m3b-core.jsonl",
           "--dev", f"{g}/m3b-dev.jsonl", "--eval", f"{g}/m2v2-worlds-val.jsonl",
           "--extra-pairs", f"{g}/m3b-pool-train.jsonl.gz", "--extra-dev", f"{g}/m3b-pool-calib.jsonl.gz",
           *shlex.split(args), "--out", f"{out}/result.json", "--save", f"/vol/models/m3b-{run}.pt"]
    p = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "BINNET_THREADS": "8"})
    vol.commit()
    files = {}
    if os.path.exists(f"{out}/result.json"):
        files["result.json"] = open(f"{out}/result.json").read()
    return {"files": files, "log": p.stdout[-8000:], "err": p.stderr[-3000:], "code": p.returncode,
            "seconds": round(time.time() - t0)}


@app.local_entrypoint()
def main(run: str, args: str):
    root = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
    got = run_remote.remote(run, args)
    out = os.path.join(root, ".local", "m3b", "modal", run)
    os.makedirs(out, exist_ok=True)
    for name, text in got["files"].items():
        open(os.path.join(out, name), "w").write(text)
    open(os.path.join(out, "log.txt"), "w").write(got["log"] + "\n--- stderr\n" + got["err"])
    print(got["log"][-2500:])
    print(f"exit {got['code']}, {got['seconds']} s -> {out}")
