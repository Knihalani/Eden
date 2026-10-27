#!/usr/bin/env python3
"""Run official MemoryAgentBench Table 3 leaves on product `openMemory` inject + NIM.

Writes:
  benchmarks/memoryagentbench/TABLE3-RESULTS.md
  benchmarks/memoryagentbench/table3-inject.config.json

Reader is NVIDIA NIM `google/gemma-4-31b-it` (disclosed). k=10. Official lengths.
LOSS is a valid close. Does not use BrainMemory, EventQA-64k, FC-6k, or retrieve-k forty.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

EDEN = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MAB = Path("/tmp/MemoryAgentBench")
CONFIG_PATH = HERE / "table3-inject.config.json"
RESULTS_PATH = HERE / "TABLE3-RESULTS.md"
AGENT_YAML = MAB / "configs/agent_conf/RAG_Agents/openrouter/Structure_rag_eden_inject.yaml"
OUTPUT_TAG = "eden-inject-gemma-4-31b-it"
NIM_MODEL = "google/gemma-4-31b-it"
# Official clone yamls cut EventQA/LME-S* to 5. Thorough run uses more samples
# at the same official lengths (still EventQA 534k / LME 355k, not 64k).
# EventQA: 5 novels × 100 QA. Official Table 3 / M15 / M18 cell is context 0,
# n=100 queries. max_test_samples: 100 would run 5 contexts (~500 queries).
# M22.3 FC-MH matches M15 n=100 (yaml default is 1).
# DetQA official n=71 is QA pairs across max_test_samples=10 contexts — not 71
# contexts. Do not put detqa: 71 here (that would bump yaml to 71 books).
THOROUGH_N = {"eventqa": 1, "lme": 50, "fc_sh": 100, "fc_mh": 100}

PROTOCOL = {
    "exam": "Table 3",
    "k": 10,
    "eventqa": 534000,
    "fc": 262000,
    "sh": 197000,
    "mh": 421000,
    "labelStrip": False,
    "reader": NIM_MODEL,
    "api": "openMemory inject",
}

# Official Table 3 leaves only (not 64k / 6k / 32k). Sample counts come from the yaml.
LEAVES = [
    {
        "id": "fc_sh",
        "comp": "SF",
        "yaml": "configs/data_conf/Conflict_Resolution/Factconsolidation_sh_262k.yaml",
        "metric": "substring_exact_match",
        "length": 262000,
        "n_cfg": 1,
    },
    {
        "id": "fc_mh",
        "comp": "SF",
        "yaml": "configs/data_conf/Conflict_Resolution/Factconsolidation_mh_262k.yaml",
        "metric": "substring_exact_match",
        "length": 262000,
        "n_cfg": 1,
    },
    {
        "id": "eventqa",
        "comp": "AR",
        "yaml": "configs/data_conf/Accurate_Retrieval/EventQA/Eventqa_full.yaml",
        "metric": "substring_exact_match",
        "length": 534000,
        "n_cfg": 5,
    },
    {
        "id": "icl_banking",
        "comp": "MCC",
        "yaml": "configs/data_conf/Test_Time_Learning/ICL/ICL_banking77.yaml",
        "metric": "exact_match",
        "length": 103000,
        "n_cfg": 100,
    },
    {
        "id": "icl_clinic",
        "comp": "MCC",
        "yaml": "configs/data_conf/Test_Time_Learning/ICL/ICL_clinic150.yaml",
        "metric": "exact_match",
        "length": 103000,
        "n_cfg": 100,
    },
    {
        "id": "icl_nlu",
        "comp": "MCC",
        "yaml": "configs/data_conf/Test_Time_Learning/ICL/ICL_nlu.yaml",
        "metric": "exact_match",
        "length": 103000,
        "n_cfg": 100,
    },
    {
        "id": "icl_trec_coarse",
        "comp": "MCC",
        "yaml": "configs/data_conf/Test_Time_Learning/ICL/ICL_trec_coarse.yaml",
        "metric": "exact_match",
        "length": 103000,
        "n_cfg": 100,
    },
    {
        "id": "icl_trec_fine",
        "comp": "MCC",
        "yaml": "configs/data_conf/Test_Time_Learning/ICL/ICL_trec_fine.yaml",
        "metric": "exact_match",
        "length": 103000,
        "n_cfg": 100,
    },
    {
        "id": "sh",
        "comp": "AR",
        "yaml": "configs/data_conf/Accurate_Retrieval/Ruler/QA/Ruler_qa1_197k.yaml",
        "metric": "substring_exact_match",
        "length": 197000,
        "n_cfg": 100,
    },
    {
        "id": "mh",
        "comp": "AR",
        "yaml": "configs/data_conf/Accurate_Retrieval/Ruler/QA/Ruler_qa2_421k.yaml",
        "metric": "substring_exact_match",
        "length": 421000,
        "n_cfg": 100,
    },
    {
        "id": "lme",
        "comp": "AR",
        "yaml": "configs/data_conf/Accurate_Retrieval/LongMemEval/Longmemeval_s_star.yaml",
        "metric": "llm_judge",
        "length": 355000,
        "n_cfg": 5,
    },
    {
        "id": "recsys",
        "comp": "TTL",
        "yaml": "configs/data_conf/Test_Time_Learning/Recsys/Recsys_redial_full.yaml",
        "metric": "recsys_recall@5",
        "length": 1440000,
        "n_cfg": 1,
    },
    {
        "id": "detqa",
        "comp": "LRU",
        "yaml": "configs/data_conf/Long_Range_Understanding/Detective_QA.yaml",
        "metric": "exact_match",
        "length": 200000,
        # 10 contexts (~6–7 QA pairs each). Official published n=71 is queries,
        # not contexts. Do not THOROUGH_N 71. --force-all archives stale JSON.
        "n_cfg": 10,
    },
    {
        "id": "summ",
        "comp": "LRU",
        "yaml": "configs/data_conf/Long_Range_Understanding/InfBench_sum.yaml",
        "metric": "llm_judge",
        "length": 1200000,
        "n_cfg": 100,
    },
]


def load_eden_env():
    path = EDEN / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        if key not in ("NVIDIA_API_KEY", "NVIDIA_BASE_URL"):
            continue
        if not os.environ.get(key):
            os.environ[key] = val.strip().strip('"').strip("'")
    os.environ["NIM_MODEL"] = NIM_MODEL


def write_protocol_config():
    CONFIG_PATH.write_text(json.dumps(PROTOCOL, indent=2) + "\n", encoding="utf-8")


ICL_YAML_NAMES = (
    "ICL_banking77.yaml",
    "ICL_clinic150.yaml",
    "ICL_nlu.yaml",
    "ICL_trec_coarse.yaml",
    "ICL_trec_fine.yaml",
)


def restore_icl_yamls() -> None:
    """MAB clone at /tmp/MemoryAgentBench often lacks Test_Time_Learning/ICL/*.yaml."""
    src_dir = HERE / "icl-yamls"
    dest = MAB / "configs/data_conf/Test_Time_Learning/ICL"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ICL_YAML_NAMES:
        src = src_dir / name
        target = dest / name
        if src.is_file() and not target.is_file():
            shutil.copyfile(src, target)
            print(f"restored ICL yaml {name}", flush=True)


def overlay_agent():
    dest = MAB / "methods" / "eden.py"
    shutil.copyfile(HERE / "inject-agent.py", dest)
    restore_icl_yamls()


def bump_yaml_samples(rel: str, n: int) -> None:
    path = MAB / rel
    text = path.read_text(encoding="utf-8")
    import re

    updated, count = re.subn(r"max_test_samples:\s*\d+", f"max_test_samples: {n}", text, count=1)
    if count:
        path.write_text(updated, encoding="utf-8")


def write_agent_yaml():
    AGENT_YAML.parent.mkdir(parents=True, exist_ok=True)
    AGENT_YAML.write_text(
        "\n".join(
            [
                "# Product inject + NVIDIA NIM reader. k=10. Not BrainMemory.",
                "agent_name: Structure_rag_eden",
                f"model: {NIM_MODEL}",
                "temperature: 0.0",
                "input_length_limit: 10000000",
                "buffer_length: 200",
                f"output_dir: ./outputs/{OUTPUT_TAG}",
                "agent_chunk_size: 4096",
                "retrieve_num: 10",
                "",
            ]
        ),
        encoding="utf-8",
    )


def find_result_json(sub_dataset: str) -> Path | None:
    root = MAB / "outputs" / OUTPUT_TAG
    if not root.is_dir():
        return None
    hits = []
    for p in root.rglob("*_results.json"):
        if "archive" in p.parts:
            continue
        if sub_dataset.replace(" ", "") in p.name.replace(" ", "") or sub_dataset in p.name:
            hits.append(p)
    if not hits:
        needle = sub_dataset.strip().split()[0]
        for p in root.rglob("*_results.json"):
            if needle in p.name:
                hits.append(p)
    if not hits:
        return None
    hits.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return hits[0]


def yaml_sub_dataset(rel: str) -> str:
    import yaml

    data = yaml.safe_load((MAB / rel).read_text(encoding="utf-8"))
    return str(data.get("sub_dataset", "")).strip()


def parse_prior_results(path: Path) -> dict[str, dict]:
    """Seed published leaf rows from TABLE3-RESULTS.md. Missing JSON must not wipe EventQA/FC/etc."""
    if not path.is_file():
        return {}
    ids = {s["id"] for s in LEAVES}
    out: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        parts = [p.strip() for p in line.strip().strip("|").split("|")]
        if len(parts) < 6:
            continue
        lid = parts[0]
        if lid not in ids:
            continue
        n_s, metric, score_s = parts[2], parts[3], parts[4]
        status = " | ".join(parts[5:]).strip()
        score = None
        if score_s not in {"—", "-", "–", "FAIL/missing"}:
            try:
                score = float(score_s)
            except ValueError:
                score = None
        n = None
        try:
            n = int(n_s)
        except (TypeError, ValueError):
            n = None
        if score is None and n is None:
            continue
        row: dict = {"status": status or "ok", "score": score, "metric": metric}
        if n is not None:
            row["n"] = n
        out[lid] = row
    return out


def seed_leaves() -> dict[str, dict]:
    """JSON first; TABLE3-RESULTS.md fills leaves hydrate_known cannot find. Does not invent scores."""
    leaves: dict[str, dict] = {}
    prior = parse_prior_results(RESULTS_PATH)
    for spec in LEAVES:
        known = hydrate_known(spec)
        if known:
            leaves[spec["id"]] = known
        elif spec["id"] in prior:
            leaves[spec["id"]] = prior[spec["id"]]
    return leaves


def hydrate_known(spec: dict) -> dict | None:
    """Read existing *_results.json. Never NIM-judge (that belongs in hydrate_leaf)."""
    try:
        sub = yaml_sub_dataset(spec["yaml"])
        out = find_result_json(sub)
        if out is None:
            return None
        parsed = extract_score(out, spec["metric"])
        parsed["path"] = str(out)
        if parsed.get("score") is not None:
            parsed["status"] = parsed.get("status") or "ok"
            if spec["id"] == "summ":
                parsed["note"] = parsed.get("note") or "NIM yes/no judge (not gpt-4o HELMET)"
            return parsed
        if parsed.get("n"):
            parsed["status"] = "needs NIM judge" if spec["metric"] == "llm_judge" else (parsed.get("note") or "FAIL/missing metric")
            return parsed
        return None
    except Exception:
        return None


def hydrate_leaf(spec: dict) -> dict | None:
    try:
        parsed = hydrate_known(spec)
        if parsed is None:
            return None
        if spec["metric"] == "llm_judge" and parsed.get("n") and parsed.get("score") is None:
            out = Path(parsed["path"])
            try:
                judged = nim_judge_lme(out)
                persist_llm_judge(out, judged)
                parsed.update(judged)
            except Exception as e:
                parsed["status"] = f"FAIL/missing judge {type(e).__name__}"
                parsed["score"] = None
                return parsed
            parsed["status"] = "ok" if parsed.get("score") is not None else (parsed.get("status") or "FAIL/missing judge")
            if spec["id"] == "summ" and parsed.get("score") is not None:
                parsed["note"] = "NIM yes/no judge (not gpt-4o HELMET)"
            return parsed
        if parsed.get("score") is None:
            return None
        parsed["status"] = parsed.get("status") or "ok"
        return parsed
    except Exception:
        return None


def leaf_done(spec: dict, parsed: dict) -> bool:
    n = int(parsed.get("n") or 0)
    avg = parsed.get("avg") or {}
    if parsed.get("score") is None:
        return False
    if spec["id"].startswith("icl"):
        em = float(avg.get("exact_match") or 0)
        sub = float(avg.get("substring_exact_match") or 0)
        if n < 90:
            return False
        if em == 0 and sub >= 20:
            return False
        return True
    if spec["id"] == "detqa":
        # Official n=71 is QA pairs (10 contexts). Gemma JSON dump scores
        # exact_match 0 with substring ~63 — that is output format, not done.
        em = float(avg.get("exact_match") or 0)
        sub = float(avg.get("substring_exact_match") or 0)
        if n < 50:
            return False
        if em == 0 and sub >= 20:
            return False
        return True
    if spec["id"] == "eventqa":
        return n >= 100
    if spec["id"] in ("fc_sh", "fc_mh"):
        return n >= 80
    need = max(int(spec.get("n_cfg") or 1), 1)
    return n >= max(1, int(need * 0.8))


def extract_score(path: Path, metric: str) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    data = raw.get("data") or []
    avg = raw.get("averaged_metrics") or {}
    n = len(data)
    if metric == "llm_judge":
        val = avg.get("llm_judge")
        if val is not None:
            return {
                "n": n,
                "score": float(val),
                "avg": avg,
                "path": str(path),
                "note": str(avg.get("llm_judge_note") or f"NIM {NIM_MODEL} yes/no judge (not gpt-4o)"),
            }
        return {"n": n, "score": None, "avg": avg, "path": str(path), "note": "needs NIM judge"}
    val = avg.get(metric)
    if val is None:
        return {"n": n, "score": None, "avg": avg, "path": str(path), "note": f"missing {metric}"}
    return {"n": n, "score": float(val), "avg": avg, "path": str(path)}


def nim_smoke() -> tuple[bool, str]:
    load_eden_env()
    key = os.environ.get("NVIDIA_API_KEY")
    base = os.environ.get("NVIDIA_BASE_URL")
    if not key or not base:
        return False, "NVIDIA_API_KEY or NVIDIA_BASE_URL missing"
    import httpx
    from openai import OpenAI

    model = os.environ.get("NIM_MODEL", NIM_MODEL)
    last = ""
    try:
        http = httpx.Client(http2=False, timeout=httpx.Timeout(connect=15, read=30, write=20, pool=10))
        client = OpenAI(
            base_url=base,
            api_key=key,
            http_client=http,
            default_headers={"NVCF-POLL-SECONDS": "30"},
        )
        r = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "Reply with the single word pong."}],
            max_tokens=16,
            temperature=0,
        )
        text = ((r.choices[0].message.content if r.choices else None) or "").strip()
        os.environ["NIM_MODEL"] = model
        if not text:
            return False, f"{model} empty"
        return True, f"ok model={model} reply={text[:80]!r}"
    except Exception as e:
        last = f"{model} {type(e).__name__}: {e}"
    return False, last


def retry_wait(err: BaseException, attempt: int) -> float:
    """Honor Retry-After when present. Idle less than a flat 45s; same token budget."""
    headers = getattr(getattr(err, "response", None), "headers", None) or {}
    ra = None
    try:
        ra = headers.get("retry-after") or headers.get("Retry-After")
    except Exception:
        ra = None
    if ra is not None:
        try:
            return min(30.0, max(1.0, float(ra)))
        except (TypeError, ValueError):
            pass
    name = type(err).__name__
    blob = str(err)
    if "RateLimit" in name or "429" in blob:
        return min(20.0, 8.0 + 2.0 * attempt)
    return min(12.0, 2.0 ** attempt)


def persist_llm_judge(result_path: Path, judged: dict) -> None:
    raw = json.loads(result_path.read_text(encoding="utf-8"))
    avg = raw.setdefault("averaged_metrics", {})
    if judged.get("score") is not None:
        avg["llm_judge"] = judged["score"]
        avg["llm_judge_note"] = judged.get("note")
    labels = judged.get("labels")
    rows = raw.get("data") or []
    if isinstance(labels, list) and rows:
        for row, lab in zip(rows, labels):
            if lab is not None:
                row["llm_judge"] = lab
    result_path.write_text(json.dumps(raw, indent=4) + "\n", encoding="utf-8")


def nim_judge_lme(result_path: Path) -> dict:
    """Yes/no judge on existing outputs. Disclosed NIM judge, not gpt-4o. Resumes per-row."""
    load_eden_env()
    import httpx
    from openai import OpenAI

    raw = json.loads(result_path.read_text(encoding="utf-8"))
    rows = raw.get("data") or []
    key = os.environ.get("NVIDIA_API_KEY")
    base = os.environ.get("NVIDIA_BASE_URL")
    if not key or not base:
        return {"n": len(rows), "score": None, "note": "NIM LME judge failed: missing NVIDIA env"}
    http = httpx.Client(
        http2=False,
        timeout=httpx.Timeout(connect=15, read=45, write=20, pool=10),
    )
    try:
        client = OpenAI(
            base_url=base,
            api_key=key,
            http_client=http,
            default_headers={"NVCF-POLL-SECONDS": os.environ.get("NVCF_POLL_SECONDS", "30")},
        )
        model = os.environ.get("NIM_MODEL", NIM_MODEL)
        labels = []
        for i, row in enumerate(rows):
            existing = row.get("llm_judge")
            if existing in (0, 1, 0.0, 1.0):
                labels.append(float(existing))
                continue
            hyp = str(row.get("output") or "")
            ans = row.get("answer")
            if isinstance(ans, list):
                ans = ans[0] if ans else ""
            q = str(row.get("query") or "")
            prompt = (
                "I will give you a question, a correct answer, and a response from a model. "
                "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
                "If the response is equivalent to the correct answer or contains all the intermediate "
                "steps to get the correct answer, you should also answer yes. If the response only "
                "contains a subset of the information required by the answer, answer no.\n\n"
                f"Question: {q}\n\nCorrect Answer: {ans}\n\nModel Response: {hyp}\n\n"
                "Is the model response correct? Answer yes or no only."
            )
            label = None
            for attempt in range(8):
                try:
                    r = client.chat.completions.create(
                        model=model,
                        messages=[{"role": "user", "content": prompt}],
                        max_tokens=10,
                        temperature=0,
                    )
                    text = (r.choices[0].message.content or "").strip().lower()
                    label = 1.0 if "yes" in text else 0.0
                    break
                except Exception as e:
                    name = type(e).__name__
                    wait = retry_wait(e, attempt)
                    print(f"NIM judge retry {attempt + 1}/8 row={i}: {name} sleep={wait:.0f}s", flush=True)
                    time.sleep(wait)
            labels.append(label)
            if (i + 1) % 25 == 0 or i + 1 == len(rows):
                done = sum(1 for x in labels if x is not None)
                print(f"NIM judge {i + 1}/{len(rows)} labeled={done}", flush=True)
                if (i + 1) % 50 == 0:
                    persist_llm_judge(result_path, {
                        "score": (100.0 * (sum(x for x in labels if x is not None) / done)) if done else None,
                        "note": f"NIM {model} yes/no judge (not gpt-4o) partial {done}/{len(rows)}",
                        "labels": labels,
                    })
        ok = [x for x in labels if x is not None]
        if not ok:
            return {"n": len(rows), "score": None, "note": "NIM LME judge failed", "labels": labels}
        return {
            "n": len(ok),
            "score": 100.0 * (sum(ok) / len(ok)),
            "note": f"NIM {model} yes/no judge (not gpt-4o)",
            "path": str(result_path),
            "labels": labels,
        }
    finally:
        try:
            http.close()
        except Exception:
            pass


def mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def fmt(v) -> str:
    if v is None:
        return "FAIL/missing"
    if isinstance(v, float):
        return f"{v:.1f}"
    return str(v)


def write_results(state: dict, nim_ok: tuple[bool, str], started: float, cmd: str):
    leaves = state.setdefault("leaves", {})
    # Keep unselected leaves (EventQA 64 / FC-SH 54 / …) when an ICL-only argv rewrites this file.
    # Do not restore a leaf that this run already wrote (honest FAIL/None stays).
    for lid, row in parse_prior_results(RESULTS_PATH).items():
        if lid not in leaves:
            leaves[lid] = row
    def leaf(i):
        return leaves.get(i) or {}

    sh = leaf("sh").get("score")
    mh = leaf("mh").get("score")
    lme = leaf("lme").get("score")
    eventqa = leaf("eventqa").get("score")
    ar_vals = [v for v in (sh, mh, lme, eventqa) if isinstance(v, (int, float))]
    ar = mean(ar_vals) if len(ar_vals) == 4 else None

    icl_ids = ["icl_banking", "icl_clinic", "icl_nlu", "icl_trec_coarse", "icl_trec_fine"]
    icl_vals = [leaf(i).get("score") for i in icl_ids]
    mcc = mean([v for v in icl_vals if isinstance(v, (int, float))]) if all(isinstance(v, (int, float)) for v in icl_vals) else None
    rec = leaf("recsys").get("score")
    ttl = mean([mcc, rec]) if isinstance(mcc, (int, float)) and isinstance(rec, (int, float)) else None

    summ = leaf("summ").get("score")
    det = leaf("detqa").get("score")
    lru = mean([summ, det]) if isinstance(summ, (int, float)) and isinstance(det, (int, float)) else None

    fc_sh = leaf("fc_sh").get("score")
    fc_mh = leaf("fc_mh").get("score")
    sf = mean([fc_sh, fc_mh]) if isinstance(fc_sh, (int, float)) and isinstance(fc_mh, (int, float)) else None

    comps = [ar, ttl, lru, sf]
    overall = mean([c for c in comps if isinstance(c, (int, float))]) if all(isinstance(c, (int, float)) for c in comps) else None
    verdict = "LOSS"
    if overall is None:
        verdict = "FAIL/incomplete"
    elif overall > 41.6:
        verdict = "WIN vs HippoRAG-v2 41.6 (memory-agent row; not 4o-mini)"
    bar50 = "yes" if isinstance(overall, (int, float)) and overall >= 50 else "no"
    sf_sota = (
        "yes"
        if isinstance(fc_sh, (int, float)) and isinstance(fc_mh, (int, float)) and fc_sh >= 82 and fc_mh >= 27
        else "no"
    )
    day = time.strftime("%Y-%m-%d")

    lines = [
        "# MemoryAgentBench Table 3 — product inject + NIM",
        "",
        f"**Wave:** M37.2 (official inject re-bench after M16–M36). Command `/memory-wave` stays.",
        f"**Date:** {day}",
        f"**Verdict:** {verdict}",
        f"**Bar ≥50:** {bar50}. **SF SOTA:** {sf_sota} (need FC-SH ≥82 and FC-MH ≥27). **4o-mini Table 3 SOTA:** no (backbone is `{NIM_MODEL}`).",
        "**API under test:** `openMemory` inject (not BrainMemory retrieve).",
        f"**Reader / backbone:** NVIDIA NIM `{NIM_MODEL}` (disclosed — **not** GPT-4o-mini, **not** local models, **not** DeepSeek V4 Flash).",
        "**k:** 10. **labelStrip:** false. Official lengths only (EventQA 534k, FC 262k, SH 197k, MH 421k).",
        "**overall** = mean of AR / TTL / LRU / SF. A competency with a missing official-length leaf is FAIL/missing, not invented.",
        "",
        f"- NIM smoke: {'worked' if nim_ok[0] else 'FAILED'} — {nim_ok[1]}",
        f"- Command: `{cmd}`",
        f"- Elapsed: {time.time() - started:.0f}s",
        f"- Config: `benchmarks/memoryagentbench/table3-inject.config.json`",
        "",
        "## Competency averages",
        "",
        "| Competency | Score | Formula |",
        "|---|---:|---|",
        f"| AR | {fmt(ar)} | mean(SH, MH, MAB-LME, EventQA) |",
        f"| TTL | {fmt(ttl)} | mean(MCC, Recsys) |",
        f"| LRU | {fmt(lru)} | mean(Summ, DetQA) only if both exist; missing named not zeroed |",
        f"| SF | {fmt(sf)} | mean(FC-SH, FC-MH) |",
        f"| **overall** | **{fmt(overall)}** | mean(AR, TTL, LRU, SF) |",
        "",
        "## Leaves",
        "",
        "| Leaf | Official length | n | metric | score | status |",
        "|---|---:|---:|---|---:|---|",
    ]
    for spec in LEAVES:
        row = leaf(spec["id"])
        status = row.get("status", "not-run")
        n = row.get("n", "")
        score = row.get("score")
        note = row.get("note") or ""
        extra = f" {note}" if note and note not in str(status) else ""
        lines.append(
            f"| {spec['id']} | {spec['length']} | {n} | {spec['metric']} | {fmt(score) if score is not None else '—'} | {status}{extra} |"
        )
    lines += [
        "",
        "## MCC (five ICL leaves, k=10, no label strip)",
        "",
        f"MCC avg: {fmt(mcc)} (requires all five ICL leaves).",
        "",
        "## Honesty",
        "",
        "- Do not compare this column to GPT-4o-mini Table 3 without naming the backbone.",
        "- Legacy `mab-bridge.ts` / `eden.py` BrainMemory numbers are **not-product**.",
        "- LoCoMo 92, k=40, Memorable 454/454, EventQA-64k, FC-6k are not this exam.",
        "- AR = mean(SH, MH, MAB-LME, EventQA) only; missing named not zeroed.",
        "- LRU vs Claude 49.6 requires ≥46; else concede. Do not claim overall ≥50 without it. See `LRU-M30.md`.",
        "",
    ]
    RESULTS_PATH.write_text("\n".join(lines), encoding="utf-8")


def archive_leaf_results(spec: dict) -> None:
    """MAB `--force` still skips queries when *_results.json has last_processed_query_id.
    `--force-all` must move that file so ingest+query actually re-run. Archive dir is
    ignored by find_result_json (`archive` in path parts)."""
    try:
        sub = yaml_sub_dataset(spec["yaml"])
        out = find_result_json(sub)
        if out is None or not out.is_file():
            return
        dest_dir = out.parent / "archive"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{out.stem}.pre-force{out.suffix}"
        n = 1
        while dest.exists():
            dest = dest_dir / f"{out.stem}.pre-force-{n}{out.suffix}"
            n += 1
        out.rename(dest)
        print(f"archived stale {out} → {dest}", flush=True)
    except Exception as e:
        print(f"archive skip: {type(e).__name__}: {e}", flush=True)


def generate_leaf(spec: dict, env: dict) -> dict:
    yaml_rel = spec["yaml"]
    print(f"\n========== {spec['id']} {yaml_rel} ==========\n", flush=True)
    if "--force-all" in sys.argv:
        archive_leaf_results(spec)
    cmd = [
        sys.executable,
        "main.py",
        "--force",
        "--agent_config",
        str(AGENT_YAML),
        "--dataset_config",
        yaml_rel,
    ]
    try:
        r = subprocess.run(cmd, cwd=str(MAB), env=env)
        sub = yaml_sub_dataset(yaml_rel)
        out = find_result_json(sub)
        if out is None:
            return {
                "status": f"FAIL exit={r.returncode} (no results json)",
                "n": 0,
                "score": None,
            }
        parsed = extract_score(out, spec["metric"])
        parsed["path"] = str(out)
        if r.returncode != 0 and parsed.get("n"):
            parsed["status"] = f"partial exit={r.returncode}"
        elif r.returncode != 0:
            parsed["status"] = f"FAIL exit={r.returncode}"
        return parsed
    except Exception as e:
        return {"status": f"FAIL {type(e).__name__}: {e}", "n": 0, "score": None, "trace": traceback.format_exc()[-2000:]}


def apply_judge(spec: dict, parsed: dict) -> dict:
    """NIM judge on generated rows. Same prompts/n; overlapping next-leaf CPU flush is free wall-clock."""
    if spec["metric"] != "llm_judge":
        parsed["status"] = parsed.get("status") or ("ok" if parsed.get("score") is not None else "FAIL/missing metric")
        return parsed
    if parsed.get("score") is not None:
        parsed["status"] = parsed.get("status") or "ok"
        if spec["id"] == "summ":
            parsed["note"] = parsed.get("note") or "NIM yes/no judge (not gpt-4o HELMET)"
        return parsed
    if not parsed.get("n") or not parsed.get("path"):
        parsed["status"] = parsed.get("status") or "FAIL/missing judge"
        return parsed
    out = Path(parsed["path"])
    judged = nim_judge_lme(out)
    persist_llm_judge(out, judged)
    parsed.update(judged)
    parsed["status"] = "ok" if judged.get("score") is not None else "FAIL/missing judge"
    if spec["id"] == "summ" and judged.get("score") is not None:
        parsed["note"] = "NIM yes/no judge (not gpt-4o HELMET)"
    return parsed


def run_leaf(spec: dict, env: dict) -> dict:
    return apply_judge(spec, generate_leaf(spec, env))


def main():
    started = time.time()
    argv = " ".join(sys.argv[1:])
    cmd = f"{sys.executable} {Path(__file__).name}" + (f" {argv}" if argv else "")
    write_protocol_config()
    load_eden_env()
    nim_ok = nim_smoke()
    print("NIM smoke:", nim_ok, flush=True)

    if not MAB.is_dir():
        state = {"leaves": seed_leaves()}
        write_results(state, nim_ok, started, cmd)
        print("Official clone missing at /tmp/MemoryAgentBench", flush=True)
        return 1

    overlay_agent()
    write_agent_yaml()

    env = os.environ.copy()
    env["EDEN_ROOT"] = str(EDEN)
    env["EDEN_BRIDGE"] = str(HERE / "inject-bridge.ts")
    env["EDEN_MEMORY_CAP"] = "10"
    env["EDEN_MEMORY_STORE_CAP"] = "50000"
    env["PYTHONUNBUFFERED"] = "1"
    env.setdefault("NIM_MODEL", NIM_MODEL)
    env.setdefault("NIM_READ_TIMEOUT", "180")
    env.setdefault("NVCF_POLL_SECONDS", "120")

    for spec in LEAVES:
        n = THOROUGH_N.get(spec["id"])
        if n:
            bump_yaml_samples(spec["yaml"], n)

    # Hydrate every Table 3 leaf before any write. `--force-all icl_*` must not blank EventQA/FC/SH.
    state = {"leaves": seed_leaves()}
    write_results(state, nim_ok, started, cmd)

    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    def selected(spec: dict) -> bool:
        if not only:
            return True
        return any(x == spec["id"] or x == spec["yaml"] or spec["yaml"].endswith(x) for x in only)

    jobs = [s for s in LEAVES if selected(s)]
    force_all = "--force-all" in sys.argv
    pending: tuple[dict, Future] | None = None

    def settle(job: tuple[dict, Future] | None) -> None:
        if not job:
            return
        spec, fut = job
        row = fut.result()
        state["leaves"][spec["id"]] = row
        write_results(state, nim_ok, started, cmd)
        print(f"leaf {spec['id']}: {row.get('status')} n={row.get('n')} score={row.get('score')}", flush=True)

    with ThreadPoolExecutor(max_workers=1) as pool:
        for spec in jobs:
            prior = None if force_all else hydrate_leaf(spec)
            if prior and leaf_done(spec, prior):
                state["leaves"][spec["id"]] = prior
                write_results(state, nim_ok, started, cmd)
                print(f"leaf {spec['id']}: skip-complete n={prior.get('n')} score={prior.get('score')}", flush=True)
                continue
            # Generate while a previous llm_judge still runs (flush is CPU; judge is NIM).
            row = generate_leaf(spec, env)
            if spec["metric"] == "llm_judge" and row.get("n") and row.get("score") is None:
                settle(pending)
                pending = (spec, pool.submit(apply_judge, spec, row))
                state["leaves"][spec["id"]] = {**row, "status": row.get("status") or "needs NIM judge"}
                write_results(state, nim_ok, started, cmd)
                print(f"leaf {spec['id']}: judging n={row.get('n')} (next leaf may overlap)", flush=True)
                continue
            row = apply_judge(spec, row)
            state["leaves"][spec["id"]] = row
            write_results(state, nim_ok, started, cmd)
            print(f"leaf {spec['id']}: {row.get('status')} n={row.get('n')} score={row.get('score')}", flush=True)
        settle(pending)

    write_results(state, nim_ok, started, cmd)
    print("Wrote", RESULTS_PATH, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
