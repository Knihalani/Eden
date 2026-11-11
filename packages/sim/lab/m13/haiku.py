"""M13: one Haiku call through the Anthropic API (HAIKU_API_KEY, never printed), with a spend ledger and a hard cap.

    from haiku import call; text = call(system, user, run="m13-gen", max_tokens=4000)
"""
import json, os, time, urllib.request

LEDGER = os.environ.get("M13_LEDGER", ".local/m13/ledger.jsonl")
CAP = float(os.environ.get("M13_USD_CAP", "10"))
PRICE_IN, PRICE_OUT = 0.10 / 1e6, 0.50 / 1e6


def spent():
    try:
        return sum(json.loads(l)["usd"] for l in open(LEDGER))
    except FileNotFoundError:
        return 0.0


def call(system, user, run, max_tokens=4000, model="claude-haiku-5-5", effort="low", think=True):
    if spent() >= CAP:
        raise RuntimeError(f"spend cap ${CAP} reached")
    body = {"model": model, "max_tokens": max_tokens, "system": system, "output_config": {"effort": effort},
            "messages": [{"role": "user", "content": user}]}
    if not think:
        body["thinking"] = {"type": "disabled"}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), headers={
        "x-api-key": os.environ["HAIKU_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"})
    for attempt in range(5):
        try:
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read())
            break
        except Exception as e:  # 429/5xx/network: back off
            if attempt == 4:
                raise
            time.sleep(2 ** attempt * 2)
    u = d["usage"]
    usd = u["input_tokens"] * PRICE_IN + u["output_tokens"] * PRICE_OUT + u.get("cache_read_input_tokens", 0) * PRICE_IN / 10
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, "a") as f:
        f.write(json.dumps({"run": run, "usd": usd, "in": u["input_tokens"], "out": u["output_tokens"],
                            "s": round(time.time() - t0, 2), "stop": d.get("stop_reason")}) + "\n")
    return "".join(b.get("text", "") for b in d["content"] if b["type"] == "text")
