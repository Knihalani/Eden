# Fix S6: privacy gaps (RealUse-1 weak point 10)

Status: done 2026-11-07 on branch `claude/fix-s6-privacy`. Decisions D220 and D221. No paid calls ($0). Every
number below comes from a command run in this session, on a shared 4-core container, with `OPENROUTER_API_KEY`
unset. The plan is [realuse-1-weak-points.md](realuse-1-weak-points.md), issue 10; the gaps were found by
[RealUse-1 part D](realuse-1/D-decisions-freshness-robustness-privacy.md), T6.

## What changed

1. **Secret gate (D220, `packages/redact`).**
   - `eden-new-relic`: a bare New Relic user key, `NRAK-` plus 27 letters or digits, any case. gitleaks' rule needs
     "new relic" within reach, so a key pasted alone passed.
   - `eden-presigned-url`: the value of `X-Amz-Signature`, `X-Goog-Signature` and `X-Amz-Security-Token` in a URL
     query. Only the value goes, so the URL still names the object. It matches the URL as written plainly, in JSON
     from a Go server (`&` as `\u0026`), and percent-encoded inside another URL (`%26`, `%3D`). The reviewer found
     the last two missing from the first version.
   - The value is an unrolled loop, with the length checked in code. A first version with a lookahead at every
     character cost 240 ms per MB on one long value, against 3.5 now.
   - **The decision on presigned URLs: redact.** D187 left them alone because they expire. This reverses that. A
     SigV4 presigned URL lasts up to 7 days, and whoever holds it can read (or write) a private object. Eden stores
     it, indexes it and sends it to a model, so an expiry does not make it safe. The cost is a dead link in Eden's
     copy only: the source still holds the live one.
2. **One line sanitiser (D221, `packages/engine/src/line.ts`).**
   - `safeLine(text)` makes text safe as part of one line:
     - it removes C0/C1 controls and bidi embeddings, overrides and isolates;
     - it collapses every line break (LF, CR, CRLF, VT, FF, NEL, U+2028, U+2029) and whitespace run to one space;
     - it removes the direction marks (U+061C, U+200E, U+200F) and the Unicode tag characters (U+E0000–U+E007F), which
       a person cannot see but a model reads (the reviewer's hardening point); zero-width joiners stay, for emoji;
     - it escapes `<` and its full-width (U+FF1C) and small (U+FE64) look-alikes as `&lt;`;
     - it trims. It is idempotent.
   - `safeBlock(text)` applies the same rules to fenced multi-line text, but keeps the lines, each break written as
     one LF.
   - Both are exported from `@eden/engine`.
   - Callers now: `judge.ts` (candidate lines use `safeLine`, the conversation uses `safeBlock`) and
     `packages/server/src/mcp.ts` (source id, title and URL of each Sources line).
3. **A bug fixed on the way: the judge prompt could be forged.** Candidate text in the judge's prompt kept its line
   breaks (only the title went through `oneLine`). So a candidate whose text held `\n[8] (calendar) …` showed the
   model a ninth candidate. `regressions.test.ts` failed before the fix. The judge is lab-only (the servers wire
   none), so no shipped prompt changed.
4. **Part D's injection probe is now a standing test**: `packages/engine/src/injection.test.ts`, in `bun run check`.
   - It runs 20 payloads (part D's 18, plus VT/FF in text and NEL/CRLF in a title) through a real default
     `ContextPartner` by observe and by ask, and puts all of them in one judge prompt.
   - Every packet and answer must be one envelope with no raw `<` inside and one item line per cited item. The judge
     prompt must hold exactly one line per candidate and one of each fence.
   - Mutation check: reverting the judge fix fails the judge case; reverting render.ts's NEL handling fails
     `nel-line-break` and `title-nel-crlf`.

## For the merge: call sites left to their owners

These sessions own the files below, so their call sites were not changed here. Each should become
`safeLine`/`safeBlock` from `./line`. The behaviour change is small: controls, bidi characters and `<` look-alikes
also go.

- **`packages/engine/src/render.ts`** (S2):
  - lines 85-92, `renderPacket`'s item line: `inert(oneLine(note))`, `oneLine(item.title)` then `inert(named)`, and
    `inert(oneLine(prefix))` → `safeLine(…)`. The `|` → `/` swap on the reader note stays.
  - line 131, `renderAnswer`: `inert(answer.trim())` → `safeBlock(answer.trim())`.
  - line 151, `oneLine`, and line 138, `inert`: delete them once nothing imports them. The engine index exports both
    today; `mcp.ts` no longer uses `oneLine`.
  - What `oneLine` misses today: U+001C–U+001E (Python's `splitlines` breaks on them), other controls, bidi overrides
    and `＜`.
- **`packages/engine/src/reader.ts`** (S1), lines 277-302, `readerMessages`:
  - `from="${inert(it.from)}"` does not strip `"`, unlike `source` and `date`. A sender name holding `"` can close
    the attribute and add attributes of its own to the `<item>` tag. It should be `safeLine(it.from).replace(/"/g, "")`.
  - Title, text and card are `inert` only. Their line breaks stay inside the `<item>` fence, so they cannot forge
    another item, but `safeLine` on the title and card (and `safeBlock` on the text) would make the prompt match the
    other prompts.
  - `<request>`, `<question>` and `<today>`: `safeBlock`/`safeLine`.
  - The reader's replay cache is keyed by the prompt. Changing it shifts the keys only for items holding the affected
    characters. Check with `bun run funnel` replay misses.

## The sweep: every other place source or event text enters a model prompt

Only three files build model prompts: `judge.ts`, `cards.ts` and `reader.ts`. `partner.ts` calls the judge, and
`intent.ts` rides on the card call's prompt. The sweep found no others in engine, server, sources or client: grep for
`.chat(` and for `role: "system"`/`"user"`, outside `packages/sim`.

- `judge.ts`: fixed here (above).
- `reader.ts`: listed above (S1).
- **`cards.ts`** (S3a, being edited; not changed here), `cardMessages` at line 291:
  - The title (`inert(sanitizeForStore(…))`) sits on its own line inside `<item>`. A line break in it makes a line
    that reads as the item's text. It cannot leave the fence, so this is minor; it should be `safeLine`.
  - The text is fenced and multi-line by design; it should be `safeBlock`.
  - `source="${inert(sourceId)}"` keeps `"`, but source ids come from the operator's config, not from source text.
  - `INTENT_INSTRUCTIONS` holds no item text.
- **`intent.ts`** (S3a): the requests are model output. They are cleaned with `/\s+/` (no NEL) and then
  `sanitizeForStore`, and are never shown to the agent or put in a prompt, so this is not a prompt sink.
- Other text the agent gets: every delivery goes through `renderPacket` or `honestAnswer` (render.ts, and source ids
  only). `client/src/messages.ts` wraps the server's enveloped text and the agent's own tool name. The firewall's
  finding is a packet.

## Numbers

### Secret probe

```bash
env -u OPENROUTER_API_KEY bun packages/sim/lab/realuse-1/D/probes/privacy-probe.ts --reps 3 --json out.json
```

Five presigned rows were appended after the original 50, so those keep their seeded values. "Before" is the base tree's
`secrets.ts` (`97d381ee`).

| | Before | After |
|---|---:|---:|
| Original 50 shapes redacted | 48 (missed `new-relic-bare`, `sentry-dsn`) | **49** (missed `sentry-dsn`, public by design) |
| Presigned rows redacted (S3 signature, S3 session token, GCS signature, JSON-escaped, percent-encoded) | 1 (the session token, by the keyword rule) | **5** |

### ReDoS: 1 MB crafted shapes, best of 3

"First" is the first version of the rules (commit `c8befcef`), "final" the version after review. The added shapes come
after the original 30.

| | Before | First | Final |
|---|---:|---:|---:|
| Worst of the original 30, `sanitizeForStore` | 77.3 ms (`keyword-near-entropy`) | 77.1 ms (`password-eq-repeat`) | 68.3 ms (`password-eq-repeat`) |
| `presigned-param-repeat` (`&X-Amz-Signature=` + 15 hex, repeated) | 14.6 ms | 13.0 ms | 26.0 ms |
| `nrak-near-miss` (`NRAK-` + 26 letters, repeated) | 45.6 ms | 46.5 ms | 57.5 ms |
| `presigned-encoded-repeat` (`%26X-Amz-Signature%3D` + 14 hex) | – | – | 16.2 ms |
| Worst `redactString` / `redact` | 11.2 / 11.6 ms | 14.7 / 12.4 ms | 10.5 / 20.4 ms |

Part D measured the worst case as 65 ms on its run. The spread between runs here is load on the shared box (the
`nrak-near-miss` row moves 46-58 ms with no change to its rule).

Size scaling (a scratch script, best of 3, ms per MB at 0.25 / 1 / 4 MB), final rules:

| Shape | 0.25 MB | 1 MB | 4 MB |
|---|---:|---:|---:|
| `presigned-param-repeat` | 40.2 | 31.8 | 18.9 |
| one long signature value | 3.4 | 3.5 | 3.5 |
| `presigned-encoded-repeat` | 9.9 | 12.7 | 13.1 |
| `\u0026x-amz-security-token=` repeated | 57.7 | 52.7 | 52.5 |
| `nrak-near-miss` | 52.6 | 46.9 | 46.5 |
| `password-eq-repeat` (part D's worst) | 73.4 | 73.8 | 73.1 |

No row grows faster than its size, so time is linear. On the first rules, the one-long-value row was 4.3 / 4.2 / 4.1
before the end-of-value change and 292 / 240 / 71 with the per-character lookahead; the unrolled loop fixed it.

### Gate bench

`bun packages/primitives/bench/gate.bench.ts`, shipped gate, mean µs. Two runs each:

| Input | Before | After |
|---|---:|---:|
| 256 B | 4.68 / 3.23 | 5.20 / 4.32 |
| 2 KB | 12.63 / 19.89 | 13.20 / 10.14 |
| 16 KB | 119.1 / 130.2 | 151.5 / 120.6 |

Within noise. The new rules run only when the prefilter sees `nrak-`, `x-amz-` or `x-goog-`.

### Injection

- `injection.test.ts`: 21 tests pass (20 payloads plus the judge prompt). `line.test.ts`: 16.
- Part D's script, `injection-probe.ts`: 36 texts, 0 envelope broken, 0 raw `<` inside, 0 stray lines.

### Gate and eval

- `bun run check` on the final tree: format, types and 1,869 tests, 0 failures (1,862 before the review fixes).
- `bun run eval` (no model): precision 0.8276, recall 0.48, falseFireRate 0, 31 scenarios and 148 turns; privacy 0
  leaked, 0 of 30 not inert. This matches part D's T2.
- Funnel: not run. No shipped path changed: the judge is not wired by the servers, and render.ts and reader.ts are
  untouched.

## Left open

- **Sentry DSN:** not redacted. Its key is public by Sentry's design.
- **New Relic, other key kinds:** `NRII-`, `NRJS-` and the 64-character user API id still need the vendor name
  nearby, as gitleaks has them. Only `NRAK-` (the user key, which reads account data) is bare-matched.
- **Other signed URLs** carry the same bearer capability, but their signature parameter has a generic name, so a bare
  rule would fire on unrelated URLs. Each needs an anchor in the same query:
  - CloudFront: `Signature=`, anchored by `Key-Pair-Id=`;
  - legacy SigV2 S3 and GCS: `Signature=`, anchored by `AWSAccessKeyId=` or `GoogleAccessId=` (the S3 key id alone
    is already caught by `eden-legacy-token`);
  - Azure SAS: `sig=`, anchored by `sv=` and `se=`.
- **Packets keep some characters until render.ts moves.** render.ts's `oneLine` + `inert` keep controls, bidi
  characters and `<` look-alikes. `injection.test.ts`'s check covers line breaks and ASCII `<` only. Once render.ts
  uses `safeLine`, widen its `faults` to controls, bidi and look-alikes too.
- **The ReDoS control flakes.** `redos.test.ts`'s control ("still flags a rule that backtracks") read 39.8 ms against
  its > 40 ms expectation once, and failed 1 run in 3 here. It times a deliberately backtracking engine, not a
  shipped rule, as part D's note records.
