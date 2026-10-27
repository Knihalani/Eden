"""not-product: offline MemoryAgentBench retrieval via mab-bridge (BrainMemory, not wrap/hook inject)."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SENTINEL = "@@EDEN@@"
ROOT = Path(__file__).resolve().parents[2]


class EdenBridge:
    def __init__(self):
        bridge = ROOT / "benchmarks/memoryagentbench/mab-bridge.ts"
        self.proc = subprocess.Popen(
            [os.environ.get("EDEN_BUN", "bun"), str(bridge)],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._call({"op": "init"})

    def _call(self, payload, timeout=900):
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while True:
            if time.time() > deadline:
                raise RuntimeError("bridge timeout")
            line = self.proc.stdout.readline()
            if not line:
                err = self.proc.stderr.read()[:4000] if self.proc.stderr else ""
                raise RuntimeError(f"bridge exit {self.proc.poll()} {err!r}")
            line = line.strip()
            if not line.startswith(SENTINEL):
                continue
            result = json.loads(line[len(SENTINEL):].strip())
            if not result.get("ok"):
                raise RuntimeError(result.get("error"))
            return result

    def add(self, text):
        self._call({"op": "add", "text": text})

    def flush(self):
        return self._call({"op": "flush"}, timeout=1800)

    def query(self, text, k):
        return self._call({"op": "query", "text": text, "k": k}, timeout=180)

    def close(self):
        try:
            self._call({"op": "close"}, timeout=30)
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass


def golds(ans):
    if isinstance(ans, list):
        out = []
        for x in ans:
            if isinstance(x, list):
                out.extend(str(y) for y in x)
            else:
                out.append(str(x))
        return [g for g in out if g.strip()]
    return [str(ans)]


def hit_icl(notes, gold):
    blob = "\n".join(notes)
    return any(f"label: {g}" in blob or f"label:{g}" in blob for g in gold)


def hit_sub(notes, gold):
    blob = "\n".join(notes).lower()
    return any(g.lower() in blob for g in gold if len(g.strip()) >= 3)


def occurred_query(q: str) -> str:
    m = re.search(r"already occurred:\s*(.*?)\n\s*Below is a list", q, re.S | re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"1\.\s*(.+)", q)
    return (m.group(1) if m else q).strip()[:500]


def run_icl_all():
    from datasets import load_dataset

    ds = load_dataset("ai-hyz/MemoryAgentBench", split="Test_Time_Learning")
    for row in ds:
        src = str(row.get("metadata", {}).get("source", ""))
        if not src.startswith("icl_"):
            continue
        bridge = EdenBridge()
        t0 = time.time()
        bridge.add(row["context"])
        flush = bridge.flush()
        ingest_s = time.time() - t0
        qs = row["questions"] if isinstance(row["questions"], list) else [row["questions"]]
        ans = row["answers"] if isinstance(row["answers"], list) else [row["answers"]]
        nq = min(100, len(qs))
        hits = top1 = top5 = 0
        for i in range(nq):
            g = golds(ans[i])
            notes = bridge.query(qs[i], 40)["contents"]
            if hit_icl(notes, g):
                hits += 1
            if notes and hit_icl(notes[:1], g):
                top1 += 1
            if hit_icl(notes[:5], g):
                top5 += 1
        bridge.close()
        print(f"ICL {src} @40: {hits}/{nq} ({100*hits/nq:.1f}%) top1={top1} top5={top5} ep={flush.get('episodes')} ingest={ingest_s:.1f}s", flush=True)


def run_facts_all():
    from datasets import load_dataset

    ds = load_dataset("ai-hyz/MemoryAgentBench", split="Conflict_Resolution")
    want = [
        "factconsolidation_sh_6k", "factconsolidation_mh_6k",
        "factconsolidation_sh_32k", "factconsolidation_mh_32k",
        "factconsolidation_sh_64k", "factconsolidation_mh_64k",
    ]
    for row in ds:
        src = str(row.get("metadata", {}).get("source", ""))
        if src not in want:
            continue
        k = 24
        bridge = EdenBridge()
        t0 = time.time()
        bridge.add(row["context"])
        flush = bridge.flush()
        ingest_s = time.time() - t0
        qs = row["questions"] if isinstance(row["questions"], list) else [row["questions"]]
        ans = row["answers"] if isinstance(row["answers"], list) else [row["answers"]]
        nq = min(100, len(qs))
        hits = top1 = 0
        misses = []
        for i in range(nq):
            g = golds(ans[i])
            notes = bridge.query(qs[i], k)["contents"]
            ok = hit_sub(notes, g)
            if ok:
                hits += 1
            if notes and hit_sub(notes[:1], g):
                top1 += 1
            elif not ok and len(misses) < 5:
                misses.append((qs[i][:80], g[:2], notes[0][:80] if notes else ""))
        bridge.close()
        print(f"FACT {src} @{k}: {hits}/{nq} ({100*hits/nq:.1f}%) top1={top1} ep={flush.get('episodes')} ingest={ingest_s:.1f}s", flush=True)
        for m in misses:
            print(f"    miss q={m[0]!r} gold={m[1]} head={m[2]!r}", flush=True)


def run_eventqa(src="eventqa_65536", max_ctx=5, max_q=100):
    from datasets import load_dataset

    ds = load_dataset("ai-hyz/MemoryAgentBench", split="Accurate_Retrieval")
    rows = [r for r in ds if r.get("metadata", {}).get("source") == src]
    hits = n = 0
    t_all = time.time()
    for ci, row in enumerate(rows[:max_ctx]):
        bridge = EdenBridge()
        t0 = time.time()
        bridge.add(row["context"])
        flush = bridge.flush()
        ingest_s = time.time() - t0
        qs = row["questions"] if isinstance(row["questions"], list) else [row["questions"]]
        ans = row["answers"] if isinstance(row["answers"], list) else [row["answers"]]
        ch = 0
        cn = 0
        for i in range(min(max_q, len(qs))):
            g = golds(ans[i])
            q = occurred_query(qs[i])
            notes = bridge.query(q, 12)["contents"]
            ok = hit_sub(notes, g)
            n += 1
            cn += 1
            if ok:
                hits += 1
                ch += 1
        bridge.close()
        print(f"  {src} ctx{ci} {ch}/{cn} ep={flush.get('episodes')} ingest={ingest_s:.1f}s", flush=True)
    print(f"EVENT {src}: {hits}/{n} ({100*hits/max(n,1):.1f}%) total={time.time()-t_all:.1f}s", flush=True)


def run_ruler(src="ruler_qa1_197K", max_q=100):
    from datasets import load_dataset

    ds = load_dataset("ai-hyz/MemoryAgentBench", split="Accurate_Retrieval")
    rows = [r for r in ds if r.get("metadata", {}).get("source") == src]
    if not rows:
        print(f"no {src}")
        return
    row = rows[0]
    bridge = EdenBridge()
    t0 = time.time()
    print(f"RULER ingest {src} chars={len(row['context'])}", flush=True)
    bridge.add(row["context"])
    flush = bridge.flush()
    ingest_s = time.time() - t0
    print(f"  flushed ep={flush.get('episodes')} ingest={ingest_s:.1f}s", flush=True)
    qs = row["questions"] if isinstance(row["questions"], list) else [row["questions"]]
    ans = row["answers"] if isinstance(row["answers"], list) else [row["answers"]]
    nq = min(max_q, len(qs))
    hits = top1 = 0
    for i in range(nq):
        g = golds(ans[i])
        notes = bridge.query(qs[i], 12)["contents"]
        if hit_sub(notes, g):
            hits += 1
        if notes and hit_sub(notes[:1], g):
            top1 += 1
        if i < 3:
            print(f"    q{i} gold={g[:2]} hit={hit_sub(notes,g)} head={(notes[0][:90] if notes else '')!r}", flush=True)
    bridge.close()
    print(f"RULER {src} @12: {hits}/{nq} ({100*hits/nq:.1f}%) top1={top1} ep={flush.get('episodes')}", flush=True)


def main():
    jobs = sys.argv[1:] or ["icl", "facts", "eventqa", "ruler"]
    if "icl" in jobs:
        run_icl_all()
    if "facts" in jobs:
        run_facts_all()
    if "eventqa" in jobs:
        run_eventqa()
    if "ruler" in jobs:
        run_ruler()


if __name__ == "__main__":
    main()
