# MemoryAgentBench × Eden

Product Table 3 scores use **`openMemory` inject** (`inject-bridge.ts`, `inject-agent.py`,
`run-table3-inject.py`) plus a hosted NVIDIA NIM reader (`google/gemma-4-31b-it`, disclosed).
See `INJECT-API.md`, `PROTOCOL.md`, and `TABLE3-RESULTS.md`. k=10. Official lengths.
Live runner config: `table3-inject.config.json`.

`mab-bridge.ts` / `eden.py` talk to Eden `BrainMemory` (`cortex: false`). That path is
**not-product** and must not be published as the wrap/hook scoreboard.

Official ICLR 2026 harness (`HUST-AI-HYZ/MemoryAgentBench`) is cloned outside this
repo. Do not put API keys here.
