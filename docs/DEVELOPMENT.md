# Eden Development Guide

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Python | 3.12+ | Type hints, async/await required |
| Docker | 24+ | For PostgreSQL, Qdrant, PgBouncer |
| Docker Compose | 2.20+ | For local infrastructure |
| OpenRouter API Key | — | Get from platform.openrouter.ai |

Verify prerequisites:
```bash
python --version  # Should be 3.12+
docker --version   # Should be 24+
docker compose version  # Should be 2.20+
```

---

## Quick Start

### 1. Clone and Setup

```bash
cd /path/to/Eden

# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -e ".[dev]"
```

### 2. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your settings
nano .env  # or vim, code, etc.
```

**Required `.env` variables:**
```bash
OPENROUTER_API_KEY=sk-or-v1-...
```

**Optional `.env` variables:**
```bash
# PostgreSQL (defaults shown)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=eden
POSTGRES_USER=eden
POSTGRES_PASSWORD=  # Leave empty for local dev

# Qdrant (defaults shown)
QDRANT_HOST=localhost
QDRANT_PORT=6333

# Debug mode
DEBUG=false
```

### 3. Start Infrastructure

```bash
# Start PostgreSQL, Qdrant, PgBouncer
docker compose -f docker/docker-compose.yml up -d

# Verify services are running
docker compose -f docker/docker-compose.yml ps
```

Expected output:
```
NAME                COMMAND                  SERVICE   STATUS
eden-postgres-1     "docker-entrypoint.s…"   postgres  running
eden-qdrant-1       "/start.py"              qdrant    running
eden-pgbouncer-1    "/usr/bin/pgbouncer…"    pgbouncer running
```

### 4. Run the API

```bash
# Development mode with auto-reload
uvicorn eden.api.app:app --reload --host 0.0.0.0 --port 8000

# Or directly via Python module
python -m eden.api.app
```

API available at:
- API: http://localhost:8000
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### 5. Verify Health

```bash
curl http://localhost:8000/health
```

Expected response:
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "postgres": "connected",
  "qdrant": "connected",
  "sandbox": "ready"
}
```

---

## Project Structure

```
eden/
├── src/eden/                    # Main package
│   ├── api/                     # FastAPI application
│   │   ├── app.py              # App definition, routes, lifespan
│   │   └── routes/
│   │       └── jobs.py        # /jobs endpoints
│   ├── pipeline/               # LangGraph orchestration
│   │   ├── state.py           # EdenJobState TypedDict
│   │   ├── graph.py           # Pipeline graph definition
│   │   └── nodes/             # LangGraph node wrappers
│   │       ├── planner.py     # Planner → EDP
│   │       ├── critic.py      # Critic → 8-dim review
│   │       ├── refiner.py     # Refiner → RES
│   │       ├── fact_checker.py # Fact Checker → verified
│   │       ├── executor.py    # Executor → code
│   │       ├── code_quality.py # Code Quality → 5 passes
│   │       ├── verifier.py    # Verifier → fidelity check
│   │       ├── tester.py      # Tester → sandbox run
│   │       └── archivist.py   # Archivist → KB learning
│   ├── agents/                 # Agent implementations
│   │   ├── planner/
│   │   │   └── agent.py       # EDP research and generation
│   │   ├── critic/
│   │   │   └── agent.py       # 8-dimension adversarial review
│   │   ├── refiner/
│   │   │   └── agent.py       # Spec resolution to RES
│   │   ├── fact_checker/
│   │   │   └── agent.py       # Framework API verification
│   │   ├── executor/
│   │   │   └── agent.py        # Code generation from RES
│   │   ├── verifier/
│   │   │   └── agent.py        # RES fidelity verification
│   │   ├── tester/
│   │   │   └── agent.py        # Sandbox testing
│   │   ├── archivist/
│   │   │   └── agent.py        # Learning from job outcomes
│   │   └── evolution/
│   │       ├── distiller.py     # Nightly pattern extraction
│   │       ├── prompt_evolver.py # Prompt A/B testing
│   │       ├── research_harvester.py # Weekly research crawl
│   │       ├── retrieval_tuner.py   # Retrieval optimization
│   │       └── pattern_miner.py    # Monthly deep analysis
│   ├── kb/                     # Knowledge Base
│   │   ├── episodic/          # PostgreSQL job records
│   │   │   ├── client.py      # Async PostgreSQL client
│   │   │   └── models.py      # Pydantic models
│   │   ├── semantic/          # Graph + Vector
│   │   │   ├── graph_client.py # PostgreSQL recursive CTEs
│   │   │   ├── vector_client.py # Qdrant wrapper
│   │   │   └── models.py      # Graph node/edge models
│   │   ├── procedural/        # Skill Library
│   │   │   ├── client.py      # Skill CRUD
│   │   │   └── models.py      # Skill models
│   │   ├── exploit/           # Exploit Library
│   │   │   ├── client.py      # Exploit CRUD
│   │   │   └── models.py      # Exploit models
│   │   └── shared/           # Shared utilities
│   │       ├── audit.py       # AUDN protocol
│   │       └── models.py      # Shared KB models
│   ├── sandbox/               # Firecracker/BandSox
│   │   ├── runner.py          # VM management, execution
│   │   └── models.py          # Sandbox models
│   ├── storage/               # Database clients
│   │   ├── postgres.py        # AsyncPG wrapper
│   │   └── qdrant.py          # Qdrant async client
│   ├── llm/                   # OpenRouter client
│   │   ├── client.py          # LLM client with retry/breaker
│   │   └── models.py          # LLM request/response models
│   └── config.py              # Settings management
├── migrations/                # Database migrations
│   └── 001_kb_schema.sql      # Full PostgreSQL schema
├── docker/                    # Docker Compose files
│   └── docker-compose.yml     # PostgreSQL, Qdrant, PgBouncer
├── tests/                     # Test suite
│   ├── conftest.py           # Pytest fixtures
│   ├── unit/
│   │   ├── agents/           # Agent unit tests
│   │   ├── kb/               # KB unit tests
│   │   └── pipeline/         # Pipeline unit tests
│   └── integration/          # Integration tests
├── docs/                      # Documentation
│   ├── ARCHITECTURE.md        # System design
│   ├── API.md                 # API reference
│   ├── ROADMAP.md             # Implementation roadmap
│   └── DEVELOPMENT.md         # This file
├── pyproject.toml            # Package configuration
└── .env.example              # Environment template
```

---

## Key Concepts

### Pipeline Flow

```
REQUEST → PLANNER → CRITIC → REFINER → FACT CHECKER
                           ↓                    ↓
                      (replan loops)       EXECUTOR
                                              ↓
                                    CODE QUALITY PIPELINE
                                     Static→Security→Complexity
                                     →Performance→Documentation
                                              ↓
                                        VERIFIER → TESTER
                                              ↓
                            (fundamental flaw loops back)
                                              ↓
                                        ARCHIVIST → RESULT
                                              ↓
                              EVOLUTION ENGINE (async)
```

**Key Stages:**
1. **Planning**: Planner produces Environment Design Plan (EDP)
2. **Criticizing**: Critic reviews EDP across 8 dimensions; may route back to Planner
3. **Refining**: Refiner closes gaps between EDP and implementable spec (RES)
4. **Fact Checking**: Fact Checker verifies all framework API claims
5. **Executing**: Executor writes code from RES
6. **Code Quality**: 5-pass automated quality pipeline (loops to Executor)
7. **Verifying**: Verifier checks code matches RES (loops to Executor or Refiner)
8. **Testing**: Tester runs in Firecracker sandbox (may loop to Planner)
9. **Archiving**: Archivist learns from job, writes to KB

### Knowledge Base Layers

| Layer | Storage | Content | Written By |
|-------|---------|---------|------------|
| **Episodic** | PostgreSQL | Job records, full traces | All agents (provisional) |
| **Semantic** | PostgreSQL + Qdrant | Facts, patterns, best practices | Archivist (canonical) |
| **Procedural** | Qdrant | Skill Library entries | Archivist (canonical) |
| **Exploit** | PostgreSQL + Qdrant | Reward hacking probes | Archivist (canonical) |

### State Management

All pipeline state flows through `EdenJobState` TypedDict. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `job_id` | str | Unique identifier |
| `request` | dict | User's job request |
| `edp_history` | list[dict] | All EDP iterations |
| `critic_decisions` | list[dict] | All critique decisions with rationale |
| `code_history` | list[str] | All code iterations |
| `quality_reports` | list[dict] | Code Quality results per pass per iteration |
| `outcome_tier` | str | Gold/Silver/Bronze/Partial/Failed |
| `archivist_summary` | dict | Archivist's learning extraction |

### Flexible Tags System

Environment classification is flexible, tag-based rather than forced:

- User provides `tags` array with hints (e.g., `["rl", "continuous", "gymnasium"]`)
- Planner infers appropriate classification from description and tags
- Tags are optional hints, not enforced constraints
- New environment classes can be created dynamically

---

## Development Workflow

### Running the API

```bash
# Development mode with auto-reload
uvicorn eden.api.app:app --reload --host 0.0.0.0 --port 8000

# Production mode
uvicorn eden.api.app:app --host 0.0.0.0 --port 8000 --workers 4

# Directly via Python module
python -m eden.api.app
```

### Running Tests

```bash
# Run all tests
pytest

# Run with verbose output
pytest -v

# Run with coverage
pytest --cov=eden --cov-report=html --cov-report=term

# Run specific test file
pytest tests/unit/pipeline/test_state.py

# Run specific test
pytest tests/unit/agents/test_planner.py::test_planner_produces_edp

# Run tests matching pattern
pytest -k "test_planner"

# Run with timeout (60 seconds per test)
pytest --timeout=60

# Run without cache
pytest --cache-clear
```

### Code Quality Checks

```bash
# Type checking (strict mode)
mypy src/eden

# Linting
ruff check src/eden

# Auto-fix linting issues
ruff check --fix src/eden

# Format code
ruff format src/eden

# Security analysis
bandit -r src/eden

# Check imports
ruff check --select=I src/eden

# All checks (pre-commit)
mypy src/eden && ruff check src/eden && pytest
```

### Testing the Pipeline Manually

```bash
# Submit a test job
curl -X POST http://localhost:8000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Simple CartPole environment with basic reward",
    "tags": ["rl", "gymnasium", "classic_control"],
    "framework": "gymnasium",
    "framework_version": "0.29"
  }'

# Response:
# {"job_id":"550e8400-e29b-41d4-a716-446655440000","status":"planning",...}

# Check status (replace job_id)
curl http://localhost:8000/jobs/550e8400-e29b-41d4-a716-446655440000

# Get result when completed
curl http://localhost:8000/jobs/550e8400-e29b-41d4-a716-446655440000/result

# Get full trace
curl http://localhost:8000/jobs/550e8400-e29b-41d4-a716-446655440000/trace

# Cancel if needed
curl -X POST http://localhost:8000/jobs/550e8400-e29b-41d4-a716-446655440000/cancel
```

---

## Database Management

### PostgreSQL

**Running Migrations:**

The schema runs automatically on API startup. To run manually:

```bash
# Via docker exec
docker exec -it eden-postgres-1 psql -U eden -d eden -f /docker-entrypoint-initdb.d/001_kb_schema.sql

# Or via pgbouncer
psql -h localhost -p 6432 -U eden -d eden
```

**Connecting Directly:**

```bash
# Connect to PostgreSQL
docker exec -it eden-postgres-1 psql -U eden -d eden

# Run queries
SELECT id, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 10;
```

**Schema Tables:**

| Table | Description |
|-------|-------------|
| `jobs` | All job records with full state |
| `skills` | Skill Library entries |
| `exploits` | Exploit Library entries |
| `semantic_nodes` | Knowledge graph nodes |
| `semantic_edges` | Knowledge graph edges |

### Qdrant

**Dashboard:**
- URL: http://localhost:6333/dashboard
- Default: no authentication

**Collections:**
- `environments` — Environment embeddings
- `patterns` — Design pattern embeddings
- `skills` — Skill Library embeddings
- `exploits` — Exploit probe embeddings

**Querying Collections:**

```bash
# List all collections
curl http://localhost:6333/collections

# Get collection info
curl http://localhost:6333/collections/environments

# Search (example)
curl -X POST http://localhost:6333/collections/environments/points/search \
  -H "Content-Type: application/json" \
  -d '{"vector": [0.1, ...], "limit": 5}'
```

---

## Adding New Agents

### Step 1: Create Agent Directory

```bash
mkdir -p src/eden/agents/new_agent
touch src/eden/agents/new_agent/__init__.py
```

### Step 2: Implement Agent Class

Create `src/eden/agents/new_agent/agent.py`:

```python
"""New Agent — brief description."""

import logging
from typing import Optional

from eden.llm.client import OpenRouterClient
from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class NewAgent:
    """New agent description."""

    SYSTEM_PROMPT = """You are the NewAgent for Eden...
    Describe agent role, inputs, outputs, and process.
    """

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        self.llm = llm_client or OpenRouterClient()
        self.max_tokens = settings.max_tokens_new_agent

    async def run(self, state: dict) -> dict:
        """Run the agent on the current state.

        Args:
            state: EdenJobState with job context

        Returns:
            dict with state updates
        """
        job_id = state["job_id"]
        logger.info(f"NewAgent running for job {job_id}")

        # Build prompt from state
        prompt = self._build_prompt(state)

        # Call LLM
        response = self.llm.call(
            agent="new_agent",
            prompt=prompt,
            system_prompt=self.SYSTEM_PROMPT,
            max_tokens=self.max_tokens,
        )

        # Parse and return state updates
        result = self._parse_response(response.content)

        return {
            **result,
            "current_stage": "next_stage",
        }

    def _build_prompt(self, state: dict) -> str:
        """Build prompt from state."""
        # Implement prompt construction
        pass

    def _parse_response(self, content: str) -> dict:
        """Parse LLM response into state updates."""
        # Implement response parsing
        pass
```

### Step 3: Create Pipeline Node

Create `src/eden/pipeline/nodes/new_agent.py`:

```python
"""NewAgent node for LangGraph pipeline."""

from eden.agents.new_agent.agent import NewAgent
from eden.pipeline.state import EdenJobState


async def new_agent_node(state: EdenJobState) -> dict:
    """Run the NewAgent and update state.

    Args:
        state: Current pipeline state

    Returns:
        State updates from NewAgent
    """
    agent = NewAgent()
    result = await agent.run(state)
    return result
```

### Step 4: Register Node

Update `src/eden/pipeline/nodes/__init__.py`:

```python
from eden.pipeline.nodes.new_agent import new_agent_node

__all__ = [
    "planner_node",
    "critic_node",
    # ... existing nodes ...
    "new_agent_node",
]
```

### Step 5: Add to Pipeline Graph

Update `src/eden/pipeline/graph.py`:

```python
from eden.pipeline.nodes import (
    # ... existing nodes ...
    new_agent_node,
)

# In build_eden_graph():
graph.add_node("new_agent", new_agent_node)

# Add edge(s)
graph.add_edge("existing_node", "new_agent")
```

### Step 6: Add Tests

Create `tests/unit/agents/test_new_agent.py`:

```python
import pytest
from eden.agents.new_agent.agent import NewAgent


class TestNewAgent:
    @pytest.fixture
    def agent(self):
        return NewAgent()

    @pytest.mark.asyncio
    async def test_runs_successfully(self, agent, sample_state):
        result = await agent.run(sample_state)
        assert "new_field" in result
        assert result["current_stage"] == "next_stage"
```

### Step 7: Update Router (if needed)

If the new agent has conditional routing, add a router function in `graph.py`:

```python
def new_agent_router(state: EdenJobState) -> str:
    """Route after NewAgent."""
    # Implement routing logic
    pass

# In build_eden_graph():
graph.add_conditional_edges("new_agent", new_agent_router)
```

---

## Configuration Reference

### Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `OPENROUTER_API_KEY` | — | Yes | OpenRouter API key |
| `POSTGRES_HOST` | localhost | No | PostgreSQL host |
| `POSTGRES_PORT` | 5432 | No | PostgreSQL port |
| `POSTGRES_DB` | eden | No | Database name |
| `POSTGRES_USER` | eden | No | Database user |
| `POSTGRES_PASSWORD` | (empty) | No | Database password |
| `QDRANT_HOST` | localhost | No | Qdrant host |
| `QDRANT_PORT` | 6333 | No | Qdrant port |
| `DEBUG` | false | No | Enable debug logging |

### Settings (config.py)

| Setting | Default | Description |
|---------|---------|-------------|
| `max_tokens_planner` | 8192 | Max response tokens for Planner |
| `max_tokens_critic` | 8192 | Max response tokens for Critic |
| `max_tokens_refiner` | 8192 | Max response tokens for Refiner |
| `max_tokens_executor` | 16384 | Max response tokens for Executor |
| `max_turns_planner` | 10 | Max research iterations |
| `sandbox_pool_size` | 5 | Number of pre-created VMs |
| `sandbox_timeout` | 1800 | Max execution seconds (30 min) |

---

## Troubleshooting

### Import Errors

**Problem:** `ModuleNotFoundError: No module named 'eden'`

**Solution:**
```bash
pip install -e .
```

### Database Connection Issues

**Problem:** `Connection refused` or `Could not connect to database`

**Solution:**
```bash
# Check services are running
docker compose -f docker/docker-compose.yml ps

# Restart services
docker compose -f docker/docker-compose.yml restart

# View logs
docker compose -f docker/docker-compose.yml logs postgres
```

### LLM API Errors

**Problem:** `RateLimitError` or `AuthenticationError`

**Solution:**
- Verify `OPENROUTER_API_KEY` is valid
- Check API key has sufficient quota
- Verify network connectivity to OpenRouter

### Port Already in Use

**Problem:** `OSError: [Errno 48] Address already in use`

**Solution:**
```bash
# Find process using port 8000
lsof -i :8000

# Kill the process
kill -9 <PID>

# Or use a different port
uvicorn eden.api.app:app --port 8001
```

### Sandbox Issues

**Problem:** Sandbox fails to start or times out

**Solution:**
```bash
# Check BandSox is installed correctly
python -c "from eden.sandbox.runner import SandboxRunner; print('OK')"

# Check Docker is running
docker ps
```

### Test Failures

**Problem:** Tests fail with `AssertionError` or `pytest.raises`

**Solution:**
```bash
# Run single test with verbose output
pytest tests/unit/agents/test_planner.py::test_planner_produces_edp -v -s

# Check test fixtures are correct
pytest --fixtures

# Run with pdb debugger
pytest --pdb tests/unit/agents/test_planner.py
```

---

## Architecture Details

For detailed system design, see:
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Complete system architecture
- [API.md](./API.md) — API endpoint reference
- [ROADMAP.md](./ROADMAP.md) — Implementation status and future plans
- [PRD.md](../PRD.md) — Full product requirements document

---

## Contributing

### Code Style

- Follow PEP 8
- Use type hints (strict mypy)
- Max line length: 100
- Single quotes for strings
- Travis clause for deeply nested conditionals

### Commit Messages

```
type(scope): description

Types: feat, fix, docs, style, refactor, test, chore
Scopes: api, pipeline, agents, kb, sandbox, llm
```

Examples:
```
feat(agents): add multi-hop research to Planner
fix(kb): correct AUDN evaluation logic for updates
docs(api): add webhook documentation
```

### Testing Requirements

- All new agents require unit tests
- Integration tests for new API endpoints
- Minimum 80% coverage for new code
- All tests must pass before merge

---

## Document Information

| Field | Value |
|-------|-------|
| Version | 1.0 |
| Last Updated | May 2026 |