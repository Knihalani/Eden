"""The lab fan-out's arithmetic, with no Modal in it (M0): shards, the spend cap's split, each shard's command line, and
merging what the shards return. `lab_fanout.py` runs these on Modal; `tests/test_fanout_plan.py` tests them with
`python3 -I -m unittest`. Lab tooling, not product code.

    python3 -I packages/sim/modal/fanout_plan.py plan --kind pi-ab --suites train1,train2 --seeds 41,42 --cap 4 \
        --run m1 -- --conditions tools,eden --model claude-haiku-5-5 ...

prints the shards and their commands without starting anything (no token needed).
"""
import json
import math
import os
import re
import shlex
import sys
from dataclasses import asdict, dataclass, field

# Where the repository sits inside the shard's container, and where a shard writes.
REPO = "/repo"
SHARD_DIR = "/tmp/shard"
# Flags the planner owns on every pi-ab shard: a shard's own spend cap on its own ledger, its outputs and its label.
OWNED_PI_AB = ("--seeds", "--suite", "--out", "--timeline", "--spend-ledger", "--spend-cap", "--spend-headroom",
               "--run-label", "--budget", "--cards-out")
OWNED_FUNNEL = ("--seeds", "--suite", "--json", "--record")
# A shard's headroom under its own cap (spend.ts keeps it clear before each call): a small share of a small cap.
MAX_HEADROOM = 0.25
# Memory for one shard (MiB): A21 measured ~10 GB a pi-ab process at 1,000 sources (`--noise-sources 995`), two at
# once killed on 15 GiB; one shard a container, with room over the measured peak.
MEMORY_MIB = {"pi-ab": 16384, "pi-ab-scale": 24576, "funnel": 8192, "funnel-scale": 16384}
CPUS = {"pi-ab": 4.0, "funnel": 8.0}


class PlanError(ValueError):
    """A plan that must not start (no cap, a held-out suite without --blind, a flag the planner owns)."""


@dataclass
class Shard:
    index: int
    kind: str
    suites: list
    seeds: list
    run_label: str
    cap_usd: float
    headroom_usd: float
    args: list = field(default_factory=list)

    @property
    def name(self):
        return f"s{self.index:03d}-{'-'.join(self.suites)}-{'-'.join(str(s) for s in self.seeds)}"


def split_list(arg):
    return [x.strip() for x in str(arg).split(",") if x.strip()]


def flag_names(args):
    return {a.split("=", 1)[0] for a in args if a.startswith("--")}


def is_scale(args):
    """A run over many sources (A21's 1,000-source shape): bigger containers."""
    for i, a in enumerate(args):
        if a == "--noise-sources" and i + 1 < len(args) and int(args[i + 1]) >= 100:
            return True
        if a.startswith("--noise-sources=") and int(a.split("=", 1)[1]) >= 100:
            return True
    return False


def split_cap(cap_usd, n):
    """Each of `n` shards' cap: cap / n, rounded down to a tenth of a cent, so the shards' caps sum to at most `cap`."""
    if cap_usd is None:
        raise PlanError("a pi-ab fan-out needs --cap USD (the total Anthropic spend cap across shards)")
    cap = float(cap_usd)
    if not math.isfinite(cap) or cap <= 0:
        raise PlanError(f"--cap must be a positive number of dollars, not {cap_usd!r}")
    if n <= 0:
        raise PlanError("no shards")
    each = math.floor(cap / n * 1000) / 1000
    if each <= 0:
        raise PlanError(f"--cap {cap} over {n} shards leaves under $0.001 a shard")
    return each


def check_suites(suites, args):
    """Held-out suites are measurement only (packages/sim/src/lab/CLAUDE.md): a run that names one says --blind."""
    held = [s for s in suites if s.startswith("heldout")]
    if held and "--blind" not in args:
        raise PlanError(f"held-out suites ({', '.join(held)}) are measurement only: pass --blind to run them")


def plan_pi_ab(suites, seeds, cap_usd, run, args=(), suites_per_shard=0):
    """One seed per shard (pi-ab's rule: one seed a process), suites grouped `suites_per_shard` at a time (0: all)."""
    suites, seeds, args = split_list(suites), split_list(seeds), list(args)
    if not suites or not seeds:
        raise PlanError("pi-ab needs --suites and --seeds")
    owned = sorted(flag_names(args) & set(OWNED_PI_AB))
    if owned:
        raise PlanError(f"the planner sets {', '.join(owned)} on every shard: leave them out of the pass-through args")
    check_suites(suites, args)
    args = [a for a in args if a != "--blind"]
    per = suites_per_shard if suites_per_shard > 0 else len(suites)
    groups = [suites[i:i + per] for i in range(0, len(suites), per)]
    pairs = [(g, s) for s in seeds for g in groups]
    each = split_cap(cap_usd, len(pairs))
    headroom = round(min(MAX_HEADROOM, each * 0.1), 4)
    return [Shard(i, "pi-ab", g, [s], f"{run}-{i:03d}", each, headroom, args) for i, (g, s) in enumerate(pairs)]


def plan_funnel(suites, seeds, run, args=(), shards=0):
    """Funnel shards over suite x seed blocks; $0 (no key reaches them), so no cap. `shards` 0: one per suite x seed."""
    suites, seeds, args = split_list(suites), split_list(seeds), list(args)
    if not suites or not seeds:
        raise PlanError("funnel needs --suites and --seeds")
    owned = sorted(flag_names(args) & set(OWNED_FUNNEL))
    if owned:
        raise PlanError(f"the planner sets {', '.join(owned)} on every shard: leave them out of the pass-through args")
    if "live" in args:
        raise PlanError("funnel shards are $0: a live reader or judge (`live`) runs on pi-ab or locally with a ledger")
    check_suites(suites, args)
    # shard_command adds --blind to each shard that holds a held-out suite.
    args = [a for a in args if a != "--blind"]
    cells = [(s, d) for d in seeds for s in suites]
    n = len(cells) if shards <= 0 else min(shards, len(cells))
    blocks = [cells[i::n] for i in range(n)]
    out = []
    for i, block in enumerate(blocks):
        ss = sorted({c[0] for c in block}, key=suites.index)
        ds = sorted({c[1] for c in block}, key=seeds.index)
        # A block must be a full grid (funnel runs suites x seeds); split it to cells when it is not.
        if len(ss) * len(ds) != len(block):
            for c in block:
                out.append(([c[0]], [c[1]]))
        else:
            out.append((ss, ds))
    return [Shard(i, "funnel", s, d, f"{run}-{i:03d}", 0.0, 0.0, args) for i, (s, d) in enumerate(out)]


def shard_paths(shard):
    base = f"{SHARD_DIR}/{shard.name}"
    return {
        "out": f"{base}.json",
        "timeline": f"{base}.timeline",
        "ledger": f"{base}.ledger.jsonl",
        "cards": f"{base}.cards.jsonl",
        "log": f"{base}.log",
        "cards_in": f"{base}.cards-in.jsonl",
    }


def cards_list(args):
    """`--cards A,B,C` on a pi-ab shard: the files to concatenate (pi-ab reads one file), else None (M1)."""
    for i, a in enumerate(args):
        val = None
        if a == "--cards" and i + 1 < len(args):
            val = args[i + 1]
        elif a.startswith("--cards="):
            val = a.split("=", 1)[1]
        if val is not None and "," in val:
            return split_list(val)
    return None


def with_cards_file(args, path):
    """The args with a `--cards` list replaced by the one file the shard merged it into."""
    out, skip = [], False
    for i, a in enumerate(args):
        if skip:
            skip = False
            continue
        if a == "--cards" and i + 1 < len(args) and "," in args[i + 1]:
            out += ["--cards", path]
            skip = True
        elif a.startswith("--cards=") and "," in a:
            out += ["--cards", path]
        else:
            out.append(a)
    return out


def prepare_shard(shard, repo=REPO):
    """Work a shard does before its command: a `--cards` list concatenated into one file, in the order given (the
    replay keeps the first card a key has). Returns the merged file's path, or None."""
    files = cards_list(shard.args) if shard.kind == "pi-ab" else None
    if not files:
        return None
    dest = shard_paths(shard)["cards_in"]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as out:
        for f in files:
            with open(os.path.join(repo, f), "rb") as src:
                data = src.read()
            out.write(data if data.endswith(b"\n") or not data else data + b"\n")
    return dest


def shard_command(shard):
    """The command a shard runs in REPO, as an argv list."""
    p = shard_paths(shard)
    if shard.kind == "pi-ab":
        return ["bun", "packages/sim/src/lab/pi-ab.ts", "--suite", ",".join(shard.suites), "--seeds",
                ",".join(shard.seeds), "--out", p["out"], "--timeline", p["timeline"], "--cards-out", p["cards"],
                "--spend-ledger", p["ledger"], "--spend-cap", f"{shard.cap_usd:.3f}", "--spend-headroom",
                f"{shard.headroom_usd:.4f}", "--run-label", shard.run_label, "--budget", f"{shard.cap_usd:.3f}",
                *with_cards_file(shard.args, p["cards_in"])]
    if shard.kind == "funnel":
        blind = ["--blind"] if any(s.startswith("heldout") for s in shard.suites) else []
        rest = list(shard.args)
        # Funnel flags before `--`, hidden-funnel's after it, as `bun run funnel` takes them.
        if "--" in rest:
            i = rest.index("--")
            head, tail = rest[:i], rest[i:]
        else:
            head, tail = rest, []
        return ["bun", "packages/sim/src/lab/funnel.ts", "--suite", ",".join(shard.suites), "--seeds",
                ",".join(shard.seeds), "--json", p["out"], *blind, *head, *tail]
    raise PlanError(f"unknown kind {shard.kind}")


def resources(kind, args):
    scale = is_scale(args)
    mem = MEMORY_MIB[f"{kind}-scale" if scale else kind]
    return {"memory": mem, "cpu": CPUS[kind]}


# ---------------------------------------------------------------------------------------------------------------
# Results.

def ledger_usd(text):
    """The spend booked in a ledger's lines (spend.ts `costUsd`); a torn last line is skipped, as spend.ts does."""
    total = 0.0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            total += float(json.loads(line).get("costUsd", 0) or 0)
        except (ValueError, AttributeError):
            continue
    return total


SAFE = re.compile(r"^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")


def safe_rel(path):
    """A returned file's relative path, refused if it could leave the run directory."""
    if not SAFE.match(path) or ".." in path.split("/"):
        raise ValueError(f"unsafe path from a shard: {path!r}")
    return path


def write_shard(run_dir, result):
    """Writes one shard's returned files under run_dir/<name>/, pointing a pi-ab results file at its local timeline."""
    name = safe_rel(result["name"])
    base = os.path.join(run_dir, name)
    os.makedirs(base, exist_ok=True)
    written = []
    for rel, data in sorted(result.get("files", {}).items()):
        dest = os.path.join(base, safe_rel(rel))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if rel == "out.json" and result.get("kind") == "pi-ab":
            # pi-ab-report reads `timeline` from the results file before its own default: the container's path
            # would not exist here.
            doc = json.loads(data)
            if isinstance(doc, dict) and "timeline" in doc:
                doc["timeline"] = os.path.join(base, "out.timeline")
            data = json.dumps(doc).encode()
        with open(dest, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode())
        written.append(dest)
    with open(os.path.join(base, "status.json"), "w") as f:
        json.dump({k: result.get(k) for k in ("name", "kind", "code", "seconds", "command", "spentUsd", "capUsd")},
                  f, indent=2)
    return written


def merge(run_dir, results, cap_usd=None):
    """The run's summary (manifest.json, ledger.jsonl and, for funnel shards, funnel.json) from every shard result."""
    shards, ledger, per_task, failed = [], [], [], []
    for r in results:
        write_shard(run_dir, r)
        files = r.get("files", {})
        led = files.get("ledger.jsonl", b"")
        led = led.decode() if isinstance(led, bytes) else led
        spent = ledger_usd(led)
        ledger.extend(l for l in led.splitlines() if l.strip())
        if r.get("code") != 0:
            failed.append(r["name"])
        if r.get("kind") == "funnel" and "out.json" in files:
            per_task.extend(json.loads(files["out.json"]).get("perTask", []))
        shards.append({"name": r["name"], "kind": r.get("kind"), "code": r.get("code"), "spentUsd": round(spent, 6),
                       "capUsd": r.get("capUsd"), "seconds": r.get("seconds")})
    total = round(sum(s["spentUsd"] for s in shards), 6)
    over = [s["name"] for s in shards if s["capUsd"] and s["spentUsd"] > s["capUsd"] + 1e-9]
    manifest = {"shards": shards, "spentUsd": total, "capUsd": cap_usd, "failed": failed, "overCap": over,
                "withinCap": cap_usd is None or total <= float(cap_usd) + 1e-9}
    with open(os.path.join(run_dir, "ledger.jsonl"), "w") as f:
        f.write("".join(l + "\n" for l in ledger))
    if per_task:
        with open(os.path.join(run_dir, "funnel.json"), "w") as f:
            json.dump({"perTask": per_task, "shards": [s["name"] for s in shards]}, f)
    with open(os.path.join(run_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    return manifest


def report_commands(run_dir, results):
    """What to run locally on the merged run: pi-ab's two reports, or the funnel score."""
    names = sorted(r["name"] for r in results if "out.json" in r.get("files", {}))
    kinds = {r.get("kind") for r in results}
    if kinds == {"pi-ab"}:
        outs = [os.path.join(run_dir, n, "out.json") for n in names]
        return [["bun", "packages/sim/src/lab/pi-ab-report.ts", *outs],
                ["bun", "packages/sim/src/lab/pi-cost-report.ts", *outs]]
    if kinds == {"funnel"}:
        return [["python3", "-I", "packages/sim/lab/scripts/funnel-score.py", os.path.join(run_dir, "funnel.json")]]
    return []


def main(argv):
    import argparse
    rest = []
    if "--" in argv:
        i = argv.index("--")
        argv, rest = argv[:i], argv[i + 1:]
    ap = argparse.ArgumentParser(prog="fanout_plan.py")
    ap.add_argument("cmd", choices=["plan"])
    ap.add_argument("--kind", choices=["pi-ab", "funnel"], required=True)
    ap.add_argument("--suites", required=True)
    ap.add_argument("--seeds", required=True)
    ap.add_argument("--cap", type=float)
    ap.add_argument("--run", default="m1")
    ap.add_argument("--suites-per-shard", type=int, default=0)
    ap.add_argument("--shards", type=int, default=0)
    a = ap.parse_args(argv)
    try:
        if a.kind == "pi-ab":
            shards = plan_pi_ab(a.suites, a.seeds, a.cap, a.run, rest, a.suites_per_shard)
        else:
            shards = plan_funnel(a.suites, a.seeds, a.run, rest, a.shards)
    except PlanError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    res = resources(a.kind, rest)
    print(json.dumps({"shards": len(shards), "capEach": shards[0].cap_usd, "resources": res}))
    for s in shards:
        print(json.dumps({**asdict(s), "command": shlex.join(shard_command(s))}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
