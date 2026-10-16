# Eden

Passive memory for coding agents. You should almost never have to tell your agent something twice. Eden records what you say and what the agent learns about the repo, and on a later turn it puts the matching note in front of the agent, or stays silent. The agent never calls a memory tool and you never call `remember()`.

It runs as Claude Code hooks (a plugin), as hooks on Gemini CLI, Codex and OpenCode (`eden setup`), and inside an OpenAI-compatible proxy for other agents (`eden wrap`).

## What it remembers

- **Rules and intents you state.** "Never push to main", "use pnpm", "don't touch the billing module until the migration lands". A rule stated with "never" or "always", or said again in a second session, becomes a pin. An intent ends when you release it, or after 7 days.
- **Facts, with history.** A newer statement replaces an older one; the old value stays as history, not as a live fact.
- **Repo facts from the repo's own files.** Package manager, node version, framework, test runner, auth SDK, database, CI. Each is cited by the files that state it ("from pnpm-lock.yaml") and re-read when one of those files changes.
- **Across sessions.** Every session of a repo writes to the same store, so a later session gets an earlier one's notes when its prompt matches them.

## How it delivers

- **On each prompt** (UserPromptSubmit): a small packet, at most 6 bullets and 900 bytes by default, or nothing. The cue is the situation, not only the prompt: what you typed, what the agent just said, and the files in play, so "yes, do it" after a proposal gets the memory for the files that proposal names. Non-human turns (task notifications, agent messages) get nothing but `Updated:` items, and chatter after a report ("thanks", "ok") gets nothing.
- **At session start** (SessionStart): up to 3 pinned rules for the folder you are likely in, and `Updated:` items for values that changed since the last session. After a compaction it briefs the latest session gists instead; a resumed session gets nothing, as it already holds its packets.
- **Not twice in a row.** Each context window keeps a ledger of what it was given. Nothing delivered recently in the window, and nothing your `CLAUDE.md` (or `AGENTS.md` where there is none) or Claude's auto-memory `MEMORY.md` already states, is injected. A compaction or `/clear` re-arms what the window lost, and a note becomes eligible again once enough of the conversation has passed.
- **Scoped to the repo and folder.** One store per repo, keyed by its git common dir, so every session, worktree and subagent of a repo shares it and two repos never do. Notes are scoped to product folders (`apps/web`, `packages/api`); a folder's rules apply in its subfolders, and a turn in one folder never gets a sibling folder's notes.

Subagent briefs, tool-batch deliveries and the policy guard (which re-delivers a rule to the agent when a command is about to break it) ship in `shadow`: they record what they would have delivered and print nothing until their flag is turned on. The guard's ask, which stops an irreversible command for your confirmation, ships `off`. See [Delivery flags](packages/cli/README.md#delivery-flags).

## Guarantees

- **Fails open.** Every hook exits 0 and prints nothing on error. A broken Eden never blocks the agent or erases your prompt.
- **No model on the hook path.** No LLM and no embedding call in any hook. Retrieval is lexical and local.
- **Local.** The store is JSONL under `~/.eden/memory` (`EDEN_MEMORY_DIR` or `$EDEN_HOME/memory`), directories `0700`, files `0600`. No memory hook makes a network call; what memory injects reaches your model provider as part of the prompt, like anything else in context. (The hooks `eden setup` writes also run a retired tool recorder: see Install.)
- **Secrets stay out.** Pasted text never becomes a rule or a fact, and a gitleaks-plus-keyword scan redacts secrets before anything is stored. `eden memory forget --secret <regex>` redacts one after the fact.
- **Off switches, narrowest first.** A delivery point's flag (next event), `EDEN_MEMORY=off` or `readonly` (next session), disabling the plugin, or Claude Code's `disableAllHooks`. An unhandled exception at a delivery point turns it to `shadow` for 24 hours on its own.

## Install

Needs [Bun](https://bun.sh). This tree is private: install from a clone, not a registry (`eden` on npm is someone else's package).

```bash
git clone <this repo> eden && cd eden
bun install
alias eden='bun packages/cli/src/cli.ts'   # or: bun run cli -- <command>
```

**Claude Code (plugin).** In a Claude Code session started in the clone:

```
/plugin marketplace add .
/plugin install eden-memory
```

Then `eden doctor --memory` checks that the hooks are registered, that the installed plugin copy matches the checkout, and that Eden loads within the 150 ms Submit budget. After pulling a new version: `claude plugin marketplace update`, then `claude plugin update eden-memory@eden`. Details: [plugins/eden-memory/README.md](plugins/eden-memory/README.md).

**Gemini CLI, Codex, OpenCode (and Claude Code without the plugin).** `eden setup` always writes Claude Code's hooks (`~/.claude/settings.json`), and Gemini CLI's, Codex's and OpenCode's when their config folders exist (`--all-agents`: always). Do not use it together with the plugin: both attach UserPromptSubmit, so a plugin user who runs it for Gemini also gets duplicate Claude hooks. Besides memory, these hooks run the retired compile-era tool recorder: each tool call's redacted arguments and result go to `~/.eden/runs/`, and once `~/.eden/config.json` holds a key (the first `eden wrap`, `eden login`, or `eden setup` given a key writes one) tool stretches are posted to that wrap's `/v1/traces`; and once you have approved a compiled tool, these hooks can steer or deny a call, or replace its result, to serve it. The plugin runs memory only. `eden doctor` names each host as ok, half-wired, skipped or not installed; Codex can drop hooks silently when a project is not trusted.

**Other agents (OpenAI-compatible).** `eden wrap` starts a local proxy at `127.0.0.1:8788` that injects the same store into the request (`messages`, or Gemini `contents[]`). Point the agent at it with `OPENAI_BASE_URL=http://127.0.0.1:8788/v1` and keep `OPENAI_API_KEY` as your model key. Memory is served only to the operator: start wrap with the same `OPENAI_API_KEY`, or send the Eden key as `x-eden-api-key`.

## Everyday commands

```
eden doctor --memory                 hooks, plugin copy, load time, flags, kill switches
eden memory remember "<text>"        store a note now (--global: a rule for every repo)
eden memory dump [--json]            what the store holds
eden memory scopes [<path>…]         the folder scopes Eden sees in this repo
eden memory forget --all-in <scope>  send a folder's rules and keyed facts to history
eden memory forget --secret <regex>  redact a secret everywhere in the store
eden memory purge <regex>            redact matching text everywhere in the store
eden memory import <path>            read existing transcripts into memory (local)
eden memory migrate --dry-run        move pre-per-repo stores into per-repo ones
eden sleep                           consolidate and mine repo facts now (it also runs on its own when idle)
eden eval build-negatives            build your private set of prompts that need no memory
```

Every environment variable, flag and file is documented in [packages/cli/README.md](packages/cli/README.md).

## Status

Early. The memory program is planned and tracked in [docs/memory-ship/](docs/memory-ship/): [PROGRESS.md](docs/memory-ship/PROGRESS.md) says which slices are done (the per-repo store, the trust gate, the ledger, rules and the guard, folder scopes, repo facts) and which are next (ranking, the evidence gate, gotchas, how-to). Each merged slice has a report in [docs/memory-ship/reports/](docs/memory-ship/reports/) with its measured numbers.

## Repository

| Path | What it is |
|---|---|
| `src/` | The memory engine: encode, store, retrieve, deliver, sleep |
| `packages/cli/` | The `eden` CLI and the hook entry points ([README](packages/cli/README.md)) |
| `plugins/eden-memory/` | The Claude Code plugin ([README](plugins/eden-memory/README.md)) |
| `packages/wrap/` | The proxy: memory injection for OpenAI-compatible agents |
| `benchmarks/memory-long-horizon/` | The evaluation harness and arms that gate each slice |
| `docs/` | Specs, decisions and reports ([index](docs/README.md)) |

Eden used to be a tool-path compiler (record repeated tool stretches, compile them, serve them after a human Approve) and, before that, an observability platform. Their code is still in the tree (`packages/compile`, `runtime`, `shadow`, `measure`, `know`, `sdk-js`, `sdk-py`, the "compile traces into a tool" commands in `eden --help`) but it is not the product. Their documents are in [archived/compile-era/](archived/compile-era/README.md) and [archived/](archived/README.md).

## Development

CI is four steps, run locally (GitHub Actions is off): `bun run format:check`, `bun run typecheck`, `bun run test` (or `bun run test:parallel`), and `EDEN_SKIP_CHECKS=1 bash scripts/build-cli.sh`. Contributor and agent rules are in [CLAUDE.md](CLAUDE.md).
