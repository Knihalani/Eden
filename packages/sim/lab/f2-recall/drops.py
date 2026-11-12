"""F2 (docs/research/f2-push-recall.md): why the push check left out a planted fact it read.

    python3 -I drops.py DUMP.jsonl ...

For each hidden task's check whose pool held the planted item and whose answer left it out, the reply's entry for it:
`unlisted` (no entry), `hits-none` (its point lands on nothing of the request's) or `act-false` (it lands, verdict no).
"""
import collections
import json
import sys


def entries(reply):
    try:
        return json.loads(reply[reply.index("{"):reply.rindex("}") + 1])["items"]
    except Exception:
        return []


def main():
    rows = [json.loads(line) for f in sys.argv[1:] for line in open(f) if line.strip()]
    why_n = collections.Counter()
    for r in rows:
        if r.get("variant") != "hidden" or r["yes"] is None:
            continue
        ids = [it["id"] for it in r["items"]]
        if r["planted"] not in ids:
            why_n["not in pool"] += 1
            continue
        if r["planted"] in r["yes"]:
            why_n["kept"] += 1
            continue
        at = ids.index(r["planted"])
        it = r["items"][at]
        e = [x for x in entries(r.get("reply") or "") if str(x.get("i")) == str(at + 1)]
        hits = str(e[0].get("hits", "")).lower() if e else ""
        why = "unlisted" if not e else "hits-none" if hits.startswith(("none", "n/a")) else "act-false"
        why_n[why] += 1
        print(f"--- {r['suite']} {r['seed']} {r['template']} [{why}] at {at + 1}/{len(ids)}")
        print(f"  request: {r['request'][:160]}")
        print(f"  item: {it['source']} | {it['title']} | {it['text'][:200]}")
        print(f"  entry: {e[0] if e else None}")
    print(dict(why_n))


if __name__ == "__main__":
    main()
