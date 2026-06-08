# Eden: Interview & Spec Generation — Implementation Spec

**Status:** Draft  
**Date:** May 2026  
**Scope:** Full audit and improvement of Eden's actual functionality, with a focus on a new Interview & Spec Generation pre-pipeline stage, enhanced user interaction with output, and enterprise-grade collaboration/governance features.

---

## 1. Executive Summary

Eden currently has a basic 3-question chat wizard (`chat-creation-view.tsx`) that collects description, difficulty, and tags before submitting a job directly to the Planner. This produces thin, under-specified requests that force the Planner to do excessive inference and research, leading to:
- Vague initial EDPs that require multiple Critic replan cycles
- Poor alignment between what the user actually wants and what gets generated
- No opportunity for team review or governance before expensive pipeline execution
- No reusable organizational knowledge capture at the requirement-gathering phase

This spec defines a **new Interview & Spec Generation pre-pipeline stage** — a dedicated agent that conducts a deep, Socratic, KB-aware interview with the user, produces a formal structured spec document, and supports team collaboration and approval workflows before any research or generation begins.

---

## 2. Goals & Success Criteria

### Primary Goals
1. **Reduce Critic replan cycles** by 50% by front-loading requirement clarity
2. **Improve outcome tier distribution** — move jobs from Bronze/Partial toward Gold/Silver by starting with better specs
3. **Enable team collaboration** on specs before committing to expensive pipeline runs
4. **Introduce governance gates** — configurable approval workflows per organization
5. **Capture reusable organizational knowledge** in the form of spec templates and best-practice hints

### Success Metrics
| Metric | Baseline | Target (6mo) | Measurement |
|--------|----------|--------------|-------------|
| Critic replan rate | ~30% (est.) | <15% | Routing history analysis |
| First-attempt Executor pass rate | ~60% (est.) | >80% | Tester results |
| Gold/Silver outcome rate | ~35% (est.) | >55% | Outcome tier distribution |
| User-reported "not what I wanted" rate | unknown | <5% | Post-delivery feedback (new) |
| Spec approval-to-job time | N/A | <2min median | Time from spec approval to job start |
| Template reuse rate | 0% | >20% of jobs | Spec → template usage tracking |
| Approval workflow utilization | 0% | >40% of orgs | Org config adoption |

---

## 3. Current State Assessment

### What Exists Today

**Frontend (`chat-creation-view.tsx`):**
- Simple chat UI with suggested prompts
- 3-question wizard: description → difficulty → tags
- Side configuration panel showing progress
- Direct submission to `/api/jobs` with `JobRequest` schema
- No spec review step; no collaboration; no approval gate

**Backend (`src/eden/api/routes/jobs.py`):**
- `POST /jobs` accepts `JobRequest` (description, tags, difficulty_parameters)
- Immediately creates a job and launches the pipeline in a background task
- No spec entity; no intermediate state between "user has an idea" and "pipeline is running"

**Pipeline (`src/eden/pipeline/graph.py`, `state.py`):**
- Entry point is `planner_node` which receives the raw `request` dict
- Planner performs KB queries + web research from a thin description
- Critic evaluates the EDP and may route back for replan/re-research
- No pre-Planner stage exists

**Enterprise Features (existing):**
- Orgs, roles (owner/admin/member), SSO, SCIM, 2FA, audit logs, analytics
- API keys, billing/limits, invitations
- No per-org configuration for approval workflows
- No spec-level collaboration features

### Pain Points Identified

1. **Thin input → thick inference burden:** The Planner must infer environment class, modality, reward structure, difficulty axes, framework, etc. from a single sentence. This is the root cause of many downstream replan cycles.

2. **No visibility into what will be built:** Users click "Submit" and hope. They don't see the EDP before execution starts. There's no chance to say "no, I meant X, not Y."

3. **No team review:** In organizations, junior members might submit expensive jobs without senior review. There's no approval gate, no commenting, no shared understanding.

4. **No organizational learning at the requirement layer:** If an org builds 50 navigation environments, the 51st still starts from a blank description. Past patterns are not surfaced during requirement gathering.

5. **No governance over spend:** A member could submit a complex multi-agent environment that costs $40 without any oversight. There's no pre-execution cost estimation or approval threshold.

---

## 4. The Interview & Spec Generation Agent

### 4.1 Agent Identity

**Name:** `InterviewerAgent`  
**Role:** Conduct deep requirement-gathering interviews with users and produce formal structured spec documents.  
**Pipeline Position:** Pre-pipeline stage. Runs before `planner_node`. Output is the primary input to the Planner.

**Responsibilities:**
1. Conduct a conversational, KB-aware interview with the user
2. Dynamically adapt question depth based on request novelty and complexity
3. Query the Knowledge Base during the interview to ask context-aware follow-ups
4. Generate a formal structured spec document when sufficient clarity is achieved
5. Present the spec for user review and approval
6. Support team collaboration (comments, shared drafts) during spec review
7. Enforce approval workflows before converting a spec into a job

### 4.2 Interview Completion Logic: Hybrid Checklist + Socratic

The agent uses a **two-phase completion model:**

**Phase 1: Required Field Checklist (hard gate)**
The agent must collect values for all of the following before it can generate a spec:

| Field | Description | Why Required |
|-------|-------------|--------------|
| `environment_class` | Classification of the environment | Determines pipeline routing, test categories, and KB queries |
| `observation_modality` | How the agent perceives the environment | Drives observation space design and framework selection |
| `primary_framework` | Target framework (Gymnasium, PettingZoo, etc.) | Required for Fact Checker and Executor |
| `reward_type` | Dense, sparse, shaped, verifiable, or none | Determines reward design patterns and exploit probes |
| `agent_count` | Single-agent or multi-agent | Affects architecture (AEC vs Parallel, communication channels) |
| `difficulty_intent` | Beginner/intermediate/advanced/expert | Calibrates Tester expectations and Critic thresholds |
| `max_episode_length` | Expected episode duration in steps | Required for termination logic and performance targets |
| `evaluation_criteria` | How success is measured (reward, task completion, etc.) | Drives the EDP's reward structure and evaluation harness |
| `output_language` | Python, TypeScript, etc. | Required for Executor output mode selection |
| `constraints` | Performance, memory, dependencies, etc. | Required for Code Quality Pipeline targets |

If any field is missing or ambiguous, the agent must continue interviewing until all are resolved.

**Phase 2: Socratic Depth (soft gate)**
Once the checklist is complete, the agent evaluates whether deeper probing is warranted based on:

- `novelty_assessment`: If the request appears novel (not matching known patterns in KB), the agent asks deeper questions about edge cases, failure modes, and design alternatives.
- `complexity_score`: A heuristic based on agent count, reward component count, difficulty axes, and framework novelty. Score > 0.7 triggers deep-dive mode.
- `org_history`: If the org has past jobs of the same environment class with Bronze/Partial/Failed outcomes, the agent asks targeted questions about the decisions that caused those failures.

The agent signals completion with: *"I have enough information to generate a spec. Would you like me to proceed, or do you have anything else to add?"*

### 4.3 Interview Style: Conversational Socratic Dialogue

The agent speaks naturally but probes aggressively for clarity. Example interaction patterns:

**Clarification chaining:**
> User: "I want a multi-agent environment."  
> Agent: "Got it. How many agents — fixed number or variable? And are they cooperative, competitive, or mixed?"  
> User: "Two agents, competitive."  
> Agent: "Competitive like zero-sum (one's gain is the other's loss) or general-sum (agents have independent objectives)?"

**KB-informed follow-up:**
> Agent: "Your org built 3 sparse-reward navigation environments in the past month. 2 of them had Bronze outcomes because the Critic found reward hacking risks. Would you like me to suggest a shaped reward structure with potential-based distance, or do you want to stick with sparse and accept the trade-off?"

**Edge case probing:**
> Agent: "You said max_episode_length is 1000 steps. What should happen if the agent gets stuck in a local minimum and hasn't made progress by step 500 — should there be a timeout bonus, a penalty, or nothing?"

**Constraint discovery:**
> Agent: "You mentioned this is for training a PPO agent. Are you using Stable Baselines3, CleanRL, or a custom implementation? This affects the observation dtype and vectorized environment requirements."

### 4.4 KB Integration During Interview

The agent queries the KB **in real-time** during the interview to ask smarter questions. Query strategy:

**Episodic queries (per org):**
- `get_recent_jobs(org_id, env_class, limit=10)` — recent jobs of the same class
- `get_failure_patterns(org_id, env_class)` — common failure modes for this org + class
- `get_success_patterns(org_id, env_class)` — what worked well (Gold/Silver)

**Semantic queries (global):**
- `get_design_patterns(env_class)` — known good patterns
- `get_failure_modes(env_class, reward_type)` — known pitfalls
- `get_best_practices(env_class, framework)` — framework-specific advice
- `get_archivist_warnings(env_class)` — forward annotations from the Archivist

**Procedural queries:**
- `get_relevant_skills(env_class, framework)` — Skill Library entries to suggest as starting points

**Exploit queries:**
- `get_applicable_exploits(env_class, reward_type)` — known attack patterns to warn about

These queries happen **asynchronously** while the user is typing their next response, so follow-up questions feel instant.

### 4.5 Spec Document Schema

The generated spec is a **structured machine-readable document** that maps directly to the Planner's EDP schema. It is NOT a human-readable PRD — the user reviews it through a rendered UI, but the underlying data is structured.

```json
{
  "spec_id": "spec_<uuid>",
  "org_id": "<uuid>",
  "created_by": "<user_id>",
  "created_at": "2026-05-29T12:00:00Z",
  "status": "draft | pending_approval | approved | rejected | converted_to_job",
  
  "interview": {
    "transcript": [
      {"role": "user", "content": "...", "timestamp": "..."},
      {"role": "agent", "content": "...", "timestamp": "..."}
    ],
    "completion_metadata": {
      "checklist_complete": true,
      "socratic_depth_reached": true,
      "novelty_assessment": "standard | variant | novel",
      "complexity_score": 0.72,
      "kb_queries_made": 8,
      "interview_duration_seconds": 145
    }
  },

  "spec": {
    "meta": {
      "environment_class": "rl_training | agent_sandbox | llm_agent_eval | multi_agent | curriculum | adversarial | simulation | tool_use | custom",
      "observation_modality": "discrete | continuous | image | language | graph | multimodal | custom",
      "novelty_assessment": "standard | variant | novel",
      "design_confidence": 0.85,
      "primary_framework": "gymnasium | pettingzoo | custom",
      "framework_version": "0.29",
      "output_language": "python | typescript | ...",
      "agent_count": "single | fixed:N | variable",
      "agent_relationship": "cooperative | competitive | mixed | independent",
      "difficulty_intent": "beginner | intermediate | advanced | expert",
      "estimated_cost_tier": "simple | standard | complex | llm_eval | curriculum",
      "research_sources": [],
      "kb_references": {
        "episodic": [...],
        "semantic": [...],
        "procedural": [...]
      },
      "archivist_warnings_addressed": [
        {"warning": "...", "how_addressed": "..."}
      ]
    },

    "environment": {
      "observation_space": {
        "type": "Box | Discrete | Tuple | Dict | ...",
        "shape": "tuple of ints",
        "bounds": "low/high values",
        "sufficiency_rationale": "why this observation is sufficient for the task"
      },
      "action_space": {
        "type": "Box | Discrete | MultiDiscrete | ...",
        "dimensionality": "int",
        "bounds": "low/high values",
        "meaningfulness_rationale": "why each action matters"
      },
      "reward_structure": {
        "type": "dense | sparse | shaped | verifiable | none",
        "components": [
          {
            "name": "string",
            "formula": "string (mathematical expression)",
            "bounds": "[min, max]",
            "rationale": "string"
          }
        ],
        "shaping_approach": "potential_based | subgoal | none",
        "hacking_risk_per_category": {
          "specification_gaming": {"level": "low|med|high", "mitigation": "..."},
          "reward_tampering": {"level": "low|med|high", "mitigation": "..."},
          "proxy_optimisation": {"level": "low|med|high", "mitigation": "..."},
          "objective_misalignment": {"level": "low|med|high", "mitigation": "..."},
          "exploitation_patterns": {"level": "low|med|high", "mitigation": "..."},
          "wireheading": {"level": "low|med|high", "mitigation": "..."}
        }
      },
      "episode_dynamics": {
        "termination_conditions": ["list of conditions"],
        "max_steps": "int",
        "reset_logic": "string",
        "stochasticity": "sources of randomness"
      },
      "difficulty_parameters": {
        "axes": ["list of difficulty dimensions"],
        "defaults": {},
        "ranges": {}
      }
    },

    "output_spec": {
      "language": "python | typescript | ...",
      "framework": "gymnasium | pettingzoo | ...",
      "framework_version": "string",
      "interface_contract": "string (e.g., gym.Env)",
      "entry_class": "string",
      "vectorized": false,
      "dependencies": ["list of required packages with versions"]
    },

    "evaluation": {
      "success_criteria": "string",
      "target_agents": ["ppo | a3c | sac | llm_agent | custom"],
      "benchmark_metrics": ["reward | task_completion | sample_efficiency | ..."],
      "baseline_performance": "optional target values"
    },

    "constraints": {
      "max_step_time_ms": 10,
      "memory_limit_mb": 512,
      "target_lines_of_code": "optional",
      "disallowed_dependencies": [],
      "must_use_framework_features": []
    },

    "known_risks": [
      {"risk": "string", "severity": "high|med|low", "mitigation": "string"}
    ],

    "design_decisions": [
      {
        "decision": "string",
        "rationale": "string",
        "alternatives_considered": ["list of alternatives"]
      }
    ]
  },

  "collaboration": {
    "comments": [
      {
        "id": "<uuid>",
        "user_id": "<uuid>",
        "content": "string",
        "created_at": "timestamp",
        "resolved": false
      }
    ],
    "reviewers": ["<user_id>"],
    "approval_status": "pending | approved | rejected",
    "approval_history": [
      {"user_id": "<uuid>", "action": "approved | rejected | commented", "timestamp": "...", "note": "..."}
    ]
  },

  "template": {
    "is_template": false,
    "template_name": "optional",
    "derived_from_template": "optional spec_id"
  }
}
```

---

## 5. User Experience Flow

### 5.1 Flow Overview

```
[User clicks "New Environment"]
         ↓
[Interview Chat UI opens — full screen or large modal]
         ↓
[Conversational interview with the InterviewerAgent]
   ├─ Agent asks questions, user answers
   ├─ Agent queries KB in background for context-aware follow-ups
   ├─ Agent shows checklist progress in side panel
   └─ Agent asks "Ready to generate spec?" when checklist + Socratic depth reached
         ↓
[Spec Review Screen — structured, readable rendering of the spec]
   ├─ User can edit any field inline
   ├─ User can add comments/annotations
   ├─ "Share for review" button (team collaboration)
   └─ "Save as template" button
         ↓
[Approval Gate — if org policy requires it]
   ├─ Spec enters "pending_approval" status
   ├─ Notifies designated approvers
   ├─ Approvers review, comment, approve/reject
   └─ On approval, spec transitions to "approved"
         ↓
[User clicks "Generate Environment"]
         ↓
[Spec is converted to a Job]
   ├─ Spec becomes the `request` input to the Planner
   ├─ Job is created with status "pending"
   ├─ Normal pipeline begins: Planner → Critic → ... → Archivist
   └─ User is taken to the job detail page to watch progress
```

### 5.2 Interview Chat UI

**Layout:** Full-screen modal or dedicated route (`/specs/new`)

**Components:**
- **Main chat area:** Natural conversation between user and InterviewerAgent
  - Agent messages rendered with rich formatting (bulleted options, highlighted terms)
  - User input at bottom with suggestion chips
  - Streaming agent responses (same pattern as existing chat-creation-view)
- **Right sidebar: Checklist Progress Panel**
  - Visual checklist of required fields with ✅/⏳/❌ states
  - Socratic depth indicator (progress bar + "depth level: basic → intermediate → deep")
  - KB insights panel: "Did you know? Your org had 2 failures with sparse reward..."
  - "Generate Spec" button (disabled until checklist complete)
- **Top bar:**
  - Spec title (auto-generated from description, editable)
  - "Save Draft" button
  - "Cancel" button

**Interaction Patterns:**
- Agent messages can include **quick-reply chips** for common answers (e.g., "Dense", "Sparse", "Shaped" for reward type)
- Agent can show **preview cards** for suggested patterns from KB ("Based on your org's history, this pattern worked well...")
- Agent can **expand/collapse** long explanations to keep the chat focused

### 5.3 Spec Review Screen

**Layout:** Split view

**Left panel — Structured Spec Viewer:**
- Rendered as a readable document with sections (Meta, Environment, Output Spec, Evaluation, Constraints, Risks, Design Decisions)
- Each field is **inline-editable** (click to edit, save on blur)
- Fields with KB provenance show a small "ⓘ" icon with tooltip: "Suggested based on 3 past org jobs"
- Changes trigger real-time re-validation (e.g., if you change framework from Gymnasium to PettingZoo, the agent re-validates agent count and relationship fields)

**Right panel — Collaboration & Actions:**
- **Comments thread:** Inline commenting on any spec section (like Google Docs)
- **Reviewers:** Add team members to review; they get notifications
- **Actions:**
  - "Request Approval" (if policy requires)
  - "Generate Environment" (if approved or no policy)
  - "Save as Template" (if user has permission)
  - "Export as JSON" (for advanced users)

**Bottom bar:**
- Estimated cost tier and pipeline duration
- Confidence score from the interview agent
- List of addressed Archivist warnings

### 5.4 Approval Workflow UI

**Approver Dashboard:**
- Accessible from sidebar: "Pending Approvals" badge
- List of specs awaiting approval with metadata (requester, estimated cost, env class, urgency)
- Click to open spec review screen with approve/reject/comment actions
- Reject requires a reason (stored in approval history)

**Notification Flow:**
- Spec submitter gets notified when approved/rejected/commented
- Approvers get notified when a new spec needs their review
- Notifications use existing notification system (`notifications` table + UI dropdown)

---

## 6. Pipeline Integration

### 6.1 New Pipeline Stage: `interviewer_node`

The Interview & Spec Generation stage is a **new pre-pipeline node** that runs BEFORE `planner_node`.

**Architecture:**
```
[User submits spec for generation]
         ↓
[POST /specs/{spec_id}/generate → creates Job]
         ↓
[Job created with request = spec document]
         ↓
[interviewer_node? No — spec IS the input]
         ↓
[planner_node receives enriched request]
         ↓
[Normal pipeline continues...]
```

Actually, the interview happens **OUTSIDE the pipeline** — it's a user interaction phase. The pipeline only starts when the spec is approved and converted to a job. The spec document becomes the `request` field in `EdenJobState`.

**Modified `JobRequest` schema:**
```python
class JobRequest(BaseModel):
    description: str
    tags: list[str] = []
    difficulty_parameters: dict = {}
    spec_id: Optional[str] = None  # NEW: reference to approved spec
    # When spec_id is present, the full spec document is injected into request
```

**Modified `create_initial_state`:**
```python
def create_initial_state(job_id: str, request: dict, spec: Optional[dict] = None) -> EdenJobState:
    # If spec is present, merge it into request so Planner can use it directly
    enriched_request = {**request}
    if spec:
        enriched_request["spec"] = spec
    return EdenJobState(
        job_id=job_id,
        request=enriched_request,
        # ... rest unchanged
    )
```

**Modified `planner_node`:**
- If `request.spec` is present, the Planner uses it as the PRIMARY source for EDP fields instead of inferring from `description`
- The Planner still performs KB queries and web research, but starts from a much richer baseline
- The Planner's EDP should be a refinement/validation of the spec, not a从零 inference

### 6.2 State Flow

```
User → InterviewAgent → Spec Document (draft)
                     ↓
              User Review + Edits
                     ↓
              Collaboration/Comments
                     ↓
              Approval Gate (if configured)
                     ↓
              Spec → Job conversion
                     ↓
              Planner receives enriched request with spec
                     ↓
              Normal pipeline
```

---

## 7. Enterprise Features

### 7.1 Approval Workflows (Fully Configurable Per Org)

**New table: `org_approval_policies`**
```sql
CREATE TABLE org_approval_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    policy_name TEXT NOT NULL DEFAULT 'Default Policy',
    is_default BOOLEAN DEFAULT false,
    
    -- Who needs to approve
    required_approver_roles TEXT[] NOT NULL DEFAULT '{owner,admin}',
    min_approver_count INTEGER NOT NULL DEFAULT 1,
    
    -- When approval is required
    always_requires_approval BOOLEAN DEFAULT false,
    cost_threshold_cents INTEGER,  -- null means no threshold
    env_class_requires_approval TEXT[],  -- e.g., {'adversarial', 'multi_agent'}
    
    -- Who can bypass
    bypass_roles TEXT[] NOT NULL DEFAULT '{owner}',
    
    -- Auto-actions
    auto_approve_if_role TEXT[],  -- e.g., '{owner}' — owners don't need approval
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(org_id, policy_name)
);
```

**Policy evaluation logic:**
```python
def requires_approval(spec: dict, user: dict, org_policy: dict) -> bool:
    if user["role"] in org_policy["bypass_roles"]:
        return False
    if org_policy["always_requires_approval"]:
        return True
    if org_policy["cost_threshold_cents"]:
        estimated_cost = estimate_spec_cost(spec)
        if estimated_cost > org_policy["cost_threshold_cents"]:
            return True
    if spec["meta"]["environment_class"] in org_policy["env_class_requires_approval"]:
        return True
    if user["role"] in org_policy["auto_approve_if_role"]:
        return False
    return False
```

### 7.2 Team Collaboration

**Comments on specs:**
- New table: `spec_comments(spec_id, user_id, section_path, content, created_at, resolved_at)`
- Inline commenting UI like Google Docs (highlight a section, add comment)
- Threaded replies
- @mentions for users (integrates with notification system)

**Shared draft specs:**
- Specs in `draft` status are visible to all org members
- Any member with `write` permission can edit
- Real-time collaborative editing via operational transforms or CRDTs (or simpler: optimistic locking with version checks)
- For MVP: optimistic locking with conflict resolution prompt

**Review assignments:**
- Spec creator can assign reviewers (org members)
- Reviewers get notifications
- Review status tracked per reviewer (pending / reviewed / approved / rejected)

### 7.3 Reusable Spec Templates

**New table: `spec_templates`**
```sql
CREATE TABLE spec_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    spec JSONB NOT NULL,  -- full spec document (without interview transcript)
    tags TEXT[] DEFAULT '{}',
    usage_count INTEGER DEFAULT 0,
    is_org_default BOOLEAN DEFAULT false,
    is_system_template BOOLEAN DEFAULT false,  -- Eden-provided templates
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Template usage flow:**
1. User clicks "New from Template" instead of "New Environment"
2. Select from org templates or system templates
3. Template pre-fills the spec; interview agent only asks about deltas/changes
4. "Save as Template" available after successful job completion (Gold/Silver outcomes only)

### 7.4 Org-Wide Best-Practice Hints

During the interview, the agent surfaces:
- **Past failure warnings:** "Your org had a Bronze outcome with sparse reward in navigation — consider shaped reward"
- **Success patterns:** "3 Gold outcomes in your org used potential-based distance shaping — want to use that?"
- **Framework-specific tips:** "Your org uses Gymnasium 0.29 — note that `Dict` spaces have a known edge case with..."
- **Cost awareness:** "This spec looks like a Complex tier ($25-45). Your org has used $120 this month."

These are pulled from episodic memory (org-specific) and semantic memory (global) and presented as **suggestion chips** the user can accept or ignore.

---

## 8. API Changes

### 8.1 New Routes

```
POST   /specs                          → Create a new spec (starts interview)
GET    /specs                          → List specs for user/org
GET    /specs/{spec_id}                → Get spec details
PUT    /specs/{spec_id}                → Update spec (edits)
DELETE /specs/{spec_id}                → Delete draft spec
POST   /specs/{spec_id}/submit         → Submit spec for approval / convert to job
POST   /specs/{spec_id}/comments       → Add comment
GET    /specs/{spec_id}/comments       → List comments
POST   /specs/{spec_id}/approve        → Approve spec (approvers only)
POST   /specs/{spec_id}/reject         → Reject spec (approvers only)
POST   /specs/{spec_id}/save-template  → Save as template

GET    /specs/templates                → List templates
POST   /specs/templates                → Create template from spec
GET    /specs/templates/{template_id}  → Get template
POST   /specs/from-template            → Create spec from template

GET    /orgs/{org_id}/approval-policies     → Get approval policies
PUT    /orgs/{org_id}/approval-policies     → Update approval policies
```

### 8.2 Modified Routes

```
POST /jobs — Accept optional spec_id. When present, injects spec into request.
```

### 8.3 WebSocket/SSE for Real-Time Interview

The interview chat should use WebSockets (or SSE if simpler) for real-time agent responses:
- `WS /ws/interview/{spec_id}` — bidirectional streaming
- User sends messages; agent streams responses token-by-token
- KB query progress shown as "thinking..." indicators
- Checklist updates pushed in real-time as fields are resolved

For MVP, SSE can be used with the existing `/api/jobs/{job_id}/stream` pattern adapted for interview sessions.

---

## 9. Frontend Components

### 9.1 New Pages/Routes

```
/specs                  → Spec list page (like Jobs page)
/specs/new              → New spec (interview UI)
/specs/{spec_id}        → Spec detail/review page
/specs/{spec_id}/edit   → Edit spec (if draft)
/specs/templates        → Template gallery
/specs/pending         → Pending approvals (for approvers)
```

### 9.2 New Components

- `InterviewChat` — Main interview conversation UI (replaces/enhances `ChatCreationView`)
- `ChecklistPanel` — Right sidebar showing required field progress
- `SpecViewer` — Structured, readable spec renderer with inline editing
- `SpecEditor` — Inline editing controls for spec fields
- `CommentThread` — Inline commenting on spec sections
- `ApprovalBadge` — Status badge for approval state
- `ApprovalActions` — Approve/reject buttons with reason input
- `TemplateCard` — Template gallery card
- `TemplateSelector` — Dropdown for choosing templates
- `CostEstimator` — Shows estimated pipeline cost and duration
- `KBHintCard` — Floating hint cards for KB-derived suggestions

### 9.3 Modified Components

- `ChatCreationView` — Deprecated in favor of `InterviewChat`, or repurposed as a simplified "Quick Create" mode
- `JobCard` — Add spec source indicator ("from spec #abc" or "from template XYZ")
- `Dashboard` — Add "Pending Approvals" metric; add "Specs" section
- `Sidebar` — Add "Specs" nav item; add "Pending Approvals" badge

---

## 10. Data Model Changes

### 10.1 New Tables

```sql
-- Specs (core entity)
CREATE TABLE specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spec_id VARCHAR(255) UNIQUE NOT NULL,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    created_by UUID NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',  -- draft, pending_approval, approved, rejected, converted_to_job
    title TEXT NOT NULL,
    description TEXT,
    spec JSONB NOT NULL DEFAULT '{}',
    interview_transcript JSONB NOT NULL DEFAULT '[]',
    completion_metadata JSONB DEFAULT '{}',
    collaboration JSONB DEFAULT '{}',
    template_info JSONB DEFAULT '{}',
    converted_job_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spec comments
CREATE TABLE spec_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spec_id UUID NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    section_path TEXT NOT NULL,  -- JSON path to the section being commented on, e.g., "environment.reward_structure"
    content TEXT NOT NULL,
    parent_id UUID REFERENCES spec_comments(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spec approval history
CREATE TABLE spec_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spec_id UUID NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,  -- approved, rejected, commented
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spec templates
CREATE TABLE spec_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL for system templates
    created_by UUID NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    spec JSONB NOT NULL,
    tags TEXT[] DEFAULT '{}',
    usage_count INTEGER DEFAULT 0,
    is_org_default BOOLEAN DEFAULT false,
    is_system_template BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Approval policies
CREATE TABLE org_approval_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    policy_name TEXT NOT NULL DEFAULT 'Default',
    is_default BOOLEAN DEFAULT true,
    required_approver_roles TEXT[] NOT NULL DEFAULT '{owner,admin}',
    min_approver_count INTEGER NOT NULL DEFAULT 1,
    always_requires_approval BOOLEAN DEFAULT false,
    cost_threshold_cents INTEGER,
    env_class_requires_approval TEXT[] DEFAULT '{}',
    bypass_roles TEXT[] NOT NULL DEFAULT '{owner}',
    auto_approve_if_role TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, policy_name)
);
```

### 10.2 Modified Tables

```sql
-- Add spec reference to jobs
ALTER TABLE jobs ADD COLUMN spec_id VARCHAR(255);
ALTER TABLE jobs ADD COLUMN estimated_cost_cents INTEGER;

-- Add spec-related notification types
-- (No schema change needed — uses existing metadata JSONB)
```

---

## 11. Agent Implementation: InterviewerAgent

### 11.1 File Structure

```
src/eden/agents/
├── interviewer/
│   ├── __init__.py
│   ├── agent.py           # InterviewerAgent class
│   ├── prompts/
│   │   ├── system.md      # System prompt
│   │   ├── checklist.md   # Required field definitions
│   │   └── socratic.md    # Deep-dive probing strategies
│   └── kb_queries.py      # KB query helpers for interview context
```

### 11.2 Agent Interface

```python
class InterviewerAgent(PromptLoader):
    AGENT_NAME = "interviewer"
    
    async def run_interview(
        self,
        user_id: str,
        org_id: str,
        initial_message: str,
        conversation_history: list[dict],
    ) -> InterviewTurn:
        """Process one turn of the interview.
        
        Returns the agent's next message, checklist status, and
        whether the interview is complete.
        """
        
    async def generate_spec(
        self,
        conversation_history: list[dict],
        org_id: str,
    ) -> dict:
        """Generate a formal spec document from the completed interview."""
        
    def evaluate_completion(
        self,
        checklist: dict,
        conversation_history: list[dict],
    ) -> CompletionStatus:
        """Evaluate whether the interview is complete enough to generate a spec."""
```

### 11.3 Key Behaviors

- **Stateful across turns:** The agent maintains conversation state (checklist progress, detected ambiguity, inferred fields) across messages.
- **KB-aware questioning:** Before responding, queries episodic/semantic/procedural memory for relevant context.
- **Conflict resolution:** If user answers contradict earlier answers, the agent surfaces the contradiction and asks for clarification.
- **Progressive disclosure:** Doesn't overwhelm the user with all questions at once. Reveals deeper questions only as context demands.
- **Spec generation:** When complete, synthesizes the structured spec from the conversation transcript + inferred fields.

---

## 12. Migration & Rollout Plan

### Phase 1: Foundation (Weeks 1-2)
- Create `specs` table and related schema
- Build `InterviewerAgent` with basic checklist logic (no KB integration yet)
- Build `InterviewChat` UI with checklist sidebar
- Build `SpecViewer` for review

### Phase 2: Pipeline Integration (Weeks 3-4)
- Modify `JobRequest` and `create_initial_state` to accept spec documents
- Modify `Planner` to use spec as primary input when available
- Build spec → job conversion flow
- Add spec reference to existing job list/detail pages

### Phase 3: Collaboration (Weeks 5-6)
- Add comments on specs
- Add shared draft specs (org-visible)
- Add template creation and usage
- Replace `ChatCreationView` with `InterviewChat` as default new-job flow

### Phase 4: Enterprise Governance (Weeks 7-8)
- Build approval policy configuration in Settings
- Build approval workflow UI (submitter + approver views)
- Add approval notifications
- Add cost estimation and threshold enforcement

### Phase 5: KB Integration & Polish (Weeks 9-10)
- Wire KB queries into interview agent
- Add org-specific best-practice hints
- Add success/failure pattern surfacing
- Performance optimization and bug fixes

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Interview agent adds friction — users prefer the old 3-question flow | Medium | Keep "Quick Create" mode that bypasses interview for simple requests; A/B test conversion rates |
| KB queries during interview add latency | Medium | Pre-fetch org history on interview start; cache semantic queries; show "thinking..." indicators |
| Spec approval workflows block users | Low | Configurable policies; auto-approve for low-cost/simple specs; bypass for owners |
| Real-time collaborative editing is complex | Medium | Start with optimistic locking + version checks; add CRDTs later if needed |
| Planner doesn't properly leverage the richer spec | High | Modify Planner prompt to explicitly prioritize spec fields over inference; add validation that spec fields appear in EDP |
| Approval policy UI is confusing | Low | Use sensible defaults; provide policy templates (strict, relaxed, custom) |

---

## 14. Open Questions

1. **Should the interview agent be a LangGraph sub-graph?** It has state, routing (checklist → Socratic → spec generation), and loops. LangGraph would give us checkpointing and introspection. However, it might be overkill for a conversational agent. Recommendation: Start as a simple stateful class; migrate to LangGraph if complexity grows.

2. **How do we handle "I don't know" answers?** The agent should either (a) suggest sensible defaults with explanation, (b) flag the field as "inferred" and let the Planner figure it out, or (c) ask a simpler follow-up. We should define a clear escalation policy.

3. **Should we support voice/video interview?** Out of scope for MVP, but the architecture should support pluggable input modalities.

4. **How does the interview agent handle multi-turn contradictions?** If the user says "single agent" on turn 3 and "two agents" on turn 8, the agent should surface the contradiction and ask which is correct. This requires maintaining a "grounded facts" dict alongside the conversation.

5. **Cost estimation accuracy:** The estimated cost tier is heuristic-based. Should we train a lightweight model on historical job data to improve accuracy? Recommendation: Start with heuristic; add ML-based estimation if data supports it.

---

## 15. Appendix: Interview Example Transcript

**User:** "I want an environment for training a robot to navigate a maze."

**Agent:** "That sounds like a discrete navigation RL environment. A few questions to get the details right:

1. Is this for a single robot, or multiple robots that might need to coordinate or compete?
2. What does the robot observe — a bird's-eye view of the maze, local sensor readings, or something else?"

**User:** "Single robot. It gets a 2D grid observation of the maze around it."

**Agent:** "Got it. For the action space, does the robot move in 4 directions (up/down/left/right), 8 directions (including diagonals), or continuous movement?"

**User:** "4 directions."

**Agent:** "Reward structure — sparse (only when reaching the goal), or dense (e.g., negative distance to goal at every step)?"

**User:** "Sparse is fine."

**Agent:** "⚠️ **Heads up:** Your organization has built 2 sparse-reward navigation environments in the past month. Both had Bronze outcomes because the Critic flagged reward hacking risks — agents found shortcuts that satisfied the literal goal without true navigation. Would you like me to suggest a shaped reward with potential-based distance, or stick with sparse and add extra safety checks?"

**User:** "Good catch. Let's do shaped reward with distance to goal."

**Agent:** "Perfect. Difficulty level — beginner (small maze, no obstacles), intermediate (medium maze, some obstacles), advanced (large maze, dynamic obstacles), or expert (very large, partial observability, time pressure)?"

**User:** "Intermediate."

**Agent:** "Framework — Gymnasium (most common), or something else?"

**User:** "Gymnasium 0.29."

**Agent:** "Great. I have enough to generate a spec. One more thing — any performance constraints? Max episode length?"

**User:** "500 steps max. Should run in under 10ms per step."

**Agent:** "✅ Checklist complete. I've gathered all the essentials. Would you like me to generate the spec now, or is there anything else you'd like to add?"

**User:** "Generate it."

**Agent:** → Generates structured spec document → User sees Spec Review Screen → Approves → Job created → Pipeline starts.

---

*End of Spec*
