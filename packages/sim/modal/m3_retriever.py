"""M3 (D900-D909, docs/research/m3-retriever.md): a small retriever trained on Eden's own question, "which held item
bears on this request?", on a Modal GPU. Lab tooling, not product code. Families:

- `dense`: a bi-encoder (query and item vectors, cosine), fine-tuned with each request's planted item as the positive
  and hard negatives (its decoy twin, other templates' facts and decoys in the same world, lexical look-alikes);
- `sparse`: inference-free learned sparse retrieval: items expanded at ingest by an MLM head (log(1 + relu), max over
  tokens), a request scored by its own tokens' learned weights alone (no model at request time);
- `rerank`: a cross-encoder over a candidate list (scored on the eval's lexical pool joined with a first stage).

Training data is `m3-export.ts`'s worlds (simulated); the eval is m3r/prep.py's file (the days users' and the short
worlds' requests with their lexical pools). Both live on the Volume `eden-retriever` (`--upload`). A run trains on
the named suites only and returns each eval request's top 100 item ids; scoring is local (m3r/score.py).

    modal run packages/sim/modal/m3_retriever.py --upload .local/m3/d       # train-worlds.jsonl.gz, eval.jsonl.gz
    modal run packages/sim/modal/m3_retriever.py --family dense --base BAAI/bge-small-en-v1.5 --suites train1,train2,train3,train4 --run d1
"""
import json
import os
import time

import modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "transformers==4.56.2", "numpy==2.3.3", "scikit-learn==1.7.2",
                 "huggingface_hub==0.35.3", "onnx==1.19.0", "onnxscript==0.5.4")
    .env({"HF_HOME": "/vol/hf"})
)
vol = modal.Volume.from_name("eden-retriever", create_if_missing=True)
app = modal.App("eden-m3-retriever", image=image)
TOP = 100


def worlds(path):
    import gzip
    with gzip.open(path, "rt") as f:
        for line in f:
            yield json.loads(line)


def item_text(it):
    return f"{it['title']}\n{it['text']}"


def build_examples(suites, n_neg, seed=7, max_seeds=0, files=("train-worlds.jsonl.gz",)):
    """Per world, one example a task of the named suites: (request, positive, negatives, template). Negatives: the
    decoy twin first, then a draw from the world's other facts and decoys and from its base items, both by TF-IDF
    likeness to the request (the look-alikes over a user's days, D712)."""
    import numpy as np
    from sklearn.feature_extraction.text import TfidfVectorizer

    rng = np.random.default_rng(seed)
    out = []
    stream = (w for name in files for wi, w in enumerate(worlds(f"/vol/data/{name}")) if not max_seeds or wi < max_seeds)
    for w in stream:
        # Facts and decoys of suites not trained on (the held-out families) leave the world: no held-out text is seen.
        away = {x for t in w["tasks"] if t["suite"] not in suites for x in (t["pos"], t["decoy"])}
        items = [i for i in w["items"] if i["id"] not in away]
        texts = [item_text(i) for i in items]
        idx = {i["id"]: k for k, i in enumerate(items)}
        planted = {t["pos"] for t in w["tasks"]} | {t["decoy"] for t in w["tasks"]}
        tasks = [t for t in w["tasks"] if t["suite"] in suites and t["pos"] in idx]
        if not tasks:
            continue
        vec = TfidfVectorizer(sublinear_tf=True, min_df=1).fit(texts)
        D = vec.transform(texts)
        Q = vec.transform([t["request"] for t in tasks])
        S = (Q @ D.T).toarray()
        is_planted = np.array([i["id"] in planted for i in items])
        group = []
        for qi, t in enumerate(tasks):
            own = {idx[t["pos"]], idx.get(t["decoy"], -1)}
            order = np.argsort(-S[qi])
            look = [k for k in order[:60] if is_planted[k] and k not in own][:12]
            base = [k for k in order[:60] if not is_planted[k] and k not in own][:12]
            negs = [idx[t["decoy"]]] if t["decoy"] in idx else []
            pick = list(rng.permutation(look))[: max(0, (n_neg - len(negs)) // 2)]
            pick += list(rng.permutation(base))[: n_neg - len(negs) - len(pick)]
            negs += pick
            # Every example gets exactly n_neg negatives (the loss's groups are fixed-size): random items fill a gap.
            while len(negs) < n_neg:
                k = int(rng.integers(len(items)))
                if k not in own and k not in negs:
                    negs.append(k)
            negs = negs[:n_neg]
            group.append({"q": t["request"], "pos": texts[idx[t["pos"]]], "neg": [texts[k] for k in negs],
                          "tpl": f"{t['suite']}/{t['template']}"})
        rng.shuffle(group)
        out.append(group)
    return out


def batches(groups, size, rng):
    """Batches of one world's tasks (distinct templates, so in-batch items are true negatives), in random order."""
    bs = [g[i : i + size] for g in groups for i in range(0, len(g), size)]
    rng.shuffle(bs)
    return bs


# ---------------------------------------------------------------------------------------------------------------- dense
def dense_encoder(base):
    import torch
    from transformers import AutoModel, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(base)
    model = AutoModel.from_pretrained(base).cuda()

    def enc(texts, max_len, grad=False):
        b = tok(texts, truncation=True, max_length=max_len, padding=True, return_tensors="pt").to("cuda")
        with torch.set_grad_enabled(grad), torch.autocast("cuda", dtype=torch.bfloat16):
            h = model(**b).last_hidden_state
        m = b["attention_mask"].unsqueeze(-1).float()
        v = (h.float() * m).sum(1) / m.sum(1).clamp(min=1)  # mean pooling
        return torch.nn.functional.normalize(v, dim=-1)

    return tok, model, enc


def static_query(tok, model):
    """`asym`'s query side: a learned vector a WordPiece token (initialised from the model's input embeddings), the
    request's tokens averaged with a learned weight each: a table lookup at request time, no network."""
    import torch

    emb = model.get_input_embeddings().weight.detach().clone().float()
    table = torch.nn.EmbeddingBag.from_pretrained(emb, freeze=False, mode="sum").cuda()
    weight = torch.nn.Parameter(torch.ones(emb.shape[0], device="cuda"))
    special = set(tok.all_special_ids)

    def query(texts, grad=True):
        ids, offs = [], []
        for t in tok(texts, truncation=True, max_length=64, add_special_tokens=False)["input_ids"]:
            offs.append(len(ids))
            ids += [i for i in t if i not in special] or [tok.unk_token_id]
        ids_t = torch.tensor(ids, device="cuda")
        with torch.set_grad_enabled(grad):
            v = table(ids_t, torch.tensor(offs, device="cuda"), per_sample_weights=torch.relu(weight[ids_t]))
            return torch.nn.functional.normalize(v, dim=-1)

    return table, weight, query


BIGRAMS = 1 << 18


def bag_items(tok, model):
    """`bag`'s item side: a learned vector a WordPiece token and a hashed bigram bucket, weighted per entry, summed,
    then a two-layer MLP: no transformer at ingest either (a lookup, a sum and two small matrix products)."""
    import torch

    emb = model.get_input_embeddings().weight.detach().clone().float()
    dim = emb.shape[1]
    uni = torch.nn.EmbeddingBag.from_pretrained(emb, freeze=False, mode="sum").cuda()
    bi = torch.nn.EmbeddingBag(BIGRAMS, dim, mode="sum").cuda()
    torch.nn.init.normal_(bi.weight, std=0.01)
    uw = torch.nn.Parameter(torch.ones(emb.shape[0], device="cuda"))
    mlp = torch.nn.Sequential(torch.nn.Linear(dim, 2 * dim), torch.nn.GELU(), torch.nn.Linear(2 * dim, dim)).cuda()
    special = set(tok.all_special_ids)

    def enc(texts, max_len, grad=False):
        u_ids, u_off, b_ids, b_off = [], [], [], []
        for t in tok(texts, truncation=True, max_length=max_len, add_special_tokens=False)["input_ids"]:
            t = [i for i in t if i not in special] or [tok.unk_token_id]
            u_off.append(len(u_ids))
            u_ids += t
            b_off.append(len(b_ids))
            b_ids += [(a * 1_000_003 + b) % BIGRAMS for a, b in zip(t, t[1:])] or [0]
        with torch.set_grad_enabled(grad):
            ui = torch.tensor(u_ids, device="cuda")
            v = uni(ui, torch.tensor(u_off, device="cuda"), per_sample_weights=torch.relu(uw[ui]))
            v = v + bi(torch.tensor(b_ids, device="cuda"), torch.tensor(b_off, device="cuda"))
            v = v + mlp(torch.nn.functional.layer_norm(v, (dim,)))
            return torch.nn.functional.normalize(v, dim=-1)

    return enc, list(uni.parameters()) + list(bi.parameters()) + [uw] + list(mlp.parameters())


# --------------------------------------------------------------------------------------------------------------- sparse
def sparse_encoder(base):
    """Doc side: MLM logits -> log(1 + relu) -> max over tokens. Query side: learned weight per token id (from the
    model's idf.json when it has one), the request's distinct tokens only: no model at request time."""
    import torch
    from huggingface_hub import hf_hub_download
    from transformers import AutoModelForMaskedLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(base)
    model = AutoModelForMaskedLM.from_pretrained(base).cuda()
    V = model.config.vocab_size
    w0 = torch.ones(V)
    try:
        idf = json.load(open(hf_hub_download(base, "idf.json")))
        for t, x in idf.items():
            i = tok.convert_tokens_to_ids(t)
            if i is not None and 0 <= i < V:
                w0[i] = float(x)
    except Exception:
        pass
    qw = torch.nn.Parameter(w0.cuda())
    special = torch.tensor(tok.all_special_ids, device="cuda")

    def doc(texts, max_len, grad=False):
        b = tok(texts, truncation=True, max_length=max_len, padding=True, return_tensors="pt").to("cuda")
        with torch.set_grad_enabled(grad), torch.autocast("cuda", dtype=torch.bfloat16):
            logits = model(**b).logits
        x = torch.log1p(torch.relu(logits.float())) * b["attention_mask"].unsqueeze(-1)
        v = x.max(1).values
        v[:, special] = 0
        return v

    def query(texts, max_len=64):
        b = tok(texts, truncation=True, max_length=max_len, add_special_tokens=False)
        q = torch.zeros(len(texts), V, device="cuda")
        for r, ids in enumerate(b["input_ids"]):
            if ids:
                t = torch.tensor(sorted(set(ids)), device="cuda")
                q[r, t] = 1.0
        return q * torch.relu(qw)

    return tok, model, doc, query, qw


@app.function(gpu=["L4", "A10G"], volumes={"/vol": vol}, timeout=4 * 3600)
def rerank_remote(base: str, suites: list, run: str, epochs: float, lr: float, batch: int, n_neg: int, max_len: int,
                  cands: dict, max_seeds: int, files: list) -> dict:
    """`rerank`: a cross-encoder trained listwise (each request's positive against its hard negatives, cross-entropy
    over the group), then each eval request's candidates (`cands`: rid -> ids) re-ordered by its score."""
    import numpy as np
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    t0 = time.time()
    torch.manual_seed(7)
    rng = np.random.default_rng(7)
    groups = build_examples(set(suites), n_neg, max_seeds=max_seeds, files=files) if epochs > 0 else []
    tok = AutoTokenizer.from_pretrained(base)
    model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=1).cuda()

    def score(qs, ds, grad=False):
        b = tok(qs, ds, truncation="only_second", max_length=max_len, padding=True, return_tensors="pt").to("cuda")
        with torch.set_grad_enabled(grad), torch.autocast("cuda", dtype=torch.bfloat16):
            return model(**b).logits.squeeze(-1).float()

    log = []
    if epochs > 0:
        opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
        total = int(sum((len(g) + batch - 1) // batch for g in groups) * epochs)
        sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, s / max(1, total // 20)) * max(0.0, 1 - s / total))
        model.train()
        step = 0
        while step < total:
            for b in batches(groups, batch, rng):
                if step >= total:
                    break
                qs, ds = [], []
                for e in b:
                    for d in [e["pos"]] + e["neg"]:
                        qs.append(e["q"]); ds.append(d)
                s = score(qs, ds, grad=True).view(len(b), 1 + n_neg)
                loss = torch.nn.functional.cross_entropy(s, torch.zeros(len(b), dtype=torch.long, device="cuda"))
                opt.zero_grad(); loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step(); sched.step()
                if step % 100 == 0:
                    log.append({"step": step, "loss": round(float(loss), 4), "s": round(time.time() - t0)})
                    print(log[-1], flush=True)
                step += 1
    t_train = time.time() - t0
    model.eval()
    out_dir = f"/vol/models/{run}"
    os.makedirs(out_dir, exist_ok=True)
    model.save_pretrained(out_dir); tok.save_pretrained(out_dir)
    ranks = []
    for w in worlds("/vol/data/eval.jsonl.gz"):
        text = {i["id"]: i["text"] for i in w["items"]}
        for r in w["requests"]:
            ids = [x for x in cands.get(r["rid"], []) if x in text]
            if not ids:
                continue
            sc = []
            for i in range(0, len(ids), 64):
                sc += score([r["request"]] * len(ids[i : i + 64]), [text[x] for x in ids[i : i + 64]]).tolist()
            order = sorted(range(len(ids)), key=lambda k: -sc[k])
            ranks.append({"rid": r["rid"], "top": [ids[k] for k in order], "score": [round(sc[k], 4) for k in order]})
    meta = {"family": "rerank", "base": base, "suites": suites, "run": run, "epochs": epochs, "lr": lr,
            "batch": batch, "n_neg": n_neg, "max_len": max_len, "examples": sum(len(g) for g in groups),
            "train_s": round(t_train), "total_s": round(time.time() - t0), "gpu": torch.cuda.get_device_name(0),
            "log": log}
    json.dump(meta, open(f"{out_dir}/meta.json", "w"), indent=1)
    vol.commit()
    return {"meta": meta, "ranks": ranks}


@app.function(gpu=["L4", "A10G"], volumes={"/vol": vol}, timeout=4 * 3600)
def train_remote(family: str, base: str, suites: list, run: str, epochs: float, lr: float, batch: int, n_neg: int,
                 max_len: int, flops: float, max_seeds: int, temp: float, files: list,
                 table_lr: float = 1e-3) -> dict:
    import numpy as np
    import torch

    t0 = time.time()
    torch.manual_seed(7)
    rng = np.random.default_rng(7)
    groups = build_examples(set(suites), n_neg, max_seeds=max_seeds, files=files) if epochs > 0 else []
    n_ex = sum(len(g) for g in groups)
    t_data = time.time() - t0
    log = []
    if family == "dense":
        tok, model, enc = dense_encoder(base)
        params = list(model.parameters())
        score_q = lambda qs: enc(qs, 64, grad=True)  # noqa: E731
        score_d = lambda ds: enc(ds, max_len, grad=True)  # noqa: E731
    elif family == "asym":
        tok, model, enc = dense_encoder(base)
        table, qweight, squery = static_query(tok, model)
        params = list(model.parameters()) + list(table.parameters()) + [qweight]
        groups_lr = [{"params": list(model.parameters())},
                     {"params": list(table.parameters()) + [qweight], "lr": table_lr}]
        score_q = squery
        score_d = lambda ds: enc(ds, max_len, grad=True)  # noqa: E731
    elif family == "bag":
        tok, model, _enc = dense_encoder(base)
        table, qweight, squery = static_query(tok, model)
        enc, bag_params = bag_items(tok, model)
        model = model.cpu()  # the transformer is not used: only its vocabulary's embeddings seeded the tables
        params = bag_params + list(table.parameters()) + [qweight]
        groups_lr = [{"params": params, "lr": table_lr}]
        score_q = squery
        score_d = lambda ds: enc(ds, max_len, grad=True)  # noqa: E731
    elif family == "sparse":
        tok, model, doc, query, qw = sparse_encoder(base)
        params = list(model.parameters()) + [qw]
        score_q = query
        score_d = lambda ds: doc(ds, max_len, grad=True)  # noqa: E731
    else:
        raise ValueError(family)
    if epochs > 0:
        opt = torch.optim.AdamW(groups_lr if family in ("asym", "bag") else params, lr=lr, weight_decay=0.01)
        steps_per = sum((len(g) + batch - 1) // batch for g in groups)
        total = int(steps_per * epochs)
        sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, s / max(1, total // 20)) * max(0.0, 1 - s / total))
        model.train()
        step = 0
        while step < total:
            for b in batches(groups, batch, rng):
                if step >= total:
                    break
                docs = []
                for e in b:
                    docs += [e["pos"]] + e["neg"]
                q = score_q([e["q"] for e in b])
                d = score_d(docs)
                s = (q @ d.T) / (temp if family in ("dense", "asym", "bag") else 1.0)
                k = 1 + n_neg
                target = torch.arange(len(b), device=s.device) * k
                loss = torch.nn.functional.cross_entropy(s, target)
                if family == "sparse" and flops > 0:
                    # FLOPS regulariser (SPLADE): keeps item expansions short, so the index stays small.
                    loss = loss + flops * min(1.0, step / max(1, total // 3)) * (d.abs().mean(0) ** 2).sum()
                opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                sched.step()
                if step % 100 == 0:
                    log.append({"step": step, "loss": round(float(loss), 4), "s": round(time.time() - t0)})
                    print(log[-1], flush=True)
                step += 1
    t_train = time.time() - t0 - t_data
    model.eval()
    out_dir = f"/vol/models/{run}"
    os.makedirs(out_dir, exist_ok=True)
    model.save_pretrained(out_dir)
    tok.save_pretrained(out_dir)
    if family == "sparse":
        torch.save(qw.detach().cpu(), f"{out_dir}/query_weights.pt")
    if family in ("asym", "bag"):
        torch.save({"table": table.weight.detach().cpu(), "weight": qweight.detach().cpu()}, f"{out_dir}/query_table.pt")
    if family == "bag":
        torch.save([p.detach().cpu() for p in bag_params], f"{out_dir}/bag_items.pt")
    # Eval: every eval world's items ranked for each of its requests; the top TOP ids come back.
    ranks, nnz, ws = [], [], 0
    with torch.no_grad():
        for w in worlds("/vol/data/eval.jsonl.gz"):
            ws += 1
            texts = [i["text"] for i in w["items"]]
            ids = [i["id"] for i in w["items"]]
            reqs = [r["request"] for r in w["requests"]]
            if not reqs:
                continue
            if family in ("dense", "asym", "bag"):
                D = torch.cat([enc(texts[i : i + 256], max_len) for i in range(0, len(texts), 256)])
                Q = enc(reqs, 64) if family == "dense" else squery(reqs, grad=False)  # asym, bag: the table
                S = Q @ D.T
            else:
                rows = []
                for i in range(0, len(texts), 128):
                    v = doc(texts[i : i + 128], max_len)
                    nnz.append(float((v > 0).sum(1).float().mean()))
                    rows.append(v.to_sparse())
                D = torch.cat([r.to_dense() for r in rows])
                Q = query(reqs)
                S = Q @ D.T
            top = torch.topk(S, min(TOP, S.shape[1]), dim=1)
            for r, ix, sc in zip(w["requests"], top.indices.tolist(), top.values.tolist()):
                ranks.append({"rid": r["rid"], "top": [ids[i] for i in ix], "score": [round(x, 4) for x in sc]})
    with open(f"{out_dir}/ranks.jsonl", "w") as f:
        for r in ranks:
            f.write(json.dumps(r) + "\n")
    meta = {"family": family, "base": base, "suites": suites, "files": files, "run": run, "epochs": epochs, "lr": lr, "batch": batch,
            "n_neg": n_neg, "max_len": max_len, "flops": flops, "temp": temp, "examples": n_ex,
            "data_s": round(t_data), "train_s": round(t_train), "total_s": round(time.time() - t0), "eval_worlds": ws,
            "doc_nnz_mean": round(sum(nnz) / len(nnz), 1) if nnz else None, "gpu": torch.cuda.get_device_name(0),
            "log": log}
    json.dump(meta, open(f"{out_dir}/meta.json", "w"), indent=1)
    vol.commit()
    return {"meta": meta, "ranks": ranks}


@app.function(gpu=["L4", "A10G"], volumes={"/vol": vol}, timeout=2 * 3600)
def rank_remote(family: str, run: str, eval_name: str, max_len: int = 256) -> list:
    """A trained run's model (`/vol/models/<run>`) ranking another eval file's worlds: no training."""
    import torch

    d = f"/vol/models/{run}"
    if family == "asym":
        tok, model, enc = dense_encoder(d)
        table, qweight, squery = static_query(tok, model)
        saved = torch.load(f"{d}/query_table.pt")
        table.weight.data.copy_(saved["table"].cuda())
        qweight.data.copy_(saved["weight"].cuda())
        query = lambda qs: squery(qs, grad=False)  # noqa: E731
        docs = lambda ts: enc(ts, max_len)  # noqa: E731
    elif family == "sparse":
        tok, model, doc, squery, qw = sparse_encoder(d)
        qw.data.copy_(torch.load(f"{d}/query_weights.pt").cuda())
        query = squery
        docs = lambda ts: doc(ts, max_len)  # noqa: E731
    else:
        raise ValueError(family)
    model.eval()
    ranks = []
    with torch.no_grad():
        for w in worlds(f"/vol/data/{eval_name}"):
            texts = [i["text"] for i in w["items"]]
            ids = [i["id"] for i in w["items"]]
            reqs = [r["request"] for r in w["requests"]]
            if not reqs:
                continue
            D = torch.cat([docs(texts[i : i + 128]) for i in range(0, len(texts), 128)])
            S = torch.cat([query(reqs[i : i + 256]) @ D.T for i in range(0, len(reqs), 256)])
            top = torch.topk(S, min(TOP, S.shape[1]), dim=1)
            for r, ix in zip(w["requests"], top.indices.tolist()):
                ranks.append({"rid": r["rid"], "top": [ids[i] for i in ix]})
    return ranks


def load_asym(run):
    """A trained asym run: the item encoder and the request's token table, frozen."""
    import torch

    d = f"/vol/models/{run}"
    tok, model, enc = dense_encoder(d)
    table, qweight, squery = static_query(tok, model)
    saved = torch.load(f"{d}/query_table.pt")
    table.weight.data.copy_(saved["table"].cuda())
    qweight.data.copy_(saved["weight"].cuda())
    model.eval()
    return enc, (lambda qs: squery(qs, grad=False))


class SetRanker:
    """`setrank` (M3, D903): reads a request and its K candidates at once. Each candidate is its ingest vector d, the
    request's vector q, d*q and their cosine, projected and passed through a small transformer encoder with a learned
    NULL slot (nothing here); each candidate's score is read against NULL's. Input is vectors only: no text model at
    request time."""

    def __init__(self, dim=384, width=256, layers=2, heads=4):
        import torch

        class Net(torch.nn.Module):
            def __init__(s):
                super().__init__()
                s.inp = torch.nn.Linear(3 * dim + 1, width)
                s.null = torch.nn.Parameter(torch.zeros(1, 1, width))
                lay = torch.nn.TransformerEncoderLayer(width, heads, 2 * width, dropout=0.1, batch_first=True)
                s.enc = torch.nn.TransformerEncoder(lay, layers)
                s.out = torch.nn.Linear(width, 1)

            def forward(s, q, D, mask):
                # q: (B, dim); D: (B, K, dim); mask: (B, K) True where padded.
                qq = q.unsqueeze(1).expand_as(D)
                cos = (qq * D).sum(-1, keepdim=True)
                x = s.inp(torch.cat([D, qq, qq * D, cos], -1))
                x = torch.cat([s.null.expand(x.shape[0], 1, -1), x], 1)
                m = torch.cat([torch.zeros_like(mask[:, :1]), mask], 1)
                h = s.enc(x, src_key_padding_mask=m)
                return s.out(h).squeeze(-1).masked_fill(m, -1e4)  # (B, 1 + K): index 0 is NULL

        self.net = Net().cuda()


def set_groups(enc, query, files, suites, K, max_worlds, rng):
    """Per training request two lists: the world's top K by the asym score with the fact in (target: the fact) and
    with the fact out and its twin in (target: NULL). Candidates are ids into the world's vectors."""
    import torch

    out = []
    for name in files:
        for wi, w in enumerate(worlds(f"/vol/data/{name}")):
            if wi >= max_worlds:
                break
            away = {x for t in w["tasks"] if t["suite"] not in suites for x in (t["pos"], t["decoy"])}
            items = [i for i in w["items"] if i["id"] not in away]
            idx = {i["id"]: k for k, i in enumerate(items)}
            tasks = [t for t in w["tasks"] if t["suite"] in suites and t["pos"] in idx and t["decoy"] in idx]
            if not tasks:
                continue
            with torch.no_grad():
                texts = [item_text(i) for i in items]
                D = torch.cat([enc(texts[i : i + 256], 256) for i in range(0, len(texts), 256)]).half()
                Q = torch.cat([query([t["request"] for t in tasks[i : i + 256]]) for i in range(0, len(tasks), 256)])
                S = Q.float() @ D.float().T
            for qi, t in enumerate(tasks):
                p, dcy = idx[t["pos"]], idx[t["decoy"]]
                order = [k for k in torch.topk(S[qi], K + 2).indices.tolist() if k not in (p, dcy)][: K - 1]
                hid = order[:]
                hid.insert(int(rng.integers(0, K)), p)
                ctl = order[:]
                ctl.insert(int(rng.integers(0, K)), dcy)
                out.append((Q[qi].half().cpu(), D[hid].cpu(), hid.index(p) + 1))
                out.append((Q[qi].half().cpu(), D[ctl].cpu(), 0))
    return out


@app.function(gpu=["L4", "A10G"], volumes={"/vol": vol}, timeout=6 * 3600, memory=32768)
def setrank_remote(asym_run: str, files: list, suites: list, run: str, K: int, epochs: float, lr: float, batch: int,
                   max_worlds: int, eval_names: list) -> dict:
    import numpy as np
    import torch

    t0 = time.time()
    torch.manual_seed(7)
    rng = np.random.default_rng(7)
    enc, query = load_asym(asym_run)
    data = set_groups(enc, query, files, set(suites), K, max_worlds, rng)
    t_data = time.time() - t0
    sr = SetRanker()
    net = sr.net
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=0.01)
    total = int(len(data) / batch * epochs)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, s / max(1, total // 20)) * max(0.0, 1 - s / total))
    log, step = [], 0
    net.train()
    while step < total:
        perm = rng.permutation(len(data))
        for i in range(0, len(perm) - batch + 1, batch):
            if step >= total:
                break
            b = [data[j] for j in perm[i : i + batch]]
            q = torch.stack([x[0] for x in b]).float().cuda()
            D = torch.stack([x[1] for x in b]).float().cuda()
            y = torch.tensor([x[2] for x in b], device="cuda")
            logits = net(q, D, torch.zeros(D.shape[:2], dtype=torch.bool, device="cuda"))
            loss = torch.nn.functional.cross_entropy(logits, y)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
            sched.step()
            if step % 200 == 0:
                log.append({"step": step, "loss": round(float(loss), 4), "s": round(time.time() - t0)})
                print(log[-1], flush=True)
            step += 1
    net.eval()
    out_dir = f"/vol/models/{run}"
    os.makedirs(out_dir, exist_ok=True)
    torch.save(net.state_dict(), f"{out_dir}/setrank.pt")
    # Eval: each request's asym top K re-read by the set ranker. `top` holds the candidates scored above NULL (best
    # first), then `rest` the others: the hybrid fuses `top` only, so an item the ranker puts below silence adds nothing.
    ranks = {}
    with torch.no_grad():
        for name in eval_names:
            rows = []
            for w in worlds(f"/vol/data/{name}"):
                reqs = [r["request"] for r in w["requests"]]
                if not reqs:
                    continue
                ids = [i["id"] for i in w["items"]]
                texts = [i["text"] for i in w["items"]]
                D = torch.cat([enc(texts[i : i + 256], 256) for i in range(0, len(texts), 256)])
                for i in range(0, len(reqs), 128):
                    Q = query(reqs[i : i + 128])
                    S = Q @ D.T
                    top = torch.topk(S, K, dim=1).indices
                    logits = net(Q, D[top], torch.zeros(top.shape, dtype=torch.bool, device="cuda"))
                    for r, cand, lg in zip(w["requests"][i : i + 128], top.tolist(), logits.tolist()):
                        null = lg[0]
                        order = sorted(range(K), key=lambda k: -lg[k + 1])
                        rows.append({"rid": r["rid"], "top": [ids[cand[k]] for k in order if lg[k + 1] > null],
                                     "rest": [ids[cand[k]] for k in order if lg[k + 1] <= null]})
            ranks[name] = rows
    meta = {"family": "setrank", "asym": asym_run, "files": files, "suites": suites, "run": run, "K": K,
            "epochs": epochs, "lr": lr, "batch": batch, "examples": len(data), "data_s": round(t_data),
            "total_s": round(time.time() - t0), "gpu": torch.cuda.get_device_name(0), "log": log}
    json.dump(meta, open(f"{out_dir}/meta.json", "w"), indent=1)
    vol.commit()
    return {"meta": meta, "ranks": ranks}


@app.local_entrypoint()
def main(upload: str = "", family: str = "dense", base: str = "BAAI/bge-small-en-v1.5",
         suites: str = "train1,train2,train3,train4", run: str = "", epochs: float = 1.0, lr: float = 3e-5,
         batch: int = 32, n_neg: int = 4, max_len: int = 256, flops: float = 0.0, max_seeds: int = 0,
         temp: float = 0.05, first: str = "", first_k: int = 15, data: str = "train-worlds.jsonl.gz",
         table_lr: float = 1e-3, rank_only: str = "", eval_name: str = "eval-m2.jsonl.gz",
         asym: str = "asym-s1", set_k: int = 32):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    if upload:
        with vol.batch_upload(force=True) as b:
            for name in os.listdir(upload):
                if name.endswith(".jsonl.gz"):
                    b.put_file(os.path.join(upload, name), f"/data/{name}")
        print("uploaded")
        return
    if family == "setrank":
        evals = ["eval.jsonl.gz", "eval-m2.jsonl.gz"]
        got = setrank_remote.remote(asym, data.split(","), suites.split(","), run, set_k, epochs, lr, batch,
                                    max_seeds or 10_000, evals)
        for name, rows in got["ranks"].items():
            out = os.path.join(root, ".local", "m3", "runs", f"{run}@{name.split('.')[0]}")
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, "ranks.jsonl"), "w") as f:
                for r in rows:
                    f.write(json.dumps(r) + "\n")
            json.dump(got["meta"], open(os.path.join(out, "meta.json"), "w"), indent=1)
            print(out)
        print(json.dumps({k: v for k, v in got["meta"].items() if k != "log"}))
        return
    if rank_only:
        ranks = rank_remote.remote(family, rank_only, eval_name)
        out = os.path.join(root, ".local", "m3", "runs", f"{rank_only}@{eval_name.split('.')[0]}")
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "ranks.jsonl"), "w") as f:
            for r in ranks:
                f.write(json.dumps(r) + "\n")
        print(out)
        return
    if any(not (s.startswith("train") or s in ("synth", "m2")) for s in suites.split(",")):
        raise SystemExit("train suites only")
    run = run or f"{family}-{time.strftime('%Y%m%d-%H%M%S')}"
    if family == "rerank":
        # Candidates: each eval request's lexical top 50 joined with a first stage's top `first_k` (a run's ranks).
        import gzip
        firsts = {}
        if first:
            for line in open(os.path.join(root, ".local", "m3", "runs", first, "ranks.jsonl")):
                r = json.loads(line)
                firsts[r["rid"]] = r["top"][:first_k]
        cands = {}
        with gzip.open(os.path.join(root, ".local", "m3", "d", "eval.jsonl.gz"), "rt") as f:
            for line in f:
                for r in json.loads(line)["requests"]:
                    cands[r["rid"]] = list(dict.fromkeys(r["pool50"] + firsts.get(r["rid"], [])))
        got = rerank_remote.remote(base, suites.split(","), run, epochs, lr, batch, n_neg, max_len, cands, max_seeds,
                                   data.split(","))
    else:
        got = train_remote.remote(family, base, suites.split(","), run, epochs, lr, batch, n_neg, max_len, flops,
                                  max_seeds, temp, data.split(","), table_lr)
    out = os.path.join(root, ".local", "m3", "runs", run)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "ranks.jsonl"), "w") as f:
        for r in got["ranks"]:
            f.write(json.dumps(r) + "\n")
    json.dump(got["meta"], open(os.path.join(out, "meta.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in got["meta"].items() if k != "log"}))
    print(out)
