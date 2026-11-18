# Eden for Hermes Agent — getting started

Eden is a context partner that runs privately beside Hermes Agent: it reads the sources you connect
(read-only), answers `ask_context`, injects relevant context before each model call, and checks acting
tool calls before they run. Everything stays on this machine; no Eden account, API key, Bun install, or
separate server is needed.

## 0. Install Hermes Agent (once)

Hermes 0.21.5 is not on PyPI, so install it from its release tag into a Python **3.12 or 3.13**
environment (Hermes rejects 3.14):

```bash
git clone --branch v2026.9.24 https://github.com/NousResearch/hermes-agent
cd hermes-agent && UV_PYTHON=3.12 uv sync   # or: python3.12 -m venv .venv && .venv/bin/pip install -e .
```

## 1. Install Eden

1. Download the archive for your OS and CPU from
   [Eden Releases](https://github.com/Knihalani/Eden/releases) and check it against `SHA256SUMS`
   (`sha256sum FILE` on Linux, `shasum -a 256 FILE` on macOS, `Get-FileHash FILE -Algorithm SHA256` on
   Windows). Extract it.
2. Inside the extracted directory run `python3 install.py` (Linux/macOS) or `py -3 install.py`
   (Windows; Python 3.10+). It installs into your active Hermes profile (`--profile NAME` or
   `--hermes-home PATH` for another), then starts the Eden sidecar once to prove it runs on this
   machine — a bad `sources.json` you already had is reported here too (`--no-check` skips this).
3. Run the `plugins enable` command it prints, then open a new Hermes session (or restart the
   gateway). If you restrict toolsets, include `eden` in `hermes tools` or `--toolsets`.

## 2. Give Eden something to read

With no sources configured Eden stays quiet. For a working first answer in one step, run
`install.py --example`: it writes a small demo source to `eden/sources.json` under your Hermes
profile. Then ask Hermes *"when does my gym membership renew?"*

For your own data, write `eden/sources.json` under the profile with this exact shape — a `users`
object keyed `<tenant>/<user>` (local mode is always `local/local`):

```json
{"users": {"local/local": [
  {"kind": "static", "id": "notes", "description": "My notes",
   "docs": [{"ref": "1", "title": "Gym renewal", "text": "Your gym membership renews on 1 December."}]}
]}}
```

Live connectors are `"kind": "mcp"` entries with a `url` and the connector's read tool names; keep
tokens in `{"env": "NAME"}` headers, never in the file. You can also point the Hermes process at a
file with `EDEN_SOURCES_FILE` (static, shared) or `EDEN_USER_SOURCES_FILE` (per-user). The full
format and MCP options are in the repo's `docs/INTEGRATION.md`, "Connect sources explicitly".

## Troubleshooting

- Eden failing never breaks Hermes: a missing or crashed sidecar just means no Eden context.
- Startup diagnostics go to `eden/logs/eden-local.log` under your Hermes profile.
- An explicit `EDEN_URL` selects a hosted Eden instead of the local sidecar; remove it for local mode.
- To uninstall: `hermes plugins disable eden`, then delete `plugins/eden` under the Hermes home.
