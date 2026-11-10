# The real-data pilot kit

A way for one person to try Eden on **their own** mail and calendar, on **their own** machine, and see whether an
agent with Eden answers their real requests better than the agent alone. Built in F3 (D489,
[research/f3-asks-bench-pilot.md](research/f3-asks-bench-pilot.md)); **it has not been run on real data**: it is
tested on simulated data only. Lab tooling (`packages/sim/src/pilot/`), not product code: no server or client package
imports it.

Use it only on an account whose owner has agreed, and run it as that owner. One account, one machine.

## What it does

1. **You write your requests** (`pilot task add`): things you would really ask an assistant, and for each one the
   facts in your mail or calendar that an assistant should have known ("Friday 9:00 clashes with the school run").
   A request where nothing should change the answer has no facts; those show whether Eden makes the agent raise
   false concerns.
2. **Import** (`pilot import`): your sources are read once through Eden's own read-only connectors (the Gmail and
   Google Calendar presets, D294) and kept in a directory on your disk, with secrets removed.
3. **Run** (`pilot run`): the standard agent (the Pi harness) answers every request twice, once alone with search
   tools over the import and once with Eden, on the same data.
4. **Annotate** (`pilot annotate`): you read each answer **without being told which arm wrote it** and mark, per
   fact, whether the answer raised it, and whether it raised anything wrong or misleading.
5. **Report** (`pilot report`): the two arms paired request by request on your marks, with cost, time and turns.
6. **Forget** (`pilot forget`): everything the pilot wrote is deleted.

## Privacy: what is read, kept and sent

| Step | What happens to your data |
| --- | --- |
| import | Eden calls only each connector's read tools, and only if the server marks them read-only or you have listed them by hand (D7). Your mail and calendar provider sees ordinary read calls from your own token. Nothing is sent to anyone else: no model is called. |
| what is kept | Each item's title, text, link and fields, **after `sanitizeForStore`** (D10): API keys, tokens and passwords the gate recognises become `[REDACTED]`. Text is cut at 8,000 characters an item, 2,000 items a source by default. The redaction removes secrets, **not personal content**: the files hold your mail. |
| where | `EDEN_PILOT_DIR` (default `~/.eden/pilot`): a directory only your user can read (0700, files 0600). The kit **refuses a directory inside a git repository**, so the data cannot be committed. It is plain text, not encrypted: it sits beside your mail client's own cache, under your disk's protection. |
| run | The agent, Eden's cards, Eden's reader and the grader are model calls. They go to **Anthropic's API with your own key** (`HAIKU_API_KEY` or `ANTHROPIC_API_KEY`), and they carry your requests, the items the tools and Eden return, and the answers. `pilot run` prints this list and **does nothing until you add `--send-to anthropic`**. Only `claude-*` models are accepted: the lab's OpenRouter route does not pin the no-retention endpoints the servers use (D12), so real data does not go that way. No connector is called during a run: the agent and Eden read the import. |
| nothing else | No telemetry, no benchmark ledger, no upload. Results stay in the pilot directory. |
| forget | `pilot forget` deletes the directory. Your tasks and marks go with it. |

**How this differs from the server (D8, D425).** A running Eden server keeps item content in memory only (D8), or
encrypted on disk when the operator opts in (D425). The pilot keeps one person's redacted items in plain files so
that both arms answer from exactly the same data and a run can be repeated. That is a departure from D8, recorded
in D489, and it is acceptable only because the person running it is the person whose data it is. Do not use the kit
to hold anyone else's data, and do not copy the directory off the machine.

## Steps

```bash
export EDEN_PILOT_DIR=~/eden-pilot            # optional; anywhere outside a git repository

# 1. Your requests, before you look at any answer.
bun run pilot task add --id dentist --text "Book the dentist for Friday morning" \
  --fact "Friday 9:00 is the school assembly I said I would attend"
bun run pilot task add --id thanks --text "Thank Priya for lunch"         # nothing should change this one
bun run pilot task list

# 2. Your sources: one JSON array, the same format as a user's entry in EDEN_USER_SOURCES_FILE (INTEGRATION.md).
cat > ~/pilot-sources.json <<'JSON'
[
  { "preset": "gmail", "id": "gmail", "url": "https://…your Gmail MCP server…/mcp",
    "headers": { "Authorization": { "env": "PILOT_GMAIL_AUTH" } } },
  { "preset": "google-calendar", "id": "calendar", "url": "https://…your Calendar MCP server…/mcp",
    "headers": { "Authorization": { "env": "PILOT_CALENDAR_AUTH" } } }
]
JSON
export PILOT_GMAIL_AUTH="Bearer …" PILOT_CALENDAR_AUTH="Bearer …"      # never written to disk by the kit
bun run pilot import --sources ~/pilot-sources.json --name "Your Name" --email you@example.com
bun run pilot status

# 3. Run: prints what would be sent; add --send-to anthropic to start. --cap is a hard dollar cap.
bun run pilot run --model claude-haiku-5-5 --cap 0.50
bun run pilot run --model claude-haiku-5-5 --cap 0.50 --send-to anthropic

# 4-6.
bun run pilot annotate
bun run pilot report
bun run pilot forget
```

Notes on the import:

- **Gmail** is read through its listing (newest threads first, up to `--max-items`, default 2,000) and by searching
  for each of your requests' own words and any `--query "…"` you add.
- **Google Calendar** has no listing in its preset, so it is read **only by search**: your requests' words and your
  `--query` values. Add queries for the people and weeks your requests are about, or the calendar side will be thin.
- If a server does not mark its read tools read-only, the connect is refused (D7). Check the tool by hand and add
  `"trustedReadTools": ["search_threads"]` to that source only if it truly only reads.
- A source that fails leaves the others' items; its error is printed with secrets removed.

## Reading the report

The report counts, on requests where something mattered, how many answers raised at least one such fact in each arm,
how many only one arm raised, and an exact sign test on those. It lists the answers you marked wrong or misleading in
each arm, and each arm's cost, time and model turns a request. The model grader's verdicts are shown beside your
marks for comparison and never replace them.

**A pilot is small.** With fewer than about 20 requests only a large difference is distinguishable from chance: at
least six requests must differ between the arms, all in one direction. Treat a smaller pilot as a look at real
answers. The lab's simulated benchmarks (LAB.md) are where effects are measured; the pilot says whether they look
true on one real account.

## What it cannot tell you

- The import is a snapshot: nothing arrives or changes during a run, so Eden's handling of updates is not exercised.
- The agent's tools are the lab's simulated connectors over your import (their search behaviour and assumed
  latency), not your provider's live search.
- One request a session: no multi-day memory effects.
- Cost and time are Anthropic-direct lab figures (D97), not the OpenRouter route a server ships with.

## Files

`packages/sim/src/pilot/`: `store.ts` (the directory), `import.ts`, `world.ts` (the import as a lab world;
`pi-ab --world-file`), `annotate.ts`, `report.ts`, `pilot.ts` (the CLI), `pilot.test.ts` (sim data only).
