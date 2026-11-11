"""M1 (D893, D894): the student as a lab endpoint, and its latency on each GPU. Lab tooling, not product code.

The endpoint loads a trained run's adapter (Volume `eden-checker`, `/runs/<run>/adapter`) on its base, merged, and
scores a push's pool as training did (`m1_student._score`: the chat template, log P(yes) - log P(no) at the answer's
first token). With `prefix` on (the default) the shared head of every item's prompt (instructions, day, request) is
run once and its keys and values reused for the pool's items; `bench` checks that this gives training's scores.

    # latency on a GPU, plain against prefix-shared, 15-item pools, and the two modes' largest score difference:
    modal run packages/sim/modal/m1_serve.py::bench --data .local/m1/data/train-truth.jsonl --run t8b-truth-a --gpu L4
    # the endpoint (POST /score {"request","today","items":[{"title","text"}]} -> {"scores":[...]}, bearer key):
    EDEN_M1_RUN=t8b-truth-a EDEN_M1_GPU=L4 EDEN_LAB_CHECKER_KEY=$(openssl rand -hex 24) \
        modal deploy packages/sim/modal/m1_serve.py
    modal app stop -y eden-m1-checker                                                    # when done

The key reaches the app only as an ephemeral `Secret.from_dict` from the deploying shell (as cards_distill.py's):
nothing is stored in the workspace, and the endpoint refuses to serve without one.
"""
import json
import os
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import m1_data as d  # noqa: E402

# The endpoint's settings, from the deploying shell, are baked into the image env: the container imports this module
# without that shell's environment, and the class below is defined only when the run is named.
SERVE_ENV = {k: os.environ[k] for k in ("EDEN_M1_RUN", "EDEN_M1_GPU", "EDEN_M1_MIN", "EDEN_M1_MAX") if k in os.environ}
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "transformers==4.56.2", "peft==0.17.1", "accelerate==1.10.1", "numpy==2.3.3",
                 "hf_transfer==0.1.9", "fastapi[standard]==0.118.0")
    .env({"HF_HOME": "/vol/hf", "HF_HUB_ENABLE_HF_TRANSFER": "1", "TOKENIZERS_PARALLELISM": "false", **SERVE_ENV})
    .add_local_python_source("m1_data")
)
vol = modal.Volume.from_name("eden-checker", create_if_missing=True)
app = modal.App("eden-m1-checker", image=image)
SPLIT = "<item>\n"


class Student:
    """A trained run, merged, scoring pools; `prefix` reuses the shared prompt head's keys and values."""

    def __init__(self, run):
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        cfg = json.load(open(f"/vol/runs/{run}/cfg.json"))
        self.tok = AutoTokenizer.from_pretrained(cfg["base"])
        self.tok.padding_side = "left"
        model = AutoModelForCausalLM.from_pretrained(cfg["base"], dtype=torch.bfloat16, attn_implementation="sdpa")
        self.model = PeftModel.from_pretrained(model.cuda(), f"/vol/runs/{run}/adapter").merge_and_unload().eval()
        self.max_len = cfg["max_len"]

        def ids(words):
            return sorted({t[0] for w in words if len(t := self.tok.encode(w, add_special_tokens=False)) == 1})

        self.yes = ids(["yes", "Yes", " yes", " Yes", "YES"])
        self.no = ids(["no", "No", " no", " No", "NO"])

    def _text(self, row):
        return self.tok.apply_chat_template([{"role": "user", "content": d.render(row)}], tokenize=False,
                                            add_generation_prompt=True, enable_thinking=False)

    def _odds(self, hidden):
        import torch

        lp = torch.log_softmax(self.model.lm_head(hidden).float(), dim=-1)
        return (torch.logsumexp(lp[:, self.yes], -1) - torch.logsumexp(lp[:, self.no], -1)).cpu().tolist()

    def score_plain(self, rows):
        import torch

        enc = self.tok([self._text(r) for r in rows], return_tensors="pt", padding=True, truncation=True,
                       max_length=self.max_len).to("cuda")
        with torch.no_grad():
            h = self.model.model(input_ids=enc.input_ids, attention_mask=enc.attention_mask).last_hidden_state[:, -1]
            return self._odds(h)

    def score_prefix(self, rows):
        """One request's pool: the prompt head once, then every item's tail against its cached keys and values."""
        import torch

        texts = [self._text(r) for r in rows]
        head = texts[0][: texts[0].index(SPLIT) + len(SPLIT)]
        if not all(t.startswith(head) for t in texts):
            return self.score_plain(rows)
        hid = self.tok(head, return_tensors="pt", add_special_tokens=False).input_ids.cuda()
        tails = [self.tok(t[len(head):], add_special_tokens=False).input_ids for t in texts]
        n, p = len(rows), hid.shape[1]
        width = max(len(t) for t in tails)
        pad = self.tok.pad_token_id
        ids = torch.full((n, width), pad, dtype=torch.long)
        mask = torch.zeros((n, p + width), dtype=torch.long)
        mask[:, :p] = 1
        for i, t in enumerate(tails):  # right-padded: a row's padding comes after its last real token
            ids[i, : len(t)] = torch.tensor(t)
            mask[i, p : p + len(t)] = 1
        ids, mask = ids.cuda(), mask.cuda()
        pos = (torch.arange(width, device="cuda") + p).unsqueeze(0).expand(n, -1)
        with torch.no_grad():
            past = self.model.model(input_ids=hid, use_cache=True).past_key_values
            past.batch_repeat_interleave(n)
            out = self.model.model(input_ids=ids, attention_mask=mask, position_ids=pos, past_key_values=past,
                                   use_cache=True).last_hidden_state
            last = torch.tensor([len(t) - 1 for t in tails], device="cuda")
            return self._odds(out[torch.arange(n, device="cuda"), last])


def _pools(rows, k=15):
    by = {}
    for r in rows:
        by.setdefault(r["group"], []).append(r)
    return [g[:k] for g in by.values() if len(g) >= 2]


@app.function(gpu="L4", volumes={"/vol": vol}, timeout=3600)
def bench_remote(run: str, rows: list, pools: int) -> dict:
    import torch

    t0 = time.time()
    st = Student(run)
    load_s = round(time.time() - t0)
    ps = _pools(rows)[: pools + 3]
    out = {"load_s": load_s, "gpu": torch.cuda.get_device_name(0)}
    diffs = []
    for mode in ("plain", "prefix"):
        fn = st.score_plain if mode == "plain" else st.score_prefix
        ts = []
        for k, pool in enumerate(ps):
            torch.cuda.synchronize()
            t = time.perf_counter()
            s = fn(pool)
            torch.cuda.synchronize()
            if k >= 3:
                ts.append((time.perf_counter() - t) * 1000)
            if mode == "prefix":
                diffs += [abs(a - b) for a, b in zip(s, st.score_plain(pool))]
        out[mode] = {"p50_ms": round(d.quantile(ts, 0.5), 1), "p90_ms": round(d.quantile(ts, 0.9), 1),
                     "items_per_pool": round(sum(len(p) for p in ps[3:]) / max(1, len(ps) - 3), 1)}
    out["prefix_max_abs_diff"] = round(max(diffs), 4)
    out["prefix_mean_abs_diff"] = round(sum(diffs) / len(diffs), 4)
    return out


@app.local_entrypoint()
def bench(data: str, run: str, gpu: str = "L4", pools: int = 40):
    rows = [r for r in d.read_jsonl(data) if r["split"] == "eval"]
    res = bench_remote.with_options(gpu=gpu).remote(run, rows[: (pools + 3) * 40], pools)
    out = os.path.join(".local", "m1", "bench")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f"{run}-{gpu.replace(':', '_')}.json"), "w") as f:
        json.dump(res, f, indent=1)
    print(json.dumps(res, indent=1))


def _key_secret():
    return modal.Secret.from_dict({"EDEN_LAB_CHECKER_KEY": os.environ.get("EDEN_LAB_CHECKER_KEY", "")})


# Defined only when a run is named (`EDEN_M1_RUN=… modal deploy`): a web endpoint's label is unique per workspace.
if os.environ.get("EDEN_M1_RUN"):

    @app.cls(gpu=os.environ.get("EDEN_M1_GPU", "L4"), volumes={"/vol": vol}, secrets=[_key_secret()],
             scaledown_window=600, timeout=3600, min_containers=int(os.environ.get("EDEN_M1_MIN", "0")),
             max_containers=int(os.environ.get("EDEN_M1_MAX", "2")))
    class Checker:
        @modal.enter()
        def load(self):
            import threading

            if not os.environ.get("EDEN_LAB_CHECKER_KEY"):
                raise RuntimeError("EDEN_LAB_CHECKER_KEY was empty at deploy: the endpoint never serves without a key")
            self.student = Student(os.environ["EDEN_M1_RUN"])
            self.lock = threading.Lock()

        @modal.asgi_app()
        def web(self):
            import hmac

            from fastapi import FastAPI, HTTPException, Request

            api = FastAPI()
            key = os.environ["EDEN_LAB_CHECKER_KEY"]

            @api.post("/score")
            async def score(req: Request):
                auth = req.headers.get("authorization", "")
                if not hmac.compare_digest(auth, f"Bearer {key}"):
                    raise HTTPException(401, "bad key")
                body = await req.json()
                items = body.get("items") or []
                if not isinstance(items, list) or not 1 <= len(items) <= 20:
                    raise HTTPException(400, "items: 1 to 20")
                rows = [{"request": str(body.get("request", ""))[: d.REQUEST_CHARS],
                         "today": str(body.get("today", ""))[:10],
                         "title": str(it.get("title", ""))[:300], "text": str(it.get("text", ""))[: d.ITEM_CHARS],
                         "group": "q"} for it in items]
                t = time.perf_counter()
                with self.lock:
                    s = self.student.score_prefix(rows)
                return {"scores": [round(x, 4) for x in s], "ms": round((time.perf_counter() - t) * 1000, 1)}

            return api


# The teacher's soft scores over M2's pair groups (owner's request through the parent, D899): a scale-to-zero batch
# job, sharded by line number, each group scored as one pool with the shared prompt head. Reads and writes the Volume
# `eden-synth` (M2's); a group's line in `<name>.t8b.jsonl.gz` is {"group", "keys", "s"} in the group's item order.
synth_vol = modal.Volume.from_name("eden-synth")


@app.function(gpu="H100", volumes={"/vol": vol, "/synth": synth_vol}, timeout=6 * 3600)
def teacher_shard(run: str, path: str, shard: int, shards: int, limit: int = 0) -> dict:
    import gzip

    t0 = time.time()
    st = Student(run)
    out = f"/synth/{path}.t8b.part-{shard:03d}-of-{shards:03d}.jsonl.gz"
    n = items = 0
    with open(f"/synth/{path}") as f, gzip.open(out, "wt") as w:
        for i, line in enumerate(f):
            if i % shards != shard:
                continue
            if limit and n >= limit:
                break
            g = json.loads(line)
            rows = [{"request": g["request"], "today": g.get("today", ""), "title": it.get("title", ""),
                     "text": it.get("text", ""), "group": g["group"]} for it in g["items"]]
            s = []
            for k in range(0, len(rows), 20):
                s += st.score_prefix(rows[k : k + 20])
            w.write(json.dumps({"line": i, "group": g["group"], "keys": [it["key"] for it in g["items"]],
                                "s": [round(x, 4) for x in s]}) + "\n")
            n += 1
            items += len(rows)
    synth_vol.commit()
    return {"shard": shard, "groups": n, "items": items, "seconds": round(time.time() - t0)}


@app.function(volumes={"/synth": synth_vol}, timeout=3600)
def teacher_merge(path: str, shards: int) -> dict:
    """The shards' parts into `<name>.t8b.jsonl.gz` in the pair groups' own line order; the parts are removed."""
    import gzip

    synth_vol.reload()
    rows = []
    for k in range(shards):
        p = f"/synth/{path}.t8b.part-{k:03d}-of-{shards:03d}.jsonl.gz"
        with gzip.open(p, "rt") as f:
            rows += [json.loads(x) for x in f]
    rows.sort(key=lambda r: r["line"])
    out = f"/synth/{path.removesuffix('.jsonl')}.t8b.jsonl.gz"
    with gzip.open(out, "wt") as w:
        for r in rows:
            w.write(json.dumps({"group": r["group"], "keys": r["keys"], "s": r["s"]}) + "\n")
    for k in range(shards):
        os.remove(f"/synth/{path}.t8b.part-{k:03d}-of-{shards:03d}.jsonl.gz")
    synth_vol.commit()
    return {"path": out, "groups": len(rows)}


@app.local_entrypoint()
def teacher(path: str, run: str = "t8b-truth-a", shards: int = 8, limit: int = 0, merge: bool = True):
    """`--limit N` scores N groups a shard (a timing probe; nothing merged)."""
    res = list(teacher_shard.starmap([(run, path, k, shards, limit) for k in range(shards)]))
    print(json.dumps(res))
    if merge and not limit:
        print(json.dumps(teacher_merge.remote(path, shards)))


@app.function(gpu="H100", volumes={"/vol": vol}, timeout=3 * 3600)
def score_pools_remote(run: str, pools: list) -> list:
    """Each pool ({request, today, items: [{title, text}]}) scored as one pool with the shared head (a batch job)."""
    st = Student(run)
    out = []
    for p in pools:
        rows = [{"request": p["request"], "today": p.get("today", ""), "title": it.get("title", ""),
                 "text": it.get("text", ""), "group": "q"} for it in p["items"]]
        s = []
        for k in range(0, len(rows), 20):
            s += st.score_prefix(rows[k : k + 20])
        out.append([round(x, 4) for x in s])
    return out


@app.local_entrypoint()
def score_pools(pools: str, run: str, out: str, gpu: str = "H100"):
    """`pools`: a JSONL of {request, today, items}; writes one JSON list of scores a line to `out`, same order."""
    ps = d.read_jsonl(pools)
    res = score_pools_remote.with_options(gpu=gpu).remote(run, ps)
    with open(out, "w") as f:
        for s in res:
            f.write(json.dumps(s) + "\n")
    print(f"{len(res)} pools scored by {run} -> {out}")
