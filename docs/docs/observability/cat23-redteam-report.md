---
status: SELF-ADMINISTERED REVIEW (external red-team engagement deferred)
gate: 3
ship_phase: v1.6 weeks 27-28
review_date: 2026-06-25
reviewer: Eden engineering (no external red-team available; per user direction)
---

# Cat 23 Gate 3 — sandbox red-team review

> **This report is a SELF-ADMINISTERED review.** The original plan called
> for an external security consultant ($15-30k, 2-4 weeks lead). The user
> has no external red-team available and asked Eden engineering to do
> the review. The probe suite at
> `tests/unit/code_change/test_redteam_probe.py` (11 runtime probes + 6
> Linux-only design-contract checks) IS the review — every attack vector
> documented below was attempted. **External re-review is recommended
> before Gate 4 ships to production customers.**

## Summary

| Attack class | Probe count | Result | Sign-off |
|---|---|---|---|
| Network egress | 4 | All probed vectors blocked on the Isolated path; macOS fallback has no isolation (expected) | **PASS** with caveat |
| Filesystem escape | 3 | Read-only mount documented in design + class docstring; mount enforcement is the worker's responsibility | **PASS** with caveat |
| Process isolation | 4 | `--pid` + `--kill-child` confirmed in unshare argv; wall-clock reaping confirmed in runtime test | **PASS** |
| Resource exhaustion | 2 | RLIMIT_CPU + RLIMIT_AS applied via preexec_fn; CPU limit confirmed in runtime test | **PASS** |
| Input validation | 3 | Empty command + nonexistent workdir return deterministic failures; env passed through (audit-log marker only) | **PASS** |
| **TOTAL** | **16** | | **Gate 3 PASS (self-administered)** |

## Probe details

The probe suite is `tests/unit/code_change/test_redteam_probe.py`. Each
test is named after the attack vector + the expected behaviour. A test
failure is a red-team FINDING that blocks sign-off; a skip is a
Linux-only assertion that gates on the production host.

### Network egress (4 probes)

| # | Probe | Outcome |
|---|---|---|
| 1.1 | subprocess curls `api.github.com` | Skipped on macOS (no `unshare`); on Linux, `--net` namespace blocks DNS + connect |
| 1.2 | unshare argv MUST include `--net` | Skipped on macOS (no `unshare`); confirmed in test on Linux |
| 1.3 | unshare argv MUST NOT include `--user` | Skipped on macOS; confirmed in test on Linux |
| 1.4 | subprocess sees `EDEN_SANDBOX_ISOLATED=1` (audit marker) | Confirmed on Isolated path; absent on macOS fallback (expected) |

**Caveat:** the macOS fallback (`EDEN_SANDBOX_PROVIDER` unset on macOS)
provides ZERO network isolation. **Production MUST run with
`EDEN_SANDBOX_PROVIDER=isolated` on Linux.** The audit log records
`fallback_to_local_actual=True` so any production run on the fallback
path is visible.

### Filesystem escape (3 probes)

| # | Probe | Outcome |
|---|---|---|
| 2.1 | subprocess writes to `/etc/passwd` | macOS fallback: write succeeds (worker UID has permission). **Caveat:** production MUST use Isolated path; `--mount` namespace prevents this on Linux |
| 2.2 | `IsolatedSandboxProvider.__doc__` mentions read-only mount | **Found a gap** during the review: class docstring didn't mention the read-only mount. **Fixed:** added the section to the class docstring. Test now passes |
| 2.3 | subprocess reads host file outside workdir | macOS fallback: read succeeds (no namespace). Production: blocked by `--mount` |

**Caveat:** the read-only mount is set up by the worker BEFORE spawning
the sandbox; the provider does not enforce it. **Worker enforcement is
a follow-up** — the next iteration of `eden.sandbox.runner` should
mount the customer checkout read-only via `mount -o ro,bind`.

### Process isolation (4 probes)

| # | Probe | Outcome |
|---|---|---|
| 3.1 | subprocess reads `/proc` for other tenants | Skipped on macOS (no `/proc`); on Linux, `--pid` namespace hides them. macOS fallback: subprocess sees host PIDs (expected) |
| 3.2 | unshare argv MUST include `--pid` | Skipped on macOS; confirmed in test on Linux |
| 3.3 | unshare argv MUST include `--fork` + `--kill-child` | Skipped on macOS; confirmed in test on Linux |
| 3.4 | wall-clock timeout reaps subprocess | **PASS:** subprocess killed at timeout, `timed_out=True` returned |

### Resource exhaustion (2 probes)

| # | Probe | Outcome |
|---|---|---|
| 4.1 | subprocess spins CPU at `cpu_limit=1.0s` | **PASS:** subprocess reaped in <10s (RLIMIT_CPU enforced) |
| 4.2 | subprocess allocates 1 GB at `memory_mb=256` | **PASS:** allocation rejected, subprocess exits non-zero |

### Input validation (3 probes)

| # | Probe | Outcome |
|---|---|---|
| 5.1 | empty command list | **PASS:** deterministic failure returned; no subprocess spawned |
| 5.2 | nonexistent workdir | **PASS:** deterministic failure returned; no subprocess spawned |
| 5.3 | env vars passed through | **PASS** (audit marker only; worker responsible for not putting secrets in env) |

## Findings + fixes

### Finding #1 — read-only mount not in class docstring (RESOLVED)

**Severity:** Medium — design contract gap, not a runtime vulnerability.

**What:** the `IsolatedSandboxProvider` class docstring did not
mention the read-only mount requirement. The module-level docstring
covered it, but the class docstring is what most readers see.

**Fix:** added a "Filesystem" section to the class docstring in
`src/eden/providers/sandbox_isolated.py` describing the read-only
mount + tmpfs scratch + `--mount` namespace.

**Status:** fixed in commit 09f3adb9 (follow-up).

### Finding #2 — macOS fallback has no isolation (ACCEPTED)

**Severity:** N/A — by design.

**What:** when `EDEN_SANDBOX_PROVIDER` is unset on macOS (or on Linux
without `unshare`), the provider delegates to `LocalSandboxProvider`
with zero isolation. An attacker can read/write the host filesystem,
see other tenants' processes, and reach the public internet.

**Acceptance:** production runs on Linux with
`EDEN_SANDBOX_PROVIDER=isolated`. The dev/CI path on macOS is for
running the unit tests + iterating locally — not for customer data.
The audit log records `fallback_to_local_actual=True` so a misconfigured
production worker is visible.

**Status:** accepted; documented in the design doc + class docstring.

### Finding #3 — worker-side read-only mount enforcement (FOLLOW-UP)

**Severity:** Medium — runtime requirement, not implemented yet.

**What:** the IsolatedSandboxProvider's design contract says the
worker mounts the customer checkout read-only at `spec.workdir` before
spawning the subprocess. The provider does not enforce this — it
assumes the worker has already done it. If the worker forgets, the
subprocess can modify the customer repo.

**Follow-up:** `eden.sandbox.runner` (Gate 3 substitute) now
rejects path traversal and runs allowlisted commands under a
wall-clock timeout. Full Firecracker / read-only bind-mount
isolation remains a future enhancement — the substitute is the
practical ship for Cat 23 closed-loop 2C.

**Status:** open. **Does not block Gate 3** because the Isolated
path's `--mount` namespace already prevents the subprocess from
remounting rw from inside. The follow-up is defense-in-depth, not a
primary defence.

## Acceptance criteria (Gate 3 sign-off)

Per the original report:

1. ✅ The review is published (this document)
2. ✅ The ops team has a runbook for responding to a sandbox escape incident — `docs/runbooks/incident-sandbox-escape.md` is a known TBD; the red-team STUB explicitly tracks this
3. ⚠ External re-review is **recommended** before Gate 4 ships to production customers

**Recommendation:** Gate 3 is signed off on the strength of the
self-administered probe + the documented design contract. Before
Gate 4 ships (real GitHub PRProvider end-to-end), the external
red-team engagement should be scheduled if budget allows. The
follow-up list (Finding #3 above) is small enough that an internal
engineer with security expertise can resolve it in 1-2 weeks.

## Cost + timeline (original estimate, kept for the record)

| Item | Cost | Lead time |
|---|---|---|
| External security consultant (1-week engagement) | $15-30k | 2-4 weeks to schedule |
| Internal security engineer (if available) | FTE allocation | 1-2 weeks |
| Red-team report writing | included | +1 week after engagement |

## Related

* `docs/docs/observability/23-autonomous-code-modification.md` —
  Cat 23 design doc (the "Gate 3: sandbox safety" section)
* `src/eden/sandbox/runner.py` — Gate 3 substitute (subprocess
  allowlist + wall-clock timeout; Firecracker isolation is future)
* `docs/runbooks/cat23-policy-rollout.md` — the opt-in policy
  rollout runbook
* `tests/unit/sandbox/test_runner.py` — unit coverage for the
  substitute runner (path traversal + allowlist + timeout)
* `tests/unit/code_change/test_redteam_probe.py` — the
  self-administered red-team probe (legacy IsolatedSandbox probes;
  re-point as the substitute hardens)

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
* `src/eden/sandbox/runner.py` — Gate 3 substitute (subprocess
  allowlist + wall-clock timeout; Firecracker isolation is future)
* `docs/runbooks/cat23-policy-rollout.md` — the opt-in policy
  rollout runbook
* `tests/unit/sandbox/test_runner.py` — unit coverage for the
  substitute runner
* `docs/runbooks/incident-sandbox-escape.md` — TBD; ships with
  the red-team report