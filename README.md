# Eden

AI-native environment generation system. Given a description of what is needed, Eden produces runnable, verified, production-quality code for reinforcement learning, agent evaluation, and simulation use cases.

## Architecture

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

## Quick Start

```bash
# Install dependencies
pip install -e ".[dev]"

# Start infrastructure
docker compose -f docker/docker-compose.yml up -d

# Run the API
python -m eden.api.app
```

## Project Structure

```
eden/
├── src/eden/
│   ├── api/                  # FastAPI job submission/retrieval
│   ├── pipeline/            # LangGraph orchestration
│   │   ├── state.py         # EdenJobState TypedDict
│   │   └── graph.py         # Pipeline graph definition
│   ├── agents/              # All pipeline agents
│   │   ├── planner/
│   │   ├── critic/
│   │   ├── refiner/
│   │   ├── fact_checker/
│   │   ├── executor/
│   │   ├── verifier/
│   │   ├── tester/
│   │   ├── archivist/
│   │   └── evolution/       # Async Evolution Engine
│   ├── kb/                  # Knowledge Base layers
│   │   ├── episodic/        # PostgreSQL job records
│   │   ├── semantic/        # Temporal knowledge graph
│   │   ├── procedural/      # Skill Library
│   │   └── exploit/         # Exploit Library
│   ├── sandbox/             # Firecracker microVM management
│   ├── storage/             # PostgreSQL + Qdrant clients
│   └── llm/                 # OpenRouter client
├── migrations/              # Database schema
├── docker/                  # docker-compose for infrastructure
└── tests/
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key settings:
- `OPENROUTER_API_KEY` — Your OpenRouter API key
- `POSTGRES_*` — PostgreSQL connection settings
- `QDRANT_*` — Qdrant connection settings

## API

```bash
# Submit a job - tags are flexible hints, not enforced classes
curl -X POST http://localhost:8000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "description": "CartPole with potential-based reward shaping",
    "tags": ["rl", "continuous", "gymnasium"],
    "framework": "gymnasium",
    "framework_version": "0.29",
    "difficulty_parameters": {},
    "output_mode": "gymnasium_mode"
  }'

# Check status
curl http://localhost:8000/jobs/{job_id}

# Get result
curl http://localhost:8000/jobs/{job_id}/result
```

## Development

```bash
# Run tests
pytest

# Type checking
mypy src/eden

# Linting
ruff check src/eden
```

## Documentation

See [PRD.md](./PRD.md) for the full product requirements document and roadmap.