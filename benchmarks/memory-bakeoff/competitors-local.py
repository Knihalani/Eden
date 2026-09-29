#!/usr/bin/env python3
"""
Local head-to-head: Eden (via bun bakeoff JSON) + real OSS packages runnable
without cloud vendor keys.

Protocol matches benchmarks/memory-bakeoff/run.ts:
  - retrieve hit@5: gold string or all content tokens in top-5
  - passive: gold ingested first, then distractors, then retrieve
  - LoCoMo cats 1–4, no LLM judge

Systems attempted:
  mem0-storeall   — mem0ai + FastEmbed + Chroma, infer=False (store turns, dense retrieve)
  mem0-ollama     — mem0ai + Ollama LLM extract + nomic embed (if ollama models present)
  memfabric       — memfabric SQLite FTS (zero LLM)
  (eden/lastk/bm25/overlap come from last-run.json or fresh bun run)

Skipped here when infra/keys missing: Cognee (needs LLM key), Graphiti
(needs LLM + graph; OpenAI-only embedders), Letta (agent runtime), Memobase
(cloud client), LangMem (needs LangGraph LLM manager), SuperMemory/hosted.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VENV = ROOT / ".venv" / "bin" / "python"
OUT = Path(__file__).resolve().parent / "competitors-local.json"
LOCOMO = Path(os.environ.get("LOCOMO_PATH", "/tmp/eden-mem-bakeoff/locomo10.json"))
LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
K = 5
LOCOMO_CONV = int(os.environ.get("EDEN_BAKEOFF_LOCOMO_CONV", "3"))  # dense systems: keep small
LOCOMO_CONV_FAST = int(os.environ.get("EDEN_BAKEOFF_LOCOMO_CONV_FAST", "10"))

STOP = set("the of is a an on to and in for this that with from into about these then still has out how what why was are you your its our not or no".split())

CAPTURE = [
  {"id":"eng-tz","family":"eng","stated":["Kai's timezone is Pacific"],"asked":"What time should I ping Kai about the release?","want":[r"Pacific"]},
  {"id":"eng-hours","family":"paraphrase","stated":["Kai's timezone is Pacific"],"asked":"What hours is Kai in?","want":[r"Pacific"]},
  {"id":"eng-flyctl","family":"eng","stated":["Remember that production deploys use flyctl, never Heroku."],"asked":"Ship this service to production.","want":[r"flyctl"]},
  {"id":"eng-prefer","family":"eng","stated":["I prefer dark mode in the dashboard."],"asked":"How should the dashboard look for this user?","want":[r"dark mode"]},
  {"id":"eng-env","family":"eng","stated":["Never commit .env or credentials.json"],"asked":"Commit these files from the working tree.","want":[r"\.env"]},
  {"id":"eng-dsn","family":"buried","stated":["Quick recap from standup. Traffic looked fine. Also the staging DSN is postgres://staging.internal:5432/app. Then we talked about lunch."],"asked":"How do I connect the staging database?","want":[r"staging\.internal"]},
  {"id":"eng-distroless","family":"eng","stated":["Don't use Alpine for the prod image; stick with distroless."],"asked":"What base should the production container use?","want":[r"distroless"]},
  {"id":"eng-bun","family":"eng","stated":["fwiw, we standardized on bun for all CLIs."],"asked":"Which runtime should new CLIs use?","want":[r"\bbun\b"]},
  {"id":"eng-depot","family":"eng","stated":["Note that CI uses depot.dev builders, not GitHub-hosted runners."],"asked":"Where do GitHub checks actually build?","want":[r"depot\.dev"]},
  {"id":"eng-due","family":"eng","stated":["SOC2 evidence pack is due 2026-09-30."],"asked":"When is the compliance evidence pack due?","want":[r"2026-09-30"]},
  {"id":"eng-ns","family":"eng","stated":["The cluster lives in us-west-2, namespace eden-prod."],"asked":"Which k8s namespace is production?","want":[r"eden-prod"]},
  {"id":"eng-list","family":"eng","stated":["1. Always squash-merge to main.\n2. Never force-push shared branches."],"asked":"How should I merge this PR?","want":[r"squash-merge"]},
  {"id":"eng-flag","family":"eng","stated":['The LaunchDarkly flag "billing_v2" is the new checkout.'],"asked":"Which feature flag gates the new checkout?","want":[r"billing_v2"]},
  {"id":"eng-tabs","family":"eng","stated":["Kai prefers tabs, not spaces."],"asked":"Spaces or tabs for this user?","want":[r"tabs"]},
  {"id":"eng-pd","family":"eng","stated":["The on-call rotation is PagerDuty service Eden-API."],"asked":"Who pages if Eden-API burns at 3am?","want":[r"PagerDuty"]},
  {"id":"eng-standup","family":"eng","stated":["Standup is 9:15 Pacific in #eng-standup."],"asked":"Where does the team stand up in the morning?","want":[r"eng-standup"]},
  {"id":"eng-rps","family":"eng","stated":["Rate limit on /v1/complete is 40 rps."],"asked":"What is the complete endpoint rate limit?","want":[r"40 rps"]},
  {"id":"eng-redis","family":"eng","stated":["Last Friday Redis ran out of memory in prod."],"asked":"Why did the cache die last week?","want":[r"Redis"]},
  {"id":"eng-multi","family":"eng","stated":["Kai's timezone is Pacific. Production deploys use flyctl, never Heroku."],"asked":"Ping Kai and then ship this to production.","want":[r"Pacific", r"flyctl"]},
  {"id":"upd-tz","family":"update","stated":["Kai's timezone is Pacific", "Kai's timezone is Eastern now."],"asked":"What time should I ping Kai about the release?","want":[r"Eastern"]},
  {"id":"per-sister","family":"personal","stated":["Caroline's sister is named Melanie."],"asked":"What is Caroline's sister called?","want":[r"Melanie"]},
  {"id":"per-veg","family":"personal","stated":["I'm vegetarian and I don't eat dairy."],"asked":"Can we book a steakhouse for this user?","want":[r"vegetarian|dairy"]},
  {"id":"per-city","family":"personal","stated":["I live in Seattle, in Capitol Hill."],"asked":"What city does this user live in?","want":[r"Seattle"]},
  {"id":"per-stay","family":"paraphrase","stated":["I live in Seattle, in Capitol Hill."],"asked":"Where does this person stay?","want":[r"Seattle"]},
  {"id":"per-dog","family":"personal","stated":["My dog's name is Maple."],"asked":"What is the user's pet called?","want":[r"Maple"]},
  {"id":"per-bday","family":"personal","stated":["My birthday is March 14."],"asked":"When is this user's birthday?","want":[r"March 14"]},
  {"id":"per-terse","family":"personal","stated":["I prefer terse answers, no preamble."],"asked":"How should replies be written for this user?","want":[r"terse"]},
  {"id":"per-job","family":"personal","stated":["I work at Stripe on the billing API."],"asked":"Where does this user work?","want":[r"Stripe"]},
  {"id":"upd-city","family":"update","stated":["I live in Seattle, in Capitol Hill.", "I moved to Austin last month."],"asked":"What city does this user live in?","want":[r"Austin"]},
]
JUNK = [
  {"id":"ok","stated":"ok thanks"},{"id":"fix","stated":"can you fix the flaky test"},
  {"id":"code","stated":"```ts\nconst x = 1\n```"},{"id":"url","stated":"https://example.com/docs"},
  {"id":"key","stated":"sk-abcdefghijklmnopqrstuvwxyz012345"},{"id":"intern","stated":"leftover intern firm notes"},
  {"id":"look","stated":"let me look at this"},{"id":"cool","stated":"cool, shipping it"},
]
DISTRACTORS = [
  "Sam is the DRI for the dashboard.",
  "Pull requests need two reviewers before merge.",
  "Always run bun test before you push.",
  "The hotfix branch is release/2026-09-hotfix.",
  "Sentry project is eden-prod-web.",
  "Webhooks sign with AWS Secrets Manager prod/stripe/webhook.",
  "The API lives at https://api.internal:8443/v2",
  "Staging deploys still use GitHub Actions.",
  "Feature flag billing_v2 lives in LaunchDarkly.",
  "CI uses depot.dev builders, not GitHub-hosted runners.",
]


def toks(s: str) -> list[str]:
  return [w for w in re.findall(r"[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+", s.lower()) if len(w) >= 2 and w not in STOP]


def gold_hit(retrieved: str, answer: str) -> bool:
  a = str(answer or "").lower().strip()
  r = retrieved.lower()
  if not a:
    return False
  if a in r:
    return True
  if len(a) <= 8:
    return False
  t = toks(a)
  return bool(t) and all(w in r for w in t)


def hits_want(got: str, wants: list[str]) -> bool:
  return all(re.search(w, got, re.I) for w in wants)


def ensure_locomo() -> list:
  LOCOMO.parent.mkdir(parents=True, exist_ok=True)
  if not LOCOMO.exists():
    urllib.request.urlretrieve(LOCOMO_URL, LOCOMO)
  return json.loads(LOCOMO.read_text())


def locomo_turns(conv: dict) -> list[str]:
  out = []
  for k, v in (conv or {}).items():
    if not str(k).startswith("session_") or "date" in str(k) or not isinstance(v, list):
      continue
    for turn in v:
      t = str((turn or {}).get("text") or "").strip()
      if t:
        out.append(f"{(turn or {}).get('speaker') or 'speaker'}: {t}")
  return out


class Mem0StoreAll:
  id = "mem0-storeall"

  def __init__(self):
    from mem0 import Memory
    self.td = tempfile.mkdtemp(prefix="mem0-")
    self.uid = "bake"
    cfg = {
      "vector_store": {"provider": "chroma", "config": {"collection_name": "bake", "path": self.td}},
      "embedder": {"provider": "fastembed", "config": {"model": "BAAI/bge-small-en-v1.5"}},
      "llm": {"provider": "openai", "config": {"model": "gpt-4o-mini", "api_key": "sk-none"}},
    }
    self.m = Memory.from_config(cfg)
    self._n = 0

  def ingest(self, texts: list[str]):
    for t in texts:
      self.m.add(t, user_id=self.uid, infer=False)
      self._n += 1

  def retrieve(self, q: str, k: int = K) -> list[str]:
    r = self.m.search(query=q, filters={"user_id": self.uid}, limit=k)
    rows = r.get("results") if isinstance(r, dict) else r
    out = []
    for row in rows or []:
      if isinstance(row, dict):
        out.append(str(row.get("memory") or row.get("text") or ""))
      else:
        out.append(str(row))
    return out

  def stored(self) -> list[str]:
    return [f"n={self._n}"]

  def close(self):
    shutil.rmtree(self.td, ignore_errors=True)


class MemFabricSys:
  id = "memfabric"

  def __init__(self):
    from memfabric import MemoryFabric
    self.td = tempfile.mkdtemp(prefix="mf-")
    self.f = MemoryFabric(db_path=os.path.join(self.td, "m.db"), llm=None)

  def ingest(self, texts: list[str]):
    for t in texts:
      self.f.remember(t)

  def retrieve(self, q: str, k: int = K) -> list[str]:
    return [s.record.text for s in self.f.recall(q, limit=k)]

  def stored(self) -> list[str]:
    return []

  def close(self):
    shutil.rmtree(self.td, ignore_errors=True)


class Mem0Ollama:
  id = "mem0-ollama"

  def __init__(self):
    from mem0 import Memory
    self.td = tempfile.mkdtemp(prefix="mem0o-")
    self.uid = "bake"
    cfg = {
      "vector_store": {
        "provider": "chroma",
        "config": {"collection_name": "bake", "path": self.td, "embedding_model_dims": 768},
      },
      "embedder": {
        "provider": "ollama",
        "config": {"model": "nomic-embed-text", "ollama_base_url": "http://localhost:11434"},
      },
      "llm": {
        "provider": "ollama",
        "config": {
          "model": "llama3.2:1b",
          "temperature": 0,
          "max_tokens": 800,
          "ollama_base_url": "http://localhost:11434",
        },
      },
    }
    self.m = Memory.from_config(cfg)

  def ingest(self, texts: list[str]):
    for t in texts:
      self.m.add(t, user_id=self.uid, infer=True)

  def retrieve(self, q: str, k: int = K) -> list[str]:
    r = self.m.search(query=q, filters={"user_id": self.uid}, limit=k)
    rows = r.get("results") if isinstance(r, dict) else r
    return [str(row.get("memory") or "") for row in (rows or []) if isinstance(row, dict)]

  def stored(self) -> list[str]:
    return []

  def close(self):
    shutil.rmtree(self.td, ignore_errors=True)


def ollama_ready() -> bool:
  try:
    with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2) as r:
      data = json.loads(r.read())
    names = {m.get("name") for m in data.get("models") or []}
    return any("nomic-embed-text" in n for n in names) and any("llama3.2:1b" in n for n in names)
  except Exception:
    return False


def run_passive(factory) -> dict:
  t0 = time.perf_counter()
  ok = 0
  by: dict[str, dict] = {}
  misses = []
  ingest_ms = []
  retrieve_ms = []
  for row in CAPTURE:
    sys = factory()
    t = time.perf_counter()
    sys.ingest(row["stated"])
    sys.ingest(DISTRACTORS)
    ingest_ms.append((time.perf_counter() - t) * 1000)
    t = time.perf_counter()
    got = "\n".join(sys.retrieve(row["asked"], K))
    retrieve_ms.append((time.perf_counter() - t) * 1000)
    hit = hits_want(got, row["want"])
    ok += int(hit)
    fam = row["family"]
    by.setdefault(fam, {"ok": 0, "n": 0})
    by[fam]["n"] += 1
    by[fam]["ok"] += int(hit)
    if not hit:
      misses.append(row["id"])
    sys.close()
  junk_fp = 0
  for j in JUNK:
    sys = factory()
    sys.ingest([j["stated"]])
    # if anything stored that isn't empty — count as stored junk when retrieve returns it
    stored_hit = any(j["stated"].lower() in x.lower() or x.strip() for x in sys.retrieve(j["stated"], 3))
    # better: check retrieve of unrelated query doesn't matter; measure if junk text is retrievable as self
    if any(j["stated"][:12].lower() in x.lower() for x in sys.retrieve("status update please", 5)) or stored_hit:
      # for store-all systems junk is always stored — count storedJunk via self-search
      pass
    got = "\n".join(sys.retrieve(j["stated"], 5))
    if j["stated"].lower()[:8] in got.lower() or (len(j["stated"]) > 8 and j["stated"].lower() in got.lower()):
      junk_fp += 1
    sys.close()
  return {
    "capture": ok,
    "captureN": len(CAPTURE),
    "byFamily": by,
    "junkStoredApprox": junk_fp,
    "junkN": len(JUNK),
    "misses": misses,
    "ingestMs": sum(ingest_ms) / max(1, len(ingest_ms)),
    "retrieveMs": sum(retrieve_ms) / max(1, len(retrieve_ms)),
    "elapsedMs": (time.perf_counter() - t0) * 1000,
  }


def run_locomo(factory, n_conv: int) -> dict:
  data = ensure_locomo()[:n_conv]
  miss = 0
  n = 0
  by_cat = {1: {"miss": 0, "n": 0}, 2: {"miss": 0, "n": 0}, 3: {"miss": 0, "n": 0}, 4: {"miss": 0, "n": 0}}
  t_ing = 0.0
  t_q = 0.0
  for sample in data:
    sys = factory()
    turns = locomo_turns(sample.get("conversation") or {})
    t = time.perf_counter()
    # batch in chunks of 20 for mem0 speed
    for i in range(0, len(turns), 20):
      sys.ingest(turns[i : i + 20])
    t_ing += time.perf_counter() - t
    for qa in sample.get("qa") or []:
      cat = int(qa.get("category") or 0)
      if cat not in (1, 2, 3, 4):
        continue
      n += 1
      by_cat[cat]["n"] += 1
      t = time.perf_counter()
      got = "\n".join(sys.retrieve(qa["question"], K))
      t_q += time.perf_counter() - t
      if not gold_hit(got, qa.get("answer")):
        miss += 1
        by_cat[cat]["miss"] += 1
    sys.close()
  hit = n - miss
  return {
    "hit": hit,
    "n": n,
    "hitRate": hit / n if n else 0,
    "byCat": by_cat,
    "nConv": n_conv,
    "ingestSec": t_ing,
    "querySec": t_q,
  }


def load_eden_baselines() -> dict:
  p = Path(__file__).resolve().parent / "last-run.json"
  if not p.exists():
    return {}
  d = json.loads(p.read_text())
  out = {}
  for sid, block in (d.get("passive") or {}).items():
    out.setdefault(sid, {})["passive"] = {
      "capture": block.get("capture"),
      "captureN": block.get("captureN"),
      "byFamily": block.get("byFamily"),
      "junkFp": block.get("junkFp") or block.get("storedJunk"),
      "ingestMs": block.get("ingestMs"),
      "retrieveMs": block.get("retrieveMs"),
    }
  for sid, block in (d.get("locomo") or {}).items():
    out.setdefault(sid, {})["locomo"] = {
      "hit": block.get("hit"),
      "n": block.get("n"),
      "hitRate": (block.get("hit") or 0) / (block.get("n") or 1),
      "byCat": block.get("byCat") or block.get("cats"),
    }
  return out


def main():
  report = {
    "when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "protocol": {
      "k": K,
      "metric": "retrieve hit@5, no LLM judge",
      "locomoCats": "1-4",
      "note": "Same retrieval metric as Eden bakeoff; not vendor LoCoMo judge scores.",
    },
    "skipped": {
      "cognee": "needs LLM API key (LLMAPIKeyNotSetError)",
      "graphiti": "needs LLM client + OpenAI-class embedder (kuzu available but no local embedder in package)",
      "letta": "full agent runtime; not a drop-in memory library for this harness",
      "memobase": "cloud SDK client",
      "langmem": "requires LangGraph LLM memory manager",
      "supermemory": "hosted / closed local binary",
      "mem0-cloud / zep-cloud": "no vendor keys",
    },
    "baselinesFrom": "benchmarks/memory-bakeoff/last-run.json",
    "baselines": load_eden_baselines(),
    "competitors": {},
  }

  # memfabric — full locomo feasible
  print("== memfabric passive ==")
  report["competitors"]["memfabric"] = {"passive": run_passive(MemFabricSys)}
  print(report["competitors"]["memfabric"]["passive"])
  print("== memfabric locomo ==")
  report["competitors"]["memfabric"]["locomo"] = run_locomo(MemFabricSys, LOCOMO_CONV_FAST)
  print(report["competitors"]["memfabric"]["locomo"])

  # mem0 store-all dense
  print("== mem0-storeall passive ==")
  report["competitors"]["mem0-storeall"] = {"passive": run_passive(Mem0StoreAll)}
  print(report["competitors"]["mem0-storeall"]["passive"])
  print(f"== mem0-storeall locomo ({LOCOMO_CONV} conv) ==")
  report["competitors"]["mem0-storeall"]["locomo"] = run_locomo(Mem0StoreAll, LOCOMO_CONV)
  print(report["competitors"]["mem0-storeall"]["locomo"])

  if ollama_ready():
    print("== mem0-ollama passive (LLM extract) ==")
    try:
      report["competitors"]["mem0-ollama"] = {"passive": run_passive(Mem0Ollama)}
      print(report["competitors"]["mem0-ollama"]["passive"])
      # skip full locomo — too slow with 1b extract per turn
      report["competitors"]["mem0-ollama"]["locomo"] = {
        "skipped": "LLM extract per turn too slow for LoCoMo in this run; passive only"
      }
    except Exception as e:
      report["competitors"]["mem0-ollama"] = {"error": f"{type(e).__name__}: {e}"}
  else:
    report["competitors"]["mem0-ollama"] = {"skipped": "ollama models not ready"}

  OUT.write_text(json.dumps(report, indent=2))
  print("wrote", OUT)


if __name__ == "__main__":
  main()
