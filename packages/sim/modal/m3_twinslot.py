"""M3-arch (D904, docs/research/m3-arch.md): TwinSlot, a retrieval network built for "which held item bears on this
request?". Token input with rule channels, a from-scratch item encoder, typed slot memory, a twin-contrast layer
over each item's corpus neighbours, a supersession gate, graph message passing, and a table-only request side with
typed comparators; listwise over the whole world with a NULL option. Lab tooling on Modal (Volume `eden-retriever`).

    modal run packages/sim/modal/m3_twinslot.py --run ts-a1 --suites train1,train2,train3,train4,synth,m2 \
        --data train-worlds.jsonl.gz,synth-a-worlds.jsonl.gz,m2-train-worlds.jsonl.gz [--ablate contrast,slots,...]

Each eval request's top 100 ids come back to `.local/m3/runs/<run>@<eval>/ranks.jsonl` (`top`: scored above NULL).
"""
import json
import os
import re
import time

import modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "transformers==4.56.2", "numpy==2.3.3")
    .env({"HF_HOME": "/vol/hf"})
)
vol = modal.Volume.from_name("eden-retriever", create_if_missing=True)
app = modal.App("eden-m3-twinslot", image=image)

BASE = "BAAI/bge-small-en-v1.5"  # only its WordPiece vocabulary and input embeddings are used
TYPES = ["person", "thing", "date", "amount", "status", "obligation"]
STATUS = set("""cancelled canceled cancel called off resolved fixed paid settled postponed moved rescheduled not no
never longer hold held suspended closed withdrawn declined rejected refunded expired lapsed done completed already
replaced superseded instead revoked frozen pending blocked unavailable away leave ill sick full booked sold""".split())
OBLIG = set("""must need needs required require approval approve sign deadline before until by due only limit cap
policy rule allowed forbidden cannot can't mustn't don't do not ask confirm check""".split())
MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
DATE_RE = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*", re.I)
SLASH_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})\b")
AMOUNT_RE = re.compile(r"[£$€]\s?([\d,]+(?:\.\d+)?)")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
HEADER_DATE_RE = re.compile(r"Date:\s*\w+,\s*(\d{1,2})\s+(\w{3})\s+(\d{4})")


def worlds(path):
    import gzip

    with gzip.open(path, "rt") as f:
        for line in f:
            yield json.loads(line)


def days_of(text):
    """Day-of-year numbers a text names (2026; '5 November', '05/11')."""
    out = set()
    for d, m in DATE_RE.findall(text):
        mi = MONTHS.get(m[:3].lower())
        if mi and 1 <= int(d) <= 31:
            out.add((mi - 1) * 31 + int(d))
    for d, m in SLASH_RE.findall(text):
        if 1 <= int(d) <= 31 and 1 <= int(m) <= 12:
            out.add((int(m) - 1) * 31 + int(d))
    return out


def amounts_of(text):
    out = set()
    for a in AMOUNT_RE.findall(text):
        try:
            out.add(round(float(a.replace(",", "")), 2))
        except ValueError:
            pass
    return out


def stamp(text):
    m = HEADER_DATE_RE.search(text)
    if m and m.group(2)[:3].lower() in MONTHS:
        return (MONTHS[m.group(2)[:3].lower()] - 1) * 31 + int(m.group(1))
    return None


def thread_key(title):
    return re.sub(r"^((re|fwd?|fw)\s*:\s*)+", "", title.strip().lower())


class Prep:
    """Per item: token ids, rule channels, dates, amounts, stamp, edges' keys. Computed once, on CPU."""

    def __init__(self, tok, T):
        self.tok, self.T = tok, T

    def items(self, items):
        texts = [f"{i['title']}\n{i['text']}" for i in items]
        enc = self.tok(texts, truncation=True, max_length=self.T, padding="max_length", return_offsets_mapping=True)
        feats = []
        for text, offs in zip(texts, enc["offset_mapping"]):
            f = []
            for a, b in offs:
                w = text[a:b]
                lw = w.lower()
                f.append([
                    float(bool(re.fullmatch(r"\d{1,2}", w)) or lw[:3] in MONTHS),
                    float(bool(re.fullmatch(r"\d{1,2}[:.]\d{2}", w))),
                    float(w[:1] in "£$€" or bool(re.fullmatch(r"\d[\d,]*", w) and len(w) > 2)),
                    float(lw in STATUS or lw in OBLIG),
                    float(w[:1].isupper() and len(w) > 1),
                ])
            feats.append(f)
        return {
            "ids": enc["input_ids"], "mask": enc["attention_mask"], "feat": feats,
            "days": [days_of(t) for t in texts], "amts": [amounts_of(t) for t in texts],
            "stamp": [stamp(t) for t in texts],
            "emails": [set(EMAIL_RE.findall(t.lower())) - {"robin@northwind.co"} for t in texts],
            "thread": [thread_key(i["title"]) for i in items],
        }


def build_net(emb, d=192, ablate=frozenset()):
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    S = len(TYPES)

    class TwinSlot(nn.Module):
        def __init__(s):
            super().__init__()
            s.ablate = ablate
            s.emb = nn.Embedding.from_pretrained(emb, freeze=True)
            s.proj = nn.Linear(emb.shape[1] + 5, d)
            s.pos = nn.Parameter(torch.zeros(1, 128, d))
            lay = nn.TransformerEncoderLayer(d, 4, 2 * d, dropout=0.1, batch_first=True, norm_first=True)
            s.enc = nn.TransformerEncoder(lay, 3)
            s.slotq = nn.Parameter(torch.randn(S, d) * 0.02)
            s.slot_attn = nn.MultiheadAttention(d, 4, batch_first=True)
            s.presence = nn.Linear(d, 1)
            # L3 twin-contrast
            s.c_att = nn.ModuleList([nn.Linear(2 * d, 1) for _ in range(S)])
            s.c_val = nn.ModuleList([nn.Linear(d, d) for _ in range(S)])
            s.c_mlp = nn.ModuleList([nn.Sequential(nn.Linear(d, d), nn.GELU(), nn.Linear(d, d)) for _ in range(S)])
            # L4 supersession
            s.sup = nn.Sequential(nn.Linear(3 * 2 * d + 1, d), nn.GELU(), nn.Linear(d, 1))
            s.lam = nn.Parameter(torch.tensor(1.0))
            # L5 graph
            s.g_gate = nn.Linear(2 * d, d)
            s.alpha = nn.Parameter(torch.tensor(-2.0))
            # L6 request side: token table (bag) -> six query slots
            s.qtab = nn.Embedding.from_pretrained(emb.clone(), freeze=False)
            s.qw = nn.Embedding(emb.shape[0], 1)
            nn.init.ones_(s.qw.weight)
            s.qproj = nn.Linear(emb.shape[1], d)
            s.qheads = nn.Linear(d, S * d)
            s.qpres = nn.Linear(d, S)
            s.Wa = nn.Parameter(torch.randn(S, d, 32) * d ** -0.5)
            s.Wb = nn.Parameter(torch.randn(S, d, 32) * d ** -0.5)
            s.phi = nn.Sequential(nn.Linear(8, 32), nn.GELU(), nn.Linear(32, 1))
            s.null = nn.Linear(d, 1)
            s.single = nn.Linear(S * d, d)  # `-slots`: one vector an item, one a request

        def items(s, ids, mask, feat, nbr, later_dt, edges):
            """Ingest: (N, S, d) slots, (N, S) presence, (N,) cleared."""
            x = s.emb(ids)
            if "rules" in s.ablate:
                feat = torch.zeros_like(feat)
            h = s.proj(torch.cat([x, feat], -1)) + s.pos[:, : ids.shape[1]]
            h = s.enc(h, src_key_padding_mask=~mask.bool())
            q = s.slotq.unsqueeze(0).expand(h.shape[0], -1, -1)
            slots, _ = s.slot_attn(q, h, h, key_padding_mask=~mask.bool())
            N = slots.shape[0]
            if "contrast" not in s.ablate:
                nb = slots[nbr]  # (N, m, S, d)
                diff = slots.unsqueeze(1) - nb
                upd = []
                for t in range(S):
                    a = s.c_att[t](torch.cat([slots[:, t].unsqueeze(1).expand_as(diff[:, :, t]), diff[:, :, t]], -1))
                    w = torch.softmax(a.squeeze(-1), -1).unsqueeze(-1)
                    upd.append(slots[:, t] + s.c_mlp[t]((w * s.c_val[t](diff[:, :, t])).sum(1)))
                slots = torch.stack(upd, 1)
            cleared = torch.zeros(N, device=slots.device)
            if "supersede" not in s.ablate:
                si = slots[:, [1, 4]].reshape(N, 1, -1).expand(-1, nbr.shape[1], -1)
                sj = slots[nbr][:, :, [1, 4]].reshape(N, nbr.shape[1], -1)
                g = torch.sigmoid(s.sup(torch.cat([si, sj, si - sj, later_dt.unsqueeze(-1)], -1))).squeeze(-1)
                cleared = (g * (later_dt > 0).float()).max(-1).values
            if "graph" not in s.ablate and edges is not None:
                for t in (0, 1):
                    m = edges @ slots[:, t]
                    slots = slots.clone()
                    slots[:, t] = slots[:, t] + torch.sigmoid(s.g_gate(torch.cat([slots[:, t], m], -1))) * m
            pres = s.presence(slots).squeeze(-1)
            return slots, pres, cleared

        def query(s, qids):
            """Request: a bag of token vectors weighted per token -> six query slots and presences."""
            v = s.qtab(qids) * F.relu(s.qw(qids)) * (qids > 0).unsqueeze(-1)
            v = s.qproj(v.sum(1) / (qids > 0).sum(1, keepdim=True).clamp(min=1))
            return s.qheads(v).view(-1, S, d), s.qpres(v), v

        def score(s, qs, qp, qv, slots, pres, cleared, phi, edges):
            """(R, N) scores and (R,) NULL."""
            if "slots" in s.ablate:
                a = F.normalize(s.single(qs.reshape(qs.shape[0], -1)), dim=-1)
                b = F.normalize(s.single(slots.reshape(slots.shape[0], -1)), dim=-1)
                sc = 20 * a @ b.T
            else:
                A = torch.einsum("rtd,tdk->rtk", qs, s.Wa)
                B = torch.einsum("ntd,tdk->ntk", slots, s.Wb)
                per = torch.einsum("rtk,ntk->rnt", A, B) / 32 ** 0.5
                gate = torch.sigmoid(qp).unsqueeze(1) * torch.sigmoid(pres).unsqueeze(0)
                sc = (per * gate).sum(-1)
            if "rules" not in s.ablate:
                sc = sc + s.phi(phi).squeeze(-1)
            if "supersede" not in s.ablate:
                sc = sc - F.softplus(s.lam) * cleared.unsqueeze(0)
            if "graph" not in s.ablate and edges is not None:
                sc = sc + torch.sigmoid(s.alpha) * (sc @ edges.T)
            return sc, s.null(qv).squeeze(-1)

    return TwinSlot()


def world_tensors(prep, items, m, dev):
    """Token tensors, m nearest-neighbour slots are found later; graph edges (row-normalised) and stamps."""
    import torch

    p = prep.items(items)
    N = len(items)
    ids = torch.tensor(p["ids"], device=dev)
    mask = torch.tensor(p["mask"], device=dev)
    feat = torch.tensor(p["feat"], device=dev, dtype=torch.float)
    A = torch.zeros(N, N, device=dev)
    by = {}
    for k in range(N):
        for key in [("t", p["thread"][k])] + [("e", e) for e in p["emails"][k]]:
            by.setdefault(key, []).append(k)
    for key, ks in by.items():
        if 1 < len(ks) <= 40:
            kt = torch.tensor(ks, device=dev)
            A[kt.unsqueeze(1), kt.unsqueeze(0)] = 1.0
    A.fill_diagonal_(0)
    A = A / A.sum(1, keepdim=True).clamp(min=1)
    st = torch.tensor([x if x is not None else -1 for x in p["stamp"]], device=dev, dtype=torch.float)
    return ids, mask, feat, A, st, p


def neighbours(net, ids, mask, feat, m):
    """Each item's m nearest by its first encoding's thing and person slots (no contrast, no grad)."""
    import torch

    with torch.no_grad():
        abl = net.ablate
        net.ablate = frozenset(abl | {"contrast", "supersede", "graph"})
        sl = []
        for i in range(0, ids.shape[0], 512):
            dummy = torch.zeros(min(512, ids.shape[0] - i), m, dtype=torch.long, device=ids.device)
            s, _, _ = net.items(ids[i : i + 512], mask[i : i + 512], feat[i : i + 512], dummy,
                                torch.zeros_like(dummy, dtype=torch.float), None)
            sl.append(s[:, :2].reshape(s.shape[0], -1))
        net.ablate = abl
        v = torch.nn.functional.normalize(torch.cat(sl), dim=-1)
        sim = v @ v.T
        sim.fill_diagonal_(-1)
        return torch.topk(sim, m, dim=1).indices


def phi_feats(p, reqs, dev):
    """(R, N, 8) symbolic date and amount features between each request and each item."""
    import torch

    N = len(p["days"])
    out = torch.zeros(len(reqs), N, 8, device=dev)
    for r, text in enumerate(reqs):
        qd, qa = days_of(text), amounts_of(text)
        for k in range(N):
            idays, iamts = p["days"][k], p["amts"][k]
            if qd and idays:
                gap = min(abs(a - b) for a in qd for b in idays)
                out[r, k, 0] = 1.0
                out[r, k, 1] = float(gap == 0)
                out[r, k, 2] = float(0 < gap <= 3)
                out[r, k, 3] = float(3 < gap <= 14)
            if qa and iamts:
                out[r, k, 4] = 1.0
                out[r, k, 5] = float(bool(qa & iamts))
                out[r, k, 6] = float(max(iamts) > max(qa))
            out[r, k, 7] = float(bool(idays))
    return out


def train_groups(files, suites, max_worlds):
    for name in files:
        for wi, w in enumerate(worlds(f"/vol/data/{name}")):
            if wi >= max_worlds:
                break
            yield w


@app.function(gpu="A10G", volumes={"/vol": vol}, timeout=8 * 3600, memory=32768)
def train_remote(run: str, files: list, suites: list, ablate: list, epochs: int, lr: float, max_worlds: int,
                 base_keep: int, m: int, evals: list) -> dict:
    import numpy as np
    import torch
    from transformers import AutoModel, AutoTokenizer

    t0 = time.time()
    torch.manual_seed(7)
    rng = np.random.default_rng(7)
    dev = "cuda"
    tok = AutoTokenizer.from_pretrained(BASE)
    emb = AutoModel.from_pretrained(BASE).get_input_embeddings().weight.detach().float()
    net = build_net(emb, ablate=frozenset(ablate)).to(dev)
    prep = Prep(tok, 128)
    opt = torch.optim.AdamW([p for p in net.parameters() if p.requires_grad], lr=lr, weight_decay=0.01)
    sset = set(suites)
    # Each world once an epoch: its tasks split at random into hidden (twin removed from the world) and control
    # (fact removed); base items subsampled to `base_keep` so a step fits; every request scored over the whole world.
    pool = list(train_groups(files, sset, max_worlds))
    log, step = [], 0
    total = epochs * len(pool)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, s / 50) * max(0.05, 1 - s / total))
    for ep in range(epochs):
        for wi in rng.permutation(len(pool)):
            w = pool[wi]
            tasks = [t for t in w["tasks"] if t["suite"] in sset]
            if not tasks:
                continue
            away = {x for t in w["tasks"] if t["suite"] not in sset for x in (t["pos"], t["decoy"])}
            planted = {x for t in tasks for x in (t["pos"], t["decoy"])}
            hid = rng.random(len(tasks)) < 0.5
            drop = {t["decoy"] if h else t["pos"] for t, h in zip(tasks, hid)}
            base = [i for i in w["items"] if i["id"] not in planted and i["id"] not in away]
            keep = [base[k] for k in rng.permutation(len(base))[:base_keep]]
            items = keep + [i for i in w["items"] if i["id"] in planted and i["id"] not in drop]
            idx = {i["id"]: k for k, i in enumerate(items)}
            sel = [(t, h) for t, h in zip(tasks, hid) if (t["pos"] if h else t["decoy"]) in idx]
            if len(sel) > 96:
                sel = [sel[k] for k in rng.permutation(len(sel))[:96]]
            ids, mask, feat, A, st, p = world_tensors(prep, items, m, dev)
            nbr = neighbours(net, ids, mask, feat, m)
            later = (st[nbr] - st.unsqueeze(1)).masked_fill((st[nbr] < 0) | (st.unsqueeze(1) < 0), 0)
            net.train()
            with torch.autocast("cuda", dtype=torch.bfloat16):
                slots, pres, cleared = net.items(ids, mask, feat, nbr, later.float() / 30, A)
                reqs = [t["request"] for t, _ in sel]
                qids = torch.tensor(tok(reqs, truncation=True, max_length=64, padding="max_length",
                                        add_special_tokens=False)["input_ids"], device=dev)
                qs, qp, qv = net.query(qids)
                sc, null = net.score(qs.float(), qp.float(), qv.float(), slots.float(), pres.float(), cleared.float(),
                                     phi_feats(p, reqs, dev), A)
            logits = torch.cat([null.unsqueeze(1), sc], 1).float()
            y = torch.tensor([idx[t["pos"]] + 1 if h else 0 for t, h in sel], device=dev)
            loss = torch.nn.functional.cross_entropy(logits, y)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
            sched.step()
            if step % 25 == 0:
                log.append({"step": step, "ep": ep, "loss": round(float(loss), 4), "s": round(time.time() - t0)})
                print(log[-1], flush=True)
            step += 1
    out_dir = f"/vol/models/{run}"
    os.makedirs(out_dir, exist_ok=True)
    torch.save(net.state_dict(), f"{out_dir}/twinslot.pt")
    n_params = sum(p.numel() for n, p in net.named_parameters() if p.requires_grad and not n.startswith("qtab"))
    net.eval()
    ranks = {}
    with torch.no_grad():
        for name in evals:
            rows = []
            for w in worlds(f"/vol/data/{name}"):
                if not w["key"].startswith("days/") or not w["requests"]:
                    continue
                items = [{"id": i["id"], "title": i["text"].split("\n", 1)[0],
                          "text": i["text"].split("\n", 1)[1] if "\n" in i["text"] else ""} for i in w["items"]]
                ids_all = [i["id"] for i in items]
                ids, mask, feat, A, st, p = world_tensors(prep, items, m, dev)
                nbr = neighbours(net, ids, mask, feat, m)
                later = (st[nbr] - st.unsqueeze(1)).masked_fill((st[nbr] < 0) | (st.unsqueeze(1) < 0), 0)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    sl, pr, cl = [], [], []
                    # Contrast and supersession read neighbours by index, so the world is encoded in one pass.
                    slots, pres, cleared = net.items(ids, mask, feat, nbr, later.float() / 30, A)
                for i in range(0, len(w["requests"]), 64):
                    rq = w["requests"][i : i + 64]
                    reqs = [r["request"] for r in rq]
                    qids = torch.tensor(tok(reqs, truncation=True, max_length=64, padding="max_length",
                                            add_special_tokens=False)["input_ids"], device=dev)
                    with torch.autocast("cuda", dtype=torch.bfloat16):
                        qs, qp, qv = net.query(qids)
                        sc, null = net.score(qs.float(), qp.float(), qv.float(), slots.float(), pres.float(),
                                             cleared.float(), phi_feats(p, reqs, dev), A)
                    top = torch.topk(sc.float(), min(100, sc.shape[1]), dim=1)
                    for r, ix, vals, nl in zip(rq, top.indices.tolist(), top.values.tolist(), null.float().tolist()):
                        rows.append({"rid": r["rid"], "top": [ids_all[k] for k, v in zip(ix, vals) if v > nl],
                                     "all": [ids_all[k] for k in ix]})
            ranks[name] = rows
    meta = {"run": run, "files": files, "suites": suites, "ablate": ablate, "epochs": epochs, "lr": lr,
            "worlds": len(pool), "steps": step, "params_trained_excl_query_table": n_params,
            "total_s": round(time.time() - t0), "log": log}
    json.dump(meta, open(f"{out_dir}/meta.json", "w"), indent=1)
    vol.commit()
    return {"meta": meta, "ranks": ranks}


@app.local_entrypoint()
def main(run: str, suites: str = "train1,train2,train3,train4,synth,m2",
         data: str = "train-worlds.jsonl.gz,synth-a-worlds.jsonl.gz,m2-train-worlds.jsonl.gz", ablate: str = "",
         epochs: int = 3, lr: float = 5e-4, max_worlds: int = 150, base_keep: int = 500, m: int = 4,
         evals: str = "eval.jsonl.gz,eval-m2.jsonl.gz"):
    if any(not (s.startswith("train") or s in ("synth", "m2")) for s in suites.split(",")):
        raise SystemExit("train suites, synth and m2 only")
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    got = train_remote.remote(run, data.split(","), suites.split(","), [x for x in ablate.split(",") if x], epochs,
                              lr, max_worlds, base_keep, m, evals.split(","))
    for name, rows in got["ranks"].items():
        out = os.path.join(root, ".local", "m3", "runs", f"{run}@{name.split('.')[0]}")
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "ranks.jsonl"), "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        json.dump(got["meta"], open(os.path.join(out, "meta.json"), "w"), indent=1)
        print(out)
    print(json.dumps({k: v for k, v in got["meta"].items() if k != "log"}))
