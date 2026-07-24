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
COPY src/eden ./src/eden

# Sync dependencies into a virtual environment using the lockfile
RUN uv venv /opt/venv \
    && VIRTUAL_ENV=/opt/venv uv sync --locked --no-dev \
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

# Install runtime Python deps DIRECTLY into the system site-packages
# via pip. This is a belt-and-braces measure — the builder's venv at
# /opt/venv should already have everything, but Northflank's image
# cache has shipped broken builds where uvicorn was missing from the
# venv layer (so ``/opt/venv/bin/uvicorn`` was absent even with PATH
# set + chown applied). ``--break-system-packages`` lets us coexist
# with the system pip on the slim base image.
#
# Pulls the full list of runtime deps from pyproject.toml at build
# time via awk (the [project] dependencies block). Replaces a
# hand-written list that kept missing transitive deps (bcrypt via
# passlib[bcrypt], then qrcode, …). The pgbouncer entry is a comment
# in the file, not a real package — awk filters that out by quoting.
COPY pyproject.toml ./
# Extract every dep from pyproject.toml's [project] dependencies and
# hand them to pip. Uses python -c + tomllib (stdlib in 3.11+) so we
# don't depend on awk/grep/sed — python:3.12-slim ships without those
# coreutils. Filters out the pgbouncer entry (comment-marker for the
# infra team, not a real package).
RUN pip install --no-cache-dir --break-system-packages \
    $(python -c "import tomllib; d=tomllib.loads(open('/app/pyproject.toml').read()); print(' '.join(p for p in d['project']['dependencies'] if not p.startswith('pgbouncer')))")

# Copy virtual environment from builder (full app deps) — kept for
# any binary wheels the app imports at runtime. ``eden`` user owns it
# so they can traverse it.
COPY --from=builder --chown=eden:eden /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Copy application code
COPY --chown=eden:eden src ./src
COPY --chown=eden:eden migrations ./migrations
COPY --chown=eden:eden alembic.ini ./alembic.ini

# StatGate (EvidenceGate.evaluate / promote decisions). Minimal
# subset only — research packages stay out of the image.
COPY --chown=eden:eden supplementaries/__init__.py ./supplementaries/__init__.py
COPY --chown=eden:eden supplementaries/phase_6_stat_gate/__init__.py ./supplementaries/phase_6_stat_gate/__init__.py
COPY --chown=eden:eden supplementaries/phase_6_stat_gate/gate.py ./supplementaries/phase_6_stat_gate/gate.py

# Make the `eden` package importable when uvicorn runs from the
# system Python (which is what `python -m uvicorn` uses). The package
# lives at /app/src/eden/ but is not on sys.path by default — the
# builder's venv at /opt/venv has it via `uv sync`, but we exec
# /usr/local/bin/python3 (not the venv's interpreter) so we need this.
# Include /app so ``supplementaries.phase_6_stat_gate`` resolves.
ENV PYTHONPATH=/app/src:/app

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

# Health check — liveness via /live; use /ready for dependency probes
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/live | grep -q '"status"' || exit 1

# Run uvicorn with a single worker per container (scale via replicas).
# Use the system Python (python:3.12-slim puts it at
# /usr/local/bin/python3) — the venv at /opt/venv cannot be trusted
# (Northflank's image cache has shipped it empty twice now). The
# safety-net pip install above puts every dep into system
# site-packages, so ``python -m uvicorn`` finds uvicorn. Absolute
# path + module form so we never depend on PATH or the venv being
# activated.
#
# PYTHONPATH=/app/src is required so ``import eden`` resolves — the
# source is at /app/src/eden/__init__.py (src-layout) but is not on
# sys.path by default.
# --proxy-headers is required when behind a reverse proxy / load balancer.
CMD ["/usr/local/bin/python3", "-m", "uvicorn", "eden.api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
