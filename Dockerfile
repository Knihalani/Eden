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
RUN pip install --no-cache-dir --break-system-packages \
    "uvicorn[standard]>=0.30.0,<1.0.0" \
    "fastapi>=0.115.0,<1.0.0" \
    "pydantic>=2.9.0,<3.0.0" \
    "pydantic-settings>=2.5.0,<3.0.0" \
    "python-jose[cryptography]>=3.3.0,<4.0.0" \
    "asyncpg>=0.29.0,<1.0.0"

# Copy virtual environment from builder (full app deps) — kept for
# any binary wheels the app imports at runtime. ``eden`` user owns it
# so they can traverse it.
COPY --from=builder --chown=eden:eden /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Copy application code
COPY --chown=eden:eden src ./src
COPY --chown=eden:eden migrations ./migrations
COPY --chown=eden:eden alembic.ini ./alembic.ini

# Make the `eden` package importable when uvicorn runs from the
# system Python (which is what `python -m uvicorn` uses). The package
# lives at /app/src/eden/ but is not on sys.path by default — the
# builder's venv at /opt/venv has it via `uv sync`, but we exec
# /usr/local/bin/python3 (not the venv's interpreter) so we need this.
ENV PYTHONPATH=/app/src

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

# Health check — lightweight ping against /health
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/health | grep -q '"status"' || exit 1

# Run uvicorn with a single worker per container (scale via replicas).
# Use `python -m uvicorn` with the absolute Python path so we never
# depend on PATH, the venv being activated, or /opt/venv/bin being on
# PATH — Northflank's pre-start wrapper is known to strip the env
# before exec'ing the CMD. `python -m uvicorn` resolves uvicorn via
# the system site-packages where the safety-net pip install lives,
# regardless of cache state. /usr/local/bin/python3 is where the
# python:3.12-slim base image puts the interpreter.
# --proxy-headers is required when behind a reverse proxy / load balancer.
CMD ["/usr/local/bin/python3", "-m", "uvicorn", "eden.api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
