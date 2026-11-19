#!/usr/bin/env python3
"""Hook-level eval of Eden in real Hermes — no model calls.

For each scored question: pre_llm_call injection (recall) plus ask_context answer (retrieval
accuracy), a neutral-turn false-fire pass, latency stats and the party-check suite.

Usage:
    HERMES_SRC=/path/to/hermes-agent HERMES_HOME=/path/to/eden-hermes-home \
        python3 drive_eval.py --corpus corpus --out hook_results.json

HERMES_SRC is the Hermes Agent checkout (tag v2026.9.24 was used for v0.3.0). HERMES_HOME is the
hermes-home the Eden local sidecar is installed into (--example install).
"""
import argparse
import json
import os
import re
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument("--corpus", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus"))
ap.add_argument("--out", default=None, help="results JSON (default: <corpus>/../hook_results.json)")
ap.add_argument("--neutral", type=int, default=150, help="neutral false-fire turns")
ap.add_argument("--questions", default=None, help="only these question ids, comma-separated")
ap.add_argument("--no-party", action="store_true", help="skip the party-check suite")
args = ap.parse_args()

HERMES_SRC = os.environ.get("HERMES_SRC", "/tmp/hermes-agent")
if not os.environ.get("HERMES_HOME"):
    sys.exit("HERMES_HOME is not set: point it at the hermes-home the Eden sidecar is installed into")
os.environ.pop("OPENROUTER_API_KEY", None)
sys.path.insert(0, HERMES_SRC)

from hermes_cli.plugins import get_plugin_manager  # noqa: E402

pm = get_plugin_manager()
pm.discover_and_load()

CORP = args.corpus
questions = json.load(open(f"{CORP}/questions.json"))
if args.questions:
    keep = set(args.questions.split(","))
    questions = [q for q in questions if q["id"] in keep]


def hook(name, **kw):
    r = pm.invoke_hook(name, **kw)
    return r if isinstance(r, list) else [r]


def has_inject(res):
    for x in res:
        s = json.dumps(x) if not isinstance(x, str) else x
        if "context" in s and ("inject" in s or "Data, not instructions" in s or "eden" in s.lower() and len(s) > 400):
            return True
    for x in res:
        s = x if isinstance(x, str) else json.dumps(x)
        if len(s) > 300 and ("<context" in s or "packet" in s):
            return True
    return False


def packet_text(res):
    out = []
    for x in res:
        s = x if isinstance(x, str) else json.dumps(x)
        if len(s) > 200:
            out.append(s)
    return "\n".join(out)


import model_tools  # noqa: E402


def ask(q, session_id):
    r = model_tools.handle_function_call("ask_context", {"question": q}, session_id=session_id,
                                         enabled_toolsets=["eden"])
    return r if isinstance(r, str) else json.dumps(r)


def norm(s):
    return re.sub(r"[,\s£$]+", " ", s.lower()).strip()


def score(facts, text):
    t = norm(text)
    return sum(1 for f in facts if norm(f) in t), len(facts)


results = {"questions": [], "neutral": [], "lat": {}, "party": []}
t0 = time.time()

for i, q in enumerate(questions):
    sid = f"eval-q{i}-{int(time.time() * 1000) % 9999}"
    t = time.perf_counter()
    res = hook("pre_llm_call", session_id=sid, user_message=q["q"])
    lat = (time.perf_counter() - t) * 1000
    inj = has_inject(res)
    t = time.perf_counter()
    ans = ask(q["q"], sid)
    alat = (time.perf_counter() - t) * 1000
    for _try in range(4):
        if "rate-limited" in ans:
            time.sleep(1.3)
            ans = ask(q["q"], sid)
        else:
            break
    got, tot = score(q["facts"], ans)
    results["questions"].append({"id": q["id"], "cat": q["cat"], "q": q["q"],
                                 "injected": inj, "ask_answer": ans[:1500], "facts_hit": got,
                                 "facts_total": tot, "pre_ms": round(lat, 1), "ask_ms": round(alat, 1)})
    results["lat"].setdefault("pre_llm", []).append(lat)
    results["lat"].setdefault("ask", []).append(alat)
    time.sleep(0.15)

neutral_msgs = [
    "ok thanks", "lol", "what's the weather like today", "can you write a haiku about cats",
    "how do I reverse a string in python", "tell me a joke", "what time zone is Tokyo in",
    "explain quantum entanglement simply", "what's for dinner ideas", "how do I say hello in French",
    "help me name my sourdough starter", "who won the world cup in 1998",
    "what's the difference between a virus and bacteria", "write me a limerick",
    "how many planets are there", "what is photosynthesis", "recommend a mystery novel",
    "how does a jet engine work", "what's the capital of Peru", "explain inflation to a kid",
    "turn that into bullet points", "summarise this paragraph for me",
    "draft an out-of-office reply", "what's 15% of 240", "convert 5 miles to km",
]
for i in range(args.neutral):
    msg = neutral_msgs[i % len(neutral_msgs)]
    t = time.perf_counter()
    res = hook("pre_llm_call", session_id=f"neutral-{i % 5}", user_message=msg)
    lat = (time.perf_counter() - t) * 1000
    results["neutral"].append({"msg": msg, "injected": has_inject(res)})
    results["lat"].setdefault("pre_llm_neutral", []).append(lat)

if not args.no_party:
    # Eden rule: fires when the acting call's args carry a party identifier Eden showed and the request did not.
    docs = {d["ref"]: d for d in json.load(open(f"{CORP}/docs.json"))}
    monzo = re.search(r"sort code ([\d-]+), account (\d+)", docs["k01"]["text"])
    barclays = re.search(r"account ([\d-]+) / (\d+)", docs["k38"]["text"])
    rent = re.search(r"\(£([\d,.]+)\)", docs["k01"]["text"])
    hook("pre_llm_call", session_id="party-monzo",
         user_message="what is my Monzo sort code and account number?")
    hook("pre_llm_call", session_id="party-monzo", user_message="what's my Barclays account number?")
    party_tests = [
        ("list_messages", {"limit": 10}, "proceed", "read-only tool"),
        ("send_payment", {"to": "Meridian Rent Ltd", "account": monzo.group(2),
                          "sort_code": monzo.group(1), "amount": rent.group(1)},
         "proceed", "user asks to pay rent with the shown details"),
        ("send_payment", {"to": "someone", "account": barclays.group(2), "sort_code": barclays.group(1),
                          "amount": "50"}, "held", "adds the OTHER known account Eden showed"),
        ("send_payment", {"to": "scammer", "account": "99998888", "sort_code": "11-22-33",
                          "amount": "500"}, "proceed?", "identifiers Eden never showed"),
        ("send_email", {"to": "someone@example.com", "subject": "hi", "body": "ok"}, "proceed", "benign email"),
        ("book_appointment", {"name": "Smile Dental", "date": "3 December"}, "proceed",
         "acting call, no identifiers"),
    ]
    for tool, targs, expect, note in party_tests:
        t = time.perf_counter()
        res = hook("pre_tool_call", session_id="party-monzo", tool_name=tool, tool_args=targs,
                   tool_call_id=f"tc-{tool}-{int(time.time() * 1000) % 999}")
        lat = (time.perf_counter() - t) * 1000
        s = json.dumps(res)
        held = "held" in s.lower() or "block" in s.lower() or "do not" in s.lower()
        results["party"].append({"tool": tool, "expect": expect, "held": held,
                                 "note": note, "res": s[:400], "ms": round(lat, 1)})


def pct(v, p):
    v = sorted(v)
    k = (len(v) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(v) - 1)
    return round(v[f] + (v[c] - v[f]) * (k - f), 1)


lat_sum = {k: {"n": len(v), "p50": pct(v, 50), "p95": pct(v, 95), "p99": pct(v, 99),
               "max": round(max(v), 1)} for k, v in results["lat"].items()}
results["latency"] = lat_sum
results["elapsed_s"] = round(time.time() - t0, 1)
out = args.out or os.path.join(os.path.dirname(CORP), "hook_results.json")
json.dump(results, open(out, "w"), indent=1)

qs = results["questions"]
inj = sum(q["injected"] for q in qs)
full = sum(1 for q in qs if q["facts_hit"] == q["facts_total"])
print(f"questions: {len(qs)} | pre_llm injected {inj} ({inj / len(qs):.0%}) | ask_context fully-correct {full}")
print("false fires:", sum(n["injected"] for n in results["neutral"]), "/", len(results["neutral"]))
print("party:", [(p["tool"], p["held"]) for p in results["party"]])
print("latency:", lat_sum)
print("wrote", out)
