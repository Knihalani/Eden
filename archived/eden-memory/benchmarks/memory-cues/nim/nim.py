"""Minimal NVIDIA NIM (OpenAI-compatible) client: disk cache, cross-process throttle, retry with backoff, per-call log.

The API key is read from the repo .env at call time and is never printed, logged or written.
Every response is cached under cache/<sha256>.json keyed by (endpoint, model, payload), so reruns are free.
Every live call appends {tag, model, endpoint, latency_s, usage, ok, cached} to out/calls.jsonl.
"""
import fcntl, hashlib, json, os, random, time, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV = Path("/Users/kaiavnihalani/Downloads/Eden/.env")
CACHE = HERE / "cache"; CACHE.mkdir(exist_ok=True)
LOG = HERE / "out" / "calls.jsonl"; LOG.parent.mkdir(exist_ok=True)
RATE_FILE = HERE / "cache" / ".rate"
RPM = int(os.environ.get("NIM_RPM", "36"))


def _env():
    out = {}
    for line in ENV.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip().removeprefix("export ").strip()
        v = v.strip().strip('"').strip("'")
        if k in ("NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NIM_MODEL"):
            out[k] = v
    return out


_E = None
def env():
    global _E
    if _E is None:
        _E = _env()
    return _E


def _throttle():
    """Sliding-window limiter shared by every process in this dir (fcntl lock on a timestamp file)."""
    RATE_FILE.touch(exist_ok=True)
    while True:
        with open(RATE_FILE, "r+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                ts = json.loads(fh.read() or "[]")
            except Exception:
                ts = []
            now = time.time()
            ts = [t for t in ts if now - t < 60]
            if len(ts) < RPM:
                ts.append(now)
                fh.seek(0); fh.truncate(); fh.write(json.dumps(ts))
                return
            wait = 60 - (now - ts[0]) + 0.05
        time.sleep(max(0.2, wait))


def _key(endpoint, payload):
    return hashlib.sha256(json.dumps([endpoint, payload], sort_keys=True).encode()).hexdigest()


def _post(endpoint, payload, timeout):
    e = env()
    req = urllib.request.Request(e["NVIDIA_BASE_URL"].rstrip("/") + endpoint, data=json.dumps(payload).encode(),
                                 headers={"Authorization": "Bearer " + e["NVIDIA_API_KEY"], "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def call(endpoint, payload, tag="", retries=10, timeout=240, use_cache=True):
    k = _key(endpoint, payload); p = CACHE / f"{k}.json"
    if use_cache and p.exists():
        rec = json.loads(p.read_text())
        rec["cached"] = True
        return rec
    err = None
    for attempt in range(retries):
        _throttle()
        t0 = time.time()
        try:
            resp = _post(endpoint, payload, timeout)
            dt = time.time() - t0
            rec = {"resp": resp, "latency_s": dt, "model": payload.get("model"), "tag": tag, "attempts": attempt + 1}
            p.write_text(json.dumps(rec))
            with open(LOG, "a") as fh:
                fh.write(json.dumps({"tag": tag, "model": payload.get("model"), "endpoint": endpoint, "latency_s": round(dt, 3), "usage": resp.get("usage"), "ok": True, "attempt": attempt + 1, "t": time.time()}) + "\n")
            rec["cached"] = False
            return rec
        except urllib.error.HTTPError as ex:
            body = ex.read()[:300].decode("utf8", "replace")
            err = f"HTTP {ex.code}: {body}"
            code = ex.code
        except Exception as ex:  # timeouts, resets
            err = f"{type(ex).__name__}: {str(ex)[:200]}"; code = 0
        with open(LOG, "a") as fh:
            fh.write(json.dumps({"tag": tag, "model": payload.get("model"), "endpoint": endpoint, "latency_s": round(time.time() - t0, 3), "ok": False, "err": err[:200], "attempt": attempt + 1, "t": time.time()}) + "\n")
        if code in (400, 401, 403, 404, 422):
            break
        time.sleep(min(90, (2 ** attempt) * 3 + random.random() * 2))
    raise RuntimeError(f"NIM call failed ({tag}, {payload.get('model')}): {err}")


def chat(model, messages, tag="", temperature=0.2, max_tokens=1024, seed=None, extra=None, **kw):
    payload = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    if seed is not None:
        payload["seed"] = seed
    if extra:
        payload.update(extra)
    rec = call("/chat/completions", payload, tag=tag, **kw)
    msg = rec["resp"]["choices"][0]["message"]
    text = msg.get("content") or ""
    return text, rec


def embed(model, texts, input_type="passage", tag=""):
    payload = {"model": model, "input": texts, "input_type": input_type, "encoding_format": "float"}
    rec = call("/embeddings", payload, tag=tag)
    return [d["embedding"] for d in rec["resp"]["data"]], rec


def parse_json(text):
    """Extract the first JSON object/array from a model reply (strips think blocks and code fences)."""
    import re
    t = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t.strip(), flags=re.M).strip()
    for opener, closer in (("{", "}"), ("[", "]")):
        i = t.find(opener)
        if i < 0:
            continue
        depth = 0; ins = False; esc = False
        for j in range(i, len(t)):
            ch = t[j]
            if ins:
                if esc: esc = False
                elif ch == "\\": esc = True
                elif ch == '"': ins = False
                continue
            if ch == '"': ins = True
            elif ch == opener: depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(t[i:j + 1])
                    except Exception:
                        break
    return None


if __name__ == "__main__":
    import sys
    m = sys.argv[1] if len(sys.argv) > 1 else env()["NIM_MODEL"]
    txt, rec = chat(m, [{"role": "user", "content": "Reply with the single word: ok"}], tag="ping", max_tokens=400, use_cache=False)
    print(m, repr(txt[:80]), round(rec["latency_s"], 2), rec["resp"].get("usage"))
