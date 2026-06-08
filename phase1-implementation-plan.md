# Phase 1 Implementation Plan: Interview & Spec Generation

**Based on:** `interview-spec-generation-spec.md`  
**Current codebase analysis:** Complete (see appendix for current-state findings)

---

## Executive Summary

Phase 1 has a single goal: **get an end-to-end interview → spec → job flow working** with a real AI interviewer, a structured spec document, and pipeline integration. Everything else (approval workflows, templates, KB integration, collaboration) is Phase 2+.

The current `ChatCreationView` is a hardcoded 3-question wizard with fake AI responses. Replacing it with a real backend-driven interview agent is the highest-leverage change we can make.

---

## Highest-Impact Changes (Ranked by Dependency + User Value)

### 1. Database Schema: The `specs` Table + `spec_id` on Jobs
**Impact:** ★★★★★ (Foundation for everything)  
**Effort:** Low (~1 migration file)  
**Why first:** Every other component reads from or writes to this table.

**Changes:**
- New migration `migrations/016_specs.sql`:
  - `specs` table with `spec_id`, `org_id`, `created_by`, `status` (draft/pending/approved/rejected/converted), `title`, `description`, `spec` (JSONB), `interview_transcript` (JSONB), `completion_metadata` (JSONB), `converted_job_id`
  - Add `spec_id VARCHAR(255)` to `jobs` table
  - Add `estimated_cost_cents INTEGER` to `jobs` table
- Update `src/eden/storage/postgres.py` with `upsert_spec`, `get_spec`, `update_spec_status`, `list_specs` methods

**Success criteria:** Can create, read, and update spec records via Postgres client.

---

### 2. InterviewerAgent Backend
**Impact:** ★★★★★ (Core engine of the entire feature)  
**Effort:** Medium (~3-4 files)  
**Why second:** Without the agent, the frontend has nothing to talk to.

**Changes:**
- New directory `src/eden/agents/interviewer/`:
  - `__init__.py`
  - `agent.py` — `InterviewerAgent(PromptLoader)` class with:
    - `run_interview_turn(history, user_message) → (agent_message, checklist_state, is_complete)`
    - `generate_spec(history) → spec_document`
    - `evaluate_completion(checklist) → CompletionStatus`
  - `prompts/system.md` — System prompt defining the checklist + Socratic style
  - `prompts/checklist.md` — Required field definitions (environment_class, observation_modality, framework, reward_type, etc.)
  - `kb_queries.py` — Stubbed KB query helpers (no real queries in Phase 1, just the interface)

**Design decisions for Phase 1:**
- **No LangGraph sub-graph** — The interview is a simple stateful conversational loop. We can migrate to LangGraph later if complexity demands it.
- **No real-time KB queries** — The agent prompt includes org history as context if provided, but async KB fetching during the interview is Phase 5.
- **State stored in DB** — Each interview turn appends to `interview_transcript` in the `specs` table. The agent re-reads the full transcript each turn.

**Success criteria:** Agent can conduct a multi-turn conversation, track checklist completion, and generate a structured JSON spec document.

---

### 3. Backend API: `/specs` Routes
**Impact:** ★★★★☆ (Connects frontend to agent)  
**Effort:** Medium (~1 file)  
**Why third:** The frontend needs endpoints to create specs, send messages, and convert specs to jobs.

**Changes:**
- New file `src/eden/api/routes/specs.py`:
  - `POST /specs` — Create a new spec (returns `spec_id`, starts interview)
  - `POST /specs/{spec_id}/message` — Send a user message, get agent response
    - Calls `InterviewerAgent.run_interview_turn()`
    - Updates transcript in DB
    - Returns agent message + checklist progress
  - `POST /specs/{spec_id}/generate` — Generate spec document from interview
    - Calls `InterviewerAgent.generate_spec()`
    - Updates spec JSONB in DB
    - Returns the spec document
  - `POST /specs/{spec_id}/submit` — Convert approved spec to job
    - Creates job with `spec_id` reference
    - Injects spec into `JobRequest`
    - Launches pipeline
  - `GET /specs/{spec_id}` — Get spec details
  - `GET /specs` — List specs for user/org
- Wire routes into `src/eden/api/app.py`

**Success criteria:** Can create a spec, have a conversation, generate a spec, and convert it to a job via API.

---

### 4. Pipeline Integration: Spec → Enriched Request → Planner
**Impact:** ★★★★★ (This is what makes the spec actually useful)  
**Effort:** Low (~3 files, small changes)  
**Why fourth:** Without this, the spec is just a document. This is the bridge to the existing pipeline.

**Changes:**
- `src/eden/api/routes/jobs.py`:
  - Add `spec_id: Optional[str] = None` to `JobRequest`
  - In `submit_job()`: if `spec_id` present, fetch spec from DB and inject into request dict
- `src/eden/pipeline/state.py`:
  - Modify `create_initial_state(job_id, request)` to accept optional `spec: Optional[dict] = None`
  - If spec present, merge `spec["spec"]` into `request` under `request["spec"]` key
- `src/eden/agents/planner/agent.py`:
  - Modify Planner prompt to check for `request.spec` first
  - If spec present, use spec fields as primary source for EDP fields instead of inferring from `description`
  - Planner's role becomes "refine and validate the spec" rather than "infer everything from a one-liner"

**Success criteria:** Jobs submitted with a `spec_id` produce EDPs that incorporate the spec's environment_class, observation_modality, framework, reward_structure, etc.

---

### 5. InterviewChat Frontend UI
**Impact:** ★★★★★ (User-facing entry point — replaces the fake AI wizard)  
**Effort:** Medium-High (~2-3 files)  
**Why fifth:** This is the primary user interaction surface. It replaces the current `ChatCreationView` which is the biggest pain point.

**Changes:**
- New component `clients/portal/src/components/specs/interview-chat.tsx`:
  - Full-screen or large modal layout (same pattern as `ChatCreationView`)
  - Real streaming conversation with the backend agent via `POST /specs/{spec_id}/message`
  - Right sidebar: **Checklist Progress Panel**
    - Visual checklist of required fields with ✅/⏳ states
    - "Generate Spec" button (disabled until checklist complete)
    - "Save Draft" button
  - Suggested prompt chips in empty state (reuse existing pattern)
  - Message bubbles with proper user/assistant styling
  - Loading states during agent response
- New page `clients/portal/src/app/(portal)/specs/new/page.tsx`:
  - Renders `InterviewChat`
- Update `clients/portal/src/app/(portal)/layout.tsx`:
  - Add "Specs" to sidebar navigation
  - Update "New Environment" link to point to `/specs/new` instead of `/jobs/new`

**Design decisions for Phase 1:**
- **No WebSocket/SSE yet** — Use simple HTTP POST for interview turns. SSE adds complexity; we can add streaming later.
- **No real-time checklist push** — Checklist state returned with each agent response.
- **Reuse existing design patterns** — Message bubbles, sidebar layout, gradient buttons from `ChatCreationView`.

**Success criteria:** User can open `/specs/new`, describe what they want, answer follow-up questions, and see a checklist fill up in real-time.

---

### 6. Spec Review Screen
**Impact:** ★★★★☆ (Critical gate before expensive pipeline execution)  
**Effort:** Medium (~1-2 files)  
**Why sixth:** Users must see and approve the spec before it becomes a job. This is the "no, I meant X" safety valve.

**Changes:**
- New component `clients/portal/src/components/specs/spec-viewer.tsx`:
  - Structured, readable rendering of the spec document
  - Sections: Meta, Environment, Output Spec, Evaluation, Constraints
  - Each field shows current value + "Edit" button (inline editing)
  - "Generate Environment" button (converts spec to job via `POST /specs/{spec_id}/submit`)
  - "Back to Interview" button (if user wants to add more context)
- New page `clients/portal/src/app/(portal)/specs/[spec_id]/page.tsx`:
  - Fetches spec from `GET /specs/{spec_id}`
  - Renders `SpecViewer`
  - After job creation, redirects to `/jobs/{job_id}`

**Design decisions for Phase 1:**
- **No inline editing yet** — Read-only viewer with "Generate" button. Inline editing is easy to add later.
- **No collaboration features** — No comments, no sharing. Single-user flow.
- **No approval gate** — Any user with permission can click "Generate Environment" immediately. Approval workflows are Phase 4.

**Success criteria:** After interview completes, user sees a readable spec document and can click "Generate Environment" to start the pipeline.

---

## What Is NOT in Phase 1 (Intentionally Deferred)

| Feature | Phase | Rationale |
|---------|-------|-----------|
| KB integration during interview | 5 | Adds latency and complexity; agent works fine with prompt-based context in Phase 1 |
| Approval workflows | 4 | Requires `org_approval_policies` table + settings UI + notification logic |
| Team collaboration (comments, shared drafts) | 3 | Requires `spec_comments` table + real-time UI |
| Reusable spec templates | 3 | Requires `spec_templates` table + template gallery UI |
| Real-time WebSocket/SSE for interview | 2-3 | HTTP polling is sufficient for MVP; SSE can be added later |
| Inline spec editing in review screen | 2 | Read-only is fine for MVP |
| Cost estimation & thresholds | 4 | Requires billing integration and heuristic model |
| Org-wide best-practice hints | 5 | Requires KB query infrastructure |

---

## Implementation Sequence (Recommended Order)

```
Week 1:
  Day 1-2:  Database migration (specs table + spec_id on jobs)
  Day 3-4:  InterviewerAgent backend (agent.py + prompts)
  Day 5:    /specs API routes (specs.py)

Week 2:
  Day 1-2:  Pipeline integration (modify JobRequest, create_initial_state, Planner)
  Day 3-4:  InterviewChat frontend UI
  Day 5:    Spec Review Screen + end-to-end testing
```

This sequence respects dependencies: DB first, then backend agent, then API, then pipeline bridge, then frontend.

---

## Files to Create / Modify (Complete List)

### New Files
```
migrations/016_specs.sql
src/eden/agents/interviewer/__init__.py
src/eden/agents/interviewer/agent.py
src/eden/agents/interviewer/prompts/system.md
src/eden/agents/interviewer/prompts/checklist.md
src/eden/agents/interviewer/kb_queries.py
src/eden/api/routes/specs.py
clients/portal/src/components/specs/interview-chat.tsx
clients/portal/src/components/specs/checklist-panel.tsx
clients/portal/src/components/specs/spec-viewer.tsx
clients/portal/src/app/(portal)/specs/new/page.tsx
clients/portal/src/app/(portal)/specs/[spec_id]/page.tsx
clients/portal/src/app/(portal)/specs/page.tsx
```

### Modified Files
```
src/eden/storage/postgres.py          # Add spec CRUD methods
src/eden/api/app.py                   # Register /specs routes
src/eden/api/routes/jobs.py           # Add spec_id to JobRequest, inject spec
src/eden/pipeline/state.py            # Accept spec in create_initial_state
src/eden/agents/planner/agent.py      # Use spec fields when present
clients/portal/src/lib/api.ts         # Add spec API methods
clients/portal/src/lib/types.ts       # Add Spec, SpecRequest types
clients/portal/src/app/(portal)/layout.tsx  # Add Specs nav, update New link
clients/portal/src/app/(portal)/jobs/new/page.tsx  # Redirect to /specs/new or keep as quick-create
```

---

## Risk Mitigation for Phase 1

| Risk | Mitigation |
|------|------------|
| Interview agent is too slow (multi-turn latency) | Each turn is a single LLM call with cached prompt; no KB queries in Phase 1 |
| Agent generates invalid/empty specs | Add JSON schema validation in `generate_spec()`; retry on parse failure |
| Planner ignores the spec | Add explicit instruction in Planner prompt: "If request.spec is present, use it as primary source" |
| Users prefer old 3-question flow | Keep `/jobs/new` as "Quick Create" shortcut that bypasses interview |
| Spec DB schema needs changes later | Use JSONB for flexible spec document; migrate fields into columns in Phase 3 if needed |

---

## Appendix: Current-State Findings

### What Works Well Today
- **Agent infrastructure:** `PromptLoader` mixin, `prompt_versions` table, KB query patterns are solid foundations
- **Pipeline:** LangGraph graph with routing, checkpointing, and SSE streaming is production-ready
- **Frontend:** `ChatCreationView` has good UX patterns (streaming, suggested prompts, progress panel) to build on
- **Org/auth:** Full auth, org switching, roles, notifications already exist
- **API pattern:** FastAPI routes with Pydantic models, SSE streaming, Postgres client are well-established

### Biggest Pain Points ( motivating this work )
1. `ChatCreationView` AI is completely fake — hardcoded questions with no backend intelligence
2. Jobs are submitted with only `description`, `tags`, `difficulty_parameters` — no structured requirements
3. Planner must infer everything from a single sentence — root cause of downstream replan cycles
4. No visibility into what will be built before pipeline starts
5. No way to refine requirements after submission

### Architectural Fit
- The new `specs` table fits naturally alongside `jobs` in the episodic memory layer
- `InterviewerAgent` follows the existing `PromptLoader` pattern
- `/specs` routes follow the same FastAPI patterns as `/jobs`
- `InterviewChat` reuses the same component patterns as `ChatCreationView` and `ChatView`
- Pipeline integration is a minimal change to `create_initial_state` and the Planner prompt

---

*End of Phase 1 Implementation Plan*
