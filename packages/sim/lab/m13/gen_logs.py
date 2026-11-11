"""M13 training set, pasted text: log lines, errors, CI and shell output, alerts and notifications a user pastes to
their assistant with no comment (the gate's `statement` kind, `log` source). Different wording from S4's brief.

    python3 -I packages/sim/lab/m13/gen_logs.py OUT.jsonl
"""
import json, os, random, re, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from haiku import call  # noqa: E402

KINDS = ["application log lines with levels and timestamps", "stack traces and exception messages",
         "CI and test runner output", "shell and package manager output", "server access logs",
         "monitoring alerts and pager texts", "bank, delivery and verification SMS texts",
         "calendar and app notification texts", "kubernetes and docker output", "database errors"]
LANGS = ["English", "English", "English", "German", "French", "Spanish", "Portuguese", "Italian", "Dutch", "Polish"]

if __name__ == "__main__":
    rnd = random.Random(77)
    jobs = [(k, rnd.choice(LANGS), rnd.randrange(10**6)) for k in KINDS for _ in range(4)]

    def run(job):
        k, lang, seed = job
        t = call("Output only a JSON array of strings.", f"Write 20 varied, realistic examples of {k} (any human "
                 f"words in them in {lang}), each 1 to 3 lines, as someone would paste them. Seed {seed}.",
                 run="m13-logs", max_tokens=6000)
        m = re.search(r"\[.*\]", t, re.S)
        try:
            return [s for s in json.loads(m.group(0)) if isinstance(s, str)] if m else []
        except json.JSONDecodeError:
            return []

    with ThreadPoolExecutor(8) as ex, open(sys.argv[1], "w") as f:
        for i, xs in enumerate(ex.map(run, jobs)):
            for s in xs:
                f.write(json.dumps({"text": s.strip(), "kind": "statement", "sub": "log", "lang": "xx",
                                    "group": f"log-{i}", "src": "genlog"}, ensure_ascii=False) + "\n")
