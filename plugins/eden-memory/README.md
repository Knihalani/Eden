# Eden Memory

Passive memory for Claude Code. Durable facts persist without `remember()`. Matching notes inject later. Broken Eden never blocks the agent (`{}`). Store: `~/.eden/memory/memories.jsonl` (`EDEN_MEMORY_DIR`, cap `EDEN_MEMORY_CAP`, isolate `EDEN_MEMORY_AGENT` / project cwd, host `EDEN_MEMORY_HOST` default `127.0.0.1`). Dir `0700`, file `0600`. Do not enable the plugin **and** `eden setup` — both attach UserPromptSubmit.

`/plugin marketplace add .` then `/plugin install eden-memory`. Needs Bun. Works from this checkout, `EDEN_ROOT`, `eden hookd`/`eden wrap`, `eden` on PATH, or `bun $EDEN_ROOT/packages/cli/src/cli.ts hook`. `eden setup` installs the same hooks on Claude, Gemini, Codex, and OpenCode when present. Wrap injects the same store (`messages` or Gemini `contents[]`). Cursor-style and kebab OpenCode events work via hookd.

UserPromptSubmit / PreCompact inject then store. SessionStart briefs constraints. Stop / SessionEnd / SubagentStop store only. HTTP (`127.0.0.1:8787`): `GET /observe?text=`, `GET /inject?text=`, `GET /remember?text=`, `GET /forget?id=`, `GET /query?q=`, `HEAD`/`GET /`. Query aliases: `body`, `system`, `content`, `message`. POST also accepts `body`, `content`, `message`, and `contents[]`.
