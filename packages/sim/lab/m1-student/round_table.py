"""M1 micro track: a round's table from micro.py's logs (one line an epoch) or result files.

  python3 -I packages/sim/lab/m1-student/round_table.py .local/m1/micro/r1/*.log
"""
import json
import os
import sys


def rows(path):
    if path.endswith(".json"):
        return json.load(open(path))["curve"]
    return [json.loads(l) for l in open(path) if l.startswith('{"epoch')]


def f3(x):
    return "—" if x is None else f"{x:.3f}"


print("| run | ep | AUC synth (decoy / neutral) | AUC sim dev | mark | dev facts / look-alikes / neutral (Haiku) | G1 m7 | G1 m3r audited |")
print("| --- | --- | --- | --- | --- | --- | --- | --- |")
for p in sys.argv[1:]:
    for r in rows(p):
        q, h = r["quality_dev"]["model"], r["quality_dev"]["haiku"]
        print(f"| {os.path.basename(p).split('.')[0]} | {r['epoch']} | {f3(r['auc_synth']['vs_decoy'])} / "
              f"{f3(r['auc_synth']['vs_neutral'])} | {f3(r['auc_sim']['vs_decoy'])} | {r['mark']} | "
              f"{q['hidden']} / {q['control']} / {q['neutral']} ({h['hidden']} / {h['control']} / {h['neutral']}) | "
              f"{r['g1_m7']} | {r['g1_m3r_audited']} |")
