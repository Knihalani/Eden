"""R10 C10-E1: the memory checker on TypeSafe Jev, a non-generative decision model (DECISIONS D37, amended
2026-10-19). One request per turn: the turn, its recent context and the user's earlier ordinary turns go in `state`,
and each candidate row is one Noul (yes/no) question, answered in parallel with the probability of yes.

It reads the inputs of an existing calibrated run (`verify/<world>-<src>/in/*.json`) and writes outputs in the same
format to `verify/<world>-<tag>/out/`, so `score.py --systems "verify:tag=<tag>,p=0.6"` reads them unchanged. Each
call's wall-clock latency (network included, retries included), attempts and token usage go to
`verify/<world>-<tag>/calls.jsonl`.

    TYPESAFE_API_KEY=… python3 benchmarks/memory-stream/verify_jev.py --world code-rt1 --src cal --tag jev --limit 30
    python3 benchmarks/memory-stream/verify_jev.py --world code-rt1 --tag jev --latency

The key comes from the environment (or the repo's .env), surrounding quotes stripped, and is never printed or
written. TYPESAFE_BASE_URL overrides the endpoint (a mock in tests).
"""
import argparse, glob, http.client, json, os, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from verify_nim import REPO, latency

DEFAULT_URL = "https://api.typesafe.ai/v1"
QUESTION = ("Does a careful assistant need the memory `row` in its context to act well on the `turn` — would it "
            "change what the assistant should say or do now, including something it should raise unasked?")
CRITERIA = {
    "true": "The row bears on this turn: without it the assistant would answer or act worse here.",
    "false": "The row is off-topic, merely related, already stated in `recent` or `turn`, or would not change the "
             "reply. Most rows are this; most turns need no stored memory at all, like the `earlier_turns`.",
}


def env():
    """TYPESAFE_* settings from the process environment, falling back to the repo's .env. Never printed."""
    out = {k: os.environ.get(k, "") for k in ("TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL")}
    path = os.path.join(REPO, ".env")
    if os.path.exists(path):
        for line in open(path):
            k, _, v = line.strip().removeprefix("export ").partition("=")
            if k.strip() in out and not out[k.strip()]:
                out[k.strip()] = v.strip()
    out = {k: v.strip().strip('"').strip("'") for k, v in out.items()}
    out["TYPESAFE_BASE_URL"] = out["TYPESAFE_BASE_URL"] or DEFAULT_URL
    out["TYPESAFE_MODEL"] = out["TYPESAFE_MODEL"] or "jev-latest"
    return out


def request(case):
    """The SystemOne request for one verifier case: one Noul per candidate, keyed q0, q1, … (ids stay local)."""
    state = {"turn": case["text"], "recent": case.get("recent", []), "earlier_turns": case.get("earlier_turns", [])}
    qs = {f"q{n}": {"type": "noul", "instructions": {"row": c["text"], "question": QUESTION}, "criteria": CRITERIA}
          for n, c in enumerate(case["candidates"])}
    return state, qs


def call(cfg, state, questions, timeout=60, retries=4):
    body = json.dumps({"model": cfg["TYPESAFE_MODEL"], "state": state, "questions": questions})
    req = urllib.request.Request(cfg["TYPESAFE_BASE_URL"].rstrip("/") + "/systemone", data=body.encode(),
                                 headers={"Authorization": "Bearer " + cfg["TYPESAFE_API_KEY"],
                                          "Content-Type": "application/json"})
    t0 = time.time()  # the whole call, retries and backoff included
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read()), time.time() - t0, attempt + 1
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError) as e:
            code = getattr(e, "code", None)
            if code in (400, 401, 403, 404, 413, 415) or attempt == retries - 1:
                raise RuntimeError(f"TypeSafe call failed (HTTP {code})") from None
            time.sleep(2 ** (attempt + 1))


def noul(answer):
    """The probability of yes from a Noul answer, or None if the answer has no usable value."""
    v = answer.get("noul") if isinstance(answer, dict) else answer
    try:
        return min(1.0, max(0.0, float(v)))
    except (TypeError, ValueError):
        return None


def run(world, src, tag, limit=0):
    cfg = env()
    if not cfg["TYPESAFE_API_KEY"]:
        sys.exit("TYPESAFE_API_KEY must be set (environment or .env)")
    d = os.path.join(HERE, "verify", f"{world}-{tag}")
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    log = open(os.path.join(d, "calls.jsonl"), "a")
    files = sorted(glob.glob(os.path.join(HERE, "verify", f"{world}-{src}", "in", "*.json")))
    done, failed = 0, 0
    for p in files[: limit or None]:
        dest = os.path.join(d, "out", f"{src}-{os.path.basename(p)}")
        if os.path.exists(dest):
            continue
        inp = json.load(open(p))
        cases = []
        for c in inp["cases"]:
            if not c["candidates"]:
                cases.append({"event": c["event"], "scores": {}})
                continue
            state, qs = request(c)
            reply, secs, attempts = call(cfg, state, qs)
            answers = reply.get("answers", {})
            scores, bad = {}, 0
            for n, cand in enumerate(c["candidates"]):
                v = noul(answers.get(f"q{n}"))
                bad += v is None
                scores[cand["id"]] = 0.0 if v is None else v
            failed += bad > 0
            cases.append({"event": c["event"], "scores": scores})
            log.write(json.dumps({"event": c["event"], "model": reply.get("model", cfg["TYPESAFE_MODEL"]),
                                  "latency_s": round(secs, 3), "attempts": attempts, "unanswered": bad,
                                  "usage": reply.get("usage", {}), "candidates": len(c["candidates"])}) + "\n")
            log.flush()
        json.dump({"batch": inp.get("batch", os.path.basename(p)[:-5]), "verifier": f"typesafe:{cfg['TYPESAFE_MODEL']}",
                   "cases": cases}, open(dest, "w"), indent=1)
        done += 1
    print(world, tag, done, "files written;", len(files), "inputs;", failed, "calls with unanswered questions")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--src", default="cal", help="calibrated run whose inputs to reuse: verify/<world>-<src>/in")
    ap.add_argument("--tag", default="jev")
    ap.add_argument("--limit", type=int, default=0, help="first N input files only (a smoke run)")
    ap.add_argument("--latency", action="store_true", help="print latency percentiles of the logged calls")
    a = ap.parse_args()
    latency(a.world, a.tag) if a.latency else run(a.world, a.src, a.tag, a.limit)
