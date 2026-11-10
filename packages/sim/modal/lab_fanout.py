"""The lab at scale on Modal (M0, lab tooling): pi-ab seeds or funnel shards fanned out over containers, each with the
repository at one commit, a hard Anthropic spend cap split across shards, results merged into .local/modal/<run>/
and reported locally. The arithmetic (shards, cap split, merging) is fanout_plan.py, tested without Modal.

    EDEN_COMMIT=HEAD modal run packages/sim/modal/lab_fanout.py --kind pi-ab --suites train --seeds 41,42,43,44 \
        --cap 4 --args "--conditions tools,eden --model claude-haiku-5-5 --grader claude-haiku-5-5 \
        --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --cards packages/sim/lab/cards/cards-train.jsonl"
    modal run packages/sim/modal/lab_fanout.py --kind funnel --suites train --seeds 41,42,43,44 --args "-- --noise-sources 995"

The Anthropic key reaches Modal only as a Modal Secret (default name `HAIKU_API_KEY`, holding HAIKU_API_KEY;
EDEN_HAIKU_SECRET names another) and only pi-ab shards get it; funnel shards run with no key at all. This app has
no GPU function (one GPU function blocks a whole app until the workspace can use GPUs). `--dry` prints the plan and starts nothing.
"""
import os
import shlex
import subprocess
import sys
import time
import zlib

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fanout_plan as plan  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
BUN_VERSION = "1.4.4"
# The Modal Secret holding HAIKU_API_KEY (the owner made it, named HAIKU_API_KEY); EDEN_HAIKU_SECRET names another.
# Read at import, since the secret is attached when the functions are defined.
HAIKU_SECRET = os.environ.get("EDEN_HAIKU_SECRET", "HAIKU_API_KEY")


def source_tarball():
    """`git archive` of EDEN_COMMIT (default HEAD) under .local/modal/src/: the repository as committed, less archived/."""
    commit = os.environ.get("EDEN_COMMIT", "HEAD")
    sha = subprocess.run(["git", "rev-parse", "--verify", f"{commit}^{{commit}}"], cwd=ROOT, check=True,
                         capture_output=True, text=True).stdout.strip()
    out = os.path.join(ROOT, ".local", "modal", "src", f"eden-{sha[:12]}.tar")
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        # archived/ is history (CLAUDE.md: never run or imported), 156 MB of it.
        subprocess.run(["git", "archive", "--format=tar", "-o", out, sha, "--", ".", ":(exclude)archived"], cwd=ROOT,
                       check=True)
    return sha, out


# The image is built where the entrypoint runs (locally); inside a container the module is imported again and only
# needs the image's handle, not the tarball.
if modal.is_local():
    COMMIT, TARBALL = source_tarball()
else:
    COMMIT, TARBALL = os.environ.get("EDEN_COMMIT_SHA", ""), "/dev/null"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "unzip", "ca-certificates", "git")
    .run_commands(f"curl -fsSL https://bun.sh/install | bash -s bun-v{BUN_VERSION}")
    .env({"PATH": "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin", "EDEN_COMMIT_SHA": COMMIT})
    .add_local_file(TARBALL, "/src/eden.tar", copy=True)
    .run_commands(f"mkdir -p {plan.REPO} && tar -xf /src/eden.tar -C {plan.REPO} && rm /src/eden.tar",
                  f"cd {plan.REPO} && bun install --frozen-lockfile")
    .add_local_python_source("fanout_plan")
)

app = modal.App("eden-lab-fanout", image=image)
HOURS = 3600


def _pack(path):
    with open(path, "rb") as f:
        return zlib.compress(f.read(), 6)


def _run(shard_dict):
    """One shard in its container: its command with its own ledger and cap, its outputs returned compressed."""
    shard = plan.Shard(**shard_dict)
    paths = plan.shard_paths(shard)
    os.makedirs(plan.SHARD_DIR, exist_ok=True)
    plan.prepare_shard(shard)
    cmd = plan.shard_command(shard)
    env = dict(os.environ)
    if shard.kind != "pi-ab":
        # Funnel shards are $0: no key in their environment, whatever the image holds.
        for k in ("HAIKU_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"):
            env.pop(k, None)
    t0 = time.time()
    with open(paths["log"], "wb") as log:
        code = subprocess.run(cmd, cwd=plan.REPO, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
    files = {}
    for rel, key in (("out.json", "out"), ("ledger.jsonl", "ledger"), ("cards.jsonl", "cards")):
        if os.path.exists(paths[key]):
            files[rel] = _pack(paths[key])
    if os.path.isdir(paths["timeline"]):
        for name in sorted(os.listdir(paths["timeline"])):
            files[f"out.timeline/{name}"] = _pack(os.path.join(paths["timeline"], name))
    # The log's tail only: a long run's log is mostly progress lines.
    with open(paths["log"], "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 400_000))
        files["log.txt"] = zlib.compress(f.read(), 6)
    return {"name": shard.name, "kind": shard.kind, "code": code, "seconds": round(time.time() - t0, 1),
            "command": cmd, "capUsd": shard.cap_usd, "commit": os.environ.get("EDEN_COMMIT_SHA", ""),
            "files": files}


haiku = [modal.Secret.from_name(HAIKU_SECRET)]


@app.function(secrets=haiku, cpu=plan.CPUS["pi-ab"], memory=plan.MEMORY_MIB["pi-ab"], timeout=12 * HOURS)
def pi_ab_shard(shard: dict) -> dict:
    return _run(shard)


@app.function(secrets=haiku, cpu=plan.CPUS["pi-ab"], memory=plan.MEMORY_MIB["pi-ab-scale"], timeout=12 * HOURS)
def pi_ab_scale_shard(shard: dict) -> dict:
    return _run(shard)


@app.function(cpu=plan.CPUS["funnel"], memory=plan.MEMORY_MIB["funnel"], timeout=4 * HOURS)
def funnel_shard(shard: dict) -> dict:
    return _run(shard)


@app.function(cpu=plan.CPUS["funnel"], memory=plan.MEMORY_MIB["funnel-scale"], timeout=8 * HOURS)
def funnel_scale_shard(shard: dict) -> dict:
    return _run(shard)


def _unpack(result):
    result = dict(result)
    result["files"] = {k: zlib.decompress(v) for k, v in result.get("files", {}).items()}
    return result


@app.local_entrypoint()
def main(kind: str, suites: str, seeds: str, cap: float = -1.0, run: str = "", args: str = "",
         suites_per_shard: int = 0, shards: int = 0, dry: bool = False, report: bool = True):
    extra = shlex.split(args)
    run = run or f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}"
    try:
        if kind == "pi-ab":
            planned = plan.plan_pi_ab(suites, seeds, cap if cap > 0 else None, run, extra, suites_per_shard)
        elif kind == "funnel":
            planned = plan.plan_funnel(suites, seeds, run, extra, shards)
        else:
            raise plan.PlanError("--kind is pi-ab or funnel")
    except plan.PlanError as e:
        sys.exit(f"refused: {e}")
    res = plan.resources(kind, extra)
    total_cap = round(sum(s.cap_usd for s in planned), 3) if kind == "pi-ab" else None
    print(f"run {run} at {COMMIT[:12]}: {len(planned)} {kind} shards, {res['memory']} MiB and {res['cpu']} CPU each"
          + (f", cap ${planned[0].cap_usd:.3f} a shard (${total_cap} of --cap {cap})" if total_cap else ", $0"))
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, capture_output=True,
                           text=True).stdout.strip()
    if dirty:
        print(f"note: the working tree has uncommitted changes; the shards run {COMMIT[:12]} as committed")
    for s in planned:
        print(f"  {s.name}: {shlex.join(plan.shard_command(s))}")
    if dry:
        return
    fn = {("pi-ab", False): pi_ab_shard, ("pi-ab", True): pi_ab_scale_shard, ("funnel", False): funnel_shard,
          ("funnel", True): funnel_scale_shard}[(kind, plan.is_scale(extra))]
    run_dir = os.path.join(ROOT, ".local", "modal", run)
    os.makedirs(run_dir, exist_ok=True)
    results = []
    for s, r in zip(planned, fn.map([plan.asdict(s) for s in planned], return_exceptions=True)):
        if isinstance(r, BaseException):
            print(f"  {s.name}: failed in Modal: {r!r}")
            results.append({"name": s.name, "kind": kind, "code": -1, "capUsd": s.cap_usd, "files": {}})
            continue
        r = _unpack(r)
        print(f"  {s.name}: exit {r['code']} in {r['seconds']} s")
        results.append(r)
    manifest = plan.merge(run_dir, results, total_cap)
    manifest_note = (f"spent ${manifest['spentUsd']:.4f}" + (f" of ${total_cap}" if total_cap else "")
                     + ("" if manifest["withinCap"] else "  OVER THE CAP"))
    print(f"results in {run_dir}: {manifest_note}; failed {manifest['failed'] or 'none'}")
    if report:
        for cmd in plan.report_commands(run_dir, results):
            name = os.path.basename(next(a for a in cmd if a.endswith((".ts", ".py")))).rsplit(".", 1)[0]
            out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            with open(os.path.join(run_dir, f"{name}.txt"), "w") as f:
                f.write(out.stdout + out.stderr)
            print(f"  {name}: exit {out.returncode}, {os.path.join(run_dir, name + '.txt')}")
