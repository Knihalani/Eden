"""F9 (D1101): how far subagent-served push checks agree with the recorded API check, on F2's pilot rows.

    python3 -I check-fidelity.py build PILOT_DIR OUT_DIR --batch 24        # batches in the queue's request format
    python3 -I check-fidelity.py score PILOT_DIR NAME=ANSWERS.json[,ANSWERS.json…] …

PILOT_DIR is F2's `pilot-build.ts` output: `meta.json` (each row's stratum, item ids, planted id and the recorded
API check's `recorded` yes ids) and `W-<b>.json` (the shipped system prompt and each row's exact user turn). `build`
writes `OUT_DIR/b<k>.json`, arrays of {id, role, model, system, messages, outputSpec}, for any batch size; a
subagent's answers are `[{id, text}]` as the queue's `put` takes them. `score` reads each arm's answers with the
shipped parser (a yes needs `act` true and a `hits` that lands; an unreadable reply names nothing) and prints, by
stratum, planted named / look-alike named / any yes, then row-level agreement with the recorded API answers.
"""
import json
import os
import re
import sys

NO_HIT = re.compile(r"^\s*(?:(?:none|n/a)(?![\w]).*|(?:nothing|no)?\s*\.?\s*)$", re.I | re.S)


def parse(reply, n):
    """The shipped `parseCompare` (as F2's pilot-score.py reads it): item indexes named yes, None when unreadable."""
    if not isinstance(reply, str) or not re.match(r'^\s*\{\s*"items"\s*:\s*\[', reply):
        return None
    try:
        ents = json.loads(reply[reply.index("{"):reply.rindex("}") + 1])["items"]
    except Exception:
        return None
    out = []
    for e in ents[:12]:
        if not isinstance(e, dict):
            return None
        if e.get("act") not in (True, "true"):
            continue
        hits = e.get("hits")
        if hits is not None and not isinstance(hits, str):
            return None
        if hits is None or NO_HIT.match(hits):
            continue
        i = e.get("i")
        i = int(i) if isinstance(i, str) and i.isdigit() else i
        if not isinstance(i, int) or not 1 <= i <= n:
            return None
        if i - 1 not in out and len(out) < 5:
            out.append(i - 1)
    return out


def rows(pilot):
    meta = {m["id"]: m for m in json.load(open(os.path.join(pilot, "meta.json")))}
    prompts = {}
    for f in sorted(os.listdir(pilot)):
        if re.fullmatch(r"W-\d+\.json", f):
            b = json.load(open(os.path.join(pilot, f)))
            for p in b["prompts"]:
                prompts[p["id"]] = (b["system"], p["user"])
    return meta, prompts


def build(pilot, out, size):
    meta, prompts = rows(pilot)
    os.makedirs(out, exist_ok=True)
    ids = sorted(prompts)
    for k in range(0, len(ids), size):
        batch = []
        for i in ids[k:k + size]:
            system, user = prompts[i]
            batch.append({"id": str(i), "role": "eden.check", "model": "claude-haiku-5-5", "system": system,
                          "messages": [{"role": "user", "content": user}],
                          "outputSpec": {"kind": "json", "maxTokens": 500}})
        json.dump(batch, open(os.path.join(out, f"b{k // size}.json"), "w"))
    print(f"{len(ids)} rows in {(len(ids) + size - 1) // size} batches of {size} → {out}")


def score(pilot, arms):
    meta, _ = rows(pilot)
    named = {"API": {i: set(m["recorded"] or []) for i, m in meta.items() if m["recorded"] is not None}}
    chars = {}
    for spec in arms:
        name, files = spec.split("=", 1)
        got, total = {}, []
        for f in files.split(","):
            for a in json.load(open(f)):
                i = int(a["id"])
                m = meta[i]
                at = parse(a.get("text", ""), len(m["items"]))
                got[i] = None if at is None else {m["items"][j] for j in at}
                total.append(len(a.get("text", "")))
        named[name] = got
        chars[name] = sum(total) / max(1, len(total))
    strata = ["dropped", "kept", "control", "neutral"]
    print(f"{'arm':10} {'rows':>4} {'unread':>6} " + " ".join(f"{s:>9}" for s in strata) + "  chars/reply")
    for arm, got in named.items():
        cells = []
        for s in strata:
            ids = [i for i, m in meta.items() if m["stratum"] == s and i in got]
            if s == "neutral":
                k = sum(bool(got[i]) for i in ids)
            else:
                k = sum(got[i] is not None and meta[i]["planted"] in got[i] for i in ids)
            cells.append(f"{k:>4}/{len(ids):<4}")
        unread = sum(v is None for v in got.values())
        print(f"{arm:10} {len(got):>4} {unread:>6} " + " ".join(f"{c:>9}" for c in cells) +
              f"  {chars.get(arm, 0):.0f}")
    print("\nagreement with the recorded API check (rows both answered):")
    api = named["API"]
    for arm, got in named.items():
        if arm == "API":
            continue
        ids = [i for i in got if i in api and got[i] is not None]
        speak = sum(bool(got[i]) == bool(api[i]) for i in ids)
        same = sum(got[i] == api[i] for i in ids)
        key = [i for i in ids if meta[i]["stratum"] != "neutral"]
        planted = sum((meta[i]["planted"] in got[i]) == (meta[i]["planted"] in api[i]) for i in key)
        print(f"  {arm:10} n {len(ids):>3}  speak/silent {speak / max(1, len(ids)):.3f}  same items "
              f"{same / max(1, len(ids)):.3f}  planted-or-look-alike call {planted / max(1, len(key)):.3f}")
        silent = [i for i in ids if not api[i]]
        spoke = [i for i in ids if api[i]]
        print(f"  {'':10} API silent kept silent {sum(not got[i] for i in silent)}/{len(silent)}; API spoke, "
              f"{arm} spoke {sum(bool(got[i]) for i in spoke)}/{len(spoke)}; items named API "
              f"{sum(len(api[i]) for i in ids)}, {arm} {sum(len(got[i]) for i in ids)}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "build":
        size = int(sys.argv[sys.argv.index("--batch") + 1]) if "--batch" in sys.argv else 24
        build(sys.argv[2], sys.argv[3], size)
    elif cmd == "score":
        score(sys.argv[2], sys.argv[3:])
    else:
        sys.exit(__doc__)
