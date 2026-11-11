"""Leave-one-generator-out screen (M14, D1021): does a micro model hold up on text written differently from its
training data? LAB ONLY.

Each source is a generator of tasks (M2's Haiku worlds, the sim's hand-written train families, G2's Sonnet worlds in
format packs, G3's programmatic worlds; rows from `packages/sim/src/lab/m14/logo-export.ts`). For each held-out
source H the model trains on every other source's train rows and is graded on H's test rows; `in` trains on H's own
train rows (the in-source ceiling) and `from:S` on one source S alone (what a single generator buys). The gap
between `in` and `logo` is the transfer gap a micro model will meet on real users' text, which matches none of them.

  python3 logo.py run --source m2=M2TRAIN:M2TEST --source sim=SIM --source g2=G2 --source g3=G3 \
      --model hashnet --recipe balance,noise --modes logo,in --seeds 1,2 --out results.json
  python3 logo.py folds --source ... --out DIR            # per held-out source: train.jsonl, test.jsonl
  python3 logo.py grade --rows DIR/g2/test.jsonl --scores SCORES.jsonl

A model is a module with `make(cfg) -> obj` whose obj has `fit(rows)` and `score(rows) -> (item_scores,
pair_scores)` (shapes in `logo_core.grade`); `--model pkg.mod` imports it (this folder is on the path). For a model
trained elsewhere (Modal, another language), `folds` writes the fold files and `grade` reads one line per test row:
{"item": {...}, "pairs": [...]}, in the test file's order.
"""

from __future__ import annotations

import argparse
import importlib
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from logo_core import Source, cap_rows, grade, length_balanced, load_source, read_rows  # noqa: E402


def fold_rows(sources: list[Source], held: str, mode: str, cap: int, seed: int) -> list[dict]:
    if mode == "in":
        return next(s.train for s in sources if s.name == held)
    if mode.startswith("from:"):
        return next(s.train for s in sources if s.name == mode[5:])
    # logo: every other source, a big one capped so it does not swamp the mix.
    return [r for s in sources if s.name != held for r in cap_rows(s.train, cap, seed)]


def run(args: argparse.Namespace) -> dict:
    sources = [load_source(x) for x in args.source]
    mod = importlib.import_module(args.model)
    held_list = args.held.split(",") if args.held else [s.name for s in sources]
    out: dict = {"recipe": args.recipe, "model": args.model, "sources": {}, "results": []}
    for s in sources:
        out["sources"][s.name] = {"train": len(s.train), "test": len(s.test)}
    for held in held_list:
        test = next(s.test for s in sources if s.name == held)
        test = test[: args.max_test] if args.max_test else test
        for mode in args.modes.split(","):
            if mode.startswith("from:") and mode[5:] == held:
                continue
            per_seed = []
            for seed in [int(x) for x in args.seeds.split(",")]:
                cfg = {"recipe": args.recipe, "seed": seed, "epochs": args.epochs, "para": args.para,
                       "teacher": args.teacher, "rows_per_source": args.rows_per_source}
                train = fold_rows(sources, held, mode, args.cap, seed)
                if "lenbal" in args.recipe.split(","):
                    # Per source, so one source's balance does not hide behind another's.
                    train = [r for s in sorted({x["src"] for x in train})
                             for r in length_balanced([x for x in train if x["src"] == s], seed)]
                t0 = time.time()
                model = mod.make(cfg).fit(train)
                g = grade(test, *model.score(test))
                g.update(seed=seed, train_rows=len(train), secs=round(time.time() - t0, 1))
                per_seed.append(g)
                print(json.dumps({"held": held, "mode": mode, **g}), flush=True)
            mean = {k: round(sum(g[k] for g in per_seed) / len(per_seed), 4)
                    for k in ("twin", "twin_hard", "twin_auc_all_clear", "twin_req", "fact_at1", "relevance")}
            spread = {f"{k}_sd": round(_sd([g[k] for g in per_seed]), 4) for k in ("twin", "fact_at1")}
            out["results"].append({"held": held, "mode": mode, **mean, **spread, "seeds": per_seed})
    if args.out:
        with open(args.out, "w", encoding="utf8") as f:
            json.dump(out, f, indent=1)
    print(table(out))
    return out


def _sd(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def table(out: dict) -> str:
    lines = [f"recipe={out['recipe'] or '-'} model={out['model']}",
             "| held out | trained on | twin | twin (length-controlled) | twin vs all-clear AUC | twin for request | fact @1 | relevance AUC |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in out["results"]:
        lines.append(f"| {r['held']} | {r['mode']} | {r['twin']:.3f} ± {r['twin_sd']:.3f} | {r['twin_hard']:.3f} "
                     f"| {r['twin_auc_all_clear']:.3f} "
                     f"| {r['twin_req']:.3f} | {r['fact_at1']:.3f} ± {r['fact_at1_sd']:.3f} | {r['relevance']:.3f} |")
    return "\n".join(lines)


def folds(args: argparse.Namespace) -> None:
    sources = [load_source(x) for x in args.source]
    for s in sources:
        d = os.path.join(args.out, s.name)
        os.makedirs(d, exist_ok=True)
        train = fold_rows(sources, s.name, "logo", args.cap, 1)
        for name, rows in (("train", train), ("test", s.test), ("own-train", s.train)):
            with open(os.path.join(d, f"{name}.jsonl"), "w", encoding="utf8") as f:
                f.writelines(json.dumps(r) + "\n" for r in rows)
        print(f"{s.name}: train {len(train)} (other sources), own-train {len(s.train)}, test {len(s.test)} → {d}")


def para_texts(args: argparse.Namespace) -> None:
    """Training texts for `paraphrase.ts`: from each source's train rows, the fact, decoy, two neutrals, two others
    and two requests of up to `--rows` rows, each at most 1,500 characters, deduplicated."""
    import random

    from logo_core import item_text

    seen, out = set(), []
    for spec in args.source:
        s = load_source(spec)
        rng = random.Random(7)
        for r in cap_rows(s.train, args.rows, 7):
            texts = [item_text(r["fact"]), item_text(r["decoy"])]
            texts += [item_text(x) for x in r["neutrals"][:2]]
            texts += [item_text(x) for x in rng.sample(r["others"], min(2, len(r["others"])))]
            texts += rng.sample(r["requests"], min(2, len(r["requests"])))
            for t in texts:
                if len(t) <= 1500 and t not in seen:
                    seen.add(t)
                    out.append(t)
    with open(args.out, "w", encoding="utf8") as f:
        f.writelines(json.dumps({"text": t}) + "\n" for t in out)
    print(f"{len(out)} texts → {args.out}")


def grade_cmd(args: argparse.Namespace) -> None:
    rows = read_rows(args.rows)
    sc = read_rows(args.scores)
    if len(sc) != len(rows):
        raise SystemExit(f"{len(sc)} score lines for {len(rows)} rows")
    print(json.dumps(grade(rows, [s["item"] for s in sc], [s["pairs"] for s in sc])))


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--source", action="append", required=True)
    r.add_argument("--model", default="hashnet")
    r.add_argument("--recipe", default="")
    r.add_argument("--modes", default="logo,in")
    r.add_argument("--held", default="")
    r.add_argument("--seeds", default="1,2")
    r.add_argument("--epochs", type=int, default=4)
    r.add_argument("--cap", type=int, default=2500, help="rows a training source gives a logo fold at most")
    r.add_argument("--rows-per-source", type=int, default=2500)
    r.add_argument("--max-test", type=int, default=0)
    r.add_argument("--para", default="")
    r.add_argument("--teacher", default="")
    r.add_argument("--out", default="")
    f = sub.add_parser("folds")
    f.add_argument("--source", action="append", required=True)
    f.add_argument("--cap", type=int, default=2500)
    f.add_argument("--out", required=True)
    g = sub.add_parser("grade")
    g.add_argument("--rows", required=True)
    g.add_argument("--scores", required=True)
    t = sub.add_parser("para-texts")
    t.add_argument("--source", action="append", required=True)
    t.add_argument("--rows", type=int, default=700)
    t.add_argument("--out", required=True)
    a = p.parse_args(argv)
    {"run": run, "folds": folds, "grade": grade_cmd, "para-texts": para_texts}[a.cmd](a)


if __name__ == "__main__":
    main()
