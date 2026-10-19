"""R10-5 under D37: the calibrated verifier (F22b, C4-E11) run on an NVIDIA NIM model instead of haiku.

It reads the inputs of an existing calibrated run (`verify/<world>-cal*/in/*.json`: the same turns, recent context,
earlier turns and candidate shortlist) and writes outputs in the same format to `verify/<world>-<tag>/out/`, so
`score.py --systems "verify:tag=<tag>,p=0.6"` reads them, and so does `downstream.py prep-h2h --vtag <tag>`
(`prep-verify` reads only the cal tags). Each call's wall-clock latency, retries included, its attempts, token usage
and whether the reply parsed go to `verify/<world>-<tag>/calls.jsonl` (the budget R10-5 needs). A re-run skips
finished files; a file interrupted mid-way is redone, so its calls appear twice in the log.

    NVIDIA_API_KEY=… python3 benchmarks/memory-stream/verify_nim.py --world code --src cal --tag nim
    (repeat with --src cal-ds, cal-ds2, cal-ds3 to cover the head-to-head turns; all land in one tag)

The key comes from the environment (or the repo's .env) and is never printed or written. NIM_MODEL must be set
(environment or .env); NVIDIA_BASE_URL defaults to the public endpoint.
"""
import argparse, glob, http.client, json, os, re, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_URL = "https://integrate.api.nvidia.com/v1"

PROMPT = (
    "You are Eden, a user's memory system. The case has `event`, `type`, `text` (the current turn), `recent` (recent "
    "context), `earlier_turns` (some of this user's ordinary turns from earlier sessions, for calibration: most turns "
    "like these need no long-term memory at all) and `candidates` (memory rows: id + text).\n\n"
    "For EACH candidate, give the probability (0.0–1.0, one decimal) that a careful assistant needs that row in "
    "context to act well on THIS turn — it changes what the assistant should say or do, including proactively. "
    "Being on-topic is not enough. Compared with the earlier turns, ask whether this turn is special. Most rows "
    "should be ≤ 0.2; most turns have no row above 0.5.\n\n"
    'Reply with JSON only: {"scores": {"<candidate id>": <p>, ...}} (an empty object if there are no candidates).')
SHORT = PROMPT.replace(  # F22c (C9-E1): only the kept rows, so the reply is a few dozen tokens
    'Reply with JSON only: {"scores": {"<candidate id>": <p>, ...}} (an empty object if there are no candidates).',
    'Report ONLY the candidates with p ≥ 0.5. Reply with JSON only: {"scores": {"<candidate id>": <p>, ...}} for '
    'those (an empty object if none reaches 0.5).')


def env():
    """NVIDIA_* settings from the process environment, falling back to the repo's .env. Never printed."""
    out = {k: os.environ.get(k, "") for k in ("NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NIM_MODEL")}
    path = os.path.join(REPO, ".env")
    if os.path.exists(path):
        for line in open(path):
            k, _, v = line.strip().removeprefix("export ").partition("=")
            if k.strip() in out and not out[k.strip()]:
                out[k.strip()] = v.strip().strip('"').strip("'")
    out["NVIDIA_BASE_URL"] = out["NVIDIA_BASE_URL"] or DEFAULT_URL
    return out


def chat(cfg, messages, timeout=180, retries=4):
    body = json.dumps({"model": cfg["NIM_MODEL"], "messages": messages, "temperature": 0.0, "max_tokens": 1024})
    req = urllib.request.Request(cfg["NVIDIA_BASE_URL"].rstrip("/") + "/chat/completions", data=body.encode(),
                                 headers={"Authorization": "Bearer " + cfg["NVIDIA_API_KEY"],
                                          "Content-Type": "application/json"})
    t0 = time.time()  # the whole call, retries and backoff included: hosted latency is mostly queueing (R8)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                out = json.loads(r.read())
            return out, time.time() - t0, attempt + 1
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError) as e:
            code = getattr(e, "code", None)
            if code in (400, 401, 403, 404) or attempt == retries - 1:
                raise RuntimeError(f"NIM call failed (HTTP {code})") from None
            time.sleep(2 ** (attempt + 1))


def parse(text, ids):
    """(scores kept to the case's candidate ids and clamped to [0, 1], whether the reply parsed). An unparseable
    reply scores every candidate 0 and is reported, so it never passes for "the verifier keeps nothing"."""
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        scores = json.loads(m.group(0))["scores"] if m else None
        ok = isinstance(scores, dict)
    except (ValueError, KeyError, TypeError):
        ok = False
    scores = scores if ok else {}
    out = {}
    for i in ids:
        try:
            out[i] = min(1.0, max(0.0, float(scores.get(i, 0.0))))
        except (TypeError, ValueError):
            out[i] = 0.0
    return out, ok


def run(world, src, tag, limit=0, model="", short=False):
    cfg = env()
    cfg["NIM_MODEL"] = model or cfg["NIM_MODEL"]
    if not cfg["NVIDIA_API_KEY"] or not cfg["NIM_MODEL"]:
        sys.exit("NVIDIA_API_KEY and NIM_MODEL must be set (environment or .env)")
    d = os.path.join(HERE, "verify", f"{world}-{tag}")
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    log = open(os.path.join(d, "calls.jsonl"), "a")
    files = sorted(glob.glob(os.path.join(HERE, "verify", f"{world}-{src}", "in", "*.json")))
    done, failed = 0, 0
    for p in files[: limit or None]:
        dest = os.path.join(d, "out", f"{src}-{os.path.basename(p)}")  # several srcs can share one tag
        if os.path.exists(dest):
            continue
        inp = json.load(open(p))
        cases = []
        for c in inp["cases"]:
            ids = [x["id"] for x in c["candidates"]]
            if not ids:
                cases.append({"event": c["event"], "scores": {}})
                continue
            case = {k: v for k, v in c.items() if k != "output"}
            reply, secs, attempts = chat(cfg, [{"role": "system", "content": SHORT if short else PROMPT},
                                               {"role": "user", "content": json.dumps(case, ensure_ascii=False)}])
            choice = reply["choices"][0]
            scores, ok = parse(choice["message"].get("content", ""), ids)
            failed += not ok
            cases.append({"event": c["event"], "scores": scores if not short else {i: v for i, v in scores.items()
                                                                                 if v >= 0.5}})
            log.write(json.dumps({"event": c["event"], "model": cfg["NIM_MODEL"], "latency_s": round(secs, 3),
                                  "attempts": attempts, "parsed": ok, "finish_reason": choice.get("finish_reason"),
                                  "usage": reply.get("usage", {}), "candidates": len(ids)}) + "\n")
            log.flush()
        json.dump({"batch": inp.get("batch", os.path.basename(p)[:-5]), "verifier": f"nim:{cfg['NIM_MODEL']}",
                   "cases": cases}, open(dest, "w"), indent=1)
        done += 1
    print(world, tag, done, "files written;", len(files), "inputs;", failed, "replies did not parse (scored 0)")


def latency(world, tag):
    """p50 / p95 / max latency of the logged calls (seconds)."""
    path = os.path.join(HERE, "verify", f"{world}-{tag}", "calls.jsonl")
    xs = sorted(json.loads(line)["latency_s"] for line in open(path)) if os.path.exists(path) else []
    if not xs:
        return print(world, tag, {"calls": 0})
    q = lambda f: xs[min(len(xs) - 1, int(f * len(xs)))]
    print(world, tag, {"calls": len(xs), "p50": q(0.5), "p95": q(0.95), "max": xs[-1]})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--src", default="cal", help="calibrated run whose inputs to reuse: verify/<world>-<src>/in")
    ap.add_argument("--tag", default="nim")
    ap.add_argument("--limit", type=int, default=0, help="first N input files only (a smoke run)")
    ap.add_argument("--model", default="", help="NIM model id; overrides NIM_MODEL")
    ap.add_argument("--short", action="store_true", help="F22c short-reply prompt (C9-E1)")
    ap.add_argument("--latency", action="store_true", help="print latency percentiles of the logged calls")
    a = ap.parse_args()
    latency(a.world, a.tag) if a.latency else run(a.world, a.src, a.tag, a.limit, a.model, a.short)
