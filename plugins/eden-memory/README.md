# Eden Memory

Passive memory for Claude Code. Durable facts persist without `remember()`. Matching notes inject later. Broken Eden never blocks the agent (`{}`).

Store: `~/.eden/memory/memories.jsonl` (`EDEN_MEMORY_DIR`, inject cap `EDEN_MEMORY_CAP`, isolate with `EDEN_MEMORY_AGENT` / project cwd). Dir `0700`, file `0600`.

Do not enable the plugin **and** `eden setup` — both attach UserPromptSubmit.

Plugin: `/plugin marketplace add .` then `/plugin install eden-memory`. Needs Bun. Works from this checkout, `EDEN_ROOT`, `eden hookd`/`eden wrap`, `eden` on PATH, or `bun $EDEN_ROOT/packages/cli/src/cli.ts hook`.

`eden setup` installs the same hooks on Claude Code plus Gemini, Codex, and OpenCode when those agents are already present. Wrap (`eden wrap`) injects the same store. Cursor-style event names (`beforeSubmitPrompt`, `afterAgentResponse`) work when the host POSTs to hookd.

UserPromptSubmit / PreCompact inject then store. SessionStart briefs constraints. Stop / SessionEnd / SubagentStop store only.
