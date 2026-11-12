"""Target 4's wall time, task by task, from a multi-turn run's timelines [EST; served by subagents (D1101)] (G4, D1550).

    python3 -I packages/sim/lab/final/wall.py RUN_DIR [--raw mt-raw] [--arms mt-final,...] [--latency 0.3,0.8,2.0]
        [--check-out TOKENS] [--check-wait-ms 1500] [--hold] [--json OUT]

`cost.py`'s wall sums the modelled latency of every agent call and every `eden.check` call in `q/calls.jsonl`. That
is not the agent's wait: a call replayed after a restart is logged again, a check that runs behind the push is not on
the path, and the agent's connector calls are left out, which is most of what Eden saves. This reads each task's own
timeline instead and adds up what the agent waits for, in order:

- **Model calls:** each of the task's requests by H3's fit, 596 ms + 2.93 ms an output token. The output is the
  request's text (four characters a token) plus `TOOL_CALL_TOKENS` a tool call it makes.
- **Connector rounds:** the agent's own tool spans (`tool.*`, `ask_context` apart). At the measured latency a round is
  the union of its overlapping spans (the lab's `direct` profile at time scale 1). At an assumed latency L a round is
  L, however many calls it makes at once, so the figure favours the agent alone, which makes more calls a round.
- **`ask_context`:** as measured (Eden's own time, no model call on the default's path).
- **The push check:** only a check that ends inside the request's observe blocks the agent. It is priced by the same
  fit at the run's mean check output (from the queue's sizes, each request once; `--check-out` overrides), capped at
  `--check-wait-ms` (the push stops waiting there and fails open). A check that ended after the agent's first model
  request began did not block: it is counted as late and adds nothing, and the arm then measured late injection.
- **Eden's other path time:** the request's observe span less its check span, as measured (CPU and index reads).

Arms are paired with the raw arm task by task; intervals are a bootstrap over templates (2,000 draws, seed 7).

`--hold` adds two hold-and-release readings. In both the agent's first model request goes out when the user's
message arrives, beside the check, and its reply is held until the check answers; a released call cuts the task's
wait by min(check, first call), and any other checked turn aborts the call and sends it again as today (no change
in the wait; the aborted call's input is paid for nothing, and their count is printed for the cost side). The agent
sees the default's context either way.
- "speculate" (F10's proxy option, D1273): the call is sent as if the turn got no packet, so it is released only
  when the turn hands nothing. With `pushLookup` a silent check still hands reference records, so it never is.
- "ahead" (D1551): the call is sent with the packet a silent check would hand (the lookup's records are built with
  no model), so it is released whenever the check names nothing.
"""

import argparse
import collections
import json
import os
import random

FIT_MS, FIT_TOKEN_MS = 596.0, 2.93
CPT = 4.0
TOOL_CALL_TOKENS = 30.0
MIX = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}


def fit(tokens):
    return FIT_MS + FIT_TOKEN_MS * tokens


def spans(events):
    """Finished spans as (name, category, lane, start, end, begin data)."""
    began, out = {}, []
    for e in events:
        if e.get("ph") == "B":
            began[e.get("id")] = e
        elif e.get("ph") == "E" and e.get("id") in began:
            b = began.pop(e["id"])
            out.append((b.get("ev", ""), b.get("cat"), b.get("lane"), b["t"], e["t"], b.get("data") or {}))
    return out


def rounds(tools):
    """Overlapping spans merged: [(start, end)] sorted."""
    merged = []
    for s, e in sorted(tools):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def check_out_tokens(run, label):
    """The run's mean push-check output in tokens, each queued request once; None when nothing is sized."""
    q = os.path.join(run, "q")
    calls = os.path.join(q, "calls.jsonl")
    if not os.path.exists(calls):
        return None
    keys = set()
    for line in open(calls):
        c = json.loads(line)
        if c.get("run") == label and c.get("role") == "eden.check" and c.get("key"):
            keys.add(c["key"])
    outs = []
    for k in keys:
        p = os.path.join(q, "done", f"{k}.json")
        try:
            d = json.load(open(p))
        except (OSError, ValueError):
            continue
        if "size" in d:
            outs.append(d["size"]["out"] / CPT)
    return sum(outs) / len(outs) if outs else None


def read_arm(run, name, check_out, check_wait_ms):
    res = json.load(open(os.path.join(run, f"{name}.json")))
    kinds = {t["id"]: t.get("kind", "hidden") for t in res.get("tasks", [])}
    failed = {r["task"] for r in res["results"] if r.get("error")}
    handed = {r["task"]: r.get("injectedItems", 0) for r in res["results"]}
    if check_out is None:
        check_out = check_out_tokens(run, f"{os.path.basename(run.rstrip('/'))}-{name}")
    check_ms = min(fit(check_out if check_out is not None else 31.0), check_wait_ms)
    tasks = {}
    for line in open(os.path.join(run, f"{name}.tl", "tasks.jsonl")):
        d = json.loads(line)
        tid = d.get("task")
        if tid in failed or not isinstance(d.get("events"), list):
            continue
        sp = spans(d["events"])
        reqs = d.get("requests") or []
        calls = [fit(r.get("textChars", 0) / CPT + TOOL_CALL_TOKENS * r.get("calls", 0)) for r in reqs]
        first_req = min((s for ev, _, _, s, _, _ in sp if ev == "model.request"), default=None)
        tools = [(s, e) for ev, cat, lane, s, e, _ in sp if cat == "tool" and lane == "path"]
        asks = sum(e - s for ev, cat, lane, s, e, _ in sp if ev == "tool.ask_context")
        tool_rounds = rounds(tools)
        observes = [(s, e) for ev, _, lane, s, e, data in sp
                    if ev == "eden.observe" and lane == "path" and data.get("event") not in ("session_start",)]
        checks = [(s, e) for ev, _, _, s, e, _ in sp if ev == "eden.check"]
        blocking = late = 0
        other = sum(e - s for s, e in observes)
        for s, e in checks:
            inside = any(os_ <= s and e <= oe for os_, oe in observes)
            if first_req is not None and e > first_req:
                late += 1
            elif inside:
                blocking += 1
                other -= e - s
        tasks[tid] = dict(
            kind=kinds.get(tid, d.get("kind", "hidden")),
            calls=calls,
            model=sum(calls),
            n_tools=len(tools),
            n_rounds=len(tool_rounds),
            tools=sum(e - s for s, e in tool_rounds),
            asks=asks,
            check=blocking * check_ms,
            checks=blocking,
            late=late,
            other=max(0.0, other),
            handed=handed.get(tid, 0),
            # The check named an item of some pool (a packet of checked candidates), as against a silent check whose
            # turn got nothing or `pushLookup`'s reference records (D1252), which need no check answer to build.
            named=any(any(p.get("checked") or []) for p in d.get("pushPools") or []),
        )
    return tasks, check_ms, check_out


def released(t, hold):
    """Whether a held first call is released: "speculate" needs a turn with no packet, "ahead" only a silent check."""
    if not hold or not t["checks"] or not t["calls"]:
        return False
    return not t["named"] if hold == "ahead" else not t["handed"]


def wall(t, latency=None, hold=None):
    """A task's wait in ms: at the measured connector latency (latency None) or at `latency` seconds a round."""
    conn = t["tools"] if latency is None else 1000.0 * latency * t["n_rounds"]
    w = t["model"] + conn + t["asks"] + t["check"] + t["other"]
    if released(t, hold):
        w -= min(t["check"], t["calls"][0])
    return w


def template(tid):
    return tid.split(":")[-1].split("-control")[0].split("-neutral")[0]


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else float("nan")


def paired(raw, arm, f_raw, f_arm, draws=2000):
    """Mean raw, mean arm and arm/raw - 1 with a 95% interval, bootstrapped over templates."""
    ids = sorted(set(raw) & set(arm))
    groups = collections.defaultdict(list)
    for i in ids:
        groups[template(i)].append(i)
    names = sorted(groups)
    a, b = mean(f_raw(raw[i]) for i in ids), mean(f_arm(arm[i]) for i in ids)
    rng = random.Random(7)
    ratios = []
    for _ in range(draws):
        pick = [i for g in (rng.choice(names) for _ in names) for i in groups[g]]
        ra, rb = mean(f_raw(raw[i]) for i in pick), mean(f_arm(arm[i]) for i in pick)
        if ra > 0:
            ratios.append(rb / ra - 1)
    ratios.sort()
    lo, hi = (ratios[int(0.025 * len(ratios))], ratios[int(0.975 * len(ratios)) - 1]) if ratios else (0.0, 0.0)
    return len(ids), a, b, (b / a - 1 if a else 0.0), lo, hi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--raw", default="mt-raw")
    ap.add_argument("--arms", default="mt-final")
    ap.add_argument("--latency", default="0.3,0.8,2.0")
    ap.add_argument("--check-out", type=float, default=None)
    ap.add_argument("--check-wait-ms", type=float, default=1500.0)
    ap.add_argument("--hold", action="store_true")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()
    lats = [float(x) for x in a.latency.split(",") if x]
    raw, _, _ = read_arm(a.run, a.raw, a.check_out, a.check_wait_ms)
    out = {}
    print("== wall time a task, from each task's timeline [EST; served by subagents (D1101)] (wall.py)")
    print("   model calls by H3's fit; connector rounds measured, or L s a round; a check counts only where it blocks")
    for name in [x for x in a.arms.split(",") if x]:
        if not os.path.exists(os.path.join(a.run, f"{name}.json")):
            continue
        arm, check_ms, check_out = read_arm(a.run, name, a.check_out, a.check_wait_ms)
        ids = sorted(set(raw) & set(arm))
        n = len(ids)
        if not n:
            print(f"\n  {name}: no task in common with {a.raw}")
            continue
        part = lambda ts, k: mean(ts[i][k] for i in ids)
        print(f"\n  {name} against {a.raw}, {n} paired tasks; a check {check_ms:.0f} ms "
              f"({'no sized check: 31 tokens assumed' if check_out is None else f'{check_out:.0f} output tokens'})")
        for label, ts in ((a.raw, raw), (name, arm)):
            print(f"    {label:9s} model calls {mean(len(ts[i]['calls']) for i in ids):.2f} ({part(ts, 'model'):.0f} ms), "
                  f"connector calls {part(ts, 'n_tools'):.2f} in {part(ts, 'n_rounds'):.2f} rounds "
                  f"({part(ts, 'tools'):.0f} ms measured), ask_context {part(ts, 'asks'):.0f} ms, blocking checks "
                  f"{part(ts, 'checks'):.2f} ({part(ts, 'check'):.0f} ms), Eden's other path time "
                  f"{part(ts, 'other'):.0f} ms; late checks {sum(ts[i]['late'] for i in ids)}")
        rows = [("measured connector latency", None)] + [(f"{l:g} s a connector round", l) for l in lats]
        out[name] = {"n": n, "check_ms": check_ms, "rows": []}
        for hold in ([None, "speculate", "ahead"] if a.hold else [None]):
            if hold:
                held = [i for i in ids if released(arm[i], hold)]
                aborted = [i for i in ids if arm[i]["checks"] and arm[i]["calls"] and not released(arm[i], hold)]
                what = ("speculate (D1273): the first call sent with no packet" if hold == "speculate" else
                        "speculate with the silent packet ahead (D1551)")
                print(f"    {what}: {len(held)} of {n} tasks released early, {len(aborted)} first calls aborted "
                      f"and sent again ({len(aborted) / n:.2f} a task)")
            for label, lat in rows:
                k, r, f, d, lo, hi = paired(raw, arm, lambda t: wall(t, lat), lambda t: wall(t, lat, hold))
                print(f"    {hold + ': ' if hold else ''}{label}: {a.raw} {r:.0f} ms, {name} {f:.0f} ms, "
                      f"{100 * d:+.1f}% ({100 * lo:+.1f}..{100 * hi:+.1f})")
                out[name]["rows"].append(dict(hold=hold, latency=lat, raw=r, arm=f, change=d, lo=lo, hi=hi))
            mix = {}
            for kind in MIX:
                kid = [i for i in ids if arm[i]["kind"] == kind]
                if kid:
                    mix[kind] = (mean(wall(raw[i]) for i in kid), mean(wall(arm[i], None, hold) for i in kid), len(kid))
            if len(mix) == len(MIX):
                mr = sum(MIX[k] * mix[k][0] for k in MIX)
                mf = sum(MIX[k] * mix[k][1] for k in MIX)
                kinds = ", ".join(f"{k} {mix[k][0]:.0f} -> {mix[k][1]:.0f} ({mix[k][2]})" for k in MIX)
                print(f"    {hold + ': ' if hold else ''}by kind, measured latency: {kinds}; on the 1:1:8 mix "
                      f"{mr:.0f} -> {mf:.0f} ms ({100 * (mf / mr - 1):+.1f}%)")
    if a.json:
        json.dump(out, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
