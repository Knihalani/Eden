"""Outcome utility per turn (C5-E2): what a system's packets do to the agent's replies, in judge points.

Per human turn: +G × recall on need turns, −C on each no-need turn that gets a packet. G and C are C5-E1's code
measurements (right packet +1.233 on plan-need turns; hook-vote packet −0.467 on no-need turns). Assumptions: every
system's wrong packet costs what the vote's did; partial recall gains in proportion; life uses code's C (life has no
measured system condition yet); code's plan labels undercount needs (C4-E13), so firing systems are under-credited.
C5-E3 measured eden directly: its wrong packets cost about the noise floor, so its row here overstates the harm.

    python3 benchmarks/memory-stream/utility.py
"""
import json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
G, C = 1.233, 0.467
DEV = ("eden vote:need=2,bt=0.25,lt=6,st=4,strip=1 verify:tag=seq verify:tag=cal,p=0.5 verify:tag=cal,p=0.6 "
       "verify:tag=cal,p=0.7 judge pull:k=2")
FRESH = "verify:tag=seq verify:tag=cal,p=0.5 verify:tag=cal,p=0.6 verify:tag=cal,p=0.7 lex:tau=4,when=1,gate=1"


def run(world, systems, extra):
    run_dir = ["--run", os.path.join(HERE, "runs", f"{world}-eden")] if world in ("code", "life") else []
    cmd = ["python3", os.path.join(HERE, "score.py"), "--world", world, "--store", "sleep", "--strict"]
    out = subprocess.run(cmd + run_dir + extra + ["--systems", systems], capture_output=True, text=True,
                         cwd=HERE).stdout
    for name, v in json.loads(out[out.index("{"):]).items():
        if isinstance(v, dict) and "human" in v:
            h = v["human"]
            gain = h["need_events"] * h["recall"] * G
            cost = h["neg_events"] * (1 - h["silence"]) * C
            print(f"{world:9s} {name:46s} recall {h['recall']:.3f} silence {h['silence']:.3f} "
                  f"utility/turn {(gain - cost) / h['events']:+.4f}")


if __name__ == "__main__":
    for w in ("code", "life"):
        run(w, DEV, ["--split", "dev", "--sample", "judge"])
    for w in ("code-rt1", "life-rt1"):
        run(w, FRESH, ["--split", "fresh"])
