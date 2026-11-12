"""B19 (D1043): every control and neutral answer the run's grader called a concern, for the pre-registered hand read.
Prints, per arm, the task, the fact the grader said the answer raised (the planted look-alike's or the neutral task's
detail), and the answer, so each can be marked a real false concern or a grader error. Sim data only.

    python3 -I packages/sim/lab/b19/concerns.py raw=STEM[,STEM…] before=… final=…
"""
import json
import sys

for spec in sys.argv[1:]:
    name, stems = spec.split("=", 1)
    for stem in stems.split(","):
        res = json.load(open(stem + ".json"))
        tasks = {t["id"]: t for t in res["tasks"]}
        for r in res["results"]:
            t = tasks.get(r["task"])
            if not t or t["kind"] not in ("control", "neutral") or not r.get("facts"):
                continue
            raised = [k for k, v in r["facts"].items() if v]
            if not raised:
                continue
            details = {m["id"]: m["detail"] for m in t.get("must", [])}
            print(f"=== {name} {stem.rsplit('/', 1)[-1]} {t['kind']} {r['task']}")
            print(f"request: {t['text']}")
            for k in raised:
                print(f"graded as raising: {details.get(k, k)}")
            print(f"answer: {r['answer']}\n")
