# edge/freelab: the lab on free OpenRouter models

Paid credit is nearly gone, so live lab runs must work on OpenRouter's free models (`<model>:free`). Those have
three problems the lab did not handle: their endpoints log prompts and none is zero-retention, so Eden's own model
calls (which always send `data_collection: "deny"` and `zdr: true`, D12) could not reach them; the account is limited
to about 20 requests a minute and 1,000 a day, shared by every agent, and free endpoints answer 429 often; and their
cost is $0, which the lab's spend accounting read as "no cost reported" and replaced with a list-price estimate at the
unknown-model price ($1/$4 per million). This track fixes all three, lab only. The product's routing does not change.

## What changed

**`@eden/llm`**

- `OpenRouterOptions.allowLogging` (LAB ONLY): sends `data_collection: "allow"` and `zdr: false`. Default off.
  `OpenRouterModel.fromEnv` never sets it, whatever the environment holds, so the server (which builds its model with
  `fromEnv`) has no way to. Tests: the default body keeps `deny` and `zdr`; `fromEnv` with `EDEN_ALLOW_LOGGING`,
  `ALLOW_LOGGING` and `EDEN_MODEL_ZDR=off` still sends `deny`; no file under `packages/{server,engine,client,sources,
  protocol,graph,redact}/src` mentions `allowLogging`.
- `Pacer` (`pacing.ts`): one per process, and `pacer.fetch` is a `fetch` through it.
  - a client-side rate limit over a sliding minute (`perMinute`);
  - a request cap (`maxRequests`): every HTTP attempt counts, retries included (the free quota counts them), and past
    it the next request throws `RequestCapReached` before anything is sent;
  - retries on 408, 429, 500, 502, 503, 504 and network failures, with jittered exponential backoff (base 2 s,
    × 0.5–1.0), honouring `retry-after-ms`, `Retry-After` (seconds or an HTTP date) and a 429's `x-ratelimit-reset`;
  - a 429 holds every caller of the pacer until its delay passes (the limit is the account's, not the request's);
  - a delay longer than `maxDelayMs` (65 s: a daily limit) is not waited out; the response goes back as it came.
- `priceFor("<model>:free")` is $0, so a run's worst-case reservations no longer refuse calls that cost nothing.

**`packages/sim/src/lab`**

- `free.ts`: the flags every live runner takes, read once into a `LabAccess`:
  - `--allow-logging`: required by any free model; a run naming one without it stops before its first call.
  - `--rpm N`: default 18 when any of the run's models is free, else no limit.
  - `--max-requests N`: the run's request cap. Default none.
  - `labModel` (Eden's judge and card maker through the pacer, with the logging choice), `piModelFor` and
    `piRegistry` (a Pi model definition for any OpenRouter id, free ones included, on the lab's own provider: pi-ai's
    generated catalog has no `:free` variants), `providerPrefs`, `isCapError`.
- `pi-ab.ts`: the agent (through pi-ai's `fetch` option, with pi's own retries off so the pacer is the only retry
  layer), Eden's judge and cards, and the grader all go through one pacer. A reported cost stands, $0 included; only a
  usage chunk with no cost at all is priced. A task starts only while the cap leaves room for a whole task and its
  grading (`MAX_STEPS` + 1 = 7 requests); after that the run stops starting tasks, grades what it has, and writes
  `partial: true` and `requests` (sent, retried, refused, retryable statuses seen) into the results file. A task the
  cap cut off records `request cap reached` as its error, not a model failure.
- `cards-enrich.ts`: the card maker through the pacer; at the cap the workers stop and the summary says `stopped`.
- `hidden-funnel.ts --judge live`: the judge through the pacer. A judge call the cap refuses takes the engine's
  no-model path, so a run with refusals prints `PARTIAL` and is not recorded in the ledger.
- `ab-common.ts`: `chat` takes the pacer's fetch (then it does not retry HTTP errors itself, so retries do not
  multiply) and `allowLogging`; a model that refuses `response_format` is asked again without it; `parseGrade` reads
  JSON mode, fenced JSON, JSON after prose or `<think>` reasoning (the last object with numbered keys wins), and failing
  that the last `"n": true|false` pair per fact. Only `true` or `"true"` counts; anything unreadable is false, as
  before.
- `free-smoke.ts`: the smoke test below. `regrade.ts`: grades a finished run's answers again with other graders and
  reports readable replies, errors and fact-level agreement, to choose a grader.

Unchanged: the product's routing (D12), every default of every runner on paid models except that `pi-ab.ts`'s agent
retries now happen in the pacer instead of in pi-ai (same statuses, Retry-After honoured in both). `bun run eval`
makes no model call and is untouched.

## Free-model smoke test

```bash
OPENROUTER_API_KEY=… bun packages/sim/src/lab/free-smoke.ts --allow-logging \
  --models nvidia/nemotron-3.5-super-vl:free,cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free
```

One JSON-mode request a model (cap: two a model). Run in this session (3 requests):

```
nvidia/nemotron-3.5-super-vl:free: ok 1150ms via Nvidia, $0, 42 in / 93 out, json true: {"ok": true, "sum": 5}
cohere/north-mini-code:free: ok 1234ms via Cohere, $0, 26 in / 72 out, json true: {"ok": true, "sum": 5}
dots-studio/dots-3-note-preview:free: ok 2655ms via AtlasCloud, $0, 33 in / 111 out, json true: {"ok": true, "sum": 5}
requests: {"sent":3,"retried":0,"refused":0,"statuses":{},"cap":6}
```

## A small free run

```bash
OPENROUTER_API_KEY=… bun packages/sim/src/lab/pi-ab.ts --suite dev6a --variants hidden --conditions eden --limit 4 \
  --model nvidia/nemotron-3.5-super-vl:free --grader dots-studio/dots-3-note-preview:free \
  --allow-logging --max-requests 22 --config '<ALL3 with "cards": false>' --out free-pi-ab.json
bun packages/sim/src/lab/regrade.ts --results free-pi-ab.json --allow-logging --max-requests 8 --limit 4 \
  --graders cohere/north-mini-code:free,dots-studio/dots-3-note-preview:free
```

`cards` was off in the verification run so the 40-request cap went to the agent and the graders; with it on, the card
maker needs `--card-model <id>:free` and its batches count against the cap too.

## Verification (this session, 35 free requests of the 40 allowed)

| step | requests | result |
|---|---:|---|
| smoke, 3 models | 3 | all ok, JSON mode honoured, $0 each |
| pi-ab, dev6a hidden, 4 tasks, `eden`, ALL3 minus cards, agent nemotron-3.5-super-vl:free, grader north-mini-code:free | 16 | 4/4 tasks ran, 0 errors, 0 ungraded, 12 agent + 4 grader requests, 0 retried, no 429, $0.0000, 20.8 s wall |
| regrade the 4 answers, both graders | 8 | readable 8/8; the two agree 4/4 |
| regrade 4 synthetic answers that state every fact, both graders | 8 | readable 8/8; both 4/4 true |

The agent's answers raised the hidden fact in 1 of 4 tasks (board-pack: it found the 15:00 Friday deadline and
warned about it). The in-run grading by north-mini-code marked that answer false; the same grader on the same prompt
in the regrade, and dots-3-note-preview, marked it true, which is right (the answer names the deadline, the time and
Amara Okonkwo). So north-mini-code was wrong on 1 of its 12 gradings here (in-run 4, regrade 4, synthetic 4), on the
one answer that mattered; dots-3-note-preview was right on 8 of 8. dots is slower (median 7.3 s and 6.3 s against
5.4 s and 1.7 s), which grading off the critical path does not mind.

**Grader choice: `dots-studio/dots-3-note-preview:free`.** Both read reliably (16/16 replies parsed, all in JSON
mode); dots matched the correct verdict every time and north-mini-code flipped once at temperature 0. The evidence is
small (n = 8 and 12, one disagreement): treat it as a default to check, not a measured accuracy. A free-model run's
scores are not comparable with the paid runs' (different agent and grader): compare conditions within a free run.

No 429 was seen in this session, so the backoff and the hold were exercised by the unit tests (`pacing.test.ts`:
Retry-After in seconds, HTTP date, ms and epoch reset; the hold; jitter; giving up past `maxDelayMs`; the cap counting
retries and refusing mid-retry; abort while waiting), not live.

## Proposed decision

| ID | Date | Decision | Why |
|---|---|---|---|
| D86 | 2026-11-01 | Lab runs may use OpenRouter's free models, on sim data only: `--allow-logging` (lab flag; `OpenRouterOptions.allowLogging`, which `fromEnv` and so the server never set) lifts `data_collection: "deny"` and ZDR for that run; every lab request goes through one `Pacer` (default 18 requests a minute with a free model, `--max-requests` cap counting retries, 429/5xx backoff honouring Retry-After); a capped run ends early with partial results said so. The free grader is `dots-studio/dots-3-note-preview:free`. The product's routing (D12) is unchanged. | Paid credit is nearly gone and free endpoints log prompts, are limited to ~20/min and ~1,000/day per account and cost $0 (which the lab priced as unknown). Verified with 35 free requests: a 4-task pi-ab run on dev6a, 0 errors, 0 ungraded, $0; dots graded 8/8 right, north-mini-code 11/12. |
