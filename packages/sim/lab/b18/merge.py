"""B18 (docs/research/b18-heldout18.md): the three arms of one seed, each run by its own pi-ab process, as one run.

    python3 -I merge.py OUT_DIR NOW.json PRE.json TOOLS.json

Writes OUT_DIR/out.json and OUT_DIR/out.timeline/tasks.jsonl in the shape `lab_fanout.py` leaves for a shard, so
`bench_report.py`, `n5/mix.py`, `n5/days_hidden.py`, `pi-ab-report.ts`, `pi-cost-report.ts` and `i3-regrade.ts` read
it. The now arm keeps the name `eden`, the pre arm's `eden` becomes `eden~pre`, the tools arm stays `tools`.

It refuses unless the three files ran the same thing: the task list (every field), seeds, suites, agent model,
grader, harness and its version, the hash of the agent's and grader's prompts, time scale and tool execution.
"""
import json
import os
import sys

SAME = ["tasks", "seeds", "suites", "model", "grader", "harness", "harnessVersion", "promptsHash", "timeScale",
        "toolExecution"]


def main():
    out_dir, now_f, pre_f, tools_f = sys.argv[1:5]
    runs = {"eden": json.load(open(now_f)), "eden~pre": json.load(open(pre_f)), "tools": json.load(open(tools_f))}
    now = runs["eden"]
    for name, run in runs.items():
        for key in SAME:
            if json.dumps(run.get(key), sort_keys=True) != json.dumps(now.get(key), sort_keys=True):
                sys.exit(f"merge: `{key}` of {name} differs from the now arm's: not the same run")
    merged = dict(now)
    merged["results"], merged["conditions"] = [], list(runs)
    lists = {}
    lines = []
    for name, run in runs.items():
        source = "tools" if name == "tools" else "eden"
        rows = [r for r in run["results"] if r["condition"] == source]
        if len(rows) != len(run["results"]):
            sys.exit(f"merge: {name} holds other conditions than `{source}`")
        merged["results"] += [{**r, "condition": name} for r in rows]
        # Per-condition lists beside the results (background spend, days, recaps): renamed and joined.
        for key, value in run.items():
            if isinstance(value, list) and value and all(isinstance(x, dict) and "condition" in x for x in value):
                if key != "results":
                    lists.setdefault(key, []).extend({**x, "condition": name} for x in value)
        tl = os.path.join(run.get("timeline") or "", "tasks.jsonl")
        if os.path.exists(tl):
            for line in open(tl):
                if line.strip():
                    rec = json.loads(line)
                    rec["condition"] = name
                    lines.append(json.dumps(rec))
    merged.update(lists)
    os.makedirs(os.path.join(out_dir, "out.timeline"), exist_ok=True)
    merged["timeline"] = os.path.join(out_dir, "out.timeline")
    merged["b18"] = {"now": now_f, "pre": pre_f, "tools": tools_f}
    json.dump(merged, open(os.path.join(out_dir, "out.json"), "w"))
    open(os.path.join(out_dir, "out.timeline", "tasks.jsonl"), "w").write("\n".join(lines) + "\n")
    print(f"{out_dir}: {len(merged['results'])} results, {len(lines)} timeline lines, lists {sorted(lists)}")


main()
