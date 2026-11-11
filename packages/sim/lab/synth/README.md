# Synthetic worlds (M2, D880–D884)

Thousands of generated users, each a world of mail, calendar, documents, chat, CRM and rarely used sources (texts,
WhatsApp, notes, to-dos, bank, health app, files, issue tracker, school app, household app), with tasks in the train
suites' HiddenTask shape: requests in many phrasings, a planted fact that changes what the agent should do, its
all-clear decoy twin, and neutral items on the same topic. Labels come from construction, never from a model. The
design, the quality checks and the numbers are in [docs/research/m2-synth.md](../../../../docs/research/m2-synth.md);
the counts, splits, error rate and cost are in [DATASHEET.md](DATASHEET.md).

Only `sample.jsonl` (four validation worlds) is in git. The dataset lives on the Modal Volume **`eden-synth`**.

## Get it

```bash
python3 -m venv .venv-modal && .venv-modal/bin/pip install -r packages/sim/modal/requirements.txt
export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt        # cloud containers only
mkdir -p .local/m2/synth/worlds
for s in train val test; do
  .venv-modal/bin/modal volume get eden-synth v2/worlds/$s.jsonl .local/m2/synth/worlds/$s.jsonl
done
.venv-modal/bin/modal volume get eden-synth v2/families.jsonl .local/m2/synth/families.jsonl
.venv-modal/bin/modal volume get eden-synth v2/manifest.json .local/m2/synth/manifest.json
```

## Load it

Python (no Modal needed; `packages/sim/modal/synth_data.py`):

```python
import sys; sys.path.insert(0, "packages/sim/modal")
import synth_data as sd
train = sd.load_worlds(".local/m2/synth/worlds/train.jsonl")
rows = sd.sample_pairs(train, unrelated=8, seed=1)   # every changes/clear pair + 8 unrelated per request, with text
all_pairs = [p for w in train for p in sd.pairs(w)]  # every (request, item) pair of every world
```

Each pair row: `world, split, task, family, area, archetype, timing, request, style, lang, item, source, label`
(`changes` | `clear` | `unrelated`), `role` (`fact` | `decoy` | `neutral` | `other`), `visible` (the item existed when
the request was made), and the texts (`request_text`, `item_title`, `item_text`).

TypeScript: `readWorlds(path)` (`packages/sim/src/lab/synth/suite.ts`), `pairsOf(world)` (`labels.ts`), the zod
schema and checks in `schema.ts`.

## Run the lab on it

The worlds are lab suites like `train` (`packages/sim/src/lab/synth/suite.ts`): `synth-sample` (this folder's file),
`synth-train`, `synth-val`, `synth-test` (from `.local/m2/synth/worlds/`, or `EDEN_SYNTH_DIR`), `synth:<file>`, and
`synth` (= train + val). Seed `s` plants world `s mod N`; `@K` plants K worlds a seed (a `--days` user needs 12–20
requests a day).

```bash
bun run funnel --suite synth-val --seeds 41-60
bun packages/sim/src/lab/days-calls.ts --suite synth-val@4 --seeds 41,42 --days 2
bun packages/sim/src/lab/pi-ab.ts --suite synth-val --seeds 41,42 ...   # as with train
```

`synth-test` is the generated test split M1 and M3 measure on: name it alone, never tune on it.

## Splits

By family cluster (`families.jsonl`: `id`, `cluster`, `split`): families whose texts are near each other share a
cluster, a cluster's hash fixes its split (80/10/10), and a world takes all its families from one split, so a test
world's templates are ones no train world saw.
