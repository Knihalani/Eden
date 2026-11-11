"""M3 (D907): full trainings of the binarised network family (packages/sim/lab/m3r/binnet.py) on Modal CPU
containers, the same code as the local test runs, with larger slices. Data on the Volume `eden-retriever` under
/data/g/ (export_groups.py's files). Lab tooling.

    modal run packages/sim/modal/m3_binnet.py --run bn-pair-A --args "--arch pair --worlds 437 --every 1 --epochs 4 \
        --bits 256" --train groups-A.jsonl.gz --eval evalA.jsonl.gz --eval2 m2A.jsonl.gz

Results come back to `.local/m3/runs/<run>/` (result.json, and for pair/notwin ranks.jsonl and ranks-m2.jsonl).
"""
import json
import os
import shlex
import subprocess
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
BINNET = os.path.join(HERE, "..", "lab", "m3r", "binnet.py")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install("numpy==2.3.3")
    .add_local_file(BINNET, "/app/binnet.py")
)
vol = modal.Volume.from_name("eden-retriever", create_if_missing=True)
app = modal.App("eden-m3-binnet", image=image)


@app.function(cpu=8.0, memory=32768, volumes={"/vol": vol}, timeout=6 * 3600)
def run_remote(run: str, args: str, train: str, ev: str, ev2: str) -> dict:
    t0 = time.time()
    out = f"/tmp/{run}"
    os.makedirs(out, exist_ok=True)
    cmd = ["python", "-u", "/app/binnet.py", *shlex.split(args), "--train", f"/vol/data/g/{train}",
           "--eval", f"/vol/data/g/{ev}", "--out", f"{out}/result.json", "--save", f"/vol/models/{run}.pt"]
    if "--arch pair" in args or "--arch notwin" in args:
        cmd += ["--ranks", f"{out}/ranks.jsonl"]
        if ev2:
            cmd += ["--eval2", f"/vol/data/g/{ev2}", "--ranks2", f"{out}/ranks-m2.jsonl"]
    p = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "BINNET_THREADS": "8"})
    vol.commit()
    files = {}
    for name in ("result.json", "ranks.jsonl", "ranks-m2.jsonl"):
        path = f"{out}/{name}"
        if os.path.exists(path):
            files[name] = open(path).read()
    return {"files": files, "log": p.stdout[-6000:], "err": p.stderr[-3000:], "code": p.returncode,
            "seconds": round(time.time() - t0)}


@app.local_entrypoint()
def main(run: str, args: str, train: str = "groups-A.jsonl.gz", eval: str = "evalA.jsonl.gz", eval2: str = ""):
    root = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
    got = run_remote.remote(run, args, train, eval, eval2)
    out = os.path.join(root, ".local", "m3", "runs", run)
    os.makedirs(out, exist_ok=True)
    for name, text in got["files"].items():
        open(os.path.join(out, name), "w").write(text)
    open(os.path.join(out, "log.txt"), "w").write(got["log"] + "\n--- stderr\n" + got["err"])
    print(got["log"][-2000:])
    print(f"exit {got['code']}, {got['seconds']} s -> {out}")
