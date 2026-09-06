# Eden Memory

Passive memory for Claude Code. Durable facts from conversation are stored without `remember()` calls. Matching notes are injected on later prompts. Broken Eden never blocks the agent (`{}`).

Store: `~/.eden/memory/memories.jsonl` (override with `EDEN_MEMORY_DIR`).

## Install — pick one

Do not enable the plugin **and** `eden setup`. Both attach UserPromptSubmit, so notes would duplicate.

### Plugin (Claude Code only)

`/plugin marketplace add .` then `/plugin install eden-memory`. Needs Bun. Works from this checkout, or with `eden hookd`/`eden wrap` running if the marketplace copy is the plugin folder alone.

### `eden setup`

Installs the same memory hooks on Claude Code plus SessionStart/Stop observe on Gemini, Codex, and OpenCode when those agents are already present. Wrap (`eden wrap`) injects the same store into OpenAI-shaped traffic.

## What fires

| Event | Behavior |
| --- | --- |
| UserPromptSubmit, PreCompact | Inject relevant notes, then store this turn |
| SessionStart | Brief stored constraints (and observe the transcript if present) |
| Stop, SessionEnd | Store from the transcript; no inject |
| OpenCode `chat.message` / `session.created` | Same inject + brief via `eden setup` plugin |
