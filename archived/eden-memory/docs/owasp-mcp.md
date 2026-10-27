# OWASP MCP Top 10

> **Compile era: a retired product direction.** Eden is now passive memory for coding agents ([docs/README.md](README.md)). This file stays in `docs/` because `isolation.md`, `evidence-pack.md` and `zdr.md` link to it; the other compile-era documents are in [archived/compile-era/](../archived/compile-era/README.md).

Source list: [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) (v0.1 beta). Eden maps each row to a control or an honest gap. **MCP08 is the audit export.**

This is not a certification. Live page: `/isolation`.

| ID | Risk | Eden control | Honest gap |
|---|---|---|---|
| MCP01:2025 | Token Mismanagement & Secret Exposure | Credential-shaped values are redacted at the control-plane ingest boundary. Status and doctor print a key fingerprint, never a prefix of the secret. Cross-origin redirects drop Authorization. | Laptop installs still keep the API key in `~/.eden/config.json` as plaintext. That file is not a vault. |
| MCP02:2025 | Privilege Escalation via Scope Creep | State-changing routes require the caller’s Clerk org to match the workspace binding. An approved tool’s steps cannot be rewritten by a later ingest. | Read routes (inbox, receipts, this audit export) are key-gated, not org-gated. A shared bearer token can list another org’s reads on that install. |
| MCP03:2025 | Tool Poisoning | Ingest cannot change what an approved tool does. Canary recompile queues a draft and never writes state On. Shadow replay uses a sandbox, not live writes. | A draft can still track a changed stretch until a human Approves. That is the product, not a second automatic gate. |
| MCP04:2025 | Software Supply Chain Attacks & Dependency Tampering | `bun.lock` pins versions for this repository. | Eden does not publish SLSA provenance or signed dependency attestations. We do not claim a supply-chain certification. |
| MCP05:2025 | Command Injection & Execution | Egress blocks loopback, private, and metadata hosts, refuses redirects into those ranges, and pins the resolved address. Compile refuses underdetermined writes rather than guessing arguments. | Laptop wrap still executes recorded Bash against the local registry. Isolation here is host-blocking, not a sandbox. |
| MCP06:2025 | Intent Flow Subversion | Underdetermined writes and commands are compile refusals. A tool turns live only after human Approve. Canary cannot Approve. | Once armed, wrap may steer a later call onto the compiled tool. That is intended serving, not a second approval. |
| MCP07:2025 | Insufficient Authentication & Authorization | Every `/v1` route requires a bearer token. Writes take the org gate. CORS echoes only localhost origins. Cross-origin state-changing POSTs are refused. | Same as MCP02: reads are not org-scoped. Unbound workspaces still work in unmanaged (laptop) installs, with a stderr warning. |
| MCP08:2025 | Lack of Audit and Telemetry | Approvals, versions, executions, and refusals export as JSONL and CSV with a sha256 hash chain (`eden audit export`). Verify fails closed on a spliced or flipped file. | The on-disk SQLite store is not itself an immutable log. The export is the tamper-evident artifact. A broken export never sits on the wrap path. |
| MCP09:2025 | Shadow MCP Servers | `eden mcp` is an explicit process the operator starts. It speaks only to the wrap control plane with the configured key. | Eden does not inventory or block other MCP servers the agent talks to on the host. Shadow servers are out of scope. |
| MCP10:2025 | Context Injection & Over-Sharing | Redaction at record time. Remainder and mutating armings are session-scoped. Read-only fleet sharing is opt-in (`EDEN_FLEET`). Result-cache keys include the workspace. Hostile `__proto__` session and fleet keys stay isolated. | Anyone holding the workspace key can read compiled program JSON for that workspace. That is the inspect surface, not a separate ACL. |
