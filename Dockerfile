# =============================================================================
# Eden — Multi-stage Production Dockerfile
# =============================================================================
# Build stage: compile dependencies and install the package
# Runtime stage: minimal image with only what's needed to run
#
# Features:
#   - Uses `uv` for fast, deterministic dependency resolution
#   - Non-root user for security
#   - Multi-stage to minimize final image size
#   - Health check baked in
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS builder

WORKDIR /build

# Install system deps needed to build native extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /usr/local/bin/uv

# Copy dependency files first (better layer caching)
COPY pyproject.toml uv.lock README.md ./

# Resolve the locked runtime dependency set into a fully-pinned
# requirements file. The runtime stage installs exactly this, so the
# tree that ships is the tree ``uv.lock`` describes — the same one
# ``uv lock --check`` and the ``pip-audit`` CI gate verify.
#
# This replaced a ``uv sync`` into /opt/venv that was then copied into
# the runtime stage *alongside* a second, independent ``pip install``
# of the [project] dependencies. That arrangement had two defects:
#   1. Every wheel shipped twice (venv + system site-packages).
#   2. The second install read the *ranges* in pyproject.toml, not
#      uv.lock, so it re-resolved at build time. Since the CMD runs
#      /usr/local/bin/python3 (system site-packages), production ran
#      the unpinned tree while CI audited the locked one.
# Building only the requirements file here also drops the builder's
# ``uv sync`` entirely, so the builder no longer needs the app source
# and its layer cache survives every source-only change.
RUN uv export --frozen --no-dev --no-hashes --no-emit-project \
    --format requirements-txt -o /tmp/requirements.txt \
    && rm -rf /root/.cache

# -----------------------------------------------------------------------------
# Stage 2: Runtime
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

WORKDIR /app

# Security: create non-root user
RUN groupadd -r eden && useradd -r -g eden -d /app -s /sbin/nologin eden

# Install runtime system dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the runtime deps ONCE, into system site-packages, from the
# lockfile-derived pin list built in the builder stage.
#
# There is deliberately no venv in this image. The previous layout
# copied /opt/venv in as a "belt and braces" backup because Northflank's
# image cache twice shipped that venv empty — but the backup was a
# second, differently-resolved copy of every dependency, and the CMD
# ran the backup rather than the venv. Installing the pinned set into
# the interpreter the CMD actually uses removes the failure mode the
# venv was insuring against, and the duplicate copy with it.
COPY --from=builder /tmp/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt

ENV PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Copy application code
COPY --chown=eden:eden src ./src
COPY --chown=eden:eden migrations ./migrations
COPY --chown=eden:eden alembic.ini ./alembic.ini

# StatGate + closed-loop gating (EvidenceGate / Cat 17 wiring).
# Minimal subset only — research packages stay out of the image.
# One COPY per directory rather than one per file: the previous nine
# single-file COPYs produced nine image layers for ~9 small modules.
COPY --chown=eden:eden supplementaries/__init__.py ./supplementaries/__init__.py
COPY --chown=eden:eden supplementaries/phase_4_guardrails/__init__.py supplementaries/phase_4_guardrails/policy_extension.py ./supplementaries/phase_4_guardrails/
COPY --chown=eden:eden supplementaries/phase_6_stat_gate/__init__.py supplementaries/phase_6_stat_gate/gate.py ./supplementaries/phase_6_stat_gate/
COPY --chown=eden:eden supplementaries/phase_7_detection/__init__.py supplementaries/phase_7_detection/stat_gated_executor.py supplementaries/phase_7_detection/detectors.py supplementaries/phase_7_detection/closed_loop.py ./supplementaries/phase_7_detection/
COPY --chown=eden:eden supplementaries/phase_10_memory/__init__.py supplementaries/phase_10_memory/a2a.py ./supplementaries/phase_10_memory/
COPY --chown=eden:eden supplementaries/cat_22_apm/__init__.py supplementaries/cat_22_apm/tail_sampling.py ./supplementaries/cat_22_apm/

# Make the `eden` package importable when uvicorn runs from the
# system Python (which is what `python -m uvicorn` uses). The package
# lives at /app/src/eden/ but is not on sys.path by default — the
# builder's venv at /opt/venv has it via `uv sync`, but we exec
# /usr/local/bin/python3 (not the venv's interpreter) so we need this.
# Include /app so ``supplementaries.phase_*`` resolves.
ENV PYTHONPATH=/app/src:/app

# Which commit is actually serving traffic.
#
# On 2026-07-30 a deploy reported build=SUCCESS while the previous image
# kept serving, and there was no way to tell from the outside which code
# was live — the Northflank status fields said COMPLETED/DEPLOYING and
# SUCCESS/IN_PROGRESS in combinations that did not mean what they sound
# like. The only reliable check was probing for a route that a specific
# commit removed, which only works by luck.
#
# Northflank passes the commit as a build argument AND as a runtime
# env var (scripts/deploy-northflank.sh keeps them in sync). Unset
# degrades to "unknown", never to a wrong answer. Do NOT use
# `northflank patch service combined` with a partial runtimeEnvironment
# — that route replaces the entire map and will wipe every other var.
ARG EDEN_GIT_SHA=unknown
ENV EDEN_GIT_SHA=${EDEN_GIT_SHA}
RUN printf '%s\n' "$EDEN_GIT_SHA" > /app/.eden-git-sha && chown eden:eden /app/.eden-git-sha || true

# Copy the pre-trained zstd dictionary (Phase 3 of the Postgres +
# Compression plan). ``eden.storage.compression`` looks for the file at
# ``$EDEN_ZSTD_DICT_PATH`` (default ``/app/var/zstd_dict.bin``). If the
# file is missing the service falls back to an empty dict — round-trip
# still works, just without the ratio win. Generate the file via
# ``scripts/train_zstd_dict.py``.
COPY --chown=eden:eden var/zstd_dict.bin ./var/zstd_dict.bin

# Switch to non-root user
USER eden

# Expose the API port
EXPOSE 8000

# northflank.yml's terminationGracePeriodSeconds comment asserts this
# matches "what bin/serve.sh and the Dockerfile's STOPSIGNAL expect",
# but no STOPSIGNAL was ever declared, so the daemon default (SIGTERM)
# applied by accident. Declared explicitly: uvicorn treats SIGTERM as
# a graceful shutdown, which is what the 30s grace period is for.
STOPSIGNAL SIGTERM

# Health check — liveness via /live; use /ready for dependency probes
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/live | grep -q '"status"' || exit 1

# Run uvicorn with a single worker per container (scale via replicas).
# Use the system Python (python:3.12-slim puts it at
# /usr/local/bin/python3) — this image has no venv, and the pinned
# install above puts every dep into system site-packages, so
# ``python -m uvicorn`` resolves uvicorn from the interpreter that is
# actually executing. Absolute path + module form so we never depend
# on PATH.
#
# PYTHONPATH=/app/src is required so ``import eden`` resolves — the
# source is at /app/src/eden/__init__.py (src-layout) but is not on
# sys.path by default.
# --proxy-headers is required when behind a reverse proxy / load balancer.
# --timeout-graceful-shutdown bounds the connection drain. Without it uvicorn
# waits *indefinitely* for in-flight requests, and the SSE routes hold a
# connection for up to 300s (observability_stream.py _STREAM_MAX_DURATION_S)
# against a 60s pod grace period. The container was therefore SIGKILLed before
# the lifespan shutdown block ran at all — so the ClickHouse buffer flush and
# every other drain in api/app.py were dead code in production.
#
# Budget: 60s pod grace = 20s connection drain + <=30s shutdown block + slack.
CMD ["/usr/local/bin/python3", "-m", "uvicorn", "eden.api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--timeout-graceful-shutdown", "20"]
