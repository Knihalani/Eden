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

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application code
COPY --chown=eden:eden src ./src
COPY --chown=eden:eden migrations ./migrations
COPY --chown=eden:eden alembic.ini ./alembic.ini

# Switch to non-root user
USER eden

# Expose the API port
EXPOSE 8000

# Health check — lightweight ping against /health
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/health | grep -q '"status"' || exit 1

# Run uvicorn with a single worker per container (scale via replicas)
# Use --proxy-headers when behind a reverse proxy / load balancer
CMD ["uvicorn", "eden.api.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
