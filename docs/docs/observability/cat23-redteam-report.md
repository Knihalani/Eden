---
status: STUB
gate: 3
ship_phase: v1.6 weeks 27-28 (red-team review)
---

# Cat 23 Gate 3 — sandbox red-team review

> **This is a STUB report.** The real report is produced by an external
> security engineer (red-team engagement, 1-week on-site, $15-30k) once
> Gates 1+2 ship. Until then, this document tracks the isolation
> guarantees the design provides + the threat model the red-team is
> asked to validate.

## When to use

* After Gate 1 (CODEOWNERS parser + read-only connectivity) + Gate 2
  (attribution accuracy + line range) ship to production
* Before Gate 4 (real PRProvider end-to-end) is enabled for any org
* Before any auto-mode opt-in (`auto_pr_enabled` or
  `auto_revert_enabled`) is granted to an org

## Scope of the red-team review

The red-team is asked to validate that the
:class:`eden.providers.sandbox_isolated.IsolatedSandboxProvider`
provides the isolation guarantees required by Cat 23 §23
("Autonomous Code Modification") in `upgradespec-v2.md` §23.4.

### What the red-team is asked to break

1. **Network egress** — the sandbox subprocess can NOT reach:
   * The public internet (other than `api.github.com` + the Eden
     control plane, which are explicitly allowlisted via the host
     firewall rules)
   * The host's local network (other tenants' pods / databases)
   * The host's loopback (`127.0.0.1`, `::1`)
   * Other sandbox processes' IPC channels

2. **Filesystem escape** — the sandbox subprocess can NOT:
   * Modify the host filesystem
   * Read files outside the per-run workdir + the tmpfs scratch dir
   * Persist state across runs (each run gets a fresh tmpfs)
   * Write to the customer's repo checkout (mounted read-only)

3. **Process isolation** — the sandbox subprocess can NOT:
   * See other tenants' processes (`/proc` is per-namespace)
   * Affect the host's process table
   * Survive the parent `unshare` wrapper being killed (the wall-clock
     timeout reaps the subprocess)

4. **Resource isolation** — the sandbox subprocess can NOT:
   * Consume more than the configured CPU-seconds (`SANDBOX_CPU_LIMIT_OVERRIDE`)
   * Allocate more than the configured RSS (`SANDBOX_MEMORY_MB_OVERRIDE`)
   * Run longer than the configured wall-clock cap
     (`SANDBOX_WALL_CLOCK_OVERRIDE`)

### What the red-team is NOT asked to validate

* The model's output safety (the LLM is read-only here; the patch
  generation happens outside the sandbox in `PatchGenerator`).
* The CODEOWNERS parser (Gate 1) — already covered by unit tests.
* The line-range extractor (Gate 2) — already covered by unit tests.
* The host's general security posture (separate engagement).

## Isolation guarantees provided

### Linux namespaces (production path)

The :class:`IsolatedSandboxProvider` spawns the subprocess via
`unshare(1)` with these flags:

| Flag | What it isolates |
|---|---|
| `--mount` | The mount table — the tmpfs scratch dir doesn't leak into the host |
| `--pid` | Process IDs — the subprocess can't see other tenants |
| `--uts` | Hostname — the subprocess sees a stable per-sandbox hostname |
| `--ipc` | System V IPC — no cross-tenant message queues |
| `--net` | Network interfaces — **NO interfaces inside** means no egress |
| `--fork` | The namespace survives the parent's exit |
| `--kill-child` | The subprocess is reaped when `unshare` is killed (timeout) |

### Resource limits

The subprocess is wrapped in a `preexec_fn` that applies:

* `RLIMIT_CPU` — soft + hard CPU-seconds cap (SIGXCPU at soft,
  SIGKILL at hard)
* `RLIMIT_AS` — virtual address space cap (memory in MB)

Defaults: 120 CPU-sec + 4 GB + 15 min wall-clock.
Enterprise tenants override via
`SANDBOX_CPU_LIMIT_OVERRIDE_<org_id>` /
`SANDBOX_MEMORY_MB_OVERRIDE_<org_id>` /
`SANDBOX_WALL_CLOCK_OVERRIDE_<org_id>` (or `_GLOBAL` for fleet-wide).

### Filesystem

The customer's repo checkout is mounted read-only at `spec.workdir`.
The subprocess writes to a tmpfs scratch dir that is discarded on exit.
**Note**: the read-only mount is set up by the worker process BEFORE
spawning the sandbox; the red-team is asked to validate that the
mount is enforced (no `mount -o remount,rw` from inside the sandbox).

### macOS / dev fallback

On macOS (where `unshare` is unavailable) the provider falls back to
:class:`LocalSandboxProvider` and logs a warning. **This is the dev
path, NOT the production path.** The audit log records
`fallback_to_local_actual=True` so any production run on macOS is
visible.

## Threat model

### Adversary capabilities

The red-team assumes:

* A determined attacker who can craft the input to the sandbox (the
  RCA description, the diff, the test plan)
* Knowledge of the sandbox's isolation boundaries (this document is
  public)
* Ability to time the attack across multiple sandbox runs

### What the adversary CAN do

* Read the contents of the customer's repo checkout (mounted read-only
  inside the sandbox)
* Read their own env vars
* Write to the tmpfs scratch dir (and read what they wrote)
* Trigger the CPU/memory/wall-clock limits (the run fails cleanly)

### What the adversary CANNOT do (per the design)

* Reach any host or remote endpoint (no network interfaces)
* Read other tenants' data (per-PID namespace)
* Persist state across runs (tmpfs discarded)
* Escalate to the host UID (same UID as the worker, but no path
  to escalate beyond the namespace boundary)

## Test plan for the red-team

The red-team is given:

1. **Source code** — the full
   :mod:`eden.providers.sandbox_isolated` module + the worker
   subprocess script
2. **Documentation** — this document + the v1.6 ship plan Cat 23 §23
3. **A staging tenant** with the isolated sandbox configured

The red-team is asked to:

1. Attempt a network-egress exploit (DNS rebinding, IPv6 router
   advertisements, ICMP redirects, etc.)
2. Attempt a filesystem-escape exploit (`/proc/self/root/...`,
   `mount --bind`, `chroot`, `pivot_root`)
3. Attempt a process-escape exploit (ptrace a sibling, write to
   `/proc/<pid>/mem`, signal the host PID 1)
4. Attempt a resource-exhaustion exploit (fork bomb, memory leak,
   CPU spin)

Each exploit attempt is graded:

* **Fail closed** — the sandbox kills the subprocess with a
  deterministic failure envelope; the worker logs the attempt
* **Fail open** — the exploit succeeds; the red-team documents the
  attack vector + recommends a fix

## Acceptance criteria

Gate 3 is considered passed when:

1. The red-team signs off on the isolation guarantees (no "fail open"
   findings, or all "fail open" findings have documented fixes that
   ship in a follow-up release)
2. The red-team's report is published at
   `docs/docs/observability/cat23-redteam-report.md` (replacing this
   stub)
3. The ops team has a runbook for responding to a sandbox escape
   incident (added to `docs/runbooks/`)

## Cost + timeline

| Item | Cost | Lead time |
|---|---|---|
| External security consultant (1-week engagement) | $15-30k | 2-4 weeks to schedule |
| Internal security engineer (if available) | FTE allocation | 1-2 weeks |
| Red-team report writing | included | +1 week after engagement |

## Related

* `docs/docs/observability/23-autonomous-code-modification.md` —
  Cat 23 design doc (the "Gate 3: sandbox safety" section)
* `src/eden/providers/sandbox_isolated.py` — the implementation
* `docs/runbooks/cat23-policy-rollout.md` — the opt-in policy
  rollout runbook
* `tests/unit/code_change/test_isolated_sandbox.py` — the unit
  tests (26 tests, 5 Linux-only skipped on macOS)
* `docs/runbooks/incident-sandbox-escape.md` — TBD; ships with
  the red-team report